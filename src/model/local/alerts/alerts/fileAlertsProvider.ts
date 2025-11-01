import path from 'path';
import { configManager } from '@/runtime/config/configManager';
import type { AlertMediaResource } from '../types';

const BUILTIN_ALERT_FILES: Record<string, string> = {
  alarm: 'alarm.mp3',
  firealarm: 'firealarm.mp3',
  bell: 'bell.mp3',
  buzzer: 'buzzer.mp3',
};

export class FileAlertProvider {
  private readonly baseDir = path.resolve(__dirname, '../../../../public/alerts');

  public async resolve(type: string): Promise<AlertMediaResource | undefined> {
    const filename = BUILTIN_ALERT_FILES[type];
    if (!filename) {
      return undefined;
    }

    const abs = path.join(this.baseDir, filename);
    const host = configManager.getAudioServerConfig()?.ip;
    const url = `http://${host}:7090/alerts/${encodeURIComponent(filename)}`;

    return {
      source: 'file',
      title: type,
      absolutePath: abs,
      relativePath: filename,
      url,
    };
  }
}