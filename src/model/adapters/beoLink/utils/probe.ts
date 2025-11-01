import axios from 'axios';
import logger from '@/utils/troxorLogger';
import { registerDeviceJid } from './deviceMap';

/**
 * -----------------------------------------------------------------------------
 * probeBeoLinkDevice
 * -----------------------------------------------------------------------------
 * Sends a lightweight GET request to the BeoLink device `/Ping` endpoint
 * to verify connectivity and capture the `Device-Jid` header.
 *
 * Returns a typed result containing:
 * - success (boolean)
 * - jid (if available)
 * - status code and message
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

  try {
    const response = await axios.get(url, { timeout: 3000 }); // 3s timeout
    const jid = response.headers['device-jid'] || response.headers['Device-Jid'];

    if (response.status === 200) {
      logger.info(`[BeoLinkProbe] ${ip} responded with 200 OK`);
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
        status: response.status,
        jid: jid as string | undefined,
      };
    }

    logger.warn(`[BeoLinkProbe] ${ip} responded with status ${response.status}`);
    return { success: false, ip, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[BeoLinkProbe] ❌ Failed to reach ${ip}: ${message}`);

    return {
      success: false,
      ip,
      error: message,
    };
  }
}