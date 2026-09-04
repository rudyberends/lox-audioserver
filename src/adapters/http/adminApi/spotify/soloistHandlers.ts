import type { IncomingMessage, ServerResponse } from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import {
  probeBinary,
  soloistBinaryPath,
} from '@/adapters/inputs/spotify/soloist/soloistProcess';
import {
  cancelAccountPairing,
  pairingSnapshot,
  startAccountPairing,
} from '@/adapters/inputs/spotify/soloist/soloistPairing';
import {
  extractSoloistFromArchive,
  looksGzipped,
} from '@/adapters/inputs/spotify/soloist/soloistArchive';
import { buildUrlForHost } from '@/adapters/inputs/spotify/soloist/soloistUpdater';

const log = createLogger('Content', 'Soloist');

/** Generous enough for any published build (the arm64 one is ~33 MB) without inviting a disk fill. */
const MAX_BINARY_BYTES = 200 * 1024 * 1024;

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
/** `e_machine` values for the architectures Spotify publishes, so a mismatch is caught on upload. */
const ELF_MACHINE = { 0x28: 'armv7l', 0xb7: 'arm64', 0x3e: 'x86_64' } as const;

function hostArch(): string {
  switch (process.arch) {
    case 'arm64':
      return 'arm64';
    case 'arm':
      return 'armv7l';
    case 'x64':
      return 'x86_64';
    default:
      return process.arch;
  }
}

/**
 * Read the architecture out of an ELF header.
 *
 * Uploading the x86_64 build to a Pi is the likeliest mistake anyone will make here, and left
 * unchecked it surfaces much later as `Exec format error` at the moment music was supposed to
 * start — from which nobody can work out what they did wrong.
 */
function readElfArch(buffer: Buffer): { ok: boolean; arch?: string } {
  if (buffer.length < 20 || !buffer.subarray(0, 4).equals(ELF_MAGIC)) {
    return { ok: false };
  }
  const machine = buffer.readUInt16LE(18);
  return { ok: true, arch: (ELF_MACHINE as Record<number, string>)[machine] };
}

export type SoloistHandlerDeps = {
  configPort: ConfigPort;
  spotifyInputService: SpotifyInputService;
  readBinaryBody: (req: IncomingMessage, res: ServerResponse, maxBytes: number) => Promise<Buffer | null>;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/** What the setup screen needs to tell the user which step is still missing. */
export async function handleSoloistStatus(
  res: ServerResponse,
  deps: SoloistHandlerDeps,
): Promise<void> {
  const cfg = deps.configPort.getConfig();
  const settings = cfg.content?.spotify?.soloist ?? {};
  const binary = await probeBinary();
  // Accounts, not rooms. A room signs itself in — it advertises and whoever picks it in their own
  // Spotify app is the one who takes it — but playback this server drives has nobody to ask at the
  // moment a track starts, so each account is signed in once, here.
  const accounts = (await deps.spotifyInputService.soloistAccounts()).map((account) => ({
    ...account,
    pairing: pairingSnapshot(account.id) ?? { state: 'idle' as const },
  }));
  deps.sendJson(res, 200, {
    ok: true,
    // The key is the switch: with one there is Spotify, without one there is not.
    hasApiKey: Boolean(settings.apiKey?.trim()),
    lossless: settings.lossless !== false,
    expiry: settings.expiry ?? null,
    // Where the program comes from now: this server fetches it, so the screen can say when it last
    // looked rather than asking anyone to keep track of a 90-day clock.
    build: settings.build ?? null,
    autoUpdates: buildUrlForHost() !== null,
    hostArch: hostArch(),
    binary,
    accounts,
  });
}

/** Store the personal API key. Never defaulted and never shipped — Spotify ties it to one person. */
export async function handleSoloistSettings(
  res: ServerResponse,
  deps: SoloistHandlerDeps,
  body: { apiKey?: string; lossless?: boolean } | null,
): Promise<void> {
  await deps.configPort.updateConfig((cfg) => {
    const spotify = cfg.content?.spotify;
    if (!spotify) {
      return;
    }
    const next = { ...(spotify.soloist ?? {}) };
    if (typeof body?.lossless === 'boolean') {
      next.lossless = body.lossless;
    }
    if (typeof body?.apiKey === 'string') {
      const trimmed = body.apiKey.trim();
      if (trimmed) {
        next.apiKey = trimmed;
      } else {
        delete next.apiKey;
      }
    }
    spotify.soloist = next;
  });
  // Config alone changes nothing: the zones are given their players by syncZones, which otherwise
  // only runs on a restart. Without this, switching player in the screen did nothing until
  // something else happened to reload the zones — and every room quietly left the Spotify app.
  const cfg = deps.configPort.getConfig();
  deps.spotifyInputService.syncZones(cfg.zones ?? [], cfg.inputs?.spotify ?? null);
  await handleSoloistStatus(res, deps);
}

/**
 * Accept the user's own Soloist build.
 *
 * Uploading rather than downloading is what keeps this legitimate: Spotify forbids redistributing
 * the binary, so it can never ship in the image or be fetched on the user's behalf. They download
 * it themselves and hand it over, the same shape the Widevine artefacts already use.
 */
export async function handleSoloistBinaryUpload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SoloistHandlerDeps,
): Promise<void> {
  const body = await deps.readBinaryBody(req, res, MAX_BINARY_BYTES);
  if (res.writableEnded) {
    return;
  }
  if (!body || body.length === 0) {
    deps.sendJson(res, 400, { error: 'empty-body' });
    return;
  }

  // Spotify hands out a .tar.gz, so take that too rather than making unpacking the user's
  // problem — on Windows especially, it is a step with nothing to do with playing music.
  let program = body;
  if (looksGzipped(body)) {
    const extracted = (() => {
      try {
        return extractSoloistFromArchive(body);
      } catch {
        return null;
      }
    })();
    if (!extracted) {
      deps.sendJson(res, 400, {
        error: 'no-soloist-in-archive',
        hint: 'That archive holds no file called soloist.',
      });
      return;
    }
    program = extracted;
  }

  const elf = readElfArch(program);
  if (!elf.ok) {
    deps.sendJson(res, 400, {
      error: 'not-an-executable',
      hint: 'Upload the soloist program, or the .tar.gz it came in.',
    });
    return;
  }
  if (elf.arch && elf.arch !== hostArch()) {
    deps.sendJson(res, 400, {
      error: 'wrong-architecture',
      uploaded: elf.arch,
      expected: hostArch(),
    });
    return;
  }

  const target = soloistBinaryPath();
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, program, { mode: 0o700 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('storing the soloist binary failed', { message });
    deps.sendJson(res, 500, { error: 'store-failed', message });
    return;
  }

  // Run it once now rather than discovering at play time that it does not work on this host.
  const binary = await probeBinary();
  log.info('soloist binary stored', { version: binary.version, arch: elf.arch });
  await handleSoloistStatus(res, deps);
}


/** Start signing an account's playback store in, and report on one already under way. */
export async function handleSoloistPairing(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SoloistHandlerDeps,
): Promise<void> {
  const cfg = deps.configPort.getConfig();
  const settings = cfg.content?.spotify?.soloist ?? {};

  if (req.method === 'GET') {
    const { searchParams } = new URL(req.url ?? '', 'http://localhost');
    const accountId = (searchParams.get('accountId') || '').trim();
    if (!accountId) {
      deps.sendJson(res, 400, { error: 'missing-account' });
      return;
    }
    deps.sendJson(res, 200, { ok: true, ...(pairingSnapshot(accountId) ?? { state: 'idle' }) });
    return;
  }

  const body = (await deps.readJsonBody(req, res)) as
    | { accountId?: string; deviceName?: string; timeoutMs?: number; cancel?: boolean }
    | null;
  if (res.writableEnded) {
    return;
  }
  const accountId = (body?.accountId || '').trim();
  if (!accountId) {
    deps.sendJson(res, 400, { error: 'missing-account' });
    return;
  }
  if (body?.cancel) {
    cancelAccountPairing(accountId);
    deps.sendJson(res, 200, { ok: true, state: 'idle' });
    return;
  }
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) {
    deps.sendJson(res, 400, { error: 'no-api-key' });
    return;
  }
  const binary = await probeBinary();
  if (!binary.present || !binary.executable) {
    deps.sendJson(res, 400, { error: 'no-binary' });
    return;
  }
  const accounts = await deps.spotifyInputService.soloistAccounts();
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) {
    deps.sendJson(res, 404, { error: 'account-not-found' });
    return;
  }
  // Named after the account rather than the server, because this is what the listener is about to
  // pick out of a device list that may already hold every room in the house.
  const deviceName = (body?.deviceName || '').trim() || `Sonn — ${account.label}`;
  // Which Spotify account this one is supposed to be, so signing in from the wrong app is caught
  // rather than quietly leaving a store that browses as one person and plays as another.
  const expectedSpotifyId = (cfg.content?.spotify?.accounts ?? [])
    .find((entry) => entry.id === accountId)?.spotifyId?.trim();
  const state = await startAccountPairing({
    accountId,
    apiKey,
    deviceName,
    ...(expectedSpotifyId ? { expectedSpotifyId } : {}),
    ...(typeof body?.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
  });
  log.info('soloist pairing offered', { accountId, deviceName });
  deps.sendJson(res, 202, { ok: true, ...state });
}
