/**
 * -----------------------------------------------------------------------------
 * BeoLink URL Builder
 * -----------------------------------------------------------------------------
 * Provides standardized endpoint builders for BeoLink devices.
 *
 * Ensures consistency across all HTTP interactions (commands, volume, grouping).
 * -----------------------------------------------------------------------------
 */

/**
 * Base helper — ensures no duplicate slashes or missing ports.
 */
function buildBaseUrl(ip: string, port = 8080): string {
  const safeIp = ip.replace(/^http:\/\//, '').replace(/\/$/, '');
  return `http://${safeIp}:${port}`;
}

/**
 * Builds a BeoLink command URL, e.g.:
 *   /BeoZone/Zone/Stream/Play
 *   /BeoZone/Zone/Device/OneWayJoin
 */
export function buildBeoLinkCommandUrl(
  ip: string,
  path: string,
  type?: string,
): string {
  const base = buildBaseUrl(ip);
  const query = type ? `?type=${encodeURIComponent(type)}` : '';
  return `${base}/BeoZone/Zone/${path}${query}`;
}

/**
 * Builds the volume endpoint:
 *   /BeoZone/Zone/Sound/Volume/Speaker/Level
 */
export function buildBeoLinkVolumeUrl(ip: string): string {
  const base = buildBaseUrl(ip);
  return `${base}/BeoZone/Zone/Sound/Volume/Speaker/Level`;
}

/**
 * Builds the notification stream endpoint:
 *   /BeoNotify/Notifications
 */
export function buildBeoLinkNotificationUrl(ip: string): string {
  const base = buildBaseUrl(ip);
  return `${base}/BeoNotify/Notifications`;
}