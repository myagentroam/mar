/** Reads dimensions from Chromium's JPEG frame header without decoding pixels. */
export function browserJpegSize(jpeg: Buffer): { width: number; height: number } | undefined {
  if (jpeg.length < 2 || jpeg.readUInt16BE(0) !== 0xffd8) return;
  for (let offset = 2; offset + 4 <= jpeg.length;) {
    const marker = jpeg.readUInt16BE(offset);
    const length = jpeg.readUInt16BE(offset + 2);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda || length < 2) return;
    if (offset + 2 + length > jpeg.length) return;
    if ((marker === 0xffc0 || marker === 0xffc2) && length >= 8) {
      const height = jpeg.readUInt16BE(offset + 5);
      const width = jpeg.readUInt16BE(offset + 7);
      if (width && height) return { width, height };
      return;
    }
    offset += 2 + length;
  }
}
