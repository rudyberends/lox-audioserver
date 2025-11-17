import logger from '@/utils/troxorLogger';
import { registerDeviceJid } from './deviceMap';

/**
 * -----------------------------------------------------------------------------
 * probeBeoLinkDevice (fetch-based)
 * -----------------------------------------------------------------------------
 */
export interface BeoLinkProbeResult {
  success: boolean;
  ip: string;
  status?: number;
  jid?: string;
  error?: string;
}

export async function probeBeoLinkDevice(ip: string, zoneId?: number): Promise<BeoLinkProbeResult> {
  const url = `http://${ip}:8080/Ping`;

  // 3s timeout via AbortController
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const status = res.status;

    if (status === 200) {
      logger.info(`[BeoLinkProbe] ${ip} responded with 200 OK`);

      const jid =
        res.headers.get('device-jid') ??
        res.headers.get('Device-Jid') ??
        undefined;

      if (jid) {
        logger.info(`[BeoLinkProbe] Found Device-Jid: ${jid}`);
        if (zoneId) {
          registerDeviceJid(zoneId, jid);
        }
      } else {
        logger.warn(`[BeoLinkProbe] ${ip} responded without Device-Jid header`);
      }

      return {
        success: true,
        ip,
        status,
        jid,
      };
    }

    logger.warn(`[BeoLinkProbe] ${ip} responded with status ${status}`);
    return { success: false, ip, status };

  } catch (err) {
    clearTimeout(timeout);

    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[BeoLinkProbe] Failed to reach ${ip}: ${msg}`);

    return { success: false, ip, error: msg };
  }
}