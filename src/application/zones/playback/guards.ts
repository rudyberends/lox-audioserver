import type { ZoneContext } from '@/application/zones/internal/zoneTypes';

// Bluetooth is here because a phone says what it is playing over AVRCP, and that is the only thing
// the room can show about it.
const METADATA_INPUTS = new Set([
  'spotify',
  'airplay',
  'musicassistant',
  'linein',
  'bluetooth',
  'mixedgroup',
]);
const COVER_INPUTS = new Set(['spotify', 'airplay', 'musicassistant', 'mixedgroup']);
const VOLUME_INPUTS = new Set(['spotify', 'airplay', 'musicassistant']);

export function allowsInputMetadata(activeInput: string | null | undefined): boolean {
  return !activeInput || METADATA_INPUTS.has(activeInput);
}

export function allowsInputCover(activeInput: string | null | undefined): boolean {
  return !activeInput || COVER_INPUTS.has(activeInput);
}

export function allowsInputVolume(activeInput: string | null | undefined): boolean {
  return !activeInput || VOLUME_INPUTS.has(activeInput);
}

export function isQueueDrivenInput(mode: ZoneContext['inputMode']): boolean {
  return !mode || mode === 'queue' || mode === 'spotify' || mode === 'musicassistant';
}

export function isActiveInputMode(
  ctx: Pick<ZoneContext, 'inputMode' | 'state'>,
  mode: ZoneContext['inputMode'],
): boolean {
  return ctx.inputMode === mode && ctx.state.mode !== 'stop';
}
