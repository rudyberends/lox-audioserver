import type { AlertMediaResource } from '@/application/alerts/types';
import type { TtsProvider } from '@/application/alerts/ttsProvider';
import { storeTtsClip } from '@/application/alerts/ttsClipStore';
import { createLogger } from '@/shared/logging/logger';

// translate.google.com/translate_tts rejects requests whose `q` exceeds ~200
// characters with HTTP 400. Longer text must be split into segments that are
// each fetched separately and concatenated, mirroring how the official server
// handles up to ~400 characters.
const MAX_TTS_CHUNK_CHARS = 200;

export class GoogleTtsProvider implements TtsProvider {
  private readonly log = createLogger('Alerts', 'GoogleTts');

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

    try {
      return await storeTtsClip({
        prefix: 'tts',
        extension: 'mp3',
        cacheKey: [lang, normalizedText],
        text: normalizedText,
        produce: () => this.fetchSpeech(normalizedText, lang),
      });
    } catch (err) {
      this.log.error('failed to generate TTS clip', {
        message: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async fetchSpeech(text: string, lang: string): Promise<Buffer> {
    const chunks = splitTextIntoChunks(text, MAX_TTS_CHUNK_CHARS);
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
    this.log.info('generated TTS clip', { lang, bytes: buffer.length, chunks: chunks.length });
    return buffer;
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
