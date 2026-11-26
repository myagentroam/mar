const GIF_LOOP_EXTENSION = Uint8Array.from('\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00', (byte) =>
  byte.charCodeAt(0)
);

/** Inspect GIF blocks without decoding the frame data or touching the original buffer. */
export function loopGif(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const invalid = () => new Error('IMAGE_PREVIEW_INVALID');
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length < 13 || !/^GIF8[79]a$/u.test(ascii(0, 6))) throw invalid();
  const colorTableSize = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  const firstBlock = 13 + colorTableSize(bytes[10]!);
  let offset = firstBlock;
  let frames = 0;
  let hasLoop = false;
  let output: Uint8Array<ArrayBuffer> | undefined;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      if (frames === 0) throw invalid();
      if (frames === 1) return bytes;
      if (hasLoop) return output ?? bytes;
      const extended = new Uint8Array(bytes.length + GIF_LOOP_EXTENSION.length);
      extended.set(bytes.subarray(0, firstBlock));
      extended[4] = 0x39; // The application extension requires GIF89a.
      extended.set(GIF_LOOP_EXTENSION, firstBlock);
      extended.set(bytes.subarray(firstBlock), firstBlock + GIF_LOOP_EXTENSION.length);
      return extended;
    }
    let label: number | undefined;
    if (marker === 0x2c) {
      if (offset + 9 >= bytes.length) throw invalid();
      offset += 10 + colorTableSize(bytes[offset + 8]!); // Descriptor, color table, LZW code size.
      frames += 1;
    } else if (marker === 0x21) label = bytes[offset++];
    else throw invalid();

    const application =
      label === 0xff && bytes[offset] === 11 ? ascii(offset + 1, offset + 12) : undefined;
    const loopApplication = application === 'NETSCAPE2.0' || application === 'ANIMEXTS1.0';
    let first = true;
    for (;;) {
      const size = bytes[offset++];
      if (size === undefined || offset + size > bytes.length) throw invalid();
      if (size === 0) break;
      if (!first && loopApplication && size === 3 && bytes[offset] === 1) {
        hasLoop = true;
        if (bytes[offset + 1] !== 0 || bytes[offset + 2] !== 0) {
          output ??= new Uint8Array(bytes);
          output[offset + 1] = output[offset + 2] = 0;
        }
      }
      first = false;
      offset += size;
    }
  }
  throw invalid();
}
