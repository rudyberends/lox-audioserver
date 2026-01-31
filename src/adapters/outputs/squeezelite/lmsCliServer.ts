import http from 'node:http';
import net from 'node:net';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import { PlayerState, type SlimClient, type MediaDetails } from '@lox-audioserver/node-slimproto';

type JsonRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: [string, Array<string | number>];
};

export class LmsCliServer {
  private readonly log = createLogger('Output', 'SqueezeliteCLI');
  private telnetServer: net.Server | null = null;
  private jsonServer: http.Server | null = null;

  constructor(
    private readonly squeezeliteCore: SqueezeliteCore,
    private readonly configPort: ConfigPort,
  ) {}

  public async start(): Promise<void> {
    const config = this.configPort.getSystemConfig();
    const telnetPort = normalizePort(config?.audioserver?.slimprotoCliPort);
    const jsonPort = normalizePort(config?.audioserver?.slimprotoJsonPort);

    if (telnetPort) {
      this.telnetServer = net.createServer((socket) => this.handleTelnetClient(socket));
      await new Promise<void>((resolve, reject) => {
        this.telnetServer
          ?.once('error', reject)
          .listen(telnetPort, '0.0.0.0', () => resolve());
      });
      this.log.info('LMS CLI (telnet) listening', { port: telnetPort });
    }

    if (jsonPort) {
      this.jsonServer = http.createServer((req, res) => {
        this.handleJsonRpcRequest(req, res).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.debug('jsonrpc request failed', { message });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: 'jsonrpc-error' }));
        });
      });
      await new Promise<void>((resolve, reject) => {
        this.jsonServer
          ?.once('error', reject)
          .listen(jsonPort, '0.0.0.0', () => resolve());
      });
      this.log.info('LMS JSON-RPC listening', { port: jsonPort });
    }
  }

  public async stop(): Promise<void> {
    if (this.telnetServer) {
      await new Promise<void>((resolve) => this.telnetServer?.close(() => resolve()));
      this.telnetServer = null;
    }
    if (this.jsonServer) {
      await new Promise<void>((resolve) => this.jsonServer?.close(() => resolve()));
      this.jsonServer = null;
    }
  }

  public async handleJsonRpcRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }

    const body = await readBody(req);
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid-json' }));
      return;
    }

    let payload: JsonRpcRequest | JsonRpcRequest[];
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid-json' }));
      return;
    }

    const responses: Array<Record<string, unknown>> = [];
    const requests = Array.isArray(payload) ? payload : [payload];
    for (const request of requests) {
      if (!request || request.method !== 'slim.request' || !request.params) {
        responses.push({ id: request?.id ?? null, error: 'unsupported-method' });
        continue;
      }
      const [playerId, args] = request.params;
      const result = await this.handleCommand(playerId, args);
      responses.push({ id: request.id ?? null, result });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
  }

  private handleTelnetClient(socket: net.Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (!raw) continue;
        void this.handleCliLine(raw).then((response) => {
          if (response) {
            socket.write(response + '\n');
          }
        });
      }
    });
  }

  private async handleCliLine(line: string): Promise<string | null> {
    const parts = line
      .trim()
      .split(/\s+/)
      .map((part) => decodeURIComponent(part));
    if (parts.length === 0) return null;
    let playerId = '';
    let command = '';
    let args: Array<string | number> = [];
    if (isPlayerId(parts[0])) {
      playerId = parts.shift() ?? '';
    }
    command = parts.shift() ?? '';
    args = parts.map((arg) => (isNumeric(arg) ? Number(arg) : arg));
    if (!command) return null;
    const result = await this.handleCommand(playerId, [command, ...args]);
    return formatCliResponse(playerId, command, result);
  }

  private async handleCommand(
    playerId: string,
    args: Array<string | number>,
  ): Promise<Record<string, unknown> | null> {
    const command = String(args[0] ?? '').toLowerCase();
    const cmdArgs = args.slice(1);
    switch (command) {
      case 'players':
        return this.handlePlayers(cmdArgs);
      case 'status':
        return this.handleStatus(playerId, cmdArgs);
      case 'serverstatus':
        return this.handleServerStatus(cmdArgs);
      case 'mixer':
        return this.handleMixer(playerId, cmdArgs);
      case 'time':
        return this.handleTime(playerId, cmdArgs);
      case 'power':
        return this.handlePower(playerId, cmdArgs);
      case 'play':
      case 'pause':
      case 'stop':
      case 'playlist':
      case 'menu':
      case 'menustatus':
      case 'displaystatus':
      case 'date':
      case 'artworkspec':
      case 'firmwareupgrade':
        return this.handleSimple(command, playerId, cmdArgs);
      default:
        return {};
    }
  }

  private handlePlayers(args: Array<string | number>): Record<string, unknown> {
    const startIndex = toNumber(args[0], 0);
    const limit = toNumber(args[1], 999);
    const players = this.squeezeliteCore.players
      .slice(startIndex, startIndex + limit)
      .map((player, idx) => buildPlayerItem(startIndex + idx, player));
    return {
      count: players.length,
      players_loop: players,
    };
  }

  private handleStatus(
    playerId: string,
    args: Array<string | number>,
  ): Record<string, unknown> | null {
    const player = this.squeezeliteCore.getPlayer(playerId);
    if (!player) return null;
    const menu = String(args[2] ?? '');
    const playlistItems = player.currentMedia ? [player.currentMedia] : [];
    const current = playlistItems[0];
    const base: Record<string, unknown> = {
      player_name: player.name,
      player_connected: Number(player.connected),
      player_needs_upgrade: false,
      player_is_upgrading: false,
      power: Number(player.connected),
      signalstrength: 0,
      waitingToPlay: 0,
    };

    const mode = mapPlayerState(player.state);
    const extended: Record<string, unknown> = {
      mode,
      remote: 1,
      current_title: this.serverName,
      time: Math.floor(player.elapsedMilliseconds / 1000),
      duration: current?.metadata?.duration ?? 0,
      sync_master: '',
      sync_slaves: '',
      'mixer volume': player.volumeLevel,
      player_ip: player.deviceAddress,
      playlist_cur_index: 0,
      playlist_tracks: playlistItems.length,
      playlist_loop: playlistItems.map((item, index) => buildPlaylistItem(index, item)),
    };

    if (menu === 'menu') {
      return {
        ...base,
        ...extended,
        alarm_state: 'none',
        alarm_snooze_seconds: 540,
        alarm_timeout_seconds: 3600,
        count: playlistItems.length,
        offset: args[0] ?? '-'
      };
    }

    return { ...base, ...extended };
  }

  private handleServerStatus(_args: Array<string | number>): Record<string, unknown> {
    const config = this.configPort.getSystemConfig();
    const httpPort = normalizePort(config?.audioserver?.slimprotoJsonPort) ?? 9000;
    const ip = config?.audioserver?.ip ?? '127.0.0.1';
    const players = this.squeezeliteCore.players.map((player, index) =>
      buildPlayerItem(index, player),
    );
    return {
      httpport: httpPort,
      ip,
      version: '7.999.999',
      uuid: 'lox-audioserver',
      'info total duration': 0,
      'info total genres': 0,
      'sn player count': 0,
      lastscan: Math.floor(Date.now() / 1000),
      'info total albums': 0,
      'info total songs': 0,
      'info total artists': 0,
      players_loop: players,
      'player count': players.length,
      'other player count': 0,
      other_players_loop: [],
    };
  }

  private async handleMixer(
    playerId: string,
    args: Array<string | number>,
  ): Promise<Record<string, unknown> | null> {
    const player = this.squeezeliteCore.getPlayer(playerId);
    if (!player) return null;
    const subcommand = String(args[0] ?? '');
    const arg = args[1];
    if (subcommand === 'volume') {
      if (arg === '?') return { _mixer: player.volumeLevel };
      if (typeof arg === 'number') {
        await player.volumeSet(Math.max(0, Math.min(100, Math.round(arg))));
      }
    }
    if (subcommand === 'muting') {
      if (arg === '?') return { _mixer: Number(player.connected ? 0 : 1) };
      if (typeof arg === 'number') {
        await player.mute(Boolean(arg));
      }
    }
    return {};
  }

  private handleTime(
    playerId: string,
    args: Array<string | number>,
  ): Record<string, unknown> | null {
    const player = this.squeezeliteCore.getPlayer(playerId);
    if (!player) return null;
    if (args[0] === '?') {
      return { _time: Math.floor(player.elapsedMilliseconds / 1000) };
    }
    return {};
  }

  private async handlePower(
    playerId: string,
    args: Array<string | number>,
  ): Promise<Record<string, unknown> | null> {
    const player = this.squeezeliteCore.getPlayer(playerId);
    if (!player) return null;
    if (args[0] === '?') {
      return { _power: Number(player.connected) };
    }
    return {};
  }

  private handleSimple(
    command: string,
    playerId: string,
    _args: Array<string | number>,
  ): Record<string, unknown> | null {
    if (command === 'date') {
      return { date_epoch: Math.floor(Date.now() / 1000), date: new Date().toISOString() };
    }
    if (command === 'firmwareupgrade') {
      return { firmwareUpgrade: 0 };
    }
    if (command === 'artworkspec') {
      return null;
    }
    if (!playerId && command !== 'serverstatus') {
      return {};
    }
    return {};
  }

  private get serverName(): string {
    return this.configPort.getSystemConfig()?.audioserver?.name || 'Loxone Audio Server';
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function normalizePort(value?: number | null): number | null {
  if (!value || !Number.isFinite(value) || value <= 0 || value > 65535) return null;
  return Math.trunc(value);
}

function toNumber(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function buildPlaylistItem(index: number, media: MediaDetails): Record<string, unknown> {
  const meta = media.metadata ?? {};
  return {
    'playlist index': index,
    id: '-187651250107376',
    url: media.url,
    title: meta.title || media.url,
    artist: meta.artist || '',
    album: meta.album || '',
    remote: 1,
    artwork_url: meta.image_url || '',
    coverid: '-187651250107376',
    duration: meta.duration ?? '',
    bitrate: '',
    samplerate: '',
    samplesize: '',
  };
}

function buildPlayerItem(index: number, player: SlimClient): Record<string, unknown> {
  const seqNo = String(Math.floor(Date.now() / 1000));
  const uuid = player.playerId.replace(/[:\-]/g, '');
  return {
    playerindex: String(index),
    playerid: player.playerId,
    name: player.name,
    modelname: player.deviceType,
    connected: Number(player.connected),
    isplaying: player.state === PlayerState.PLAYING ? 1 : 0,
    power: Number(player.connected),
    model: player.deviceType,
    canpoweroff: 1,
    firmware: player.firmware,
    isplayer: 1,
    displaytype: 'none',
    uuid,
    seq_no: seqNo,
    sequenceNumber: seqNo,
    ip: player.deviceAddress,
  };
}

function mapPlayerState(state: PlayerState): string {
  switch (state) {
    case PlayerState.PLAYING:
    case PlayerState.BUFFER_READY:
    case PlayerState.BUFFERING:
      return 'play';
    case PlayerState.PAUSED:
      return 'pause';
    case PlayerState.STOPPED:
    default:
      return 'stop';
  }
}

function isPlayerId(value: string): boolean {
  return /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(value);
}

function isNumeric(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}

function formatCliResponse(
  playerId: string,
  command: string,
  data: Record<string, unknown> | null,
): string {
  const parts = [playerId || '', command].filter(Boolean);
  if (data) {
    parts.push(...flattenCliData(data));
  }
  return parts.join(' ').trim();
}

function flattenCliData(source: Record<string, unknown>): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          result.push(...flattenCliData(item as Record<string, unknown>));
        } else {
          result.push(String(item));
        }
      }
      continue;
    }
    if (typeof value === 'object') {
      result.push(...flattenCliData(value as Record<string, unknown>));
      continue;
    }
    result.push(`${key}:${value}`);
  }
  return result;
}
