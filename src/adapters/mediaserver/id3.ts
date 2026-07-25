/**
 * Minimal ID3v2.3 tag writer for the MediaServer track endpoint.
 *
 * DLNA renderers that pull a stream (rather than trusting the controller's DIDL)
 * read now-playing from the audio itself. The engine's ffmpeg output carries no
 * tags, so we prepend an ID3v2 header with the title/artist/album we already
 * resolved for the browse listing. A renderer that ignores ID3 simply skips it
 * (ID3v2 sits before the first MP3 frame and is spec-defined to be skippable),
 * so this is safe for every client.
 *
 * We keep it to text frames (TIT2/TPE1/TALB) encoded as UTF-16 with BOM, which is
 * the most broadly accepted encoding across renderers.
 */

type Id3Fields = {
  title?: string;
  artist?: string;
  album?: string;
};

function encodeTextFrame(id: string, value: string): Buffer {
  // Encoding byte 0x00 = ISO-8859-1 (Latin-1). This is the most broadly readable
  // ID3v2.3 text encoding — simple tag scanners (e.g. B&O's gvfs) handle it where
  // UTF-16 trips them up. Characters outside Latin-1 are dropped by 'latin1'
  // encoding, which is acceptable for a display title, then NUL-terminated.
  const text = Buffer.from(value, 'latin1');
  const body = Buffer.concat([Buffer.from([0x00]), text, Buffer.from([0x00])]);

  const header = Buffer.alloc(10);
  header.write(id, 0, 4, 'ascii');
  // ID3v2.3 uses a plain 32-bit big-endian size (not synchsafe) for frame bodies.
  header.writeUInt32BE(body.length, 4);
  // Flags: 0x0000.
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, body]);
}

/** Encode a size as a 28-bit synchsafe integer (7 bits per byte), as ID3v2 headers require. */
function synchsafe(size: number): Buffer {
  const b = Buffer.alloc(4);
  b[0] = (size >> 21) & 0x7f;
  b[1] = (size >> 14) & 0x7f;
  b[2] = (size >> 7) & 0x7f;
  b[3] = size & 0x7f;
  return b;
}

/**
 * Build an ID3v2.3 tag buffer for the given fields. Returns an empty buffer when
 * there is nothing worth tagging, so callers can prepend unconditionally.
 */
export function buildId3v2Tag(fields: Id3Fields): Buffer {
  const frames: Buffer[] = [];
  if (fields.title?.trim()) {
    frames.push(encodeTextFrame('TIT2', fields.title.trim()));
  }
  if (fields.artist?.trim()) {
    frames.push(encodeTextFrame('TPE1', fields.artist.trim()));
  }
  if (fields.album?.trim()) {
    frames.push(encodeTextFrame('TALB', fields.album.trim()));
  }
  if (!frames.length) {
    return Buffer.alloc(0);
  }
  const framesBuf = Buffer.concat(frames);

  const header = Buffer.alloc(10);
  header.write('ID3', 0, 3, 'ascii');
  header[3] = 0x03; // version 2.3.0
  header[4] = 0x00; // revision
  header[5] = 0x00; // flags
  synchsafe(framesBuf.length).copy(header, 6);

  return Buffer.concat([header, framesBuf]);
}
