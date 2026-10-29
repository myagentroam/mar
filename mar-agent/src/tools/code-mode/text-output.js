/** Bounded UTF-8 capture shared by trusted engines, the bridge and retained cells. */
export class BoundedTextOutput {
  #chunks = [];
  #used = 0;
  #original = 0;
  #retained = 0;
  #hasValue = false;
  #sealed = false;

  constructor(maximumBytes, separator = '\n', retention = 'head') {
    this.maximumBytes = maximumBytes;
    this.separator = separator;
    this.retention = retention;
  }

  append(value, originalBytes = Buffer.byteLength(value)) {
    const separator = this.#hasValue ? this.separator : '';
    this.#hasValue = true;
    this.#original += Buffer.byteLength(separator) + originalBytes;
    this.#capture(separator);
    this.#capture(value);
    if (this.retention === 'head' && originalBytes > Buffer.byteLength(value)) this.#sealed = true;
  }

  #capture(value) {
    if (this.retention === 'tail') {
      let start = Math.max(0, value.length - this.maximumBytes);
      if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start])) start++;
      const bytes = Buffer.from(this.#chunks.join('') + value.slice(start));
      let offset = Math.max(0, bytes.length - this.maximumBytes);
      while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
      this.#chunks = [bytes.subarray(offset).toString('utf8')];
      this.#retained = bytes.length - offset;
      return;
    }
    const remaining = Math.max(0, this.maximumBytes - this.#used);
    if (this.#sealed || !value.length) return;
    if (!remaining) {
      this.#sealed = true;
      return;
    }
    // Slice UTF-16 first so even a large injected-engine string never creates an unbounded Buffer.
    let end = Math.min(value.length, remaining);
    if (
      end < value.length &&
      end > 0 &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    )
      end--;
    const bytes = Buffer.from(value.slice(0, end));
    let length = Math.min(bytes.length, remaining);
    while (length > 0 && length < bytes.length && (bytes[length] & 0xc0) === 0x80) length--;
    if (length < Buffer.byteLength(value)) this.#sealed = true;
    if (!length) return;
    this.#chunks.push(bytes.toString('utf8', 0, length));
    this.#used += length;
    this.#retained += length;
  }

  snapshot() {
    return {
      text: this.#chunks.join(''),
      originalBytes: this.#original,
      retainedBytes: this.#retained,
      droppedBytes: this.#original - this.#retained
    };
  }

  drain() {
    const snapshot = this.snapshot();
    this.#chunks = [];
    this.#original = 0;
    this.#retained = 0;
    this.#hasValue = false;
    // Consuming output never replenishes the cell's capture budget.
    return snapshot;
  }
}

export function renderCapturedText(snapshot, imageCount = 0) {
  const text =
    snapshot.droppedBytes > 0
      ? `${snapshot.text}\n...[${snapshot.droppedBytes} text bytes omitted; original output: ${snapshot.originalBytes} bytes]...`
      : snapshot.text;
  const imageSummary =
    imageCount > 0 ? `Code Exec emitted ${imageCount} image${imageCount === 1 ? '' : 's'}.` : '';
  return [text, imageSummary].filter(Boolean).join('\n');
}
