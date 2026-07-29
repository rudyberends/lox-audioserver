import type { StreamingServiceConfig } from '@/domain/config/types';
import { parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import { slugFromBridgeId } from '@/domain/media/serviceIdentity';

/**
 * Bridge-identity translation between the SERVICE-NATIVE core audiopath form
 * (`<service>[:<acct>]:<kind>:<id>`) and the Loxone-facing disguise form
 * (`spotify@<bridgeId>:<kind>:<id>`).
 *
 * The real Loxone Audio Server knows only Spotify as a native streaming service.
 * Non-Spotify services are exposed to Loxone by "bridging" them under a
 * `spotify@bridge-<service>-<slug>` provider id. The core speaks service-native, so
 * these pure functions are the single place that converts between the two, backed by
 * the bridge registry derived from `content.streamingServices`.
 *
 * It sits in the domain rather than the Loxone adapter because both directions have a
 * caller outside that adapter: anything accepting an inbound path has to normalise it
 * to service-native (`toServiceNative`), and the registry type is part of
 * `ContentPort`. Only `toLoxoneAudiopath` is adapter-only. They import nothing from
 * config or adapters; the caller (which owns ConfigPort) supplies the registry.
 */

export interface BridgeRegistry {
  /** Forward: `<service>:<slug>` → bridge config. */
  byServiceSlug: Map<string, StreamingServiceConfig>;
  /** Reverse: Loxone bridge id → { service, slug }. */
  byBridgeId: Map<string, { service: string; slug: string }>;
  /** Per-service account count, to decide slug-omission eligibility. */
  accountCountByService: Map<string, number>;
}

const serviceSlugKey = (service: string, slug: string): string =>
  `${service.toLowerCase()}:${slug}`;

/**
 * Build the bidirectional bridge registry from the configured bridges. Pure —
 * consumes only the bridge list. Disabled bridges are skipped.
 */
export function buildBridgeRegistry(
  bridges: readonly StreamingServiceConfig[] | undefined | null,
): BridgeRegistry {
  const byServiceSlug = new Map<string, StreamingServiceConfig>();
  const byBridgeId = new Map<string, { service: string; slug: string }>();
  const accountCountByService = new Map<string, number>();
  if (Array.isArray(bridges)) {
    for (const bridge of bridges) {
      if (!bridge || bridge.enabled === false || !bridge.id || !bridge.provider) {
        continue;
      }
      const service = bridge.provider.toLowerCase();
      const slug = slugFromBridgeId(bridge.id, service);
      byServiceSlug.set(serviceSlugKey(service, slug), bridge);
      byBridgeId.set(bridge.id, { service, slug });
      accountCountByService.set(service, (accountCountByService.get(service) ?? 0) + 1);
    }
  }
  return { byServiceSlug, byBridgeId, accountCountByService };
}

const BRIDGE_PREFIX_RE = /^spotify@(bridge-[^:]+):/i;

/**
 * Loxone form → service-native form.
 * `spotify@bridge-applemusic-p0gngd:track:X` → `applemusic:p0gngd:track:X`.
 *
 * Genuine Spotify (`spotify@<realAccount>` that is not a known bridge, and bare
 * `spotify:`) and any already-service-native or non-Spotify path pass through
 * unchanged. The base64 id and `library-*` kinds are preserved verbatim.
 */
export function toServiceNative(loxoneAudiopath: string, registry: BridgeRegistry): string {
  const raw = (loxoneAudiopath || '').trim();
  if (!raw) {
    return loxoneAudiopath;
  }
  const match = BRIDGE_PREFIX_RE.exec(raw);
  if (!match) {
    return raw;
  }
  const bridgeId = match[1]!;
  const ref = registry.byBridgeId.get(bridgeId);
  if (!ref) {
    // Not a registered bridge — leave untouched (genuine spotify account, or an
    // unknown/stale bridge id we must not corrupt).
    return raw;
  }
  const rest = raw.slice(match[0].length); // `<kind>:<id>`
  const single = (registry.accountCountByService.get(ref.service) ?? 0) <= 1;
  const prefix = single ? ref.service : `${ref.service}:${ref.slug}`;
  return `${prefix}:${rest}`;
}

/**
 * Service-native form → Loxone form.
 * `applemusic:p0gngd:track:X` → `spotify@bridge-applemusic-p0gngd:track:X`.
 *
 * When the slug is omitted, resolves the sole account of that service. The bridge
 * id is taken from the registry (authoritative — never string-concatenated), so a
 * non-conforming/renamed bridge id still resolves. Genuine `spotify:`/`spotify@`,
 * and any path that does not map to a registered bridge, pass through unchanged.
 */
export function toLoxoneAudiopath(serviceNative: string, registry: BridgeRegistry): string {
  const raw = (serviceNative || '').trim();
  if (!raw) {
    return serviceNative;
  }
  const parsed = parseServiceNativeAudiopath(raw);
  if (!parsed) {
    return raw;
  }
  const { service, slug, kind, isLibrary, id } = parsed;
  // Real Spotify has no bridge — leave it in its native spotify form.
  if (service === 'spotify') {
    return raw;
  }
  let bridge: StreamingServiceConfig | undefined;
  if (slug) {
    bridge = registry.byServiceSlug.get(serviceSlugKey(service, slug));
  } else if ((registry.accountCountByService.get(service) ?? 0) === 1) {
    // Sole account for this service.
    for (const [, ref] of registry.byBridgeId) {
      if (ref.service === service) {
        bridge = registry.byServiceSlug.get(serviceSlugKey(service, ref.slug));
        break;
      }
    }
  }
  if (!bridge) {
    // Unknown (service, slug) — do not fabricate a bridge id; pass through.
    return raw;
  }
  const kindSegment = isLibrary ? `library-${kind}` : kind;
  return `spotify@${bridge.id}:${kindSegment}:${id}`;
}
