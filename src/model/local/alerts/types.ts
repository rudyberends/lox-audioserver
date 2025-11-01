export interface AlertMediaRequest {
  type: string;
  text?: string;
  language?: string;
}

export interface AlertMediaResource {
  source: 'file' | 'tts';
  title: string;
  absolutePath: string;
  relativePath: string;
  url: string;        // ← add this field
  text?: string;
  language?: string;
}

export interface AlertMediaProvider {
  id: string;
  canHandle(type: string): boolean;
  resolve(request: AlertMediaRequest): Promise<AlertMediaResource | undefined>;
}