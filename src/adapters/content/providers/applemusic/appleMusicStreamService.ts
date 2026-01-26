import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyBridgeConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/application/playback/audioManager';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import Widevine, { LicenseType as WvLicenseType } from 'widevine';
import { loadWidevineArtifacts } from './widevine';
import protobuf from 'protobufjs';
import { gunzipSync } from 'zlib';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

const APPLE_MUSIC_API_BASE = 'https://amp-api.music.apple.com/v1';
const WEBPLAYBACK_URL = 'https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback';
const WVN_LICENSE_URL = 'https://play.music.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense';

const BEARER_TOKEN_TTL_MS = 30 * 60 * 1000;

type AppleMusicPlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
};

type AppleMusicTrackRequest = {
  providerId: string;
  trackId: string;
  isLibrary: boolean;
  bridge: SpotifyBridgeConfig;
};

type BearerState = {
  token?: string;
  fetchedAt: number;
  inFlight?: Promise<string | null>;
};

type StorefrontState = {
  value: string;
  inFlight?: Promise<string>;
};

type AppleMusicProxySession = {
  id: string;
  streamUrl: string;
  headers?: Record<string, string>;
  keyBytes?: Buffer;
  createdAt: number;
  playlist?: string;
  playlistBaseUrl?: string;
  initUrl?: string;
  segmentUrls?: string[];
};

type AppleMusicDrmStreamInfo = {
  fileUrl: string;
  keyUri?: string;
};

type AppleMusicDrmKeyCacheEntry = {
  key?: string;
  expiresAt: number;
  inFlight?: Promise<string | null>;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

const WIDEVINE_KEYFORMAT_UUID = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const DRM_KEY_TTL_MS = 60 * 60 * 1000;

const WIDEVINE_PSSH_PROTO = `
syntax = "proto2";

message WidevinePsshData {
  optional uint32 algorithm = 1;
  repeated bytes key_ids = 2;
}
`;

const WidevinePsshDataMsg = (() => {
  const parsed = protobuf.parse(WIDEVINE_PSSH_PROTO);
  return parsed.root.lookupType('WidevinePsshData');
})();

export class AppleMusicStreamService {
  private readonly log = createLogger('Content', 'AppleMusicStream');
  private readonly bridgesByProvider = new Map<string, SpotifyBridgeConfig>();
  private readonly bridgesById = new Map<string, SpotifyBridgeConfig>();
  private readonly bearerTokens = new Map<string, BearerState>();
  private readonly storefronts = new Map<string, StorefrontState>();
  private readonly proxySessions = new Map<string, AppleMusicProxySession>();
  private readonly drmKeyCache = new Map<string, AppleMusicDrmKeyCacheEntry>();
  private proxyServer?: ReturnType<typeof createServer>;
  private proxyPort?: number;
  private readonly proxyHost = '127.0.0.1';
  private readonly configPort: ConfigPort;

  constructor(private readonly notifyOutputError: OutputErrorHandler, configPort: ConfigPort) {
    this.configPort = configPort;
  }

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    const bridges = this.configPort.getConfig().content?.spotify?.bridges ?? [];
    for (const bridge of bridges) {
      const provider = (bridge.provider || '').toLowerCase();
      if (provider !== 'applemusic') continue;
      const providerId = `spotify@${bridge.id}`;
      this.bridgesByProvider.set(providerId, bridge);
      this.bridgesById.set(bridge.id, bridge);
    }
  }

  public isAppleMusicProvider(providerId: string): boolean {
    if (!providerId) return false;
    if (this.bridgesByProvider.has(providerId)) return true;
    const id = providerId.split('@')[1] ?? providerId;
    if (this.bridgesById.has(id)) return true;
    return providerId.toLowerCase().includes('applemusic');
  }

  public async startStreamForAudiopath(
    zoneId: number,
    _zoneName: string,
    audiopath: string,
  ): Promise<AppleMusicPlaybackResult> {
    const request = this.parseTrackRequest(audiopath);
    if (!request) {
      this.log.warn('apple music stream request unresolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'apple music invalid request');
      return { playbackSource: null };
    }

    const headers = await this.buildAuthHeaders(request.bridge);
    if (!headers.authorization) {
      this.log.warn('apple music stream missing bearer token', { zoneId, providerId: request.providerId });
    }

    let webPlayback = await this.fetchWebPlayback(headers, request.trackId, request.isLibrary);
    let streamUrl = this.extractStreamUrl(webPlayback);
    let drmTrackId = request.trackId;
    let drmIsLibrary = request.isLibrary;
    let failureReason = '';

    if (request.isLibrary) {
      const catalogId = await this.fetchCatalogIdForLibraryTrack(headers, request.trackId);
      if (catalogId) {
        const catalogPlayback = await this.fetchWebPlayback(headers, catalogId, false);
        const catalogUrl = this.extractStreamUrl(catalogPlayback);
        if (catalogPlayback && catalogUrl) {
          this.log.info('apple music library using catalog playback for drm', {
            zoneId,
            trackId: request.trackId,
            catalogId,
          });
          webPlayback = catalogPlayback;
          streamUrl = catalogUrl;
          drmTrackId = catalogId;
          drmIsLibrary = false;
        }
      } else {
        failureReason = 'apple music library catalog unresolved';
      }
    }

    if (!streamUrl && request.isLibrary) {
      const catalogId = await this.fetchCatalogIdForLibraryTrack(headers, request.trackId);
      if (catalogId) {
        this.log.info('apple music library fallback to catalog id', {
          zoneId,
          trackId: request.trackId,
          catalogId,
        });
        webPlayback = await this.fetchWebPlayback(headers, catalogId, false);
        streamUrl = this.extractStreamUrl(webPlayback);
        if (streamUrl) {
          drmTrackId = catalogId;
          drmIsLibrary = false;
        }
      } else if (!failureReason) {
        failureReason = 'apple music library catalog unresolved';
      }
    }

    if (!streamUrl) {
      const webPlaybackError = webPlayback?.__error as
        | { failureType?: string; customerMessage?: string; keys?: string[] }
        | undefined;
      if (!failureReason && webPlaybackError) {
        const details = [
          webPlaybackError.failureType,
          webPlaybackError.customerMessage,
        ].filter(Boolean);
        failureReason = details.length
          ? `apple music webPlayback missing songList (${details.join(' | ')})`
          : 'apple music webPlayback missing songList';
      }
      this.log.warn('apple music stream url unavailable', {
        zoneId,
        trackId: request.trackId,
        failureType: webPlaybackError?.failureType,
      });
      this.reportPlaybackError(zoneId, failureReason || 'apple music stream url unavailable');
      return { playbackSource: null };
    }

    const requiresDrm = await this.detectDrm(streamUrl, headers);
    if (!requiresDrm) {
      return { playbackSource: await this.buildStreamPlaybackSource(streamUrl, headers, request.bridge) };
    }

    const drmHandled = await this.tryPrepareDrmStream(
      headers,
      streamUrl,
      drmTrackId,
      drmIsLibrary,
      request.bridge,
      webPlayback,
    );
    if (drmHandled?.playbackSource) return drmHandled;

    this.log.warn('apple music stream blocked; drm not available', { zoneId, trackId: request.trackId });
    this.reportPlaybackError(zoneId, 'apple music drm unavailable');
    return { playbackSource: null };
  }

  private reportPlaybackError(zoneId: number, reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) return;
    this.notifyOutputError(zoneId, trimmed);
  }

  private parseTrackRequest(audiopath: string): AppleMusicTrackRequest | null {
    const raw = String(audiopath || '');
    const parts = raw.split(':');
    if (parts.length < 3) return null;
    const providerId = parts[0] ?? '';
    const type = (parts[1] ?? '').toLowerCase();
    const rawId = parts.slice(2).join(':').trim();
    const decodedId = decodeAudiopath(rawId);
    const trackId = decodedId || rawId;
    if (!providerId || !trackId) return null;
    const looksLikeLibraryId = /^[il]\./i.test(trackId);
    const isLibrary = type.startsWith('library-') || looksLikeLibraryId;
    const normalized = type.replace(/^library-/, '');
    if (normalized !== 'track') return null;

    const bridge =
      this.bridgesByProvider.get(providerId) ??
      this.bridgesById.get(providerId.split('@')[1] ?? '') ??
      null;
    if (!bridge) return null;

    return { providerId, trackId, isLibrary, bridge };
  }

  private async fetchWebPlayback(
    headers: Record<string, string>,
    trackId: string,
    isLibrary: boolean,
  ): Promise<any | null> {
    try {
      const normalizedTrackId = isLibrary ? trackId : this.normalizeSalableAdamId(trackId);
      const payload: Record<string, any> = {
        'user-initiated': true,
      };
      if (isLibrary) {
        payload.universalLibraryId = trackId;
        payload.isLibrary = true;
      } else {
        payload.salableAdamId = normalizedTrackId;
      }

      const res = await fetch(WEBPLAYBACK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await safeReadText(res, '', {
          onError: 'debug',
          log: this.log,
          label: 'apple music web playback read failed',
          context: { status: res.status },
        });
        this.log.warn('apple music webPlayback failed', {
          status: res.status,
          body: body ? body.slice(0, 200) : undefined,
        });
        return null;
      }

      const data = (await res.json()) as any;
      const song = data?.songList?.[0];
      if (!song) {
        const keys = data && typeof data === 'object' ? Object.keys(data) : undefined;
        const failureType = data?.failureType ?? data?.['failureType'];
        const customerMessage = data?.customerMessage ?? data?.['customerMessage'];
        this.log.warn('apple music webPlayback missing songList', {
          keys,
          failureType,
          customerMessage,
        });
        return {
          __error: {
            failureType: typeof failureType === 'string' ? failureType : undefined,
            customerMessage: typeof customerMessage === 'string' ? customerMessage : undefined,
            keys,
          },
        };
      }
      if (song && data?.['hls-key-server-url'] && !song['hls-key-server-url']) {
        song['hls-key-server-url'] = data['hls-key-server-url'];
      }
      return song ?? null;
    } catch (err) {
      this.log.warn('apple music webPlayback error', { message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private normalizeSalableAdamId(trackId: string): string {
    const trimmed = trackId.trim();
    const match = trimmed.match(/^[a-z]\.(\d+)$/i);
    if (match) {
      return match[1];
    }
    return trimmed;
  }

  private extractStreamUrl(info: any): string | null {
    const candidates: Array<string | undefined> = [
      info?.hlsUrl,
      info?.hlsURL,
      info?.streamUrl,
      info?.streamURL,
      info?.url,
      info?.assetUrl,
      info?.assets?.[0]?.url,
      info?.assets?.[0]?.URL,
      info?.assets?.find((asset: any) => typeof asset?.url === 'string')?.url,
      info?.streams?.hls?.url,
      info?.streams?.hls?.[0]?.url,
    ];
    const match = candidates.find((value) => typeof value === 'string' && value.length > 0);
    return match ?? null;
  }

  private async detectDrm(streamUrl: string, headers: Record<string, string>): Promise<boolean> {
    const playlist = await this.fetchText(streamUrl, headers);
    if (!playlist) return false;
    return /#EXT-X-KEY/i.test(playlist);
  }

  private async tryPrepareDrmStream(
    headers: Record<string, string>,
    streamUrl: string,
    trackId: string,
    isLibrary: boolean,
    bridge: SpotifyBridgeConfig,
    webPlayback?: any,
  ): Promise<AppleMusicPlaybackResult | null> {
    const drmStreamInfo = await this.resolveCtrp256StreamInfo(webPlayback, headers);
    const playbackUrl = drmStreamInfo?.fileUrl ?? streamUrl;
    let playlist = await this.fetchText(streamUrl, headers);
    if (!playlist) {
      this.log.warn('apple music drm check failed; playlist unavailable');
      return null;
    }

    const variantUrl = this.findVariantPlaylistUrl(playlist, streamUrl);
    if (variantUrl) {
      this.log.debug('Apple Music DRM: resolved variant playlist', { variantUrl });
    }
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, headers);
      if (variantPlaylist) {
        playlist = variantPlaylist;
      } else {
        this.log.warn('Apple Music DRM: failed to fetch variant playlist', { variantUrl });
      }
    }

    const keyInfo = this.extractKeyInfo(playlist);
    let keyUri = keyInfo?.uri ?? null;

    if (keyUri && !this.extractPsshFromKeyUri(keyUri)) {
      this.log.debug('Apple Music DRM: key URI missing PSSH; searching fallback', {
        keyUri,
        keyLine: keyInfo?.line,
      });
      const fallbackUri = this.findPsshKeyUri(playlist);
      if (fallbackUri) keyUri = fallbackUri;
    }

    if (!keyUri || !this.extractPsshFromKeyUri(keyUri)) {
      const assetKey = await this.findKeyUriFromAssets(webPlayback, headers);
      if (assetKey) keyUri = assetKey;
    }
    if (!keyUri && drmStreamInfo?.keyUri) {
      keyUri = drmStreamInfo.keyUri;
    }

    if (!keyUri) {
      return { playbackSource: await this.buildStreamPlaybackSource(playbackUrl, headers, bridge) };
    }

    const licenseUrl = this.normalizeLicenseUrl(webPlayback?.['hls-key-server-url']);
    if (!licenseUrl) {
      this.log.warn('Apple Music DRM: missing license URL in playback metadata', { trackId, isLibrary });
      return null;
    }
    const drmKey = await this.fetchDrmKey(
      headers,
      licenseUrl,
      keyUri,
      keyInfo?.format,
      trackId,
      isLibrary,
    );
    if (!drmKey) return null;

    this.log.info('DRM key ready, streaming with decryption', { keyPreview: `${drmKey.slice(0, 16)}...` });
    return { playbackSource: await this.buildStreamPlaybackSource(playbackUrl, headers, bridge, drmKey) };
  }

  private extractKeyInfo(playlist: string): { uri: string; line: string; format?: string } | null {
    const lines = playlist.split(/\r?\n/);
    const entries: Array<{ uri: string; line: string; format?: string }> = [];
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-KEY')) continue;
      const uri = this.readM3u8Attribute(line, 'URI');
      if (!uri) continue;
      const format = this.readM3u8Attribute(line, 'KEYFORMAT');
      entries.push({ uri, line, format });
    }
    if (!entries.length) return null;
    const widevine = entries.find((entry) => this.isWidevineKeyformat(entry.format));
    if (widevine) return widevine;
    const base64 = entries.find((entry) => entry.uri.toLowerCase().includes('base64,'));
    return base64 ?? entries[0] ?? null;
  }

  private async fetchDrmKey(
    headers: Record<string, string>,
    licenseUrl: string,
    keyUri: string,
    _keyFormat: string | undefined,
    trackId: string,
    isLibrary: boolean,
  ): Promise<string | null> {
    const cacheKey = this.buildDrmCacheKey(trackId, isLibrary);
    const now = Date.now();
    const cached = this.drmKeyCache.get(cacheKey);
    if (cached?.key && cached.expiresAt > now) {
      this.log.debug('Apple Music DRM: using cached key', {
        trackId,
        isLibrary,
        expiresInMs: cached.expiresAt - now,
      });
      return cached.key;
    }
    if (cached?.expiresAt && cached.expiresAt <= now && !cached.inFlight) {
      this.drmKeyCache.delete(cacheKey);
    }
    if (cached?.inFlight) {
      const key = await cached.inFlight;
      if (key) {
        return key;
      }
    }
    const inFlight = this.fetchDrmKeyUncached(headers, licenseUrl, keyUri, _keyFormat, trackId, isLibrary);
    this.drmKeyCache.set(cacheKey, {
      key: cached?.key,
      expiresAt: cached?.expiresAt ?? 0,
      inFlight,
    });
    const keyHex = await inFlight;
    const entry = this.drmKeyCache.get(cacheKey);
    if (entry?.inFlight === inFlight) {
      if (keyHex) {
        this.drmKeyCache.set(cacheKey, {
          key: keyHex,
          expiresAt: Date.now() + DRM_KEY_TTL_MS,
        });
      } else {
        this.drmKeyCache.delete(cacheKey);
      }
    }
    return keyHex;
  }

  private async fetchDrmKeyUncached(
    headers: Record<string, string>,
    licenseUrl: string,
    keyUri: string,
    _keyFormat: string | undefined,
    trackId: string,
    isLibrary: boolean,
  ): Promise<string | null> {
    try {
      this.log.info('Apple Music DRM: starting key extraction (new format)', { trackId, isLibrary, keyUri });

      const pssh = this.extractPsshFromKeyUri(keyUri);
      if (!pssh) {
        this.log.warn('Apple Music DRM: unsupported key URI; missing PSSH data', { keyUri });
        return null;
      }
      const expectedKid = this.extractKidFromKeyUri(keyUri, pssh);
      const expectedKidHex = expectedKid ? expectedKid.toString('hex') : null;

      let device: ReturnType<typeof Widevine.init>;
      let artifacts: { privateKey: Buffer; clientIdBlob: Buffer };
      try {
        artifacts = await loadWidevineArtifacts();
      } catch (err) {
        this.log.error('Apple Music DRM: Widevine artifacts unavailable', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }

      try {
        device = Widevine.init(artifacts.clientIdBlob, artifacts.privateKey);
      } catch (err) {
        this.log.error('Apple Music DRM: Widevine init failed', {
          error: err instanceof Error ? err.message : String(err),
          usingWvd: false,
        });
        return null;
      }

      let session: ReturnType<typeof device.createSession>;
      try {
        session = device.createSession(pssh, WvLicenseType.STREAMING);
      } catch (err) {
        this.log.error('Apple Music DRM: Widevine session creation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }

      let challenge: Buffer;
      try {
        challenge = session.generateChallenge();
      } catch (err) {
        this.log.error('Apple Music DRM: Widevine challenge generation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }

      const payload = {
        challenge: Buffer.from(challenge).toString('base64'),
        'key-system': 'com.widevine.alpha',
        uri: keyUri,
        adamId: trackId,
        isLibrary,
        'user-initiated': true,
      };

      this.log.debug('Apple Music DRM: requesting license', { licenseUrl });
      const licenseHeaders = this.buildLicenseHeaders(headers);
      const licenseRes = await fetch(licenseUrl, {
        method: 'POST',
        headers: licenseHeaders,
        body: JSON.stringify(payload),
      });

      if (!licenseRes.ok) {
        const text = await safeReadText(licenseRes, '', {
          onError: 'debug',
          log: this.log,
          label: 'apple music license read failed',
          context: { status: licenseRes.status },
        });
        this.log.warn('License request failed', { status: licenseRes.status, body: text.slice(0, 300) });
        return null;
      }

      const licenseJson = (await licenseRes.json()) as { license?: string; failureType?: string; message?: string };
      if (licenseJson.failureType || licenseJson.message) {
        this.log.warn('License response indicates failure', {
          failureType: licenseJson.failureType,
          message: licenseJson.message,
        });
        return null;
      }
      const licenseBase64 = licenseJson.license;
      if (!licenseBase64) {
        this.log.warn('No license in response');
        return null;
      }

      let license = Buffer.from(this.normalizeBase64(licenseBase64), 'base64');
      if (license.length >= 2 && license[0] === 0x1f && license[1] === 0x8b) {
        try {
          license = gunzipSync(license);
          this.log.debug('License response was gzipped', { licenseLength: license.length });
        } catch (err) {
          this.log.warn('Failed to gunzip license response', {
            message: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }
      this.log.debug('License response header', {
        licenseLength: license.length,
        licenseHeaderHex: license.subarray(0, 12).toString('hex'),
      });

      let keys: Array<{ key?: string } | undefined>;
      try {
        keys = session.parseLicense(license);
      } catch (err) {
        this.log.error('DRM license parse failed', {
          error: err instanceof Error ? err.message : String(err),
          licenseHeaderHex: license.subarray(0, 12).toString('hex'),
        });
        return null;
      }

      if (!keys.length) {
        this.log.warn('No keys in license');
        return null;
      }

      this.log.debug('DRM license keys parsed', {
        expectedKid: expectedKidHex ?? undefined,
        availableKids: keys.map((entry: any) => entry?.kid).filter(Boolean),
      });

      const contentKey = expectedKidHex
        ? keys.find((key: any) => key?.key && String(key?.kid || '').toLowerCase() === expectedKidHex)
        : keys.find((key) => key?.key);
      const keyHex = contentKey?.key;
      if (!keyHex) {
        this.log.warn('No content key found', {
          expectedKid: expectedKidHex ?? undefined,
          availableKids: keys.map((entry: any) => entry?.kid).filter(Boolean),
        });
        return null;
      }
      this.log.info('DRM key extracted successfully', { keyPreview: `${keyHex.slice(0, 16)}...` });
      return keyHex;
    } catch (err) {
      this.log.error('DRM key extraction failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private buildDrmCacheKey(trackId: string, isLibrary: boolean): string {
    return `${isLibrary ? 'library' : 'catalog'}:${trackId}`;
  }

  private readM3u8Attribute(line: string, name: string): string | undefined {
    const pattern = new RegExp(`${name}=("(?:[^"\\\\]|\\\\.)*"|[^,]*)`, 'i');
    const match = line.match(pattern);
    if (!match?.[1]) return undefined;
    let value = match[1].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\(.)/g, '$1');
    return value;
  }

  private isWidevineKeyformat(format?: string): boolean {
    if (!format) return false;
    const normalized = format.toLowerCase();
    return normalized.includes('widevine') || normalized.includes(WIDEVINE_KEYFORMAT_UUID);
  }

  private extractPsshFromKeyUri(keyUri: string): Buffer | null {
    const trimmed = keyUri.trim();
    if (/^skd:\/\//i.test(trimmed)) return null;
    const base64Index = trimmed.indexOf('base64,');
    if (base64Index !== -1) {
      const payload = trimmed.slice(base64Index + 'base64,'.length).trim();
      if (!payload) return null;
      return this.coercePssh(Buffer.from(payload, 'base64'));
    }
    if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 16) {
      try {
        return this.coercePssh(Buffer.from(trimmed, 'base64'));
      } catch {
        return null;
      }
    }
    return null;
  }

  private extractKidFromKeyUri(keyUri: string, pssh?: Buffer | null): Buffer | null {
    const trimmed = keyUri.trim();
    if (/^skd:\/\//i.test(trimmed)) return null;
    const base64Index = trimmed.indexOf('base64,');
    const payload = base64Index !== -1 ? trimmed.slice(base64Index + 'base64,'.length).trim() : trimmed;
    if (payload && /^[A-Za-z0-9+/=]+$/.test(payload)) {
      try {
        const decoded = Buffer.from(payload, 'base64');
        if (decoded.length === 16) return decoded;
      } catch {
        // ignore
      }
    }
    if (pssh) {
      return this.extractKidFromPssh(pssh);
    }
    return null;
  }

  private extractKidFromPssh(pssh: Buffer): Buffer | null {
    if (!pssh || pssh.length < 32) return null;
    if (pssh.subarray(4, 8).toString('ascii') !== 'pssh') return null;
    try {
      const decoded = WidevinePsshDataMsg.decode(pssh.subarray(32)) as { keyIds?: Buffer[] };
      const keyId = decoded?.keyIds?.[0];
      return Buffer.isBuffer(keyId) ? keyId : keyId ? Buffer.from(keyId) : null;
    } catch {
      return null;
    }
  }

  private findPsshKeyUri(playlist: string): string | null {
    const match = playlist.match(/URI=(?:"|\\")?(data:[^,]+;base64,[A-Za-z0-9+/=]+)(?:"|\\")?/i);
    return match?.[1] ?? null;
  }

  private findVariantPlaylistUrl(playlist: string, baseUrl: string): string | null {
    if (!/#EXT-X-STREAM-INF/i.test(playlist)) return null;
    const lines = playlist.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || !line.startsWith('#EXT-X-STREAM-INF')) continue;
      for (let j = i + 1; j < lines.length; j += 1) {
        const uri = lines[j]?.trim();
        if (!uri || uri.startsWith('#')) continue;
        try {
          return new URL(uri, baseUrl).toString();
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private normalizeBase64(value: string): string {
    const trimmed = value.trim().replace(/-/g, '+').replace(/_/g, '/');
    const pad = trimmed.length % 4;
    if (pad === 0) return trimmed;
    return trimmed + '='.repeat(4 - pad);
  }

  private coercePssh(data: Buffer): Buffer | null {
    if (data.length >= 32 && data.subarray(4, 8).toString('ascii') === 'pssh') {
      return data;
    }
    if (data.length === 16) {
      return this.buildWidevinePsshFromKid(data);
    }
    return null;
  }

  private buildWidevinePsshFromKid(kid: Buffer): Buffer {
    const initData = WidevinePsshDataMsg.encode({ algorithm: 1, keyIds: [kid] }).finish();
    const systemId = Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex');
    const totalSize = 32 + initData.length;
    const pssh = Buffer.alloc(totalSize);
    let offset = 0;
    pssh.writeUInt32BE(totalSize, offset); offset += 4;
    pssh.write('pssh', offset); offset += 4;
    pssh.writeUInt32BE(0, offset); offset += 4;
    systemId.copy(pssh, offset); offset += 16;
    pssh.writeUInt32BE(initData.length, offset); offset += 4;
    Buffer.from(initData).copy(pssh, offset);
    return pssh;
  }

  private async findKeyUriFromAssets(
    webPlayback: any,
    headers: Record<string, string>,
  ): Promise<string | null> {
    const assets = webPlayback?.assets;
    if (!Array.isArray(assets)) return null;
    const ctrpAsset = assets.find(
      (asset: any) => asset?.flavor === '28:ctrp256' && typeof asset?.URL === 'string',
    );
    const assetUrl = ctrpAsset?.URL;
    if (!assetUrl) return null;

    let playlist = await this.fetchText(assetUrl, headers);
    if (!playlist) return null;

    const variantUrl = this.findVariantPlaylistUrl(playlist, assetUrl);
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, headers);
      if (variantPlaylist) playlist = variantPlaylist;
    }

    const keyInfo = this.extractKeyInfo(playlist);
    const keyUri = keyInfo?.uri ?? null;
    if (keyUri && this.extractPsshFromKeyUri(keyUri)) return keyUri;
    return this.findPsshKeyUri(playlist);
  }

  private extractLibraryAssetUrl(webPlayback: any): string | null {
    const assets = webPlayback?.assets;
    if (!Array.isArray(assets)) return null;
    const url = assets?.[0]?.URL;
    return typeof url === 'string' && url.length > 0 ? url : null;
  }

  private buildStreamHeaders(headers: Record<string, string>): Record<string, string> | undefined {
    const allowlist = new Set([
      'authorization',
      'media-user-token',
      'music-user-token',
      'user-agent',
      'accept',
      'accept-language',
      'origin',
      'referer',
    ]);
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!value) continue;
      if (allowlist.has(key.toLowerCase())) {
        filtered[key] = value;
      }
    }
    return Object.keys(filtered).length ? filtered : undefined;
  }

  private async buildStreamPlaybackSource(
    streamUrl: string,
    headers: Record<string, string>,
    bridge: SpotifyBridgeConfig,
    decryptionKey?: string,
  ): Promise<PlaybackSource> {
    const streamHeaders = this.buildStreamHeaders(headers);
    if (decryptionKey) {
      const directDrm = await this.buildDirectDrmPlaybackSource(
        streamUrl,
        streamHeaders,
        bridge,
        decryptionKey,
      );
      if (directDrm) return directDrm;
      return this.buildProxyPlaybackSource(streamUrl, streamHeaders, bridge, decryptionKey);
    }
    const resolved = await this.resolveUrlForFfmpeg(streamUrl, streamHeaders);
    await this.logInputDetails('direct', resolved.url, resolved.headers, undefined);
    const realTime = this.resolvePaceInput(bridge);
    if (!realTime) {
      this.log.info('Apple Music pacing disabled (direct)', { inputFormat: null });
    }
    return {
      kind: 'url',
      url: resolved.url,
      headers: resolved.headers,
      decryptionKey,
      tlsVerifyHost: resolved.tlsVerifyHost,
      realTime,
    };
  }

  private async buildDirectDrmPlaybackSource(
    streamUrl: string,
    headers: Record<string, string> | undefined,
    bridge: SpotifyBridgeConfig,
    decryptionKey: string,
  ): Promise<PlaybackSource | null> {
    const resolved = await this.resolveUrlForFfmpeg(streamUrl, headers);
    await this.logInputDetails('direct', resolved.url, resolved.headers, 'mov');
    const realTime = this.resolvePaceInput(bridge);
    if (!realTime) {
      this.log.info('Apple Music pacing disabled (direct DRM)', { inputFormat: 'mov' });
    }
    return {
      kind: 'url',
      url: resolved.url,
      headers: resolved.headers,
      decryptionKey,
      tlsVerifyHost: resolved.tlsVerifyHost,
      inputFormat: 'mov',
      realTime,
    };
  }

  private async resolveUrlForFfmpeg(
    streamUrl: string,
    headers?: Record<string, string>,
  ): Promise<{ url: string; headers?: Record<string, string>; tlsVerifyHost?: string }> {
    let parsed: URL;
    try {
      parsed = new URL(streamUrl);
    } catch {
      return { url: streamUrl, headers };
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
      return { url: streamUrl, headers };
    }

    const hostname = parsed.hostname;
    if (!hostname || isIP(hostname)) {
      return { url: streamUrl, headers };
    }
    if (hostname.endsWith('blobstore.apple.com')) {
      return { url: streamUrl, headers };
    }
    for (const key of parsed.searchParams.keys()) {
      if (key.startsWith('X-Amz-')) {
        return { url: streamUrl, headers };
      }
    }

    try {
      const records = await lookup(hostname, { all: true });
      if (!records.length) return { url: streamUrl, headers };
      const selected = records.find((record) => record.family === 4) ?? records[0];
      if (!selected?.address) return { url: streamUrl, headers };

      const resolvedUrl = new URL(streamUrl);
      resolvedUrl.hostname = selected.address;
      const resolvedHeaders = headers ? { ...headers, Host: hostname } : { Host: hostname };

      this.log.debug('Apple Music stream DNS resolved for ffmpeg', {
        hostname,
        address: selected.address,
      });
      return { url: resolvedUrl.toString(), headers: resolvedHeaders, tlsVerifyHost: hostname };
    } catch (err) {
      this.log.warn('Apple Music stream DNS resolve failed', {
        hostname,
        message: err instanceof Error ? err.message : String(err),
      });
      return { url: streamUrl, headers };
    }
  }

  private async resolveCtrp256StreamInfo(
    webPlayback: any,
    headers: Record<string, string>,
  ): Promise<AppleMusicDrmStreamInfo | null> {
    const assets = webPlayback?.assets;
    if (!Array.isArray(assets)) return null;
    const ctrpAsset = assets.find(
      (asset: any) => asset?.flavor === '28:ctrp256' && typeof asset?.URL === 'string',
    );
    const assetUrl = ctrpAsset?.URL;
    if (!assetUrl) return null;
    let playlist = await this.fetchText(assetUrl, headers);
    if (!playlist) return null;
    let baseUrl = assetUrl;
    const variantUrl = this.findVariantPlaylistUrl(playlist, assetUrl);
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, headers);
      if (variantPlaylist) {
        playlist = variantPlaylist;
        baseUrl = variantUrl;
      }
    }
    const fileUrl = this.extractFirstSegmentUrl(playlist, baseUrl);
    if (!fileUrl) return null;
    const keyInfo = this.extractKeyInfo(playlist);
    return { fileUrl, keyUri: keyInfo?.uri };
  }

  private extractFirstSegmentUrl(playlist: string, baseUrl: string): string | null {
    const lines = playlist.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      try {
        return new URL(trimmed, baseUrl).toString();
      } catch {
        return null;
      }
    }
    return null;
  }

  private async buildProxyPlaybackSource(
    streamUrl: string,
    headers: Record<string, string> | undefined,
    bridge: SpotifyBridgeConfig,
    decryptionKey: string,
  ): Promise<PlaybackSource> {
    const { host, port, sessionId } = await this.ensureProxySession(streamUrl, headers, decryptionKey);
    const url = `http://${host}:${port}/applemusic/${sessionId}/playlist.m3u8`;
    await this.logInputDetails('proxy', streamUrl, headers, 'hls', sessionId);
    const realTime = this.resolvePaceInput(bridge);
    if (!realTime) {
      this.log.info('Apple Music pacing disabled (proxy)', { inputFormat: 'hls', sessionId });
    }
    return { kind: 'url', url, inputFormat: 'hls', realTime };
  }

  private resolvePaceInput(bridge: SpotifyBridgeConfig): boolean {
    if (typeof bridge.appleMusicPaceInput === 'boolean') {
      return bridge.appleMusicPaceInput;
    }
    return true;
  }

  private async logInputDetails(
    kind: 'direct' | 'proxy',
    streamUrl: string,
    headers: Record<string, string> | undefined,
    inputFormat?: string,
    sessionId?: string,
  ): Promise<void> {
    this.log.debug('Apple Music input details', {
      kind,
      streamUrl,
      inputFormat,
      sessionId,
    });
  }

  private async fetchStreamInfo(
    streamUrl: string,
    headers: Record<string, string> | undefined,
  ): Promise<{ contentType?: string; contentLength?: string } | null> {
    try {
      const response = await fetch(streamUrl, {
        method: 'HEAD',
        headers,
      });
      if (!response.ok) return null;
      return {
        contentType: response.headers.get('content-type') ?? undefined,
        contentLength: response.headers.get('content-length') ?? undefined,
      };
    } catch {
      return null;
    }
  }

  private async ensureProxySession(
    streamUrl: string,
    headers: Record<string, string> | undefined,
    decryptionKey: string,
  ): Promise<{ host: string; port: number; sessionId: string }> {
    const { host, port } = await this.ensureProxyServer();
    this.pruneProxySessions();
    const sessionId = randomUUID();
    const session: AppleMusicProxySession = {
      id: sessionId,
      streamUrl,
      headers,
      keyBytes: Buffer.from(decryptionKey, 'hex'),
      createdAt: Date.now(),
    };
    this.proxySessions.set(sessionId, session);
    return { host, port, sessionId };
  }

  private async ensureProxyServer(): Promise<{ host: string; port: number }> {
    if (this.proxyServer && this.proxyPort) {
      return { host: this.proxyHost, port: this.proxyPort };
    }
    this.proxyServer = createServer((req, res) => {
      this.handleProxyRequest(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('Apple Music proxy request failed', { message });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.proxyServer!
        .listen(0, this.proxyHost, () => {
          const address = this.proxyServer?.address();
          if (address && typeof address === 'object') {
            this.proxyPort = address.port;
          }
          resolve();
        })
        .on('error', reject);
    });
    return { host: this.proxyHost, port: this.proxyPort ?? 0 };
  }

  private async handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== 'applemusic') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }

    const sessionId = parts[1];
    const resource = parts[2];
    const session = this.proxySessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }

    if (resource === 'playlist.m3u8') {
      const playlist = await this.getProxyPlaylist(session);
      if (!playlist) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(playlist);
      return;
    }

    if (resource === 'key') {
      if (!session.keyBytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(session.keyBytes);
      return;
    }

    if (resource === 'segment') {
      const target = url.searchParams.get('u');
      if (!target) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      await this.proxyUpstreamResponse(res, target, session.headers);
      return;
    }

    if (resource === 'stream.mp4') {
      await this.streamConcatenatedMp4(res, session);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end();
  }

  private async getProxyPlaylist(session: AppleMusicProxySession): Promise<string | null> {
    if (session.playlist && session.playlistBaseUrl) {
      return session.playlist;
    }
    let playlist = await this.fetchText(session.streamUrl, session.headers ?? {});
    if (!playlist) return null;
    let baseUrl = session.streamUrl;
    const variantUrl = this.findVariantPlaylistUrl(playlist, baseUrl);
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, session.headers ?? {});
      if (variantPlaylist) {
        playlist = variantPlaylist;
        baseUrl = variantUrl;
      }
    }
    const rewritten = this.rewritePlaylistForProxy(session, playlist, baseUrl);
    const preview = rewritten.split(/\r?\n/, 2);
    this.log.debug('Apple Music proxy playlist ready', {
      sessionId: session.id,
      length: rewritten.length,
      firstLine: preview[0] ?? '',
      secondLine: preview[1] ?? '',
    });
    session.playlist = rewritten;
    session.playlistBaseUrl = baseUrl;
    return rewritten;
  }

  private rewritePlaylistForProxy(
    session: AppleMusicProxySession,
    playlist: string,
    baseUrl: string,
  ): string {
    const normalized = playlist.startsWith('#EXTM3U') ? playlist : `#EXTM3U\n${playlist}`;
    const sourceLines = normalized.split(/\r?\n/);
    const keyUrl = `http://${this.proxyHost}:${this.proxyPort}/applemusic/${session.id}/key`;
    const output: string[] = [];
    for (const line of sourceLines) {
      if (line.startsWith('#EXT-X-KEY')) {
        let next = this.replaceM3u8Attribute(line, 'URI', keyUrl);
        next = this.stripM3u8Attribute(next, 'KEYFORMAT');
        next = this.stripM3u8Attribute(next, 'KEYFORMATVERSIONS');
        output.push(next);
        continue;
      }
      if (line.startsWith('#EXT-X-MAP')) {
        const mapUri = this.readM3u8Attribute(line, 'URI');
        if (mapUri) {
          const absolute = new URL(mapUri, baseUrl).toString();
          const proxyUrl = this.buildProxySegmentUrl(session.id, absolute);
          output.push(this.replaceM3u8Attribute(line, 'URI', proxyUrl));
          continue;
        }
      }
      if (!line || line.startsWith('#')) {
        output.push(line);
        continue;
      }
      const absolute = new URL(line.trim(), baseUrl).toString();
      output.push(this.buildProxySegmentUrl(session.id, absolute));
    }
    return output.join('\n');
  }

  private buildProxySegmentUrl(sessionId: string, targetUrl: string): string {
    const encoded = encodeURIComponent(targetUrl);
    return `http://${this.proxyHost}:${this.proxyPort}/applemusic/${sessionId}/segment?u=${encoded}`;
  }

  private async proxyUpstreamResponse(
    res: ServerResponse,
    targetUrl: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    try {
      const response = await fetch(targetUrl, headers ? { headers } : undefined);
      if (!response.ok || !response.body) {
        let bodyPreview = '';
        try {
          const text = await response.text();
          bodyPreview = text.slice(0, 200);
        } catch {
          bodyPreview = '';
        }
        this.log.warn('Apple Music proxy upstream rejected', {
          status: response.status,
          targetUrl,
          contentType: response.headers.get('content-type') ?? undefined,
          bodyPreview: bodyPreview || undefined,
        });
        res.writeHead(response.status || 502, { 'Content-Type': 'text/plain' });
        res.end(bodyPreview);
        return;
      }
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      this.log.debug('Apple Music proxy upstream ok', {
        targetUrl,
        contentType,
        contentLength: response.headers.get('content-length') ?? undefined,
      });
      res.writeHead(200, { 'Content-Type': contentType });
      const stream = Readable.fromWeb(response.body as any);
      stream.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('Apple Music proxy stream failed', { message });
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        res.end();
      });
      stream.pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('Apple Music proxy fetch failed', { message, targetUrl });
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end();
    }
  }

  private async streamConcatenatedMp4(res: ServerResponse, session: AppleMusicProxySession): Promise<void> {
    const segments = await this.ensureSegmentList(session);
    if (!segments || segments.length === 0) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    const headers = session.headers;
    const urls = session.initUrl ? [session.initUrl, ...segments] : segments;
    for (const url of urls) {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      const ok = await this.pipeFetchToResponse(url, headers, res);
      if (!ok) return;
    }
    res.end();
  }

  private async ensureSegmentList(session: AppleMusicProxySession): Promise<string[] | null> {
    if (session.segmentUrls && session.segmentUrls.length > 0) {
      return session.segmentUrls;
    }
    let playlist = await this.fetchText(session.streamUrl, session.headers ?? {});
    if (!playlist) return null;
    let baseUrl = session.streamUrl;
    const variantUrl = this.findVariantPlaylistUrl(playlist, baseUrl);
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, session.headers ?? {});
      if (variantPlaylist) {
        playlist = variantPlaylist;
        baseUrl = variantUrl;
      }
    }
    const { initUrl, segments } = this.parseSegmentUrls(playlist, baseUrl);
    session.initUrl = initUrl ?? undefined;
    session.segmentUrls = segments;
    return segments;
  }

  private parseSegmentUrls(
    playlist: string,
    baseUrl: string,
  ): { initUrl?: string; segments: string[] } {
    const lines = playlist.split(/\r?\n/);
    let initUrl: string | undefined;
    const segments: string[] = [];
    for (const line of lines) {
      if (line.startsWith('#EXT-X-MAP')) {
        const uri = this.readM3u8Attribute(line, 'URI');
        if (uri) {
          try {
            initUrl = new URL(uri, baseUrl).toString();
          } catch {
            initUrl = undefined;
          }
        }
        continue;
      }
      if (!line || line.startsWith('#')) continue;
      try {
        segments.push(new URL(line.trim(), baseUrl).toString());
      } catch {
        // ignore invalid
      }
    }
    return { initUrl, segments };
  }

  private async pipeFetchToResponse(
    targetUrl: string,
    headers: Record<string, string> | undefined,
    res: ServerResponse,
  ): Promise<boolean> {
    try {
      const response = await fetch(targetUrl, headers ? { headers } : undefined);
      if (!response.ok || !response.body) {
        this.log.warn('Apple Music proxy stream segment failed', {
          status: response.status,
          targetUrl,
        });
        res.end();
        return false;
      }
      const stream = Readable.fromWeb(response.body as any);
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.on('end', () => resolve());
        stream.pipe(res, { end: false });
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('Apple Music proxy stream segment error', { message, targetUrl });
      res.end();
      return false;
    }
  }

  private pruneProxySessions(maxAgeMs = 10 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, session] of this.proxySessions) {
      if (session.createdAt < cutoff) {
        this.proxySessions.delete(id);
      }
    }
  }

  private stripM3u8Attribute(line: string, name: string): string {
    const pattern = new RegExp(`(?:,)?${name}=("(?:[^"\\\\]|\\\\.)*"|[^,]*)`, 'ig');
    let next = line.replace(pattern, '');
    next = next.replace(/,(\s*)$/, '');
    next = next.replace(/:,+/, ':');
    next = next.replace(/,,+/g, ',');
    return next;
  }

  private replaceM3u8Attribute(line: string, name: string, value: string): string {
    const pattern = new RegExp(`${name}=("(?:[^"\\\\]|\\\\.)*"|[^,]*)`, 'i');
    if (pattern.test(line)) {
      return line.replace(pattern, `${name}="${value}"`);
    }
    const suffix = line.includes(':') ? ',' : ':';
    return `${line}${suffix}${name}="${value}"`;
  }

  private buildLicenseHeaders(headers: Record<string, string>): Record<string, string> {
    const token =
      headers['media-user-token'] ??
      headers['music-user-token'] ??
      headers['Media-User-Token'] ??
      headers['Music-User-Token'];
    const ua = headers['user-agent'] ?? headers['User-Agent'];
    const auth = headers.authorization ?? headers.Authorization;
    const payload: Record<string, string> = {
      connection: 'keep-alive',
      accept: 'application/json',
      origin: 'https://music.apple.com',
      referer: 'https://music.apple.com/',
      'accept-encoding': 'gzip, deflate, br',
      'content-type': 'application/json;charset=utf-8',
    };
    if (ua) payload['user-agent'] = ua;
    if (auth) payload.authorization = auth;
    if (token) payload['media-user-token'] = token;
    return payload;
  }

  private normalizeLicenseUrl(url?: string): string | null {
    if (!url) return null;
    if (url.includes('play.itunes.apple.com')) {
      return url.replace('play.itunes.apple.com', 'play.music.apple.com');
    }
    return url;
  }

  private async fetchJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (err) {
      this.log.warn('apple music json fetch failed', { url, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async fetchText(url: string, headers?: Record<string, string>): Promise<string | null> {
    try {
      const res = await fetch(url, headers ? { headers } : undefined);
      if (!res.ok) return null;
      return await res.text();
    } catch (err) {
      this.log.warn('apple music text fetch failed', { url, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async fetchCatalogIdForLibraryTrack(headers: Record<string, string>, trackId: string): Promise<string | null> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/songs/${encodeURIComponent(trackId)}`;
    const data = await this.fetchJson<any>(url, headers);
    const attrs = data?.data?.[0]?.attributes;
    const playParams = attrs?.playParams;
    const catalogId = playParams?.catalogId || attrs?.catalogId;
    return catalogId ? String(catalogId) : null;
  }

  private baseHeaders(userToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:95.0) Gecko/20100101 Firefox/95.0',
      Accept: 'application/json',
      'Accept-Language': 'en-US',
      'Accept-Encoding': 'utf-8',
      'content-type': 'application/json',
      'x-apple-renewal': 'true',
      DNT: '1',
      Connection: 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      origin: 'https://music.apple.com',
      referer: 'https://music.apple.com/',
    };
    if (userToken) {
      headers['Media-User-Token'] = userToken;
      headers['Music-User-Token'] = userToken;
    }
    return headers;
  }

  private async buildAuthHeaders(bridge: SpotifyBridgeConfig): Promise<Record<string, string>> {
    const headers = this.baseHeaders(bridge.userToken);
    let bearer = bridge.developerToken ?? null;
    if (!bearer && bridge.userToken) bearer = await this.ensureBearerToken(bridge);
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return headers;
  }

  private async ensureBearerToken(bridge: SpotifyBridgeConfig): Promise<string | null> {
    const key = bridge.id;
    const cached = this.bearerTokens.get(key);
    if (cached?.token && Date.now() - cached.fetchedAt < BEARER_TOKEN_TTL_MS) return cached.token;
    if (cached?.inFlight) return cached.inFlight;

    const state: BearerState = cached ?? { fetchedAt: 0 };
    state.inFlight = (async () => {
      try {
        const headers = this.baseHeaders(bridge.userToken);
        const homeRes = await fetch('https://music.apple.com', { headers });
        const homeText = await homeRes.text();
        const match = homeText.match(/\/(assets\/index-legacy[~-][^/"]+\.js)/i);
        if (!match) return null;

        const jsRes = await fetch(`https://music.apple.com/${match[1]}`, { headers });
        const jsText = await jsRes.text();
        const tokenMatch = jsText.match(/eyJh[^"]+/);
        if (!tokenMatch) return null;

        const token = tokenMatch[0];
        state.token = token;
        state.fetchedAt = Date.now();
        return token;
      } catch (err) {
        this.log.warn('apple music bearer fetch failed', { message: err instanceof Error ? err.message : String(err) });
        return null;
      } finally {
        state.inFlight = undefined;
      }
    })();

    this.bearerTokens.set(key, state);
    return state.inFlight;
  }

  private async ensureStorefront(headers: Record<string, string>, bridge: SpotifyBridgeConfig): Promise<string> {
    const key = bridge.id;
    const cached = this.storefronts.get(key);
    if (cached?.value) return cached.value;
    if (cached?.inFlight) return cached.inFlight;

    const fallback = 'us';
    const state: StorefrontState = cached ?? { value: fallback };

    state.inFlight = (async () => {
      if (!bridge.userToken) {
        state.value = fallback;
        return fallback;
      }
      const account = await this.fetchJson<any>(`${APPLE_MUSIC_API_BASE}/me/account?meta=subscription`, headers);
      const storefront = account?.meta?.subscription?.storefront;
      state.value = storefront ? String(storefront).toLowerCase() : fallback;
      return state.value;
    })();

    this.storefronts.set(key, state);
    try {
      return await state.inFlight;
    } finally {
      state.inFlight = undefined;
    }
  }
}
