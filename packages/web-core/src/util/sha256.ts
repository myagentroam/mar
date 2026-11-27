// SHA-256 round constants and compression follow FIPS 180-4, sections 4.2.2 and 6.2.
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Hash bytes identically in HTTPS and HTTP; the fallback needs no browser crypto API. */
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    );
  }

  return sha256Chunks(
    (async function* () {
      const stride = 256 * 1024;
      for (let start = 0; start < bytes.length; start += stride) {
        if (start > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield bytes.subarray(start, start + stride);
      }
    })()
  );
}

/** Streams full blocks in place; owns only one partial block and the compression state. */
export async function sha256Chunks(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const words = new Uint32Array(64);
  const tail = new Uint8Array(128);
  const tailView = new DataView(tail.buffer);
  let length = 0;
  let remaining = 0;
  for await (const bytes of chunks) {
    length += bytes.length;
    let offset = 0;
    if (remaining > 0) {
      offset = Math.min(64 - remaining, bytes.length);
      tail.set(bytes.subarray(0, offset), remaining);
      remaining += offset;
      if (remaining < 64) continue;
      compress(tailView, 0);
      remaining = 0;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (; offset + 64 <= bytes.length; offset += 64) compress(view, offset);
    remaining = bytes.length - offset;
    tail.set(bytes.subarray(offset), 0);
  }
  tail.fill(0, remaining);
  tail[remaining] = 0x80;
  const paddedLength = remaining < 56 ? 64 : 128;
  tailView.setUint32(paddedLength - 8, Math.floor(length / 0x20000000));
  tailView.setUint32(paddedLength - 4, length << 3);
  compress(tailView, 0);
  if (paddedLength === 128) compress(tailView, 64);
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('');

  function compress(view: DataView, blockOffset: number): void {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(blockOffset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!;
      const y = words[i - 2]!;
      words[i] =
        words[i - 16]! +
        (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
        words[i - 7]! +
        (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let a = state[0]!,
      b = state[1]!,
      c = state[2]!,
      d = state[3]!;
    let e = state[4]!,
      f = state[5]!,
      g = state[6]!,
      h = state[7]!;
    for (let i = 0; i < 64; i++) {
      const first =
        h +
        (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
        ((e & f) ^ (~e & g)) +
        ROUND_CONSTANTS[i]! +
        words[i]!;
      const second = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    const block = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) state[i] = state[i]! + block[i]!;
  }
}
