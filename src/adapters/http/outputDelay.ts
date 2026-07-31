/**
 * Setting a zone's output delay, in one place.
 *
 * How much delay a speaker's own chain adds after its audio output — an amplifier, an active
 * speaker. The client compensates by playing that much *earlier*, which is what lines a room up
 * that arrives late; it is not an offset that holds a room back, and the protocol has no negative
 * form for one.
 *
 * Two things have to happen together and neither is optional: the value is persisted to the zone's
 * output config so it survives a restart, and it is pushed to the live output so it takes effect
 * now — Sendspin sends it to the client as `set_static_delay`, with no stream restart. Pushing it is
 * the intended route: these clients usually run headless, and `supported_commands` exists so a panel
 * can tune them all from one screen.
 *
 * It lives in the HTTP adapter layer, beside the two transports that set it — the admin UI and the
 * public API — because it knows the *shape of the persisted config*, which is an adapter's business
 * and not the application's. Written twice it
 * would be two settings writes that could disagree about which config mirrors to update, and the
 * mirroring is the fiddly part — a zone's output can appear as `output`, as `transports[0]` and as
 * the legacy primary, and a value written to only some of them comes back different after a
 * restart. That is exactly the failure this session already paid for once in the engine's source
 * mapping.
 */
import type { ConfigPort } from '@/ports/ConfigPort';
import { getZoneOutputConfig } from '@/adapters/http/adminApi/config/configHandlers';
import { parseSendspinSatellites } from '@/adapters/outputs/factory';

/**
 * Bounds for the value. Wider than Sendspin's own 0–5000 accepts, because this clamp guards the
 * config against nonsense while each output narrows it to what its protocol allows.
 */
export const OUTPUT_DELAY_MIN_MS = 0;
export const OUTPUT_DELAY_MAX_MS = 10_000;

export type OutputDelaySetter = {
  configPort: ConfigPort;
  setOutputLatency: (zoneId: number, latencyMs: number, clientId?: string) => boolean;
};

/** Clamps to the supported range, or null when the input is not a number at all. */
export function parseOutputDelayMs(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(OUTPUT_DELAY_MIN_MS, Math.min(OUTPUT_DELAY_MAX_MS, Math.round(value)));
}

/**
 * Persist and apply a zone's output delay.
 *
 * `clientId` targets one Sendspin satellite's own delay instead of the zone's output — a subwoofer
 * needs a different offset from the speakers it sits under. `applied` is false when no live output
 * took the value (the zone is configured but its output does not support a delay, or the named
 * satellite does not exist); the config is written either way, so a device that connects later
 * still gets it.
 */
export async function setOutputDelayMs(
  deps: OutputDelaySetter,
  zoneId: number,
  delayMs: number,
  clientId?: string | null,
): Promise<{ delayMs: number; applied: boolean }> {
  const target = clientId?.trim() ? clientId.trim() : null;

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

    if (target) {
      // Update just this satellite's delay in the rich array (normalised across mirrors).
      const primaryClientId = typeof primary.clientId === 'string' ? primary.clientId : '';
      const sats = parseSendspinSatellites(primary.satellites, primaryClientId);
      const next = sats.map((s) => (s.clientId === target ? { ...s, latencyMs: delayMs } : s));
      for (const m of mirrors) m.satellites = next;
    } else {
      for (const m of mirrors) m.latencyMs = delayMs;
    }
  });

  const applied = deps.setOutputLatency(zoneId, delayMs, target ?? undefined);
  return { delayMs, applied };
}
