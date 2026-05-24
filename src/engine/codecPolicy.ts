/**
 * Codec-specific knowledge for capturing the init bytes that late-joining
 * subscribers need prepended before audio frames.
 */
export interface CodecPolicy {
  /** Extract the codec init bytes from the first emitted chunk, or null if N/A. */
  captureHeader(firstChunk: Buffer): Buffer | null;
  /** True if `chunk` starts with a codec init block. Used to avoid double-priming. */
  startsWithHeader(chunk: Buffer): boolean;
}

const NULL_POLICY: CodecPolicy = {
  captureHeader: () => null,
  startsWithHeader: () => false,
};

const FLAC_SIGNATURE = Buffer.from('fLaC', 'ascii');

const FLAC_POLICY: CodecPolicy = {
  startsWithHeader(chunk: Buffer): boolean {
    return (
      chunk.length >= FLAC_SIGNATURE.length &&
      chunk.subarray(0, FLAC_SIGNATURE.length).equals(FLAC_SIGNATURE)
    );
  },

  captureHeader(firstChunk: Buffer): Buffer | null {
    if (!this.startsWithHeader(firstChunk)) return null;
    // Return only the STREAMINFO block (always the first block, always 34 bytes of data).
    // STREAMINFO is the only block VLC needs to initialize the decoder.
    // Optional blocks (PADDING, SEEKTABLE, VORBIS_COMMENT) can be very large
    // and are not needed for decoding — sending them as a burst inflates VLC's
    // network-cache estimate.
    const metaLen = extractFlacMetadataLength(firstChunk);
    const header = Buffer.from(firstChunk.subarray(0, metaLen));
    // Set is_last on the STREAMINFO block so VLC knows audio frames follow immediately.
    if (header.length >= 5) {
      header[4] = (header[4]! & 0x7f) | 0x80;
    }
    return header;
  },
};

function extractFlacMetadataLength(data: Buffer): number {
  if (data.length < 8) return data.length;
  const firstBlockDataLen = (data[5]! << 16) | (data[6]! << 8) | data[7]!;
  return Math.min(4 + 4 + firstBlockDataLen, data.length); // fLaC + block-header + STREAMINFO
}

export function codecPolicyForProfile(profile: string): CodecPolicy {
  return profile === 'flac' ? FLAC_POLICY : NULL_POLICY;
}
