import type { AlertMediaResource } from '@/application/alerts/types';
import type { TtsProvider } from '@/application/alerts/ttsProvider';
import { storeTtsClip } from '@/application/alerts/ttsClipStore';
import type { OpenAiTtsProviderConfig } from '@/domain/config/types';
import { createLogger } from '@/shared/logging/logger';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'tts-1';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_FORMAT = 'mp3';
const DEFAULT_TIMEOUT_MS = 30_000;

/** The schema's documented ceiling on `input`; longer text is refused outright. */
const MAX_INPUT_CHARS = 4096;

/**
 * Speaks to any server implementing OpenAI's `POST /v1/audio/speech`: OpenAI
 * itself, a router like OpenRouter or LiteLLM, or a local engine such as
 * Kokoro-FastAPI, AllTalk or openai-edge-tts. One request, audio in the body.
 */
export class OpenAiTtsProvider implements TtsProvider {
  private readonly log = createLogger('Alerts', 'OpenAiTts');

  constructor(private readonly config: OpenAiTtsProviderConfig) {}

  public async generate(text: string, language?: string): Promise<AlertMediaResource | undefined> {
    const normalizedText = (text ?? '').trim();
    if (!normalizedText) {
      this.log.warn('missing text for TTS generation');
      return undefined;
    }
    if (this.config.enabled === false) {
      this.log.warn('OpenAI TTS provider is disabled');
      return undefined;
    }

    const spoken = clampSpeechInput(normalizedText);
    if (spoken.length !== normalizedText.length) {
      this.log.warn('announcement exceeds the speech API limit and was shortened', {
        limit: MAX_INPUT_CHARS,
        given: normalizedText.length,
        spoken: spoken.length,
      });
    }

    const request = buildSpeechRequest(this.config, spoken, language);
    try {
      return await storeTtsClip({
        prefix: 'tts-openai',
        // Playback resolves the clip to a file path and lets ffmpeg detect the
        // format from its content, so the extension only has to be recognisable.
        extension: request.body.response_format,
        cacheKey: speechCacheKey(request, language),
        text: spoken,
        produce: async () => {
          const buffer = await this.fetchSpeech(request);
          this.log.info('generated TTS clip', {
            model: request.body.model,
            voice: request.body.voice,
            format: request.body.response_format,
            bytes: buffer.length,
          });
          return buffer;
        },
      });
    } catch (err) {
      this.log.error('failed to generate TTS clip', {
        endpoint: request.url,
        message: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async fetchSpeech(request: SpeechRequest): Promise<Buffer> {
    const res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(resolveTimeoutMs(this.config.timeoutMs)),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}${await describeErrorBody(res)}`);
    }
    // A server that fails after committing to 200 tends to answer JSON on an
    // endpoint that promises audio; without this the bytes land in the cache and
    // every later play silently resolves the same broken file.
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !contentType.includes('audio') && !contentType.includes('octet-stream')) {
      throw new Error(`expected audio, got ${contentType}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) {
      throw new Error('empty audio response');
    }
    return buffer;
  }
}

export interface SpeechRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    input: string;
    voice: string;
    response_format: string;
    speed?: number;
    instructions?: string;
  };
}

/**
 * Build the request without performing it, so the shape stays checkable on its own.
 */
export function buildSpeechRequest(
  config: OpenAiTtsProviderConfig,
  text: string,
  language?: string,
): SpeechRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'audio/*',
  };
  const apiKey = config.apiKey?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const speed = typeof config.speed === 'number' && Number.isFinite(config.speed) ? config.speed : undefined;
  const instructions = config.instructions?.trim();
  return {
    url: resolveSpeechEndpoint(config.baseUrl),
    headers,
    body: {
      model: config.model?.trim() || DEFAULT_MODEL,
      input: text,
      voice: resolveVoice(config, language),
      response_format: config.format?.trim() || DEFAULT_FORMAT,
      ...(speed !== undefined ? { speed } : {}),
      ...(instructions ? { instructions } : {}),
    },
  };
}

/**
 * Keep `input` inside the documented 4096-character ceiling, cutting at a word
 * boundary so the announcement ends on a whole word rather than mid-syllable.
 *
 * Shortening beats the alternative: over the limit the backend answers 400 and
 * the zone stays silent, which is a worse answer to "say this" than saying most
 * of it. Google's provider splits instead, but that only works because raw mp3
 * frames concatenate — a flac or wav backend would end up with headers stranded
 * in the middle of the file.
 */
export function clampSpeechInput(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) {
    return text;
  }
  const window = text.slice(0, MAX_INPUT_CHARS);
  const wordBreak = window.lastIndexOf(' ');
  return (wordBreak > 0 ? window.slice(0, wordBreak) : window).trimEnd();
}

/**
 * The endpoint is the one thing users type by hand, and every backend documents
 * it slightly differently. Accept the three forms that actually appear:
 * a bare origin, a base ending in `/v1`, or the full speech URL.
 */
export function resolveSpeechEndpoint(baseUrl?: string): string {
  const raw = baseUrl?.trim() || DEFAULT_BASE_URL;
  const withoutTrailingSlash = raw.replace(/\/+$/, '');
  if (/\/audio\/speech$/i.test(withoutTrailingSlash)) {
    return withoutTrailingSlash;
  }
  try {
    // A bare origin means the caller never named an API version, so assume the
    // one every implementation of this schema serves.
    const hasPath = new URL(withoutTrailingSlash).pathname.replace(/\/+$/, '') !== '';
    return `${withoutTrailingSlash}${hasPath ? '' : '/v1'}/audio/speech`;
  } catch {
    return `${withoutTrailingSlash}/audio/speech`;
  }
}

/**
 * `/v1/audio/speech` has no language parameter — the voice carries it. Servers
 * that ship per-language voices can be given a mapping; otherwise the single
 * configured voice speaks whatever it is handed.
 */
function resolveVoice(config: OpenAiTtsProviderConfig, language?: string): string {
  const code = language?.trim().toLowerCase();
  if (code) {
    const byLanguage = config.voiceByLanguage ?? {};
    const match = byLanguage[code] ?? byLanguage[code.slice(0, 2)];
    if (match?.trim()) {
      return match.trim();
    }
  }
  return config.voice?.trim() || DEFAULT_VOICE;
}

/**
 * The language is part of the key even when it did not select a voice: it is
 * what the caller asked for, and a later voice mapping must not replay clips
 * rendered before it existed.
 */
function speechCacheKey(request: SpeechRequest, language?: string): string[] {
  return [
    request.url,
    request.body.model,
    request.body.voice,
    request.body.response_format,
    String(request.body.speed ?? ''),
    request.body.instructions ?? '',
    language ?? '',
    request.body.input,
  ];
}

function resolveTimeoutMs(timeoutMs?: number): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.round(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
}

async function describeErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.text()).trim();
    if (!body) {
      return '';
    }
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const message = parsed.error?.message ?? parsed.message;
    return message ? ` — ${message}` : ` — ${body.slice(0, 200)}`;
  } catch {
    return '';
  }
}
