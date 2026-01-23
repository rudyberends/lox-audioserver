import { createLogger } from '@/shared/logging/logger';
import { PlaybackStateType, sendspinCore, serverNowUs, type PlayerFormat } from '@lox-audioserver/node-sendspin';
import type { SendspinSession } from '@lox-audioserver/node-sendspin';
import { getGroupByZone, onGroupChanged } from '@/application/groups/groupTracker';
import type { GroupRecord } from '@/application/groups/types/groupRecord';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';

export type SendspinGroupParticipant = {
  getClientId(): string;
  isClientConnected(): boolean;
  getBufferedFrames?(): Array<{ data: Buffer; timestampUs: number }>;
  getFutureFrames?(minFutureMs?: number): Array<{ data: Buffer; timestampUs: number }>;
  ensureClientReady?(): Promise<void> | void;
};

type PlayerStreamFormat = PlayerFormat;

type MetadataPayload = Parameters<SendspinSession['sendMetadata']>[0];
type ControllerPayload = Parameters<SendspinSession['sendControllerState']>[0];

export type SendspinGroupCoordinator = {
  register: (zoneId: number, participant: SendspinGroupParticipant) => void;
  unregister: (zoneId: number) => void;
  notifyStreamStart: (leaderZoneId: number, format: PlayerStreamFormat) => void;
  notifyStreamEnd: (leaderZoneId: number) => void;
  broadcastFrame: (leaderZoneId: number, frame: { data: Buffer; timestampUs: number }) => void;
  broadcastMetadata: (leaderZoneId: number, payload: MetadataPayload) => void;
  broadcastControllerState: (leaderZoneId: number, payload: ControllerPayload) => void;
  broadcastPlaybackState: (
    leaderZoneId: number,
    state: PlaybackStateType,
    groupId: string,
    groupName: string,
  ) => void;
};

/**
 * Simple orchestrator that reuses the leader's Sendspin stream for all grouped members.
 * The leader keeps producing PCM frames; we mirror stream control, metadata and audio
 * frames to Sendspin clients of the grouped member zones.
 */
class SendspinGroupController {
  private readonly log = createLogger('Output', 'SendspinGroups');
  private readonly participants = new Map<number, SendspinGroupParticipant>();
  private readonly lastStreamFormat = new Map<number, PlayerStreamFormat>();
  private readonly lastMetadata = new Map<number, MetadataPayload>();
  private readonly lastController = new Map<number, ControllerPayload>();
  private readonly lastPlaybackState = new Map<number, PlaybackStateType>();
  private zoneManager: ZoneManagerFacade | null = null;

  constructor() {
    onGroupChanged((event, leader, record) => {
      if (event === 'remove' && record) {
        this.handleGroupRemoved(record);
        return;
      }
      if ((event === 'update' || event === 'new') && record) {
        this.syncNewMembers(record);
      }
    });
  }

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('sendspin group controller already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('sendspin group controller missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  public register(zoneId: number, participant: SendspinGroupParticipant): void {
    this.participants.set(zoneId, participant);
  }

  public unregister(zoneId: number): void {
    this.participants.delete(zoneId);
    this.lastStreamFormat.delete(zoneId);
    this.lastMetadata.delete(zoneId);
    this.lastController.delete(zoneId);
    this.lastPlaybackState.delete(zoneId);
  }

  public notifyStreamStart(leaderZoneId: number, format: PlayerStreamFormat): void {
    this.lastStreamFormat.set(leaderZoneId, format);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.sendStreamStart(output.getClientId(), format);
    });
  }

  public notifyStreamEnd(leaderZoneId: number): void {
    this.lastStreamFormat.delete(leaderZoneId);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      const clientId = output.getClientId();
      sendspinCore.sendStreamEnd(clientId, ['player@v1']);
      sendspinCore.sendStreamClear(clientId, ['player@v1']);
    });
  }

  public broadcastFrame(
    leaderZoneId: number,
    frame: { data: Buffer; timestampUs: number },
  ): void {
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.sendPcmFrameToClient(output.getClientId(), frame);
    });
  }

  public broadcastMetadata(leaderZoneId: number, payload: MetadataPayload): void {
    this.lastMetadata.set(leaderZoneId, payload);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.setClientMetadata(output.getClientId(), payload);
    });
  }

  public broadcastControllerState(leaderZoneId: number, payload: ControllerPayload): void {
    this.lastController.set(leaderZoneId, payload);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.setClientControllerState(output.getClientId(), payload);
    });
  }

  public broadcastPlaybackState(
    leaderZoneId: number,
    state: PlaybackStateType,
    groupId: string,
    groupName: string,
  ): void {
    this.lastPlaybackState.set(leaderZoneId, state);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.setClientPlaybackState(output.getClientId(), state, groupId, groupName);
    });
  }

  private forEachMemberOutput(
    leaderZoneId: number,
    fn: (participant: SendspinGroupParticipant, group: GroupRecord) => void,
  ): void {
    const group = getGroupByZone(leaderZoneId);
    if (!group || group.leader !== leaderZoneId) {
      return;
    }
    const members = new Set<number>([group.leader, ...group.members]);
    members.delete(leaderZoneId);
    for (const memberId of members) {
      const participant = this.participants.get(memberId);
      if (!participant || !participant.isClientConnected()) {
        // Try to wake up latent participants (e.g. Google Cast) so they can join soon.
        try {
          void participant?.ensureClientReady?.();
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        fn(participant, group);
      } catch (err) {
        this.log.debug('sendspin group broadcast failed', {
          leaderZoneId,
          memberId,
          message: (err as Error).message,
        });
      }
    }
  }

  private handleGroupRemoved(record: GroupRecord): void {
    const { leader } = record;
    const members = new Set<number>([leader, ...record.members]);
    members.delete(leader);
    for (const memberId of members) {
      const participant = this.participants.get(memberId);
      if (!participant) continue;
      const clientId = participant.getClientId();
      sendspinCore.sendStreamEnd(clientId, ['player@v1']);
      sendspinCore.sendStreamClear(clientId, ['player@v1']);
      const name = this.zones.getZoneState(memberId)?.name ?? `Zone ${memberId}`;
      const groupId = record.externalId ?? `group-${leader}`;
      sendspinCore.setClientPlaybackState(clientId, PlaybackStateType.STOPPED, groupId, name);
    }
  }

  /**
   * When a group is created/updated while the leader is already playing,
   * push the current snapshot to newly added members.
   */
  private async syncNewMembers(record: GroupRecord): Promise<void> {
    const leader = record.leader;
    const members = new Set<number>([leader, ...record.members]);
    members.delete(leader);

    const leaderParticipant = this.participants.get(leader);
    if (!leaderParticipant || !leaderParticipant.isClientConnected()) {
      return;
    }

    const snapshotTargets: SendspinGroupParticipant[] = [];
    for (const memberId of members) {
      const memberTransport = this.participants.get(memberId);
      if (memberTransport && memberTransport.isClientConnected()) {
        snapshotTargets.push(memberTransport);
      }
    }
    if (!snapshotTargets.length) return;

    const fmt = this.lastStreamFormat.get(leader);
    const metadata = this.lastMetadata.get(leader);
    const controller = this.lastController.get(leader);
    const playbackState = this.lastPlaybackState.get(leader);
    const groupId = record.externalId ?? `group-${leader}`;
    const groupName = this.zones.getZoneState(leader)?.name ?? `Zone ${leader}`;

    for (const member of snapshotTargets) {
      const clientId = member.getClientId();
      if (fmt) {
        sendspinCore.sendStreamStart(clientId, fmt);
      }
      if (metadata) {
        sendspinCore.setClientMetadata(clientId, metadata);
      }
      if (controller) {
        sendspinCore.setClientControllerState(clientId, controller);
      }
      // Push buffered frames as-is; timestamps are already in server time.
      const buffered = leaderParticipant.getFutureFrames?.(150) ?? [];
      if (buffered.length) {
        for (const frame of buffered) {
          sendspinCore.sendPcmFrameToClient(clientId, frame);
        }
      }
      if (playbackState) {
        sendspinCore.setClientPlaybackState(clientId, playbackState, groupId, groupName);
      }
    }
  }
}

export const sendspinGroupController = new SendspinGroupController();
