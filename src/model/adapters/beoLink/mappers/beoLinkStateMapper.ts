import axios from 'axios';
import ndjson from 'ndjson';
import { Readable } from 'stream';
import logger from '@/utils/troxorLogger';
import type { ZoneState } from '@/runtime/zones/types/zoneStateTypes';
import type { NotificationData, NotificationMessage, NotificationPayload, PrimaryExperience } from '../types/notifications';
import { mapBeoLinkNotification } from './beoLinkMappingUtils';
import { findZoneIdByJid } from '../utils/deviceMap';
import { probeBeoLinkDevice } from '../utils/probe';
import { disbandGroupFromBackend, normalizeMembers, updateGroupFromBackend } from '@/runtime/zones/utils/groupUtils';
import { StateMapper } from '@/core/interfaces/stateMapper';

/**
 * -----------------------------------------------------------------------------
 * BeoLinkStateMapper
 * -----------------------------------------------------------------------------
 * Listens to the /BeoNotify/Notifications NDJSON stream and converts
 * incoming BeoLink events into normalized ZoneState updates.
 *
 * Responsibilities:
 * - NDJSON parsing
 * - Connection resilience (auto-reconnect with backoff)
 * - Automatic group synchronization via SOURCE_EXPERIENCE_CHANGED
 * -----------------------------------------------------------------------------
 */

type BeoNotifyEnvelope = Partial<NotificationMessage> | Partial<NotificationPayload>;

export class BeoLinkStateMapper implements StateMapper {
  public readonly type = 'beolink' as const;
  private readonly zoneId: number;
  private readonly zoneName: string;
  private readonly ip: string;
  private readonly notifyUrl: string;
  private notifyStream: Readable | null = null;
  private updateHandler?: (update: Partial<ZoneState>) => void;
  private reconnectTimer?: NodeJS.Timeout;
  private abortController?: AbortController;
  private consecutiveFailures = 0;

  constructor(config: { zoneId: number; zoneName: string; ip: string }) {
    this.zoneId = config.zoneId;
    this.zoneName = config.zoneName;
    this.ip = config.ip;
    this.notifyUrl = `http://${this.ip}:8080/BeoNotify/Notifications`;
  }

  /** Starts the NDJSON listener and periodic reconnect watchdog. */
  async initialize(): Promise<void> {
    const probe = await probeBeoLinkDevice(this.ip, this.zoneId);
    if (probe.success) {
      logger.info(`[BeoLinkStateMapper][${this.zoneName}] Probe OK — JID=${probe.jid ?? 'unknown'}`);
    } else {
      logger.warn(`[BeoLinkStateMapper][${this.zoneName}] Probe failed — ${probe.error ?? 'no response'}`);
    }
    logger.info(`[BeoLinkStateMapper][${this.zoneName}] Starting BeoLink listener for ${this.ip}`);

    await this.startListener();

    // Restart every 3 minutes to avoid stale connections
    this.reconnectTimer = setInterval(async () => {
      await this.stopListener();
      await this.startListener();
    }, 180_000);
  }

  /** Stops the listener and clears timers. */
  async destroy(): Promise<void> {
    await this.stopListener();
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /** Registers the ZoneRuntime update callback. */
  onUpdate(handler: (update: Partial<ZoneState>) => void): void {
    this.updateHandler = handler;
  }

  /* -------------------------------------------------------------------------- */
  /* Listener Lifecycle                                                         */
  /* -------------------------------------------------------------------------- */

  private async startListener(): Promise<void> {
    try {
      this.abortController = new AbortController();
      const response = await axios.get(this.notifyUrl, {
        responseType: 'stream',
        signal: this.abortController.signal as unknown as AbortSignal,
      });

      const parsed = response.data.pipe(ndjson.parse());
      this.notifyStream = parsed as unknown as Readable;

      parsed.on('data', (msg: unknown) => this.handleMessage(msg));
      parsed.once('error', (err: unknown) => {
        logger.warn(
          `[BeoLinkStateMapper][${this.zoneName}] Stream error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        void this.restartWithBackoff();
      });
      parsed.once('close', () => {
        logger.info(`[BeoLinkStateMapper][${this.zoneName}] Stream closed`);
      });

      this.consecutiveFailures = 0;
      logger.info(`[BeoLinkStateMapper][${this.zoneName}] Stream active`);
    } catch (err) {
      logger.error(
        `[BeoLinkStateMapper][${this.zoneName}] Failed to connect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await this.restartWithBackoff();
    }
  }

  private async stopListener(): Promise<void> {
    try {
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = undefined;
      }
      if (this.notifyStream) {
        this.notifyStream.removeAllListeners?.();
        this.notifyStream.destroy();
        this.notifyStream = null;
      }
    } catch (e) {
      logger.warn(
        `[BeoLinkStateMapper][${this.zoneName}] stopListener error: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Message Handling                                                           */
  /* -------------------------------------------------------------------------- */

  private handleMessage(msg: unknown): void {
    try {
      const env = msg as BeoNotifyEnvelope;
      const type =
        (env as NotificationMessage)?.notification?.type ??
        (env as NotificationPayload)?.type ??
        '';
      const data =
        ((env as NotificationMessage)?.notification?.data ??
          (env as NotificationPayload)?.data) as NotificationData | undefined;

      if (!type || !data) {
        return;
      }

      const mapped = mapBeoLinkNotification(
        type,
        data,
        this.ip,
        (exp) => this.handlePrimaryExperienceChanged(exp),
      );

      if (mapped && this.updateHandler) {
        this.updateHandler(mapped);
      }
    } catch (err) {
      logger.error(
        `[BeoLinkStateMapper][${this.zoneName}] Error handling message: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Group Synchronization (SOURCE_EXPERIENCE_CHANGED)                          */
  /* -------------------------------------------------------------------------- */
  private async handlePrimaryExperienceChanged(exp?: PrimaryExperience | null): Promise<void> {
    if (!exp) {
      return;
    }

    try {
      const sourceId = exp.source?.id ?? '';
      const leaderJid = exp.source?.product?.jid ?? '';
      const leaderZoneId = findZoneIdByJid(leaderJid) ?? this.zoneId!;

      // Normalize listener list (always array of strings)
      const listenersRaw = Array.isArray(exp.listener)
        ? exp.listener
        : exp.listener
          ? [exp.listener]
          : [];

      const listeners = listenersRaw
        .map((l) => (typeof l === 'string' ? l : (l as { jid?: string })?.jid))
        .filter((jid): jid is string => !!jid && jid.trim().length > 0);

      logger.info(
        `[BeoLink][${this.zoneName}] Experience update: leaderJid=${leaderJid}, listeners=${listeners.length}, source=${sourceId}`,
      );

      // -----------------------------------------------------------------------
      // Case 1: Disband — only the leader remains
      // -----------------------------------------------------------------------
      const onlyLeaderOver =
        listeners.length <= 1 &&
        (!listeners[0] || listeners[0].toLowerCase() === leaderJid.toLowerCase());

      if (onlyLeaderOver) {
        disbandGroupFromBackend('BeoLink', this.zoneName, leaderZoneId);
        return;
      }

      // -----------------------------------------------------------------------
      // Case 2: Active group — map listeners to known zone IDs
      // -----------------------------------------------------------------------
      const memberZoneIds = normalizeMembers(listeners, (jid) => findZoneIdByJid(jid));
      updateGroupFromBackend({
        adapter: 'BeoLink',
        zoneName: this.zoneName,
        leaderZoneId,
        memberZoneIds,
        externalId: sourceId || `beolink-${leaderZoneId}`,
      });
    } catch (err) {
      logger.error(
        `[BeoLink][${this.zoneName}] Failed to process experience change: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }


  /* -------------------------------------------------------------------------- */
  /* Reconnect Logic                                                            */
  /* -------------------------------------------------------------------------- */

  private async restartWithBackoff(): Promise<void> {
    this.consecutiveFailures += 1;
    const base = 1000; // 1s
    const max = 15000; // 15s
    const jitter = Math.random() * 300;
    const delay =
      Math.min(max, Math.pow(2, Math.min(5, this.consecutiveFailures)) * base) + jitter;

    logger.info(
      `[BeoLinkStateMapper][${this.zoneName}] Reconnecting in ${Math.round(
        delay,
      )}ms (attempt ${this.consecutiveFailures})`,
    );

    await this.stopListener();
    await new Promise((res) => setTimeout(res, delay));
    await this.startListener();
  }
}
