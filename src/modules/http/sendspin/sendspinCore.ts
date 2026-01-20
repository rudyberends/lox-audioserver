/**
 * Core Sendspin session manager: tracks WebSocket sessions and provides helpers
 * to push stream/state/metadata to clients by clientId.
 */
import type { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import WebSocket from 'ws';
import { createLogger } from '@/core/logging/logger';
import {
  SendspinSession,
  type SendspinSessionHooks,
  type SendspinPcmFrame,
  type SendspinConnectionMeta,
} from '@/modules/http/sendspin/sendspinSession';

const log = createLogger('Sendspin', 'Core');

/** Tracks active Sendspin sessions and routes server-driven messages. */
export class SendspinCore {
  private readonly sessionsBySocket = new Map<WebSocket, SendspinSession>();
  private readonly hooksByClientId = new Map<
    string,
    { hooks: SendspinSessionHooks; context?: SendspinConnectionMeta }
  >();

  private readonly leadStatsByClientId = new Map<
    string,
    { leadUs: number; targetLeadUs: number; bufferedBytes?: number; updatedAt: number }
  >();

  public handleConnection(
    ws: WebSocket,
    req?: IncomingMessage | null,
    connectionReason: 'discovery' | 'playback' = 'discovery',
  ): void {
    const meta = this.extractConnectionMetadata(req);
    const session = new SendspinSession(ws, req ?? null, connectionReason, {
      zoneId: meta.zoneId,
      playerId: meta.playerId,
      remote: req?.socket?.remoteAddress ?? null,
    });
    this.sessionsBySocket.set(ws, session);

    log.info('WebSocket connected', {
      remote: req?.socket?.remoteAddress ?? 'unknown',
      reason: connectionReason,
      zone: meta.zoneId,
      playerId: meta.playerId,
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        session.handleBinary(data);
      } else {
        session.handleText(data.toString());
        const info = session.getInfo();
        if (info.id && !session.hasHooksAttached()) {
          const entry = this.hooksByClientId.get(info.id);
          if (entry) {
            session.setHooks(entry.hooks, entry.context);
          }
        }
      }
    });

    ws.on('close', () => {
      log.info('WebSocket closed', { clientId: session.getClientId() ?? 'unknown' });
      this.sessionsBySocket.delete(ws);
      session.destroy();
    });

    ws.on('error', (err) => {
      log.warn('WebSocket error', { message: (err as Error).message });
    });
  }

  public registerHooks(
    clientId: string,
    hooks: SendspinSessionHooks,
    context?: SendspinConnectionMeta,
  ): void {
    this.hooksByClientId.set(clientId, { hooks, context });
    const session = this.getSession(clientId);
    if (session) {
      session.setHooks(hooks, context);
      log.info('Hooks attached for client', {
        clientId,
        reason: context?.reason,
        zone: context?.zoneId,
      });
    }
  }

  public unregisterHooks(clientId: string): void {
    this.hooksByClientId.delete(clientId);
    this.leadStatsByClientId.delete(clientId);
    const session = this.getSession(clientId);
    if (session) {
      session.setHooks({});
    }
  }

  public sendPcmFrameToClient(clientId: string, frame: SendspinPcmFrame): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    session.sendPcmAudioFrame(frame);
  }

  public sendStreamClear(clientId: string, roles?: string[]): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    session.sendStreamClear(roles);
  }

  public sendStreamEnd(clientId: string, roles?: string[]): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    session.sendStreamEnd(roles);
  }

  public sendArtwork(clientId: string, channel: 0 | 1 | 2 | 3, imageData: Buffer | null): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    if (!session.getRoles().includes('artwork@v1')) {
      return;
    }
    session.sendArtwork(channel, imageData);
  }

  public sendVisualizerStreamStart(clientId: string, config: Record<string, any> = {}): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    session.sendVisualizerStreamStart(config);
  }

  public sendVisualizerFrame(clientId: string, data: Buffer, timestampUs?: number): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    session.sendVisualizerFrame(data, timestampUs);
  }

  public sendStreamStart(
    clientId: string,
    format?: {
      codec?: 'pcm' | 'opus' | 'flac';
      sampleRate?: number;
      channels?: number;
      bitDepth?: number;
      codecHeader?: string;
    },
  ): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    session.sendStreamStart(format);
  }

  public sendArtworkStreamStart(
    clientId: string,
    channels: Array<{ source: 'album' | 'artist' | 'none'; format: 'jpeg' | 'png' | 'bmp'; width: number; height: number }>,
  ): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    session.sendArtworkStreamStart(channels);
  }

  public setClientPlaybackState(
    clientId: string,
    playbackState: 'playing' | 'paused' | 'stopped',
    groupId?: string,
    groupName?: string,
  ): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    const mappedState: 'playing' | 'paused' | 'stopped' =
      playbackState === 'playing'
        ? 'playing'
        : playbackState === 'paused'
          ? 'paused'
          : 'stopped';
    session.sendGroupUpdate({
      playback_state: mappedState,
      group_id: groupId,
      group_name: groupName,
    });
  }

  public setClientMetadata(
    clientId: string,
    metadata: Parameters<SendspinSession['sendMetadata']>[0],
  ): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    session.sendMetadata(metadata);
  }

  public setClientControllerState(
    clientId: string,
    controller: Parameters<SendspinSession['sendControllerState']>[0],
  ): void {
    const session = this.getSession(clientId);
    if (!session) {
      return;
    }
    session.sendControllerState(controller);
  }

  public listClients(): Array<{
    clientId: string;
    roles: string[];
    playbackState: 'playing' | 'paused' | 'stopped';
    remote: string | null;
  }> {
    const clients: Array<{
      clientId: string;
      roles: string[];
      playbackState: 'playing' | 'paused' | 'stopped';
      remote: string | null;
    }> = [];
    for (const session of this.sessionsBySocket.values()) {
      const descriptor = session.getDescriptor();
      if (!descriptor.clientId) {
        continue;
      }
      clients.push({
        clientId: descriptor.clientId,
        roles: descriptor.roles,
        playbackState: descriptor.playbackState,
        remote: descriptor.remote,
      });
    }
    clients.sort((a, b) => a.clientId.localeCompare(b.clientId));
    return clients;
  }

  public getStreamFormat(
    clientId: string,
  ): { codec: 'pcm' | 'opus' | 'flac'; sampleRate: number; channels: number; bitDepth: number } | null {
    const session = this.getSession(clientId);
    if (!session) {
      return null;
    }
    return session.getStreamFormat();
  }

  public setLeadStats(
    clientId: string,
    stats: { leadUs: number; targetLeadUs: number; bufferedBytes?: number },
  ): void {
    if (!clientId) {
      return;
    }
    this.leadStatsByClientId.set(clientId, {
      leadUs: stats.leadUs,
      targetLeadUs: stats.targetLeadUs,
      bufferedBytes: stats.bufferedBytes,
      updatedAt: Date.now(),
    });
  }

  public clearLeadStats(clientId: string): void {
    if (!clientId) {
      return;
    }
    this.leadStatsByClientId.delete(clientId);
  }

  public getLeadStats(
    clientId: string,
  ): { leadUs: number; targetLeadUs: number; bufferedBytes?: number; updatedAt: number } | null {
    return this.leadStatsByClientId.get(clientId) ?? null;
  }

  public getPlayerBufferCapacity(clientId: string): number | null {
    const session = this.getSession(clientId);
    if (!session) {
      return null;
    }
    const cap = session.getPlayerBufferCapacity();
    return cap > 0 ? cap : null;
  }

  public getArtworkChannels(
    clientId: string,
  ): Array<{ source: 'album' | 'artist' | 'none'; format: 'jpeg' | 'png' | 'bmp'; width: number; height: number }> | null {
    const session = this.getSession(clientId);
    if (!session) {
      return null;
    }
    return session.getArtworkChannels();
  }

  public getBackpressureStats(
    clientId: string,
  ): { drops: number; lastBytes: number; lastDropTs: number | null; recentDrops: number } | null {
    const session = this.getSession(clientId);
    if (!session) {
      return null;
    }
    return session.getBackpressureStats();
  }

  private getSession(clientId: string): SendspinSession | null {
    if (!clientId) {
      return null;
    }
    let preferred: SendspinSession | null = null;
    let fallback: SendspinSession | null = null;
    for (const session of this.sessionsBySocket.values()) {
      const info = session.getInfo();
      if (info.id && info.id === clientId) {
        const reason = session.getConnectionReason();
        if (reason === 'playback' && !preferred) {
          preferred = session;
        } else if (!fallback) {
          fallback = session;
        }
      }
    }
    return preferred ?? fallback ?? null;
  }

  private extractConnectionMetadata(
    req?: IncomingMessage | null,
  ): {
    zoneId?: number;
    playerId?: string;
  } {
    if (!req?.url) {
      return {};
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const zoneStr = url.searchParams.get('zone');
      const zoneId = zoneStr && Number.isFinite(Number(zoneStr)) ? Number(zoneStr) : undefined;
      const playerId = url.searchParams.get('player') ?? undefined;
      return { zoneId, playerId };
    } catch {
      return {};
    }
  }
}

export const sendspinCore = new SendspinCore();
