import type { AlertFilesPort } from '@/ports/AlertFilesPort';
import {
  listAlertFiles,
  revertAlertFile,
  updateAlertFile,
} from '@/application/alerts/alertFileManager';

export function createAlertFilesPort(): AlertFilesPort {
  return {
    list: listAlertFiles,
    update: updateAlertFile,
    revert: revertAlertFile,
  };
}
