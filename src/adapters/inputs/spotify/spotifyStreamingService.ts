import { PassThrough } from 'stream';
import { createLogger } from '@/shared/logging/logger';
import { audioOutputSettings } from '@/ports/types/audioFormat';
import type {
  CreateSessionOpts,
  LibrespotSession,
  ConnectHandle,
  CredentialsResult,
  StreamHandle,
  ConnectEvent,
  LibrespotErrorCode,
} from '@lox-audioserver/node-librespot';

import type { SpotifyResolvedAudio } from './spotifyStreamProxyService';

const log = createLogger('Audio', '@lox-audioserver/node-librespot');
type NativeAddon = typeof import('@lox-audioserver/node-librespot') & {
  loginWithAccessToken: (
    accessToken: string,
    deviceName?: string,
  ) => Promise<CredentialsResult>;
  setLogLevel?: (level: string) => void;
  createSessionWithCredentials?: (
    credentialsJson: string,
    deviceName: string | null,
    cacheDir?: string | null,
    cacheSizeLimitMb?: number | null,
  ) => Promise<LibrespotSession | null>;
  startConnectDeviceWithCredentials?: (...args: unknown[]) => Promise<ConnectHandle>;
  startConnectDeviceWithToken?: (...args: unknown[]) => Promise<ConnectHandle>;
};
type NativeStreamHandle = Pick<StreamHandle, 'stop' | 'sampleRate' | 'channels'>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const addon: NativeAddon = require('@lox-audioserver/node-librespot') as NativeAddon;
// Default to quieter native logging; only warnings/errors by default.
try {
  if (typeof addon.setLogLevel === 'function') {
    addon.setLogLevel('warn');
  }
} catch {
  /* ignore */
}

type NativeLogEvent = { level?: string; message?: string; scope?: string };

const isNoisyDemuxerWarning = (event: NativeLogEvent): boolean => {
  if (!event?.scope?.includes('symphonia_bundle_mp3::demuxer')) {
    return false;
  }
  const message = event?.message ?? '';
  return message.includes('skipping junk') || message.includes('invalid mpeg audio header');
};

const handleNativeLog =
  (source: string) =>
    (event: NativeLogEvent): void => {
      const level = event?.level ?? 'debug';
      const message = event?.message ?? 'native librespot log';
      const meta = { source, scope: event?.scope };
      if (level === 'error') {
        log.error(message, meta);
        return;
      }
      if (level === 'warn') {
        if (isNoisyDemuxerWarning(event)) {
          return;
        }
        log.warn(message, meta);
        return;
      }
      // Drop info/debug to spam to avoid noisy logs by default.
      log.spam(message, meta);
    };

async function getSession(
  opts: CreateSessionOpts & {
    accessToken?: string;
    clientId?: string;
    credentialsJson?: string;
    cacheDir?: string;
    cacheSizeLimitMb?: number;
  },
): Promise<LibrespotSession | null> {
  try {
    const credentialsJson = opts.credentialsJson;
    if (credentialsJson && typeof addon.createSessionWithCredentials === 'function') {
      return await addon.createSessionWithCredentials(
        credentialsJson,
        opts.deviceName ?? null,
        opts.cacheDir ?? null,
        opts.cacheSizeLimitMb ?? null,
      );
    }
    // Intentionally omit clientId unless explicitly needed; overriding can break playback.
    const safeOpts: any = { ...opts };
    delete safeOpts.credentialsJson;
    if (safeOpts.clientId && typeof safeOpts.clientId === 'string') {
      delete safeOpts.clientId;
    }
    return await addon.createSession(safeOpts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('failed to create native librespot session', { message });
    return null;
  }
}

/**
 * Resolve a track's signed CDN URL + AES key via node-librespot WITHOUT
 * downloading audio. The caller (the Spotify stream proxy) fetches and decrypts
 * itself, so playback runs through ffmpeg like the other URL providers instead
 * of a PCM pipe. Returns null when the native module is too old or resolve fails.
 *
 * Prefers the async binding (`resolveAudioFileAsync`, ^0.4.5+), which runs the
 * blocking CDN/key lookup on the libuv threadpool so it never stalls the Node
 * event loop (measured: ~150-500ms main-thread stall on every track start with
 * the sync call). Falls back to the sync `resolveAudioFile` on older modules.
 */
export async function resolveSpotifyAudioFile(
  session: LibrespotSession,
  uri: string,
  bitrate = 320,
): Promise<SpotifyResolvedAudio | null> {
  const native = session as Partial<{
    resolveAudioFileAsync: (opts: { uri: string; bitrate?: number }) => Promise<SpotifyResolvedAudio>;
    resolveAudioFile: (opts: { uri: string; bitrate?: number }) => SpotifyResolvedAudio;
  }>;
  try {
    if (typeof native.resolveAudioFileAsync === 'function') {
      return await native.resolveAudioFileAsync.call(session, { uri, bitrate });
    }
    if (typeof native.resolveAudioFile === 'function') {
      return native.resolveAudioFile.call(session, { uri, bitrate });
    }
    log.warn('node-librespot session lacks resolveAudioFile; update the native module');
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('spotify resolveAudioFile failed', { uri, message });
    return null;
  }
}

export async function createNativeLibrespotSession(params: {
  accessToken?: string | null;
  credentialsJson?: string | null;
  clientId?: string | null;
  deviceName?: string;
  cacheDir?: string | null;
  cacheSizeLimitMb?: number | null;
}): Promise<LibrespotSession | null> {
  const { accessToken, credentialsJson, clientId, deviceName, cacheDir, cacheSizeLimitMb } = params;
  if (!accessToken && !credentialsJson) {
    return null;
  }
  return getSession({
    accessToken: accessToken || undefined,
    clientId: clientId || undefined,
    deviceName,
    credentialsJson: credentialsJson || undefined,
    cacheDir: cacheDir || undefined,
    cacheSizeLimitMb: cacheSizeLimitMb ?? undefined,
  });
}

export type NativeStreamResult = NativeStreamHandle & {
  stream: NodeJS.ReadableStream;
  format: 's16le';
};

/**
 * Use an OAuth access token to obtain a reusable librespot credentials blob.
 */
export async function generateLibrespotCredentialsFromOAuth(params: {
  accessToken: string;
  deviceName?: string;
}): Promise<{ username: string; credentials: string } | null> {
  const { accessToken, deviceName } = params;
  if (!accessToken) {
    return null;
  }
  try {
    const result: CredentialsResult = await addon.loginWithAccessToken(
      accessToken,
      deviceName,
    );
    const credentials = result.credentialsJson;
    if (!credentials) {
      log.warn('native librespot oauth login returned no credentials payload');
      return null;
    }
    return { username: result.username, credentials };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('native librespot oauth login failed', { message });
    return null;
  }
}

export async function getNativeLibrespotStream(params: {
  uri: string;
  accessToken?: string | null;
  credentialsJson?: string | null;
  clientId?: string | null;
  deviceName?: string;
  bitrate?: number;
  startPositionMs?: number;
  onEvent?: (event: ConnectEvent) => void;
  /** Reuse an existing PassThrough to keep the stream reference stable across tracks. */
  reuseStream?: NodeJS.ReadWriteStream | null;
  /** Reuse an existing session to avoid reconnect/handshake overhead. */
  reuseSession?: LibrespotSession | null;
  /** Whether stop() should end the provided stream. Defaults to true for fresh streams. */
  endStreamOnStop?: boolean;
  /** Whether stop() should also close the underlying session (when we created it). Defaults to true. */
  closeSessionOnStop?: boolean;
}): Promise<NativeStreamResult | null> {
  const {
    uri,
    accessToken,
    credentialsJson,
    clientId,
    deviceName,
    bitrate,
    startPositionMs,
    onEvent,
    reuseStream,
    reuseSession,
    endStreamOnStop,
    closeSessionOnStop,
  } = params;
  if (!uri) {
    return null;
  }
  if (!accessToken && !credentialsJson) {
    log.warn('native librespot stream skipped; missing access token and credentials json');
    return null;
  }
  const shouldCloseSession = reuseSession ? false : closeSessionOnStop !== false;
  let session: LibrespotSession | null = reuseSession ?? null;
  if (!session) {
    try {
      session = await getSession({
        accessToken: accessToken || undefined,
        clientId: clientId || undefined,
        deviceName,
        credentialsJson: credentialsJson || undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('native librespot session unavailable', { message });
      return null;
    }
  }
  if (!session) {
    return null;
  }
  try {
    const pass = reuseStream ?? new PassThrough();
    let ended = false;
    let errorEmitted = false;
    let sessionClosed = false;
    const safeWrite = (chunk: Buffer) => {
      const state = pass as { destroyed?: boolean; writableEnded?: boolean };
      if (ended || state.destroyed || state.writableEnded) {
        return;
      }
      pass.write(chunk);
    };
    const emitErrorOnce = (code: LibrespotErrorCode, message: string): void => {
      if (errorEmitted || !onEvent) {
        return;
      }
      errorEmitted = true;
      onEvent({
        type: 'error',
        errorCode: code,
        errorMessage: message,
        uri,
      });
    };
    const handleStreamLog = (event: NativeLogEvent): void => {
      handleNativeLog('stream_track')(event);
      if (event?.level === 'error') {
        const msg = event?.message ?? '';
        if (msg.includes('Unable to read audio file')) {
          emitErrorOnce('audio_key_error', 'audio stream unavailable');
        }
      }
    };
    const handleStreamEvent = (event: ConnectEvent): void => {
      if (!onEvent) {
        return;
      }
      if (event?.type === 'metric') {
        log.debug('librespot metric event', {
          metricName: event.metricName,
          metricValueMs: event.metricValueMs,
          metricMessage: event.metricMessage,
          uri: event.uri ?? uri,
          deviceId: event.deviceId,
          sessionId: event.sessionId,
        });
        onEvent(event);
        return;
      }
      if (event?.type === 'error') {
        if (errorEmitted) {
          return;
        }
        const code = event?.errorCode ?? 'unknown';
        const message = event?.errorMessage ?? 'playback failed';
        emitErrorOnce(code, message);
        return;
      }
      onEvent(event);
    };
    const handle = session.streamTrack(
      {
        uri,
        startPositionMs,
        bitrate,
        emitEvents: Boolean(onEvent),
      },
      (chunk: Buffer) => {
        safeWrite(chunk);
      },
      handleStreamEvent,
      handleStreamLog,
    );
    const stop = () => {
      ended = true;
      try {
        handle.stop();
      } catch {
        /* ignore */
      }
      if (endStreamOnStop !== false) {
        try {
          pass.end();
        } catch {
          /* ignore */
        }
      }
      if (shouldCloseSession && !sessionClosed) {
        sessionClosed = true;
        // Intentionally fire-and-forget; the stop() surface is sync.
        session
          .close()
          .catch(() => {
            /* ignore */
          });
      }
    };
    return {
      stream: pass,
      format: 's16le',
      sampleRate: handle.sampleRate || audioOutputSettings.sampleRate,
      channels: handle.channels || 2,
      stop,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('native librespot stream failed', { uri, message });
    return null;
  }
}

/**
 * Start a native connect host; returns PCM stream + handle. Experimental.
 */
export async function startNativeConnectHost(params: {
  credentialsPath: string;
  deviceName: string;
  publishName: string;
  onEvent?: (event: ConnectEvent) => void;
  accessToken?: string | null;
  clientId?: string | null;
}): Promise<{
  stream: NodeJS.ReadableStream;
  sampleRate: number;
  channels: number;
  stop: () => void;
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
} | null> {
  const { credentialsPath, deviceName, publishName, onEvent, accessToken, clientId } = params;
  const hasCredentialsPayload = Boolean(credentialsPath && credentialsPath.trim());
  const canUseToken = Boolean(accessToken && accessToken.trim());
  if (!hasCredentialsPayload && !canUseToken) {
    log.warn('native connect skipped; missing credentials payload and access token', {
      hasCredentialsPayload,
      hasAccessToken: Boolean(accessToken),
      hasClientId: Boolean(clientId),
    });
    return null;
  }
  const pass = new PassThrough();
  let ended = false;
  const safeWrite = (chunk: Buffer) => {
    if (ended || pass.destroyed || pass.writableEnded) {
      return;
    }
    pass.write(chunk);
  };
  try {
    const onEvt = (event: ConnectEvent) => {
      if (event?.type === 'error') {
        log.warn('connect host error event', {
          deviceName,
          publishName,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
        });
      }
      onEvent?.(event);
    };

    // Prefer direct credentials when available; avoids relying on token->credential exchange.
    const handle: ConnectHandle =
      hasCredentialsPayload && typeof addon.startConnectDeviceWithCredentials === 'function'
        ? await addon.startConnectDeviceWithCredentials(
            credentialsPath,
            publishName,
            deviceName,
            (chunk: Buffer) => safeWrite(chunk),
            onEvt,
            handleNativeLog('connect_host'),
          )
        : await addon.startConnectDeviceWithToken!(
            accessToken,
            clientId,
            publishName,
            deviceName,
            (chunk: Buffer) => safeWrite(chunk),
            onEvt,
            handleNativeLog('connect_host'),
          );

    const stop = () => {
      ended = true;
      try {
        pass.end();
      } catch {
        /* ignore */
      }
      try {
        handle.stop();
      } catch {
        log.warn('connect host stop failed', { deviceName, publishName });
      }
    };
    return {
      stream: pass,
      sampleRate: handle.sampleRate || audioOutputSettings.sampleRate,
      channels: handle.channels || 2,
      stop,
      play: handle.play,
      pause: handle.pause,
      next: handle.next,
      prev: handle.prev,
    };
  } catch (error) {
    if ((error as Error | undefined)?.message === 'missing_credentials_payload') {
      log.warn('native connect skipped; missing credentials payload', { credentialsPath });
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    log.warn('native connect host failed', {
      deviceName,
      publishName,
      message,
    });
    return null;
  }
}
