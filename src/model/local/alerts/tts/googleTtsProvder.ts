import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import logger from '@/utils/troxorLogger';
import { configManager } from '@/runtime/config/configManager';
import type { AlertMediaResource } from '../types';

/**
 * -----------------------------------------------------------------------------
 * GoogleTtsProvider (no external library)
 * -----------------------------------------------------------------------------
 * Generates spoken audio files using Google Translate Text-to-Speech (TTS)
 * -----------------------------------------------------------------------------
 */
export class GoogleTtsProvider {
  /** Directory used to store generated and cached TTS audio files. */
  private readonly cacheDir = path.resolve(__dirname, '../../../../../public/alerts/cache');

  /**
   * Generates or retrieves a TTS audio resource for the given text and language.
   */
  public async generate(
    text: string,
    language?: string,
  ): Promise<AlertMediaResource | undefined> {
    const lang = this.normalizeLang(language);
    if (!lang) {
      logger.warn('[GoogleTtsProvider] No valid language provided, defaulting to "en"');
      return undefined;
    }

    const digest = createHash('sha1').update(`${lang}|${text}`).digest('hex');
    const fileName = `tts-${digest}.mp3`;
    const abs = path.join(this.cacheDir, fileName);

    try {
      await fs.mkdir(this.cacheDir, { recursive: true });

      // Use cached version if available
      try {
        await fs.access(abs);
        logger.debug(`[GoogleTtsProvider] Using cached TTS: ${fileName}`);
        return this.buildResource(abs, fileName, text);
      } catch { /* empty */ }

      // Build Google Translate TTS URL
      const url = this.buildGoogleTtsUrl(text, lang);

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(abs, buffer);
      logger.info(`[GoogleTtsProvider] Generated new TTS (${lang}) → ${fileName}`);

      return this.buildResource(abs, fileName, text);
    } catch (err) {
      logger.error(`[GoogleTtsProvider] Failed to generate TTS audio: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Constructs a Google Translate TTS URL.
   */
  private buildGoogleTtsUrl(text: string, lang: string): string {
    const url = new URL('https://translate.google.com/translate_tts');
    url.searchParams.set('ie', 'UTF-8');
    url.searchParams.set('q', text);
    url.searchParams.set('tl', lang);
    url.searchParams.set('client', 'tw-ob');
    url.searchParams.set('ttsspeed', '1');
    url.searchParams.set('total', String(text.length));
    url.searchParams.set('idx', '0');

    return url.toString();
  }

  /**
   * Normalizes language codes.
   */
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

  /**
   * Builds metadata for the generated file.
   */
  private buildResource(abs: string, fileName: string, text: string): AlertMediaResource {
    const host = configManager.getAudioServerConfig()?.ip ?? '127.0.0.1';
    const relativePath = `cache/${fileName}`;

    const encodedPath = relativePath
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    const url = `http://${host}:7090/alerts/${encodedPath}`;

    return {
      title: text.length > 48 ? `${text.slice(0, 45)}…` : text,
      relativePath,
      url,
    };
  }
}