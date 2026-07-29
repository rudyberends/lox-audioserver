/**
 * Projects configured line-in inputs onto the public API shape.
 *
 * The one translation that matters here is the icon. Internally it is a `LineInIconType`
 * number, which is Loxone's encoding: a client would have to carry that table to render
 * anything, and the numbers mean nothing outside their app. Names travel instead.
 */
import { LineInIconType } from '@/domain/zones/enums';
import type { ApiInput, ApiInputIcon } from '@/domain/zones/apiTypes';

const ICONS: Record<number, ApiInputIcon> = {
  [LineInIconType.LineIn]: 'line-in',
  [LineInIconType.CdPlayer]: 'cd-player',
  [LineInIconType.Computer]: 'computer',
  [LineInIconType.IMac]: 'imac',
  [LineInIconType.IPod]: 'ipod',
  [LineInIconType.Mobile]: 'mobile',
  [LineInIconType.Radio]: 'radio',
  [LineInIconType.Screen]: 'screen',
  [LineInIconType.TurnTable]: 'turntable',
};

/** What a line-in looks like once resolved, plus the config flags the API exposes. */
export type LineInForApi = {
  id: string;
  name: string;
  iconType: number;
  controllable?: boolean;
  metadataEnabled?: boolean;
};

export function toApiInput(input: LineInForApi): ApiInput {
  return {
    id: input.id,
    name: input.name,
    // An unknown number falls back rather than leaking through: the icon is a hint, and a
    // client that gets a number where it expects a name has no way to recover.
    icon: ICONS[input.iconType] ?? 'line-in',
    controllable: input.controllable === true,
    reportsMetadata: input.metadataEnabled === true,
  };
}
