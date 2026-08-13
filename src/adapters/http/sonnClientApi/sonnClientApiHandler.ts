import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import { defaultLocalIp } from '@/shared/utils/net';
import type { ConfigPort } from '@/ports/ConfigPort';
import type {
  SonnClientComponentConfig,
  SonnClientDeviceConfig,
  SonnClientPlayerConfig,
  SonnClientSourceConfig,
} from '@/domain/config/types';
import {
  bluetoothClientId,
  type BluetoothNowPlaying,
} from '@/adapters/inputs/bluetooth/bluetoothInputService';

/**
 * The management API for devices running Sonn Client.
 *
 * Audio between those devices and this server is plain Sendspin and stays that way. This is
 * everything the protocol has no message for: which sound card to open, what the room is called,
 * which zone a Beoremote drives. The device reports what hardware it has, this replies with what it
 * should be, and the reply to *every* request is the full desired state — so a change made in the
 * admin UI takes effect one poll later without this server having to reach back into the device.
 *
 * Ungated, like `/api/linein`: a speaker has no admin session, and the payloads are its own hardware
 * inventory. The auth-gated read/write surface for the UI lives under `/admin/api/sonnclients`.
 */

type DeviceInventoryEntry = {
  id: string;
  name?: string;
  channels?: number;
  sample_rates?: number[];
  is_default?: boolean;
};

type RegisterPayload = {
  device_id?: string;
  agent?: string;
  version?: string;
  hostname?: string;
  ip?: string;
  mac?: string;
  model?: string;
  os?: string;
  arch?: string;
  outputs?: DeviceInventoryEntry[];
  inputs?: DeviceInventoryEntry[];
  capabilities?: {
    codecs?: string[];
    max_players?: number;
    features?: string[];
  };
  components?: Array<{ name?: string; version?: string | null; state?: string }>;
};

type StatusPayload = {
  state?: string;
  version?: string;
  uptime_s?: number;
  players?: unknown[];
  sources?: unknown[];
  outputs?: DeviceInventoryEntry[];
  inputs?: DeviceInventoryEntry[];
  components?: Array<{ name?: string; version?: string | null; state?: string }>;
  pairing?: unknown;
  beoremote?: unknown;
  /** What the device's radio is doing: visible, paired phones, what is connected and playing. */
  bluetooth?: unknown;
};

/** Where a phone's now-playing is handed on, so the zone can show what is playing. */
export type BluetoothNowPlayingSink = {
  updateNowPlaying(deviceId: string, playing: BluetoothNowPlaying | null | undefined): void;
};

type Registration = {
  deviceId: string;
  agent?: string;
  version?: string;
  hostname?: string;
  ip?: string;
  mac?: string;
  model?: string;
  os?: string;
  arch?: string;
  outputs: DeviceInventoryEntry[];
  inputs: DeviceInventoryEntry[];
  capabilities: NonNullable<RegisterPayload['capabilities']>;
  components: NonNullable<RegisterPayload['components']>;
  registeredAt: number;
};

type StatusSnapshot = {
  payload: StatusPayload;
  receivedAt: number;
};

type QueuedCommand = {
  command: string;
  args: string[];
};

/** A device is offline once it has missed a few polls; the client polls every 5s by default. */
const STATUS_STALE_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 60_000;
/**
 * How often a device is asked while it is providing an input a room is listening to.
 *
 * The floor the client accepts, because this is the window a button press waits in.
 */
const ACTIVE_INPUT_POLL_INTERVAL_MS = 1_000;
/** Sendspin lives on the gateway's own port, at this path. */
const SENDSPIN_PATH = '/sendspin';

export type SonnClientAdminView = {
  deviceId: string;
  online: boolean;
  config: SonnClientDeviceConfig | null;
  registration: Registration | null;
  status: StatusPayload | null;
  statusReceivedAt: string | null;
  queuedCommands: QueuedCommand[];
};

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** What this handler needs of the line-in registry: what is waiting, and what is in use. */
export type LineInCommandSource = {
  takeCommands: (inputId: string) => Array<{ command: string; args: string[] }>;
  isActive: (inputId: string) => boolean;
};

/** Catalogue name under which the client's own build is published. */
export const CLIENT_COMPONENT = 'sonn-client';

export class SonnClientApiHandler {
  private readonly log = createLogger('Http', 'SonnClients');
  /** Last registration per device. In memory: it is a description of hardware, not a setting. */
  private readonly registrations = new Map<string, Registration>();
  private readonly statusByDevice = new Map<string, StatusSnapshot>();
  /** Commands waiting for their device's next poll, oldest first. */
  private readonly commandQueues = new Map<string, QueuedCommand[]>();

  constructor(
    private readonly configPort: ConfigPort,
    /** Gateway port, for the fallback when a request arrives without a Host header. */
    private readonly httpPort: number,
    /**
     * Where transport commands for a line-in are waiting.
     *
     * The source role carries no command at all — that surface was never in the protocol — so a
     * BeoSound told to skip a track is told over this management channel instead, on the poll the
     * device is making anyway.
     */
    private readonly lineInActivation?: LineInCommandSource,
    /**
     * Where a phone's now-playing goes.
     *
     * It rides the status poll rather than the audio stream because it is the phone's, not the
     * stream's: AVRCP keeps answering while the music is paused, which is exactly when someone looks
     * at the screen to see what stopped.
     */
    private readonly bluetoothInput?: BluetoothNowPlayingSink,
  ) {}

  public matches(pathname: string): boolean {
    return pathname.startsWith('/api/sonnclients');
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const normalized = this.normalizePath(pathname);
    if (!normalized) {
      this.sendJson(res, 404, { error: 'not-found' });
      return;
    }

    if (normalized === '/api/sonnclients') {
      if (req.method !== 'GET') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      this.sendJson(res, 200, { devices: this.listForAdmin() });
      return;
    }

    if (normalized === '/api/sonnclients/register') {
      if (req.method !== 'POST') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      await this.handleRegister(req, res);
      return;
    }

    const statusMatch = normalized.match(/^\/api\/sonnclients\/([^/]+)\/status$/);
    if (statusMatch) {
      if (req.method !== 'POST') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      await this.handleStatus(req, res, decodeURIComponent(statusMatch[1] ?? '').trim());
      return;
    }

    this.sendJson(res, 404, { error: 'not-found' });
  }

  // -------------------------------------------------------------- device-facing

  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req)) as RegisterPayload | null;
    const deviceId = (body?.device_id ?? '').trim();
    if (!deviceId) {
      this.sendJson(res, 400, { error: 'missing-device-id' });
      return;
    }

    const registration: Registration = {
      deviceId,
      agent: body?.agent,
      version: body?.version,
      hostname: body?.hostname,
      ip: body?.ip,
      mac: body?.mac,
      model: body?.model,
      os: body?.os,
      arch: body?.arch,
      outputs: Array.isArray(body?.outputs) ? body!.outputs! : [],
      inputs: Array.isArray(body?.inputs) ? body!.inputs! : [],
      capabilities: body?.capabilities ?? {},
      components: Array.isArray(body?.components) ? body!.components! : [],
      registeredAt: Date.now(),
    };
    this.registrations.set(deviceId, registration);

    const known = this.findDeviceConfig(deviceId) !== null;
    this.log.info('sonn client registered', {
      deviceId,
      hostname: registration.hostname,
      model: registration.model,
      outputs: registration.outputs.length,
      inputs: registration.inputs.length,
      configured: known,
    });
    // A device is written into the config on first sight so it shows up in the admin UI as
    // something waiting to be given a room. Nothing about what it plays is decided here.
    await this.rememberDevice(registration);
    this.sendJson(res, 200, this.buildDesiredState(deviceId, req));
  }

  private async handleStatus(
    req: IncomingMessage,
    res: ServerResponse,
    deviceId: string,
  ): Promise<void> {
    if (!deviceId) {
      this.sendJson(res, 400, { error: 'missing-device-id' });
      return;
    }
    const body = await this.readJsonBody(req);
    if (!body || typeof body !== 'object') {
      this.sendJson(res, 400, { error: 'invalid-body' });
      return;
    }
    const payload = body as StatusPayload;
    this.statusByDevice.set(deviceId, { payload, receivedAt: Date.now() });
    this.publishBluetoothNowPlaying(deviceId, payload);

    // The card lists only arrive when they changed, so an absent list means "as before" — keep the
    // one we have rather than replacing it with nothing.
    const registration = this.registrations.get(deviceId);
    if (registration) {
      if (Array.isArray(payload.outputs)) {
        registration.outputs = payload.outputs;
      }
      if (Array.isArray(payload.inputs)) {
        registration.inputs = payload.inputs;
      }
      if (Array.isArray(payload.components)) {
        registration.components = payload.components;
      }
      if (payload.version) {
        registration.version = payload.version;
      }
    }

    this.log.spam('sonn client status', {
      deviceId,
      state: payload.state,
      players: Array.isArray(payload.players) ? payload.players.length : 0,
      sources: Array.isArray(payload.sources) ? payload.sources.length : 0,
    });
    this.sendJson(res, 200, this.buildDesiredState(deviceId, req, { takeCommands: true }));
  }

  /**
   * The server's desired state for one device.
   *
   * Everything is derived from config on the spot rather than cached: it is a handful of objects,
   * and a cache would be one more thing that can disagree with what the UI just saved.
   */
  private buildDesiredState(
    deviceId: string,
    req: IncomingMessage,
    options: { takeCommands?: boolean } = {},
  ): Record<string, unknown> {
    const device = this.findDeviceConfig(deviceId);
    const section = this.configPort.getConfig().sonnClients ?? {};
    const enabled = device?.enabled !== false;

    return {
      device_name: device?.name,
      // Absent while the device is disabled: the client keeps polling and plays nothing, which is
      // exactly what "parked" should look like from the device's side.
      sendspin_url: enabled ? this.resolveSendspinUrl(req) : undefined,
      poll_interval_ms: this.resolvePollInterval(section.pollIntervalMs, device),
      players: enabled ? (device?.players ?? []).map((player) => this.mapPlayer(player)) : [],
      sources: enabled ? (device?.sources ?? []).map((source) => this.mapSource(source)) : [],
      beoremote: this.mapBeoremote(device),
      bluetooth: this.mapBluetooth(device),
      components: this.mapComponents(device, deviceId),
      commands: options.takeCommands ? this.takeCommands(deviceId) : [],
      // Transport for the gear on an input — start it, skip a track, pick a disc. Taken on the same
      // poll rather than pushed, because the device has no inbound channel for this: the protocol
      // has no source command at all, and that is what makes this a management concern.
      source_commands:
        enabled && options.takeCommands ? this.takeSourceCommands(device) : [],
    };
  }

  private mapPlayer(player: SonnClientPlayerConfig): Record<string, unknown> {
    return {
      client_id: player.clientId,
      name: player.name,
      output: player.output,
      enabled: player.enabled !== false,
      codecs: player.codecs,
      sample_rate: player.sampleRate,
      bit_depth: player.bitDepth,
      channels: player.channels,
      static_delay_ms: player.delayMs,
      volume: player.volume,
      muted: player.muted,
      buffer_ms: player.bufferMs,
      required_lead_time_ms: player.requiredLeadTimeMs,
      volume_hook: player.volumeHook,
      volume_control: player.volumeControl,
      mixer_element: player.mixerElement,
      mixer_mapped: player.mixerMapped,
    };
  }

  /**
   * One input, as the device should capture it.
   *
   * The format and the silence thresholds come from the line-in this source feeds, not from the
   * device entry. Both used to carry them, which meant the screen where you set them — the line-in,
   * where you are thinking about *this input* — wrote numbers nobody read, while the device quietly
   * ran on its own defaults. The same fact in two places is a bug waiting for someone to notice the
   * sample rate is not the one they typed.
   */
  private mapSource(source: SonnClientSourceConfig): Record<string, unknown> {
    const input = this.lineInFor(source.clientId);
    const pick = <T>(fromInput: T | undefined, fromDevice: T | undefined): T | undefined =>
      fromInput ?? fromDevice;

    return {
      client_id: source.clientId,
      name: source.name,
      input: source.input,
      enabled: source.enabled !== false,
      codec: pick(asString(input?.codec), source.codec),
      sample_rate: pick(asNumber(input?.sample_rate), source.sampleRate),
      bit_depth: pick(asNumber(input?.bit_depth), source.bitDepth),
      channels: pick(asNumber(input?.channels), source.channels),
      frame_ms: source.frameMs,
      threshold_db: pick(asNumber(input?.vad_threshold_db), source.thresholdDb),
      hold_ms: pick(asNumber(input?.vad_hold_ms), source.holdMs),
      controls: source.controls,
      control_hook: source.controlHook,
      always_on: source.alwaysOn,
    };
  }

  /**
   * Transport commands waiting for the inputs this device provides.
   *
   * Drained here, which is what acknowledges delivery: the queue exists because the alternative —
   * dropping a button press because the device was mid-poll — is the failure people notice.
   */
  private takeSourceCommands(
    device: SonnClientDeviceConfig | null,
  ): Array<Record<string, unknown>> {
    if (!this.lineInActivation || !device?.sources?.length) {
      return [];
    }
    const taken: Array<Record<string, unknown>> = [];
    for (const source of device.sources) {
      const input = this.lineInIdFor(source.clientId);
      if (!input) continue;
      for (const queued of this.lineInActivation.takeCommands(input)) {
        taken.push({
          client_id: source.clientId,
          command: queued.command,
          args: queued.args,
        });
      }
    }
    return taken;
  }

  /**
   * How long this device should wait before asking again.
   *
   * Faster while it provides an input a room is listening to, because that is when a button press
   * is waiting on the next poll: five seconds between "next" and the track changing is the
   * difference between a remote that works and one nobody uses. Back to the ordinary interval as
   * soon as the room moves on — there is nothing to be quick about then.
   */
  private pollIntervalFor(device: SonnClientDeviceConfig | null): number | null {
    if (!this.lineInActivation) return null;
    for (const source of device?.sources ?? []) {
      const input = this.lineInIdFor(source.clientId);
      if (input && this.lineInActivation.isActive(input)) {
        return ACTIVE_INPUT_POLL_INTERVAL_MS;
      }
    }
    return null;
  }

  /** The line-in id this Sendspin source provides audio for, if any. */
  private lineInIdFor(clientId: string): string | null {
    const inputs = this.configPort.getConfig().inputs?.lineIn?.inputs ?? [];
    for (const entry of inputs) {
      const source = (entry as { id?: string; source?: Record<string, unknown> }).source;
      const id = (entry as { id?: string }).id;
      if (!source || source.type !== 'sendspin' || typeof id !== 'string') continue;
      const client = (source.clientId ?? source.client_id) as string | undefined;
      if (typeof client === 'string' && client.trim() === clientId) {
        return id;
      }
    }
    return null;
  }

  /** The line-in whose audio this Sendspin source provides, if any. */
  private lineInFor(clientId: string): Record<string, unknown> | null {
    const inputs = this.configPort.getConfig().inputs?.lineIn?.inputs ?? [];
    for (const entry of inputs) {
      const source = (entry as { source?: Record<string, unknown> }).source;
      if (!source || source.type !== 'sendspin') continue;
      const id = (source.clientId ?? source.client_id) as string | undefined;
      if (typeof id === 'string' && id.trim() === clientId) {
        return source;
      }
    }
    return null;
  }

  /**
   * The remote this device runs, and the room it drives.
   *
   * The room comes from the zone that claimed this device's remote, not from the device entry:
   * which room a remote belongs to is a fact about the room. Pairing is a fact about the device and
   * stays on the device screen, which is the split the speakers already follow — one screen makes
   * the thing, the other puts it to work.
   */
  private mapBeoremote(device: SonnClientDeviceConfig | null): Record<string, unknown> | undefined {
    if (!device) return undefined;
    const config = this.configPort.getConfig();
    const zone = config.zones.find(
      (candidate) => candidate.inputs?.beoremote?.deviceId === device.deviceId,
    );
    const legacy = device.beoremote;

    // The device entry is still read for an installation configured before rooms could claim a
    // remote; nothing writes it any more.
    // A room that claimed this remote but switched it off is not driving anything.
    const claimed = zone?.inputs?.beoremote?.enabled === false ? undefined : zone?.id;
    const zoneId = claimed ?? (legacy?.enabled === true ? legacy.zoneId : undefined);
    if (typeof zoneId !== 'number') {
      return undefined;
    }
    // The room's name travels with it: the adapter carries one name, and everything a user sees --
    // the remote's product entry, the Bluetooth speaker, AirPlay, DLNA -- should be the room.
    const zoneName = zone?.name ?? config.zones.find((candidate) => candidate.id === zoneId)?.name;
    return {
      enabled: true,
      zone_id: zoneId,
      zone_name: zoneName,
      menu_poll_ms: legacy?.menuPollMs,
      volume_player: legacy?.volumePlayer,
      volume_step: zone?.inputs?.beoremote?.volumeStep ?? legacy?.volumeStep,
    };
  }

  /**
   * Bluetooth audio for the room that claimed this device's radio.
   *
   * Same split as the remote: the radio belongs to the device, the room decides whether it is used.
   * Nothing is received here — the client terminates A2DP and streams what it gets in as a source,
   * so what goes down is a switch, a name to be seen under, and how long to stay visible.
   */
  private publishBluetoothNowPlaying(deviceId: string, payload: StatusPayload): void {
    if (!this.bluetoothInput) return;
    const bluetooth = payload.bluetooth;
    if (!bluetooth || typeof bluetooth !== 'object') return;
    const playing = (bluetooth as { now_playing?: unknown }).now_playing;
    if (playing !== null && typeof playing !== 'object') return;
    this.bluetoothInput.updateNowPlaying(deviceId, playing as BluetoothNowPlaying | null);
  }

  private mapBluetooth(device: SonnClientDeviceConfig | null): Record<string, unknown> | undefined {
    if (!device) return undefined;
    const config = this.configPort.getConfig();
    const zone = config.zones.find(
      (candidate) => candidate.inputs?.bluetooth?.deviceId === device.deviceId,
    );
    const bluetooth = zone?.inputs?.bluetooth;
    if (!zone || bluetooth?.enabled !== true) {
      return undefined;
    }
    return {
      enabled: true,
      zone_id: zone.id,
      // The room's name is what someone looks for on their phone; the device's hostname means
      // nothing to them.
      name: bluetooth.publishName?.trim() || zone.name,
      // Named here so both ends spell it the same way: the device sends the decoded audio under
      // this id, and this end recognises it as the room's Bluetooth.
      client_id: bluetoothClientId(device.deviceId),
      discoverable_seconds: bluetooth.discoverableSeconds,
      pin: bluetooth.pin?.trim() || undefined,
      control: bluetooth.control !== false,
    };
  }

  /**
   * Components this device should have, with the artifact for *its* architecture resolved here.
   *
   * The client installs one file; picking which one is this end's job because only this end knows
   * what has been published. A component whose catalogue entry has no artifact for the device's
   * architecture is left out rather than sent without a URL — the client would refuse it anyway,
   * and refusing it here is where someone can see why.
   */
  private mapComponents(
    device: SonnClientDeviceConfig | null,
    deviceId: string,
  ): Array<Record<string, unknown>> {
    const catalogue = this.configPort.getConfig().sonnClients?.components ?? [];
    // The client itself goes to every device that has one, without being asked for: a park where
    // some speakers quietly stay behind on an old version is the thing a central version is for.
    const wanted = [...(device?.requiredComponents ?? [])];
    if (catalogue.some((entry) => entry.name === CLIENT_COMPONENT) && !wanted.includes(CLIENT_COMPONENT)) {
      wanted.push(CLIENT_COMPONENT);
    }
    if (!wanted.length) {
      return [];
    }
    const arch = this.resolveArch(deviceId);
    const resolved: Array<Record<string, unknown>> = [];

    for (const name of wanted) {
      const entry = catalogue.find((candidate) => candidate.name === name) as
        | SonnClientComponentConfig
        | undefined;
      if (!entry) {
        this.log.warn('sonn client wants a component that is not configured', { deviceId, name });
        continue;
      }
      const url = this.pickForArch(entry.urls, arch);
      const sha256 = this.pickForArch(entry.sha256, arch);
      if (!url || !sha256) {
        this.log.warn('no component artifact for this architecture', {
          deviceId,
          name,
          arch: arch ?? 'unknown',
        });
        continue;
      }
      resolved.push({ name, version: entry.version, url, sha256, enabled: true });
    }
    return resolved;
  }

  private pickForArch(
    map: Record<string, string> | undefined,
    arch: string | null,
  ): string | undefined {
    if (!map) {
      return undefined;
    }
    if (arch && map[arch]) {
      return map[arch];
    }
    return map.default;
  }

  /**
   * The device's architecture, for choosing a component artifact.
   *
   * Taken from what the client reports; older clients only sent an OS description with the
   * architecture at the end of it, so that is read as a fallback.
   */
  private resolveArch(deviceId: string): string | null {
    const registration = this.registrations.get(deviceId);
    const arch = registration?.arch?.trim();
    if (arch) {
      return arch;
    }
    const os = registration?.os?.trim();
    if (!os) {
      return null;
    }
    const known = ['aarch64', 'armv7l', 'armv7', 'arm', 'x86_64'];
    return known.find((candidate) => os.includes(candidate)) ?? null;
  }

  /**
   * WebSocket URL for the Sendspin gateway.
   *
   * Built from the request's own Host header, which is by definition an address the device just
   * reached us on — a reconstructed host:port is a guess, and on a machine with several interfaces
   * it is often the wrong one. Config and the local IP are the fallbacks, in that order.
   */
  private resolveSendspinUrl(req: IncomingMessage): string {
    const authority = (req.headers.host ?? '').trim();
    if (authority) {
      return `ws://${authority}${SENDSPIN_PATH}`;
    }
    const host = this.configPort.getConfig().system?.audioserver?.ip?.trim() || defaultLocalIp();
    return `ws://${host}:${this.httpPort}${SENDSPIN_PATH}`;
  }

  private resolvePollInterval(
    configured?: number,
    device?: SonnClientDeviceConfig | null,
  ): number {
    const active = this.pollIntervalFor(device ?? null);
    if (active !== null) {
      return active;
    }
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
      return DEFAULT_POLL_INTERVAL_MS;
    }
    return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.round(configured)));
  }

  // -------------------------------------------------------------- admin surface

  /** Everything the admin UI needs about every device it has ever seen or been configured with. */
  public listForAdmin(): SonnClientAdminView[] {
    const configured = this.configPort.getConfig().sonnClients?.devices ?? [];
    const ids = new Set<string>([
      ...configured.map((device) => device.deviceId),
      ...this.registrations.keys(),
    ]);
    return [...ids]
      .sort((a, b) => a.localeCompare(b))
      .map((deviceId) => this.viewForAdmin(deviceId));
  }

  public viewForAdmin(deviceId: string): SonnClientAdminView {
    const snapshot = this.statusByDevice.get(deviceId) ?? null;
    const receivedAt = snapshot?.receivedAt ?? 0;
    return {
      deviceId,
      online: receivedAt > 0 && Date.now() - receivedAt <= STATUS_STALE_MS,
      config: this.findDeviceConfig(deviceId),
      registration: this.registrations.get(deviceId) ?? null,
      status: snapshot?.payload ?? null,
      statusReceivedAt: receivedAt ? new Date(receivedAt).toISOString() : null,
      queuedCommands: [...(this.commandQueues.get(deviceId) ?? [])],
    };
  }

  public isKnown(deviceId: string): boolean {
    return this.registrations.has(deviceId) || this.findDeviceConfig(deviceId) !== null;
  }

  /** Queue a one-shot command for a device's next poll. */
  public queueCommand(deviceId: string, command: string, args: string[] = []): void {
    const trimmed = command.trim();
    if (!trimmed) {
      return;
    }
    const queue = this.commandQueues.get(deviceId) ?? [];
    queue.push({ command: trimmed, args });
    this.commandQueues.set(deviceId, queue);
    this.log.info('sonn client command queued', { deviceId, command: trimmed });
  }

  /** Forget a device: its config record, its registration and anything queued for it. */
  public async forget(deviceId: string): Promise<void> {
    await this.configPort.updateConfig((config) => {
      const devices = config.sonnClients?.devices;
      if (!devices) {
        return;
      }
      config.sonnClients!.devices = devices.filter((device) => device.deviceId !== deviceId);
    });
    this.registrations.delete(deviceId);
    this.statusByDevice.delete(deviceId);
    this.commandQueues.delete(deviceId);
    this.log.info('sonn client forgotten', { deviceId });
  }

  /** Client ids this device would claim, so a caller can check them against zone assignments. */
  public clientIdsFor(deviceId: string): string[] {
    const device = this.findDeviceConfig(deviceId);
    if (!device) {
      return [];
    }
    return [
      ...(device.players ?? []).map((player) => player.clientId),
      ...(device.sources ?? []).map((source) => source.clientId),
    ].filter((clientId) => typeof clientId === 'string' && clientId.trim().length > 0);
  }

  // -------------------------------------------------------------- internals

  private takeCommands(deviceId: string): QueuedCommand[] {
    const queue = this.commandQueues.get(deviceId);
    if (!queue?.length) {
      return [];
    }
    this.commandQueues.delete(deviceId);
    return queue;
  }

  private findDeviceConfig(deviceId: string): SonnClientDeviceConfig | null {
    const devices = this.configPort.getConfig().sonnClients?.devices;
    if (!Array.isArray(devices)) {
      return null;
    }
    return devices.find((device) => device.deviceId === deviceId) ?? null;
  }

  /**
   * Write the device's identity into the config, so a device that is currently off still appears in
   * the UI with the name it had.
   *
   * Only when something actually changed. A device re-registers on every reconnect, and rewriting
   * the config file for an unchanged record would turn a flapping network into disk churn.
   */
  private async rememberDevice(registration: Registration): Promise<void> {
    const existing = this.findDeviceConfig(registration.deviceId);
    const identity = {
      hostname: registration.hostname,
      ip: registration.ip,
      mac: registration.mac,
      model: registration.model,
      version: registration.version,
    };
    const unchanged =
      existing &&
      existing.hostname === identity.hostname &&
      existing.ip === identity.ip &&
      existing.mac === identity.mac &&
      existing.model === identity.model &&
      existing.version === identity.version;
    if (unchanged) {
      return;
    }

    await this.configPort.updateConfig((config) => {
      config.sonnClients = config.sonnClients ?? {};
      config.sonnClients.devices = config.sonnClients.devices ?? [];
      const devices = config.sonnClients.devices;
      const index = devices.findIndex((device) => device.deviceId === registration.deviceId);
      const existingRecord = index >= 0 ? devices[index] : undefined;
      const record: SonnClientDeviceConfig = {
        ...existingRecord,
        deviceId: registration.deviceId,
        ...identity,
        lastSeen: new Date().toISOString(),
      };
      if (index >= 0) {
        devices[index] = record;
      } else {
        devices.push(record);
      }
    });
  }

  private normalizePath(pathname: string): string | null {
    const raw = (pathname.split('?')[0] ?? '').trim();
    if (!raw.startsWith('/api/sonnclients')) {
      return null;
    }
    return raw.replace(/\/+$/, '') || '/api/sonnclients';
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown | null> {
    const chunks: Buffer[] = [];
    return new Promise((resolve) => {
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body, (_key, value) => (value === undefined ? undefined : value));
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
