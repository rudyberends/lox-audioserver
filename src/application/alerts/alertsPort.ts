import type { AlertsPort } from '@/ports/AlertsPort';
import { alertsManager } from '@/application/alerts/alertsManager';

export function createAlertsPort(): AlertsPort {
  return {
    handleGroupedAlert: (...args) => alertsManager.handleGroupedAlert(...args),
    handleUploadedAlert: (...args) => alertsManager.handleUploadedAlert(...args),
    handlePlayEventFile: (...args) => alertsManager.handlePlayEventFile(...args),
  };
}
