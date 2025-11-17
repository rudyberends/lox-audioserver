/** Standardized play command coming from the Loxone API layer. */
export interface ContentPlayCommand {
  zoneId: number;
  item: string;
  start_item?: string;
  shuffle?: boolean;
  type: 'service' | 'playlist' | 'library' | 'alert' | 'radio' | 'url' | 'announce'| 'queue_seek' | 'unknown';
}

/** Interface for adapters that can handle play commands. */
export interface ContentPlaybackHandler {
  handlePlayCommand(cmd: ContentPlayCommand): Promise<void>;
}