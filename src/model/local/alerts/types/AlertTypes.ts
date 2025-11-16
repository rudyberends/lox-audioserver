/**
 * -----------------------------------------------------------------------------
 * AlertTypes
 * -----------------------------------------------------------------------------
 * Shared domain types used by the alert lifecycle:
 * - Alert actions and results
 * - Saved playback snapshot
 * - Re-export of AlertMediaResource from the local alert providers
 *
 * This module intentionally contains no business logic, only types
 * and simple aliases used across the alert implementation.
 * -----------------------------------------------------------------------------
 */

import type { ZoneState } from '@/runtime/zones/types/zoneStateTypes';
import type { AlertMediaResource as BaseAlertMediaResource } from '@/model/local/alerts/types';

/**
 * Media resource used for alerts.
 *
 * This is re-exported from the local alert provider types so that the
 * alert model does not redefine the same shape multiple times.
 */
export type AlertMediaResource = BaseAlertMediaResource;

/**
 * High-level action for an alert lifecycle.
 *
 * - "on"  → start or activate an alert
 * - "off" → stop a running alert and restore previous playback state
 */
export type AlertAction = 'on' | 'off';

/**
 * Result object returned by alert orchestration entrypoints.
 *
 * `reason` is only set when `success === false` and provides a
 * machine-readable explanation (e.g. "media-unavailable").
 */
export interface AlertActionResult {
  success: boolean;
  type: string;
  action: AlertAction;
  reason?: string;
}

/**
 * Snapshot of the original playback state for a single zone.
 *
 * This structure is stored before an alert starts and consumed when
 * restoring playback after the alert has stopped.
 */
export interface SavedPlayback {
  /** Original volume level. */
  volume?: number;

  /** Original repeat mode value (enum or numeric). */
  repeat?: number;

  /** Original audiopath, e.g. "spotify@...:track:...". */
  audiopath?: string;

  /** Original playback position in milliseconds. */
  positionMs?: number;

  /** Original playback mode (play, pause, stop, etc.), stored as a number. */
  mode?: number;

  /**
   * Optional queue snapshot. This mirrors the internal queue structure on
   * ZoneState and may be used by the runtime to restore the queue.
   */
  queue?: ZoneState['queue'];
}

/**
 * Mapping of configured alert volumes on a zone.
 *
 * This reflects the structure used in the configuration JSON:
 *
 * {
 *   "volumes": {
 *     "default": 25,
 *     "alarm": 40,
 *     "fire": 40,
 *     "bell": 50,
 *     "buzzer": 50,
 *     "tts": 42,
 *     "maxVolume": 100
 *   }
 * }
 */
export interface AlertVolumeConfig {
  default?: number;
  alarm?: number;
  fire?: number;
  bell?: number;
  buzzer?: number;
  tts?: number;
  maxVolume?: number;
}