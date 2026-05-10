import type { AlertAction, AlertActionResult } from '@/ports/types/alerts';

export interface AlertsPort {
  handleGroupedAlert(
    leaderId: number,
    type: string,
    action: AlertAction,
    targetZones?: number[],
    ttsText?: string,
    ttsLang?: string,
    volumeOverride?: number,
  ): Promise<AlertActionResult>;
  handleUploadedAlert(filename: string, targetZones: number[]): Promise<AlertActionResult>;
  handlePlayEventFile(
    relativePath: string,
    targets: Array<{ zoneId: number; volume?: number }>,
  ): Promise<AlertActionResult>;
}
