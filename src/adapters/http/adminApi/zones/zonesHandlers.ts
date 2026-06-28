import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import {
  formatEqualizerSettings,
  getZoneEqualizerBands,
  normalizeEqualizerBands,
} from '@/domain/zones/equalizer';
import { audioResampler } from '@/ports/types/audioFormat';
import { sendspinCore } from '@sonn-audio/node-sendspin';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import { getZoneOutputConfig } from '@/adapters/http/adminApi/config/configHandlers';
import { parseSendspinSatellites } from '@/adapters/outputs/factory';

export const STATE_CONTROLLER_DEFINITIONS = [
  { id: 'internal', label: 'Internal', description: 'Use internal playback state only.' },
  { id: 'beolink', label: 'BeoLink', description: 'Use BeoLink external playback state.' },
  { id: 'sonos', label: 'Sonos', description: 'Use Sonos external playback state.' },
  {
    id: 'musicassistant',
    label: 'Music Assistant',
    description: 'Mirror playback state from a Music Assistant player and proxy commands via RPC.',
  },
] as const;

export type ZoneOutputLike = { id: string } & Record<string, unknown>;

export type ZonesHandlerDeps = {
  log: ComponentLogger;
  configPort: ConfigPort;
  audioManager: AudioManager;
  zoneAudioPrefs: ZoneAudioPreferences;
  zoneManager: ZoneManagerFacade;
  favoritesManager: FavoritesManager;
  recentsManager: RecentsManager;
  squeezeliteCore: SqueezeliteCore;
  getClockOffsetMs: () => Promise<number | null>;
  buildSqueezeliteAdminPlayerSnapshot: (
    primaryOutput: ZoneOutputLike | undefined,
    players: SqueezeliteCore['players'],
  ) => unknown;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

export function buildZonesRoutes(deps: ZonesHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/zones\/states$/,
      handler: async (_req, res) => handleZoneStates(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/zones\/(\d+)\/equalizer$/,
      handler: async (_req, res, match) => {
        await handleZoneEqualizerGet(Number(match[1]), res, deps);
      },
    },
    {
      method: 'PUT',
      pattern: /^\/zones\/(\d+)\/equalizer$/,
      handler: async (req, res, match) => {
        await handleZoneEqualizerPut(Number(match[1]), req, res, deps);
      },
    },
    {
      method: 'GET',
      pattern: /^\/zones\/state-controllers$/,
      handler: async (_req, res) => handleZoneStateControllerDefinitions(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/zones\/(\d+)\/favorites\/(purge|copy)$/,
      handler: async (req, res, match) => {
        const zoneId = Number(match[1]);
        const action = match[2];
        if (!Number.isFinite(zoneId) || zoneId <= 0) {
          deps.sendJson(res, 400, { error: 'invalid-zone-id' });
          return;
        }
        if (action === 'purge') {
          await handleZoneFavoritesPurge(zoneId, res, deps);
        } else {
          await handleZoneFavoritesCopy(zoneId, req, res, deps);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/zones\/(\d+)\/recents\/purge$/,
      handler: async (_req, res, match) => {
        const zoneId = Number(match[1]);
        if (!Number.isFinite(zoneId) || zoneId <= 0) {
          deps.sendJson(res, 400, { error: 'invalid-zone-id' });
          return;
        }
        await handleZoneRecentsPurge(zoneId, res, deps);
      },
    },
    {
      method: 'POST',
      pattern: /^\/zones\/favorites\/purge$/,
      handler: async (_req, res) => handleFavoritesPurge(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/zones\/recents\/purge$/,
      handler: async (_req, res) => handleRecentsPurge(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/zones\/(\d+)\/output-latency$/,
      handler: async (req, res, match) => {
        const zoneId = Number(match[1]);
        if (!Number.isFinite(zoneId) || zoneId <= 0) {
          deps.sendJson(res, 400, { error: 'invalid-zone-id' });
          return;
        }
        await handleZoneOutputLatency(zoneId, req, res, deps);
      },
    },
  ];
}

async function handleZoneOutputLatency(
  zoneId: number,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ZonesHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { latencyMs?: unknown; clientId?: unknown } | null;
  if (!body) return;
  const raw = body.latencyMs;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(num)) {
    deps.sendJson(res, 400, { error: 'invalid-latency' });
    return;
  }
  const clamped = Math.max(0, Math.min(10_000, Math.round(num)));
  // A clientId targets a specific Sendspin satellite's delay; otherwise the primary output.
  const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : null;

  // Persist to zone-config without triggering replaceZones — latency is a live, benign tweak.
  await deps.configPort.updateConfig((cfg) => {
    const zone = cfg.zones?.find((z) => z.id === zoneId);
    if (!zone) return;
    const primary = getZoneOutputConfig(zone) as Record<string, unknown> | null;
    if (!primary) return;
    const mirrors: Record<string, unknown>[] = [primary];
    const transports = (zone as { transports?: Record<string, unknown>[] }).transports;
    if (Array.isArray(transports) && transports[0]) mirrors.push(transports[0]);
    const output = (zone as { output?: Record<string, unknown> }).output;
    if (output) mirrors.push(output);

    if (clientId) {
      // Update just this satellite's latency in the rich array (normalised across mirrors).
      const primaryClientId = typeof primary.clientId === 'string' ? primary.clientId : '';
      const sats = parseSendspinSatellites(primary.satellites, primaryClientId);
      const next = sats.map((s) => (s.clientId === clientId ? { ...s, latencyMs: clamped } : s));
      for (const m of mirrors) m.satellites = next;
    } else {
      for (const m of mirrors) m.latencyMs = clamped;
    }
  });

  const applied = deps.zoneManager.setOutputLatency(zoneId, clamped, clientId ?? undefined);
  deps.sendJson(res, 200, { latencyMs: clamped, clientId, applied });
}

function handleZoneStateControllerDefinitions(
  res: ServerResponse,
  deps: ZonesHandlerDeps,
): void {
  deps.sendJson(res, 200, { stateControllers: STATE_CONTROLLER_DEFINITIONS });
}

async function handleZoneStates(res: ServerResponse, deps: ZonesHandlerDeps): Promise<void> {
  try {
    const cfg = deps.configPort.getConfig();
    const clockOffsetMs = await deps.getClockOffsetMs();
    const zones = (cfg.zones ?? []).map((zone) => {
      const state = deps.zoneManager.getState(zone.id);
      const session = deps.audioManager.getSession(zone.id);
      const playbackSource = session?.playbackSource;
      const effectiveOutput = deps.zoneAudioPrefs.getEffectiveOutputSettings(zone.id);
      const techSnapshot = deps.zoneManager.getTechnicalSnapshot(zone.id);
      const primaryOutput = getZoneOutputConfig(zone);
      const sendspinOutput =
        primaryOutput?.id === 'sendspin'
          ? (primaryOutput as { id: string; clientId?: string } & Record<string, unknown>)
          : undefined;
      const sendspinClientId =
        typeof sendspinOutput?.clientId === 'string' ? sendspinOutput.clientId : null;
      const backpressure =
        sendspinClientId != null ? sendspinCore.getBackpressureStats(sendspinClientId) : null;
      const sendspinFormat =
        sendspinClientId != null ? sendspinCore.getStreamFormat(sendspinClientId) : null;
      const sendspinBufferCap =
        sendspinClientId != null ? sendspinCore.getPlayerBufferCapacity(sendspinClientId) : null;
      const sendspinLead =
        sendspinClientId != null ? sendspinCore.getLeadStats(sendspinClientId) : null;
      const configuredTransports =
        Array.isArray(zone.transports) && zone.transports.length > 0
          ? zone.transports
          : primaryOutput
            ? [primaryOutput]
            : [];
      const squeezelitePlayer = deps.buildSqueezeliteAdminPlayerSnapshot(
        primaryOutput ?? undefined,
        deps.squeezeliteCore.players,
      );
      const groupProtocol =
        techSnapshot?.transports && techSnapshot.transports.some((t) => t === 'sendspin') ? 'sendspin' : null;
      const streams = session
        ? {
            mp3: session.stream?.url ?? null,
            pcm: session.pcmStream?.url ?? null,
          }
        : undefined;
      const streamStats = deps.audioManager.getStreamStats(zone.id);
      const tech =
        session || playbackSource || squeezelitePlayer
          ? {
              input: playbackSource
                ? {
                    kind: playbackSource.kind,
                    format:
                      playbackSource.kind === 'pipe'
                        ? playbackSource.format ?? 'pcm'
                        : playbackSource.kind,
                    sampleRate: playbackSource.kind === 'pipe' ? playbackSource.sampleRate ?? null : null,
                    channels: playbackSource.kind === 'pipe' ? playbackSource.channels ?? null : null,
                  }
                : null,
              output: {
                profiles: session?.profiles ?? [],
                sampleRate: effectiveOutput.sampleRate,
                channels: effectiveOutput.channels,
                bitrate: effectiveOutput.mp3Bitrate,
                pcmBitDepth: effectiveOutput.pcmBitDepth,
                resampler: audioResampler.name,
                resamplePrecision: audioResampler.precision,
                resampleCutoff: audioResampler.cutoff,
                httpProfile: effectiveOutput.httpProfile,
                httpIcyEnabled: effectiveOutput.httpIcyEnabled,
                httpIcyInterval: effectiveOutput.httpIcyInterval,
                httpIcyName: effectiveOutput.httpIcyName,
                prebufferBytes: effectiveOutput.prebufferBytes,
                httpFallbackSeconds: effectiveOutput.httpFallbackSeconds,
              },
              inputProvider: techSnapshot?.inputMode ?? techSnapshot?.activeInput ?? null,
              outputTarget: techSnapshot?.activeOutput ?? null,
              outputs: techSnapshot?.outputs ?? [],
              transports: techSnapshot?.transports ?? [],
              player: squeezelitePlayer,
              session: session
                ? {
                    state: session.state,
                    elapsed: session.elapsed,
                    duration: session.duration,
                    startedAt: session.startedAt,
                    updatedAt: session.updatedAt,
                  }
                : undefined,
              streams,
              streamStats,
              backpressure,
              sendspin: sendspinFormat
                ? {
                    codec: sendspinFormat.codec,
                    sampleRate: sendspinFormat.sampleRate,
                    channels: sendspinFormat.channels,
                    bitDepth: sendspinFormat.bitDepth,
                    bufferCapacity: sendspinBufferCap,
                    leadUs: sendspinLead?.leadUs ?? null,
                    targetLeadUs: sendspinLead?.targetLeadUs ?? null,
                    bufferedBytes: sendspinLead?.bufferedBytes ?? null,
                    leadUpdatedAt: sendspinLead?.updatedAt ?? null,
                    protocol: groupProtocol,
                  }
                : undefined,
            }
          : undefined;
      return {
        id: zone.id,
        name: zone.name,
        title: state?.title ?? '',
        artist: state?.artist ?? '',
        album: state?.album ?? '',
        sourceName: state?.sourceName ?? '',
        station: state?.station ?? '',
        state: state?.mode ?? '',
        coverurl: state?.coverurl ?? '',
        coverUrl: state?.coverurl ?? '',
        transport: configuredTransports[0] ?? null,
        transports: configuredTransports,
        tech,
        updatedAt: Date.now(),
      };
    });
    const system = {
      now: Date.now(),
      loadavg: os.loadavg().slice(0, 3),
      uptimeSec: Math.round(process.uptime()),
      clockOffsetMs,
      cores: os.cpus()?.length ?? 1,
    };
    deps.sendJson(res, 200, { zones, system });
  } catch (err) {
    deps.log.warn('zone state fetch failed', { err });
    deps.sendJson(res, 500, { error: 'zone-states-failed' });
  }
}

async function handleZoneEqualizerGet(
  zoneId: number,
  res: ServerResponse,
  deps: ZonesHandlerDeps,
): Promise<void> {
  const zone = deps.configPort.getConfig().zones.find((entry) => entry.id === zoneId);
  if (!zone) {
    deps.sendJson(res, 404, { error: 'zone-not-found' });
    return;
  }

  const bands = getZoneEqualizerBands(zone);
  deps.sendJson(res, 200, {
    ok: true,
    zoneId,
    bands,
    equalizerSettings: formatEqualizerSettings(bands),
  });
}

async function handleZoneEqualizerPut(
  zoneId: number,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ZonesHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { bands?: unknown } | unknown[] | null;
  if (res.writableEnded) {
    return;
  }

  const bands = normalizeEqualizerBands(Array.isArray(body) ? body : body?.bands);
  if (!bands) {
    deps.sendJson(res, 400, { error: 'invalid-equalizer-bands' });
    return;
  }

  const zone = deps.configPort.getConfig().zones.find((entry) => entry.id === zoneId);
  if (!zone) {
    deps.sendJson(res, 404, { error: 'zone-not-found' });
    return;
  }

  const updated = await deps.zoneManager.setEqualizerBands(zoneId, bands);
  if (!updated) {
    deps.sendJson(res, 404, { error: 'zone-not-found' });
    return;
  }

  deps.sendJson(res, 200, {
    ok: true,
    zoneId,
    bands: updated.bands,
    equalizerSettings: updated.equalizerSettings,
  });
}

async function handleFavoritesPurge(res: ServerResponse, deps: ZonesHandlerDeps): Promise<void> {
  try {
    await deps.favoritesManager.clearAll();
    deps.sendJson(res, 202, { status: 'favorites-purged' });
  } catch (err) {
    deps.log.warn('favorites purge failed', { err });
    deps.sendJson(res, 500, { error: 'favorites-purge-failed' });
  }
}

async function handleRecentsPurge(res: ServerResponse, deps: ZonesHandlerDeps): Promise<void> {
  try {
    await deps.recentsManager.clearAll();
    deps.sendJson(res, 202, { status: 'recents-purged' });
  } catch (err) {
    deps.log.warn('recents purge failed', { err });
    deps.sendJson(res, 500, { error: 'recents-purge-failed' });
  }
}

async function handleZoneFavoritesPurge(
  zoneId: number,
  res: ServerResponse,
  deps: ZonesHandlerDeps,
): Promise<void> {
  try {
    await deps.favoritesManager.clear(zoneId);
    deps.sendJson(res, 202, { status: 'favorites-purged', zoneId });
  } catch (err) {
    deps.log.warn('zone favorites purge failed', { err, zoneId });
    deps.sendJson(res, 500, { error: 'favorites-purge-failed' });
  }
}

async function handleZoneFavoritesCopy(
  zoneId: number,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ZonesHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { destinations?: unknown } | null;
  if (res.writableEnded) {
    return;
  }
  const rawList = Array.isArray(body?.destinations) ? body!.destinations : [];
  const destinations = Array.from(
    new Set(
      rawList
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0 && value !== zoneId),
    ),
  );
  if (destinations.length === 0) {
    deps.sendJson(res, 400, { error: 'invalid-destinations' });
    return;
  }
  try {
    await deps.favoritesManager.copy(zoneId, destinations);
    deps.sendJson(res, 202, { status: 'favorites-copied', zoneId, destinations });
  } catch (err) {
    deps.log.warn('favorites copy failed', { err, zoneId, destinations });
    deps.sendJson(res, 500, { error: 'favorites-copy-failed' });
  }
}

async function handleZoneRecentsPurge(
  zoneId: number,
  res: ServerResponse,
  deps: ZonesHandlerDeps,
): Promise<void> {
  try {
    await deps.recentsManager.clear(zoneId);
    deps.sendJson(res, 202, { status: 'recents-purged', zoneId });
  } catch (err) {
    deps.log.warn('zone recents purge failed', { err, zoneId });
    deps.sendJson(res, 500, { error: 'recents-purge-failed' });
  }
}
