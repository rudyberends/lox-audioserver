import type { AlertMediaResource } from '@/application/alerts/types';

export interface TtsProvider {
  generate(text: string, language?: string): Promise<AlertMediaResource | undefined>;
}
