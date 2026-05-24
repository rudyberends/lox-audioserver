import type { ComponentLogger } from '@/shared/logging/logger';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { QueueItem } from '@/application/zones/internal/zoneTypes';
import {
  resolveZoneStateControllerId,
  filterAuthoritativePatchWhileLocalSessionActive,
} from '@/application/zones/state/types';

export type ExternalStateRouterDeps = {
  zones: ZoneRepository;
  audioManager: Pick<AudioManager, 'hasActiveLocalSession' | 'getSession' | 'stopPlayback'>;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>, force?: boolean) => void;
  notifyQueueUpdated: (zoneId: number, queueSize: number) => void;
  log: ComponentLogger;
};

/**
 * Routes state-controller updates (BeoLink, MA, Sonos, etc.) into the zone.
 *
 * When a local audio session is active we let the per-controller authority
 * policy decide which fields the external controller is still allowed to
 * write — see filterAuthoritativePatchWhileLocalSessionActive. Without an
 * active local session the external controller is fully authoritative.
 */
export class ExternalStateRouter {
  private readonly deps: ExternalStateRouterDeps;

  constructor(deps: ExternalStateRouterDeps) {
    this.deps = deps;
  }

  public onStatePatch(zoneId: number, patch: Partial<LoxoneZoneState>): void {
    const ctx = this.deps.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const controllerId = resolveZoneStateControllerId(ctx.config);
    if (controllerId === 'internal') {
      this.deps.applyPatch(zoneId, patch);
      return;
    }
    const hasActiveLocalSession = this.deps.audioManager.hasActiveLocalSession(zoneId);
    if (hasActiveLocalSession) {
      const authoritativePatch = filterAuthoritativePatchWhileLocalSessionActive(controllerId, patch);
      if (authoritativePatch) {
        const keys = Object.keys(authoritativePatch);
        if (keys.length === 1 && keys[0] === 'volume' && typeof authoritativePatch.volume === 'number') {
          this.deps.log.info('accepted external volume-only patch while local session active', {
            zoneId,
            controller: controllerId,
            volume: authoritativePatch.volume,
          });
        }
        this.deps.applyPatch(zoneId, authoritativePatch);
        return;
      }
      this.deps.log.debug('ignored external state patch while local session active', {
        zoneId,
        controller: controllerId,
        keys: Object.keys(patch),
      });
      return;
    }
    if (this.deps.audioManager.getSession(zoneId)) {
      // Session object can outlive real output playback; drop it before accepting external authority.
      this.deps.audioManager.stopPlayback(zoneId);
      this.deps.log.info('cleared stale local session before external state patch', {
        zoneId,
        controller: controllerId,
      });
    }
    this.deps.applyPatch(zoneId, patch);
  }

  public onQueueMirror(zoneId: number, items: QueueItem[], currentIndex: number): void {
    const ctx = this.deps.zones.get(zoneId);
    if (!ctx) return;
    // Only mirror MA's queue when there's no local audio session — when we're
    // streaming our own content into MA, the local queue is authoritative.
    if (this.deps.audioManager.hasActiveLocalSession(zoneId)) {
      return;
    }
    const safeIndex = Math.max(0, Math.min(items.length - 1, Math.floor(currentIndex)));
    ctx.queueController.setItems(items, safeIndex);
    // Mark the zone as queue-driven so the Loxone app renders the queue UI:
    //   - audiotype = 2 (Playlist) tells the app "we're playing from a queue"
    //   - qid is the unique_id of the current item
    //   - queueAuthority = local mirrors the existing playContent flow
    const current = items[safeIndex];
    if (current) {
      const patch: Partial<LoxoneZoneState> = {
        audiopath: current.audiopath,
        audiotype: 2,
        qindex: safeIndex,
        qid: current.unique_id,
        queueAuthority: 'local',
      };
      this.deps.applyPatch(zoneId, patch);
    }
    this.deps.notifyQueueUpdated(zoneId, items.length);
  }
}
