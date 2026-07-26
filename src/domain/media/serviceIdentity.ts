import type { StreamingServiceConfig } from '@/domain/config/types';

/**
 * How a configured streaming account is named outside the Loxone adapter.
 *
 * A configured account has two names. Its Loxone one is `bridge-<service>-<slug>`
 * — "bridge" because the real Loxone Audio Server knows only Spotify, so every
 * other service reaches its app disguised as one. That word belongs to that
 * adapter and to nothing else: a DLNA controller, a Subsonic client and our own
 * player have no Spotify to be disguised as.
 *
 * The name they use is the service, plus the account only when there is more than
 * one of that service to tell apart. It is the same identity the core already puts
 * in an audiopath (`applemusic:library-album:…`), so a browse id and a track id
 * speak of the same account in the same words.
 */

/**
 * The account part of that identity, derived from the configured service id.
 *
 * `bridge-applemusic-p0gngd` → `p0gngd`. Config generates ids in the Loxone bridge
 * shape because that adapter came first, but what is wanted here is only the part
 * that tells two accounts of one service apart. Strips the provider-specific prefix,
 * then a generic one, else keeps the id whole — an id from elsewhere still yields a
 * usable slug.
 */
export function slugFromBridgeId(bridgeId: string, provider: string): string {
  const id = (bridgeId || '').trim();
  if (!id) {
    return id;
  }
  const svc = (provider || '').toLowerCase();
  const providerPrefix = `bridge-${svc}-`;
  if (svc && id.toLowerCase().startsWith(providerPrefix)) {
    return id.slice(providerPrefix.length);
  }
  const generic = id.replace(/^bridge-[^-]+-/i, '');
  return generic || id;
}

/** `applemusic`, or `applemusic:p0gngd` when that service has several accounts. */
export function serviceNativeKey(
  bridge: StreamingServiceConfig,
  bridges: readonly StreamingServiceConfig[] | undefined | null,
): string {
  const service = (bridge.provider || 'spotify').toLowerCase();
  const sameServiceCount = (bridges ?? []).filter(
    (b) => b && b.enabled !== false && (b.provider || '').toLowerCase() === service,
  ).length;
  if (sameServiceCount <= 1) {
    return service;
  }
  return `${service}:${slugFromBridgeId(bridge.id, service)}`;
}

/**
 * The same identity as a `globalSearch` source.
 *
 * That grammar is `<provider>[@<account>]:<filters>` — it spends the colon on the
 * filter list, so an account has to arrive after an `@` instead. Everything the
 * key does not spell out (a single-account service) is identical either way.
 */
export function searchSourceFromServiceKey(serviceKey: string): string {
  return serviceKey.replace(':', '@');
}
