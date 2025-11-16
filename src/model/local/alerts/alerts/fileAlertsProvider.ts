import { configManager } from '@/runtime/config/configManager';
import type { AlertMediaResource } from '@/model/local/alerts/types/AlertTypes';

const BUILTIN_ALERT_FILES: Record<string, string> = {
  alarm: 'alarm.mp3',
  firealarm: 'firealarm.mp3',
  bell: 'bell.mp3',
  buzzer: 'buzzer.mp3',
};

export class FileAlertProvider {

  /**
   * Resolves built-in alert files such as:
   *   alarm → alarm.mp3
   *   firealarm → firealarm.mp3
   *   bell → bell.mp3
   *   buzzer → buzzer.mp3
   */
  public async resolve(type: string): Promise<AlertMediaResource | undefined> {
    const filename = BUILTIN_ALERT_FILES[type];
    if (!filename) {
      return undefined;
    }

    const host = configManager.getAudioServerConfig()?.ip;
    const url = `http://${host}:7090/alerts/${encodeURIComponent(filename)}`;

    return {
      title: type,
      relativePath: filename,
      url,
    };
  }

  /**
   * Resolves uploaded alert audio files.
   * Works with: audio/grouped/playuploadedfile/<filename>/<zones>
   *
   * Uploads are stored under:
   *   data/uploads/<filename>
   *
   * Exposed to MiniServer over:
   *   http://<host>:7090/alerts/<filename>
   */
  public async resolveUploaded(filename: string): Promise<AlertMediaResource | undefined> {
    if (!filename) {
      return undefined;
    }

    const host = configManager.getAudioServerConfig()?.ip;

    const relativePath = `cache/${encodeURIComponent(filename)}`;
    const url = `http://${host}:7090/alerts/${relativePath}`;

    return {
      title: filename,
      relativePath,
      url,
    };
  }
}