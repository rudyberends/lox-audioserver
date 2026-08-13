import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig } from '@/domain/config/types';
import type { AirplayInstanceController } from '@/adapters/inputs/airplay/airplayInstance';
import type { SendspinHookRegistryPort } from '@/adapters/outputs/sendspin/sendspinHookRegistry';
import type { PlaybackMetadata } from '@/application/playback/audioManager';
import { sendspinCore, SourceCommand } from '@sonn-audio/node-sendspin';
import type { SendspinSourceStreamFormat } from '@sonn-audio/node-sendspin';

/** What a Sonn Client reports about the phone it is playing, as its status block carries it. */
export type BluetoothNowPlaying = {
  title?: string;
  artist?: string;
  album?: string;
  status?: string;
  /** Track length and position in milliseconds, as AVRCP gives them. */
  duration_ms?: number;
  position_ms?: number;
};

/** The sendspin client id a device's Bluetooth input sends its audio under. */
export function bluetoothClientId(deviceId: string): string {
  return `${deviceId.trim()}-bt`;
}

type ZoneEntry = {
  zoneId: number;
  clientId: string;
  stopHooks: () => void;
};

type ActiveStream = {
  zoneId: number;
  stream: PassThrough;
  dropping?: boolean;
  /** How much arrived and how much was thrown away, said out loud once a second. */
  bytes: number;
  dropped: number;
  lastReport: number;
};

const LABEL = 'bluetooth';
/** What ffmpeg on the device decodes to, and therefore what arrives here. */
const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_CHANNELS = 2;

/**
 * Bluetooth as a zone input, in the same shape as AirPlay and DLNA.
 *
 * The radio is not here. It is on a Sonn Client in the room, which pairs the phone, takes the A2DP
 * stream, decodes it and sends the result on as an ordinary sendspin source. So all this end does is
 * what it does for any other input that pushes: recognise the audio when it starts, hand it to the
 * zone, and let go when it stops.
 *
 * That split is deliberate. A phone's radio range is the room it is in, so the thing that hears it
 * has to be in that room too; and once the audio is PCM on the network, a room with a Bluetooth
 * phone in it is not different from a room with a turntable in it.
 */
export class BluetoothInputService {
  private readonly log = createLogger('Input', 'Bluetooth');
  private readonly zones = new Map<number, ZoneEntry>();
  private readonly active = new Map<string, ActiveStream>();
  /** Last metadata published per zone, so an unchanged poll does not republish. */
  private readonly published = new Map<number, string>();
  private controller: AirplayInstanceController | null = null;

  constructor(private readonly hooks: SendspinHookRegistryPort) {}

  public configure(controller: AirplayInstanceController): void {
    this.controller = controller;
  }

  /** A zone gets a Bluetooth input iff its own input is on and names a device to hear it with. */
  public syncZones(zones: ZoneConfig[]): void {
    const wanted = new Map<number, string>();
    for (const zone of zones) {
      const bluetooth = zone.inputs?.bluetooth;
      const deviceId = bluetooth?.deviceId?.trim();
      if (bluetooth?.enabled !== true || !deviceId) {
        continue;
      }
      wanted.set(zone.id, bluetoothClientId(deviceId));
    }

    for (const [zoneId, entry] of this.zones.entries()) {
      if (wanted.get(zoneId) === entry.clientId) {
        continue;
      }
      this.removeZone(zoneId, 'bluetooth-reconfigured');
    }

    for (const [zoneId, clientId] of wanted.entries()) {
      if (this.zones.has(zoneId)) {
        continue;
      }
      const stopHooks = this.hooks.register(clientId, {
        // A source waits to be told, and this one is told the moment it appears.
        //
        // For a line-in that is a decision — a turntable is wired up whether anyone is listening or
        // not, so the server asks for its audio only when the room selects it. A phone is the other
        // way round: the client builds this source when someone presses play and tears it down when
        // they stop, so the session existing at all *is* the phone playing.
        onIdentified: () => {
          this.log.info('a phone started playing', { clientId });
          sendspinCore.sendServerCommand(clientId, { source: { command: SourceCommand.START } });
        },
        onSourceStreamStart: (_session, format) => {
          // The format arrives with the stream, not before it: a phone that switches from music to
          // a call changes it, and the zone has already been handed a stream shaped for the old one.
          this.stopStream(clientId, 'bluetooth-format-announced');
          this.startStream(clientId, format);
        },
        onSourceAudio: (_session, chunk) => {
          this.writeAudio(clientId, chunk.data);
        },
        onSourceState: (_session, update) => {
          if (update.state && update.state !== 'streaming') {
            this.stopStream(clientId, `bluetooth-${update.state}`);
          }
        },
        onSourceStreamEnd: () => this.stopStream(clientId, 'bluetooth-stream-ended'),
        onDisconnected: () => this.stopStream(clientId, 'bluetooth-client-gone'),
        // A radio that connects and is turned away is the hardest failure to see from the room: the
        // phone plays, the client says it is sending, and nothing happens here.
        onUnsupportedRoles: (_session, roles) => {
          this.log.warn('the bluetooth client asked for roles this server does not serve', {
            clientId,
            roles,
          });
        },
        onNoncompliance: (_session, issue) => {
          this.log.warn('the bluetooth client said something this server would not take', {
            clientId,
            issue,
          });
        },
        onGoodbye: (_session, reason) => {
          this.log.info('the bluetooth client said goodbye', { clientId, reason });
        },
      });
      this.zones.set(zoneId, { zoneId, clientId, stopHooks });
      this.log.info('bluetooth input listening', { zoneId, clientId });
    }
  }

  /**
   * What the phone says it is playing, from the device's poll.
   *
   * AVRCP metadata reaches this end over the management API rather than over sendspin, because it is
   * the phone's, not the stream's — and it keeps arriving while the phone is paused, which is
   * exactly when someone looks at the screen to see what stopped.
   */
  public updateNowPlaying(deviceId: string, playing: BluetoothNowPlaying | null | undefined): void {
    const clientId = bluetoothClientId(deviceId);
    const zoneId = this.zoneFor(clientId);
    if (zoneId === null || !this.active.has(clientId)) {
      return;
    }
    // The phone is the one playing, so its clock is the truth: length and position come from every
    // poll rather than being counted here, which is what makes a skip or a scrub look right.
    const duration = Math.round((playing?.duration_ms ?? 0) / 1000);
    const position = Math.round((playing?.position_ms ?? 0) / 1000);
    if (duration > 0) {
      this.controller?.updateTiming(zoneId, position, duration);
    }

    const metadata: Partial<PlaybackMetadata> = {
      title: playing?.title?.trim() || 'Bluetooth',
      artist: playing?.artist?.trim() || '',
      album: playing?.album?.trim() || '',
      ...(duration > 0 ? { duration } : {}),
    };
    const fingerprint = [metadata.title, metadata.artist, metadata.album].join('\u0000');
    if (this.published.get(zoneId) === fingerprint) {
      return;
    }
    this.published.set(zoneId, fingerprint);
    this.controller?.updateMetadata(zoneId, metadata);
  }

  public shutdown(): void {
    for (const zoneId of [...this.zones.keys()]) {
      this.removeZone(zoneId, 'bluetooth-shutdown');
    }
  }

  private removeZone(zoneId: number, reason: string): void {
    const entry = this.zones.get(zoneId);
    if (!entry) return;
    this.stopStream(entry.clientId, reason);
    entry.stopHooks();
    this.zones.delete(zoneId);
    this.published.delete(zoneId);
    this.log.info('bluetooth input released', { zoneId, clientId: entry.clientId, reason });
  }

  private zoneFor(clientId: string): number | null {
    for (const entry of this.zones.values()) {
      if (entry.clientId === clientId) {
        return entry.zoneId;
      }
    }
    return null;
  }

  private startStream(clientId: string, format: SendspinSourceStreamFormat | null): void {
    const zoneId = this.zoneFor(clientId);
    if (zoneId === null) return;
    if (!this.controller) {
      this.log.warn('bluetooth audio arrived before the zone controller was wired', { clientId });
      return;
    }
    const stream = new PassThrough({ highWaterMark: 512 * 1024 });
    this.active.set(clientId, { zoneId, stream, bytes: 0, dropped: 0, lastReport: Date.now() });
    this.published.delete(zoneId);
    this.controller.startPlayback(
      zoneId,
      LABEL,
      {
        kind: 'pipe',
        path: `bluetooth-${zoneId}`,
        format: 's16le',
        sampleRate: format?.sampleRate || DEFAULT_SAMPLE_RATE,
        channels: format?.channels || DEFAULT_CHANNELS,
        stream,
      },
      // A name to show before the phone has said anything. A blank screen while music plays reads as
      // a fault; "Bluetooth" reads as what it is.
      { title: 'Bluetooth', artist: '', album: '' } as PlaybackMetadata,
    );
    this.log.info('bluetooth playback started', {
      zoneId,
      clientId,
      sampleRate: format?.sampleRate,
      channels: format?.channels,
    });
  }

  private writeAudio(clientId: string, payload: Buffer): void {
    const active = this.active.get(clientId);
    if (!active) {
      return;
    }
    // Said out loud while it moves. A phone sends a known number of bytes a second, so a rate that
    // is short of it is a room hearing gaps — and a drop that is never mentioned reads as working.
    active.bytes += payload.length;
    const now = Date.now();
    if (now - active.lastReport >= 5000) {
      const seconds = (now - active.lastReport) / 1000;
      this.log.debug('bluetooth audio arriving', {
        zoneId: active.zoneId,
        kbPerSecond: Math.round(active.bytes / seconds / 1024),
        droppedBytes: active.dropped,
      });
      active.bytes = 0;
      active.lastReport = now;
    }
    if (active.dropping) {
      active.dropped += payload.length;
      return;
    }
    if (!active.stream.write(payload)) {
      // Live audio has no queue worth keeping: what the room missed is already past, and holding it
      // only makes the room later.
      active.dropping = true;
      this.log.warn('the zone is not keeping up with the phone; dropping audio', {
        zoneId: active.zoneId,
      });
      active.stream.once('drain', () => {
        if (this.active.get(clientId) === active) {
          active.dropping = false;
        }
      });
    }
  }

  private stopStream(clientId: string, reason: string): void {
    const active = this.active.get(clientId);
    if (!active) return;
    this.active.delete(clientId);
    this.published.delete(active.zoneId);
    try {
      active.stream.end();
    } catch {
      /* the stream is already gone; the zone is stopped either way */
    }
    this.controller?.stopPlayback(active.zoneId);
    this.log.info('bluetooth playback stopped', { zoneId: active.zoneId, clientId, reason });
  }
}
