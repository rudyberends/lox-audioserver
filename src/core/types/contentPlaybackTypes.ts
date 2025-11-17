/** Standardized play command coming from the Loxone API layer. */
export interface ContentPlayCommand {
  zoneId: number;
  item: string;
  start_item?: string;
  shuffle?: boolean;
  type: 'contentplay' | 'announce'| 'alert' | 'queue_seek';
}

/** Interface for adapters that can handle play commands. */
export interface ContentPlaybackHandler {
  handlePlayCommand(cmd: ContentPlayCommand): Promise<void>;
}