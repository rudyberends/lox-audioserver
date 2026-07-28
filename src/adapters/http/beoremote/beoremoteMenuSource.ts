/**
 * Gathers a zone's sources and hands them to the Beoremote menu builder.
 *
 * The builder in `@/application/beoremote/beoremoteMenu` is pure: it enforces the
 * remote's three firmware limits but does no I/O. This module is the other half —
 * it reads favorites, radio and (later) line-ins, decides the order, and feeds the
 * builder. It sits in the adapter layer because it needs the ContentManager, which
 * the application layer is not allowed to import.
 *
 * Ordering is the contract. The remote answers with a position, so the order here
 * must be stable across rebuilds or a user's pick lands on the wrong source. Every
 * list is therefore emitted in a deterministic order (config order, then favorite
 * slot), never in whatever order an async fetch happened to resolve.
 */

import { createLogger } from '@/shared/logging/logger';
import {
  buildBeoremoteMenu,
  type BeoremoteCandidate,
  type BeoremoteMenuPlan,
} from '@/application/beoremote/beoremoteMenu';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { LineInActivationService } from '@/application/inputs/lineInActivationService';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { BeoremoteSubmenuSource, ZoneBeoremoteConfig } from '@/domain/config/types';

const log = createLogger('Http', 'BeoremoteMenu');

/** How many entries to pull for a submenu; the builder caps to what actually fits. */
const SUBMENU_FETCH_LIMIT = 60;

export type BeoremoteMenuSourceDeps = {
  configPort: ConfigPort;
  favorites: FavoritesManager;
  contentManager: ContentManager;
  lineIn: LineInActivationService;
};

/** A zone's own remote settings; the zone owns them, not the bridge. */
export function zoneBeoremoteConfig(
  configPort: ConfigPort,
  zoneId: number,
): ZoneBeoremoteConfig | null {
  const zones = configPort.getConfig().zones;
  if (!Array.isArray(zones)) {
    return null;
  }
  return zones.find((zone) => zone?.id === zoneId)?.inputs?.beoremote ?? null;
}

/**
 * The integration is live as soon as any zone turns its remote on. There is no
 * separate master switch to forget: enabling it on a zone is the whole gesture.
 */
export function isBeoremoteEnabled(configPort: ConfigPort): boolean {
  const zones = configPort.getConfig().zones;
  return Array.isArray(zones) && zones.some((zone) => zone?.inputs?.beoremote?.enabled === true);
}

/** True when this specific zone is set up to be driven by a remote. */
export function isZoneBeoremoteEnabled(configPort: ConfigPort, zoneId: number): boolean {
  return zoneBeoremoteConfig(configPort, zoneId)?.enabled === true;
}

/**
 * Favorites in slot order. Slot is the user's own arrangement and is stable across
 * rebuilds, which is exactly what limit 2 needs; array order after a reorder is not.
 */
async function favoriteCandidates(
  deps: BeoremoteMenuSourceDeps,
  zoneId: number,
): Promise<BeoremoteCandidate[]> {
  const response = await deps.favorites.get(zoneId, 0, 0).catch((error) => {
    log.warn('favorites unavailable for beoremote menu', {
      zoneId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  const items = Array.isArray(response?.items) ? response!.items : [];
  return items
    .filter((item) => item && typeof item.audiopath === 'string' && item.audiopath.trim())
    .slice()
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
    .map((item) => ({
      name: item.name || item.title || 'Favorite',
      id: `favorite-${item.id}`,
      action: {
        kind: 'favorite' as const,
        favoriteId: item.id,
        audiopath: item.audiopath,
        title: item.title || item.name || undefined,
        artist: item.artist || undefined,
        album: item.album || undefined,
        coverurl: item.coverurl || undefined,
      },
    }));
}

/**
 * Line-in inputs, in config order. Config order is what the admin UI shows and is
 * stable across rebuilds, which is what the remote's position-as-identity needs.
 */
function lineInCandidates(deps: BeoremoteMenuSourceDeps): BeoremoteCandidate[] {
  let inputs: ReturnType<LineInActivationService['listLineInInputs']> = [];
  try {
    inputs = deps.lineIn.listLineInInputs();
  } catch (error) {
    log.warn('line-in list unavailable for beoremote menu', {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  return inputs.map((input) => ({
    name: input.name,
    id: `linein-${input.id}`,
    action: { kind: 'lineIn' as const, inputId: input.id },
  }));
}

/**
 * Playable radio stations, flattened.
 *
 * `getRadios()` returns the roots ("TuneIn Presets", "Custom Streams"), which are
 * folders — useless on a remote that cannot browse into anything. So the roots are
 * opened here and their stations spliced into one flat list, in root order, which
 * is what the remote's one submenu can actually show.
 */
export async function radioCandidates(deps: BeoremoteMenuSourceDeps): Promise<BeoremoteCandidate[]> {
  const roots = await deps.contentManager.getRadios().catch((error) => {
    log.warn('radio list unavailable for beoremote menu', {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  });

  const candidates: BeoremoteCandidate[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const service = root?.cmd?.trim();
    if (!service) {
      continue;
    }
    const folder = await deps.contentManager
      .getServiceFolder(service, 'nouser', root.root || 'start', 0, SUBMENU_FETCH_LIMIT)
      .catch((error) => {
        log.warn('radio folder unavailable for beoremote menu', {
          service,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    for (const item of folder?.items ?? []) {
      const audiopath = item.audiopath || item.id;
      const name = item.name?.trim() || item.title?.trim();
      // A station with no stream is a dead row on a list this short.
      if (!audiopath || !name || seen.has(audiopath)) {
        continue;
      }
      seen.add(audiopath);
      candidates.push({
        name,
        id: `radio-${service}-${item.id}`,
        action: {
          kind: 'radio',
          audiopath,
          title: name,
          coverurl: item.coverurl || undefined,
        },
      });
    }
  }

  return candidates;
}

/** One folder of a browsable service, flattened to its playable children. */
async function serviceFolderCandidates(
  deps: BeoremoteMenuSourceDeps,
  spec: Extract<BeoremoteSubmenuSource, { kind: 'serviceFolder' }>,
): Promise<BeoremoteCandidate[]> {
  const folder = await deps.contentManager
    .getServiceFolder(spec.service, spec.user || 'nouser', spec.folderId, 0, SUBMENU_FETCH_LIMIT)
    .catch((error) => {
      log.warn('service folder unavailable for beoremote menu', {
        service: spec.service,
        folderId: spec.folderId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const items = Array.isArray(folder?.items) ? folder!.items : [];
  const candidates: BeoremoteCandidate[] = [];
  for (const item of items) {
    const audiopath = item.audiopath || item.id;
    if (!audiopath || !item.name) {
      continue;
    }
    candidates.push({
      name: item.name,
      id: `content-${item.id}`,
      action: {
        kind: 'content',
        audiopath,
        title: item.title || item.name,
        artist: item.artist || undefined,
        album: item.album || undefined,
        coverurl: item.coverurl || undefined,
      },
    });
  }
  return candidates;
}

async function submenuCandidates(
  deps: BeoremoteMenuSourceDeps,
  zoneId: number,
  spec: BeoremoteSubmenuSource | null | undefined,
): Promise<{ title: string; entries: BeoremoteCandidate[] } | null> {
  if (!spec || spec.kind === 'none') {
    return null;
  }
  if (spec.kind === 'radio') {
    return { title: 'Radio', entries: await radioCandidates(deps) };
  }
  if (spec.kind === 'favorites') {
    return { title: 'Favorites', entries: await favoriteCandidates(deps, zoneId) };
  }
  if (spec.kind === 'serviceFolder') {
    return {
      title: spec.title?.trim() || spec.service,
      entries: await serviceFolderCandidates(deps, spec),
    };
  }
  return null;
}

/**
 * Build the published menu for a zone.
 *
 * Source order, fixed deliberately: the submenu owner first (it is the one entry
 * whose position the remote's SOURCE_CONTENT_1 read depends on), then line-ins in
 * config order, then favorites in slot order.
 *
 * Line-ins come before favorites because they are physical and few: a turntable
 * stays where it is, while favorites come and go. Putting the volatile list last
 * keeps the stable entries at stable positions, which is what the remote needs.
 */
export async function buildBeoremoteZoneMenu(
  deps: BeoremoteMenuSourceDeps,
  zoneId: number,
): Promise<BeoremoteMenuPlan> {
  const zoneCfg = zoneBeoremoteConfig(deps.configPort, zoneId);
  const submenu = await submenuCandidates(deps, zoneId, zoneCfg?.submenuSource);

  const sources: BeoremoteCandidate[] = [];
  let submenuOwnerIndex: number | null = null;

  if (submenu && submenu.entries.length > 0) {
    // The owner is a heading, not a destination: selecting it would have to mean
    // "play the whole folder", which for a radio root is meaningless.
    submenuOwnerIndex = sources.length;
    sources.push({ name: submenu.title, id: 'submenu-owner', action: { kind: 'inert' } });
  }

  if (zoneCfg?.includeLineIns !== false) {
    sources.push(...lineInCandidates(deps));
  }

  if (zoneCfg?.includeFavorites !== false) {
    sources.push(...(await favoriteCandidates(deps, zoneId)));
  }

  const plan = buildBeoremoteMenu({ zoneId, sources, submenu: submenu?.entries ?? [], submenuOwnerIndex });

  if (plan.droppedSources || plan.droppedSubmenu || plan.truncatedNames) {
    // The remote's list budget is small enough that dropping is normal; saying so
    // beats a menu that silently looks complete.
    log.info('beoremote menu capped to fit the remote', {
      zoneId,
      revision: plan.menu.revision,
      sources: plan.menu.sources.length,
      submenu: plan.menu.submenu.length,
      droppedSources: plan.droppedSources,
      droppedSubmenu: plan.droppedSubmenu,
      truncatedNames: plan.truncatedNames,
    });
  }

  return plan;
}
