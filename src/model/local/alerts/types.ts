/**
 * -----------------------------------------------------------------------------
 * AlertTypes
 * -----------------------------------------------------------------------------
 * Shared domain types used by the alerts lifecycle components.
 * These types represent alert media resources and lifecycle results.
 * -----------------------------------------------------------------------------
 */

export interface AlertMediaResource {
  /** Public URL where the audio resource can be streamed. */
  url: string;

  /** Local relative file path (used for serviceplay payloads). */
  relativePath: string;

  /** Optional display title for debugging/logging. */
  title?: string;
}

export interface AlertStartResult {
  zoneId: number;
  success: boolean;
  reason?: string;
}

export interface AlertStopResult {
  zoneId: number;
  success: boolean;
  reason?: string;
}