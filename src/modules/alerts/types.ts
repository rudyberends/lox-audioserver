export interface AlertMediaResource {
  /** Public URL where the alert audio can be streamed. */
  url: string;
  /** Relative file path under the public alerts directory. */
  relativePath: string;
  /** If true, the audio source should loop until the alert is stopped. */
  loop?: boolean;
  /** Optional human friendly label for logging/UX. */
  title?: string;
  /** Optional duration in seconds if known. */
  duration?: number;
}

export interface AlertActionResult {
  success: boolean;
  type: string;
  action: AlertAction;
  reason?: string;
}

export type AlertAction = 'on' | 'off';
