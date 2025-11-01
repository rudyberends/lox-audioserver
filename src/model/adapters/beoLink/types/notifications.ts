/**
 * -----------------------------------------------------------------------------
 * BeoLink Notification Types
 * -----------------------------------------------------------------------------
 * Represents the structure of NDJSON events received from BeoLink devices.
 * Each line in the BeoNotify stream contains a single NotificationMessage.
 * -----------------------------------------------------------------------------
 */

export interface PrimaryExperienceSourceType {
  /** The specific source type, e.g. "netRadio" or "storedMusic". */
  type?: string;
}

export interface PrimaryExperienceProduct {
  /** BeoLink JID identifier of the source product. */
  jid?: string;
  /** Human-readable name of the source product. */
  friendlyName?: string;
}

/**
 * Describes the currently active source for a BeoLink device.
 */
export interface PrimaryExperienceSource {
  id?: string;
  friendlyName?: string;
  sourceType?: PrimaryExperienceSourceType;
  product?: PrimaryExperienceProduct;

  /** Catch-all for unrecognized fields (e.g. vendor-specific data). */
  [key: string]: unknown;
}

/**
 * Represents the active playback context (source, listeners, state).
 */
export interface PrimaryExperience {
  source?: PrimaryExperienceSource;
  listener?: Array<string | { jid?: string }>;
  state?: string;
  lastUsed?: string;

  /** Catch-all for vendor- or version-specific fields. */
  [key: string]: unknown;
}

/**
 * Inner payload of a BeoLink notification.
 */
export interface NotificationData {
  /** Speaker and volume data. */
  speaker?: {
    level: number;
  };

  /** Track metadata (music or radio). */
  artist?: string;
  album?: string;
  name?: string;
  liveDescription?: string;
  friendlyName?: string;
  playQueueItemId?: string;
  duration?: number;

  /** Cover art. */
  trackImage?: Array<{ url: string }>;
  image?: Array<{ url: string }>;

  /** Playback state. */
  state?: string;
  position?: number;

  /** Extended BeoLink context. */
  primaryExperience?: PrimaryExperience;

  /** Catch-all for unrecognized fields. */
  [key: string]: unknown;
}

/**
 * Core payload structure of a single NDJSON event line.
 */
export interface NotificationPayload {
  /** Optional numeric or string identifier for the event. */
  id?: number | string;
  timestamp?: string;
  /** Core notification type, e.g. "VOLUME", "NOW_PLAYING_NET_RADIO", etc. */
  type: string;
  /** Sometimes indicates subcategory (e.g. "source", "volume"). */
  kind?: string;
  /** Actual event data payload. */
  data: NotificationData;
}

/**
 * Root message structure parsed from a BeoNotify NDJSON line.
 */
export interface NotificationMessage {
  notification: NotificationPayload;
}