export interface FadeOptions {
  fade?: boolean;
  fadeDurationMs?: number;
}

export interface FadeControllerPort {
  parseFadeOptions(raw: string): FadeOptions;
  fadeIn(zoneId: number, durationMs: number): Promise<void>;
}
