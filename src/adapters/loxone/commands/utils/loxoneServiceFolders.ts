/**
 * Translates between the Loxone app's fixed service-folder slots and the named
 * nodes a provider publishes.
 *
 * The Loxone app addresses a streaming service's sections by a numeric index from
 * its own `SpotifyFolder` enum (Features=0, NewReleases=1, Categories=2,
 * MyPlaylists=3, LikedSongs=4, Albums=5, Artists=6, Podcasts=7) — it only knows
 * Spotify, so every service is presented as one. Which of its own sections a
 * service puts in a given slot is a *presentation* decision for this app, not a
 * property of the service, so it lives here rather than in the provider. That
 * keeps providers free to name and extend their own tree: nodes with no slot are
 * simply unreachable from the Loxone app and fully available everywhere else.
 *
 * A service without an entry here passes its folder ids through untouched, so
 * providers can be migrated one at a time.
 */

/** Slot index → the provider node it maps onto, per provider type. */
const SLOT_NODES: Record<string, Readonly<Record<string, string>>> = {
  // Apple Music deliberately fills the first three slots with its recommendation
  // feeds — this mirrors exactly what the provider used to decode internally.
  applemusic: {
    '0': 'new-releases',
    '1': 'recommended-playlists',
    '2': 'recommended-albums',
    '3': 'playlists',
    '5': 'albums',
    '6': 'artists',
  },
  // Both YouTube services fill the slots with their own sections; the names mirror
  // exactly what each provider used to decode from the index.
  ytmusic: {
    '0': 'popular',
    '1': 'new-releases',
    '2': 'genres',
    '3': 'playlists',
    '5': 'albums',
    '6': 'artists',
  },
  youtube: {
    '0': 'trending',
    '1': 'new-releases',
    '2': 'genres',
    '3': 'playlists',
  },
};

/** `bridge-applemusic-p0gngd` → `applemusic`. Empty when it isn't a bridge id. */
export function providerTypeFromBridgeId(bridgeId: string): string {
  const match = /^bridge-([^-]+)-/.exec(bridgeId.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

function slotsFor(bridgeId: string): Readonly<Record<string, string>> | undefined {
  return SLOT_NODES[providerTypeFromBridgeId(bridgeId)];
}

/** Inbound: the app's slot index becomes the provider's node name. */
export function toProviderNode(bridgeId: string, folderId: string): string {
  const slots = slotsFor(bridgeId);
  if (!slots) {
    return folderId;
  }
  return slots[folderId.trim()] ?? folderId;
}

/**
 * Outbound: a root listing goes back with the ids the app expects.
 *
 * The app drives its sections from its own enum, so the ids we return for the root
 * must stay the numeric slots — otherwise a node the app cannot address could end
 * up in a section. Nodes without a slot are dropped from the Loxone view; they
 * remain visible to every other consumer.
 */
export function rootItemsForLoxone<T extends { id: string }>(
  bridgeId: string,
  items: readonly T[],
): T[] {
  const slots = slotsFor(bridgeId);
  if (!slots) {
    return [...items];
  }
  const slotByNode = new Map(Object.entries(slots).map(([slot, node]) => [node, slot]));
  const out: T[] = [];
  for (const item of items) {
    const slot = slotByNode.get(item.id);
    if (slot !== undefined) {
      out.push({ ...item, id: slot });
    }
  }
  return out;
}
