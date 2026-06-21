import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFile } from 'music-metadata';
import type { AlertMediaResource } from '@/application/alerts/types';
import type { TtsProvider } from '@/application/alerts/ttsProvider';
import { createLogger } from '@/shared/logging/logger';

const CACHE_DIR = path.resolve(process.cwd(), 'public', 'alerts', 'cache');

// translate.google.com/translate_tts rejects requests whose `q` exceeds ~200
// characters with HTTP 400. Longer text must be split into segments that are
// each fetched separately and concatenated, mirroring how the official server
// handles up to ~400 characters.
const MAX_TTS_CHUNK_CHARS = 200;

export class GoogleTtsProvider implements TtsProvider {
  private readonly log = createLogger('Alerts', 'GoogleTts');
  private readonly durationCache = new Map<string, number>();

  public async generate(
    text: string,
    language?: string,
  ): Promise<AlertMediaResource | undefined> {
    const normalizedText = (text ?? '').trim();
    if (!normalizedText) {
      this.log.warn('missing text for TTS generation');
      return undefined;
    }
    const lang = this.normalizeLang(language);
    if (!lang) {
      this.log.warn('missing language for TTS generation');
      return undefined;
    }
    const digest = createHash('sha1').update(`${lang}|${normalizedText}`).digest('hex');
    const filename = `tts-${digest}.mp3`;
    const abs = path.join(CACHE_DIR, filename);

    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      if (await this.exists(abs)) {
        return this.buildResource(filename, normalizedText);
      }

      const chunks = splitTextIntoChunks(normalizedText, MAX_TTS_CHUNK_CHARS);
      const parts: Buffer[] = [];
      for (let idx = 0; idx < chunks.length; idx += 1) {
        const chunk = chunks[idx] ?? '';
        const url = this.buildGoogleTtsUrl(chunk, lang, idx, chunks.length);
        const res = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
            Accept: '*/*',
          },
        });
        const contentType = res.headers.get('content-type') ?? '';
        if (!res.ok || !contentType.includes('audio')) {
          throw new Error(
            `HTTP ${res.status} ${res.statusText} (ct=${contentType || 'none'}, chunk ${idx + 1}/${chunks.length})`,
          );
        }
        parts.push(Buffer.from(await res.arrayBuffer()));
      }
      const buffer = Buffer.concat(parts);
      await fs.writeFile(abs, buffer);
      this.log.info('generated TTS clip', {
        lang,
        filename,
        bytes: buffer.length,
        chunks: chunks.length,
      });
      return this.buildResource(filename, normalizedText);
    } catch (err) {
      this.log.error('failed to generate TTS clip', {
        message: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private buildGoogleTtsUrl(text: string, lang: string, idx: number, total: number): string {
    const url = new URL('https://translate.google.com/translate_tts');
    url.searchParams.set('ie', 'UTF-8');
    url.searchParams.set('q', text);
    url.searchParams.set('tl', lang);
    url.searchParams.set('client', 'tw-ob');
    url.searchParams.set('ttsspeed', '1');
    url.searchParams.set('total', String(total));
    url.searchParams.set('idx', String(idx));
    url.searchParams.set('textlen', String(text.length));
    return url.toString();
  }

  private normalizeLang(lang?: string): string {
    if (!lang) {
      return 'en';
    }
    const lower = lang.trim().toLowerCase();
    const map: Record<string, string> = {
      nld: 'nl',
      dut: 'nl',
      eng: 'en',
      deu: 'de',
      ger: 'de',
      fra: 'fr',
      fre: 'fr',
      spa: 'es',
      ita: 'it',
      por: 'pt',
    };
    return map[lower] ?? lower.slice(0, 2);
  }

  private async buildResource(filename: string, text: string): Promise<AlertMediaResource> {
    const relativePath = `cache/${filename}`;
    const url = `alerts://cache/${encodeURIComponent(filename)}`;
    const duration = await this.resolveDuration(filename);
    return {
      title: text.length > 48 ? `${text.slice(0, 45)}…` : text,
      relativePath,
      url,
      duration,
    };
  }

  private async resolveDuration(filename: string): Promise<number | undefined> {
    const cacheKey = `cache/${filename}`;
    if (this.durationCache.has(cacheKey)) {
      return this.durationCache.get(cacheKey);
    }
    const abs = path.join(CACHE_DIR, filename);
    try {
      const meta = await parseFile(abs);
      const duration = meta.format.duration;
      if (typeof duration === 'number' && duration > 0) {
        const rounded = Math.round(duration);
        this.durationCache.set(cacheKey, rounded);
        return rounded;
      }
    } catch (err) {
      this.log.debug('tts duration probe failed', {
        path: abs,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Split text into segments no longer than `maxLen`, preferring to break after
 * sentence punctuation and otherwise on word boundaries so the synthesized
 * audio doesn't slice through a word. An oversized single token is hard-cut.
 */
export function splitTextIntoChunks(text: string, maxLen = MAX_TTS_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    const sentenceBreak = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('; '),
      window.lastIndexOf(', '),
    );
    const wordBreak = window.lastIndexOf(' ');
    const cut = sentenceBreak > 0 ? sentenceBreak + 1 : wordBreak > 0 ? wordBreak + 1 : maxLen;
    const piece = remaining.slice(0, cut).trim();
    if (piece) {
      chunks.push(piece);
    }
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
