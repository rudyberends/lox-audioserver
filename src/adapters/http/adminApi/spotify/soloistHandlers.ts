import type { IncomingMessage, ServerResponse } from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import {
  isZonePaired,
  probeBinary,
  soloistBinaryPath,
} from '@/adapters/inputs/spotify/soloist/soloistProcess';
import {
  extractSoloistFromArchive,
  looksGzipped,
} from '@/adapters/inputs/spotify/soloist/soloistArchive';

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
  // Which client plays is one choice for the whole server; a zone appears here only because
  // Soloist has to be paired once per room, whatever that choice is.
  const zones = await Promise.all(
    (cfg.zones ?? []).map(async (zone) => ({
      zoneId: zone.id,
      name: zone.name,
      paired: await isZonePaired(zone.id),
    })),
  );
  deps.sendJson(res, 200, {
    ok: true,
    enabled: settings.enabled === true,
    hasApiKey: Boolean(settings.apiKey?.trim()),
    expiry: settings.expiry ?? null,
    hostArch: hostArch(),
    binary,
    zones,
  });
}

/** Store the personal API key. Never defaulted and never shipped — Spotify ties it to one person. */
export async function handleSoloistSettings(
  res: ServerResponse,
  deps: SoloistHandlerDeps,
  body: { enabled?: boolean; apiKey?: string } | null,
): Promise<void> {
  await deps.configPort.updateConfig((cfg) => {
    const spotify = cfg.content?.spotify;
    if (!spotify) {
      return;
    }
    const next = { ...(spotify.soloist ?? {}) };
    if (typeof body?.enabled === 'boolean') {
      next.enabled = body.enabled;
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
