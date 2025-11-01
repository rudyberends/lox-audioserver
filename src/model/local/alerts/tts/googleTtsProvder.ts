import * as googleTTS from 'google-tts-api';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import logger from '@/utils/troxorLogger';
import { configManager } from '@/runtime/config/configManager';
import type { AlertMediaResource } from '../types';

/**
 * -----------------------------------------------------------------------------
 * GoogleTtsProvider
 * -----------------------------------------------------------------------------
 * Generates spoken audio files using Google Translate Text-to-Speech (TTS).
 *
 * Responsibilities:
 *  • Convert text into speech using the google-tts-api package (v2.x)
 *  • Cache generated files to avoid redundant TTS requests
 *  • Return normalized metadata (including URL) for use in alert playback
 *
 * Files are stored under `/public/alerts/cache` and served through `/alerts/cache/...`.
 * -----------------------------------------------------------------------------
 */
export class GoogleTtsProvider {
  /** Directory used to store generated and cached TTS audio files. */
  private readonly cacheDir = path.resolve(__dirname, '../../../../../public/alerts/cache');

  /**
   * Generates or retrieves a TTS audio resource for the given text and language.
   *
   * @param text - The text to synthesize into speech.
   * @param language - Optional language code (e.g., "en", "nl", "de").
   * @returns The generated or cached AlertMediaResource, or undefined on failure.
   */
  public async generate(text: string, language?: string): Promise<AlertMediaResource | undefined> {
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

      // Reuse cached file if it already exists
      try {
        await fs.access(abs);
        logger.debug(`[GoogleTtsProvider] Using cached TTS: ${fileName}`);
        return this.buildResource(abs, fileName, text, lang);
      } catch {
        // Not cached — continue to generate
      }

      // Request audio generation from Google
      const url = googleTTS.getAudioUrl(text, {
        lang,
        slow: false,
        host: 'https://translate.google.com',
      });

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(abs, buffer);
      logger.info(`[GoogleTtsProvider] Generated new TTS (${lang}) → ${fileName}`);

      return this.buildResource(abs, fileName, text, lang);
    } catch (err) {
      logger.error(`[GoogleTtsProvider] Failed to generate TTS audio: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Normalizes various language codes and aliases (e.g., "nld" → "nl").
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
   * Builds a normalized media resource description for the generated TTS file.
   * Includes a fully qualified HTTP URL ready for playback.
   */
  private buildResource(abs: string, fileName: string, text: string, lang: string): AlertMediaResource {
    const host = configManager.getAudioServerConfig()?.ip ?? '127.0.0.1';
    const relativePath = `cache/${fileName}`;

    // Encode each segment separately to preserve `/` structure
    const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
    const url = `http://${host}:7090/alerts/${encodedPath}`;

    return {
      source: 'tts',
      title: text.length > 48 ? `${text.slice(0, 45)}…` : text,
      absolutePath: abs,
      relativePath,
      url,
      text,
      language: lang,
    };
  }
}