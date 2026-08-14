import type { SendspinDeclaredFormat } from '@/application/outputs/sendspinGroupController';

/** A PCM format as the three things a device either renders or does not. */
export type TargetFormat = { sampleRate: number; bitDepth: number; channels: number };

/**
 * Whether a client's `supported_formats` list contains this format.
 *
 * Rate, depth and channel count only — never the codec. A grouped member is always fed PCM
 * (the leader forces it, so members on any codec can decode the shared audio), and for the
 * leader itself the codec is settled before this is asked. What is left is whether the
 * device can render these samples at all.
 */
export function declaresFormat(
  declared: ReadonlyArray<SendspinDeclaredFormat>,
  target: TargetFormat,
): boolean {
  return declared.some(
    (fmt) =>
      fmt.sample_rate === target.sampleRate &&
      fmt.bit_depth === target.bitDepth &&
      fmt.channels === target.channels,
  );
}

/**
 * Whether every client in these lists declares the format — the question a group leader asks
 * before following its source instead of its own negotiated format.
 *
 * A client that declared nothing counts as a no. It is not being difficult: an older
 * node-sendspin has no `supported_formats` getter, so its list arrives empty and silence is
 * not consent. Treating it as a yes would move a whole group onto a rate on the word of a
 * client that never said one — the leader stays where it is, which is what happened before
 * members had a say at all.
 *
 * No members (a solo zone, or a group whose members are all disconnected) is vacuously true:
 * nobody else is listening, so nothing constrains the choice.
 */
export function allDeclareFormat(
  perClient: ReadonlyArray<ReadonlyArray<SendspinDeclaredFormat>>,
  target: TargetFormat,
): boolean {
  return perClient.every((declared) => declaresFormat(declared, target));
}
