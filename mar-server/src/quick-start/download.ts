import { createHash, randomBytes } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Downloads a pinned artifact without exposing an incomplete or unverified file. */
export async function downloadPinnedFile(
  url: string,
  sha256: string,
  destination: string,
  signal?: AbortSignal
): Promise<void> {
  const temporary = `${destination}.${randomBytes(12).toString('hex')}.tmp`;
  let created = false;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])])
    });
    if (!response.ok || response.body === null) throw new Error('QUICK_START_DOWNLOAD_FAILED');
    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > 512 * 1024 * 1024) return callback(new Error('QUICK_START_DOWNLOAD_INVALID'));
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      verify,
      file.createWriteStream()
    );
    if (hash.digest('hex') !== sha256) throw new Error('QUICK_START_DOWNLOAD_INVALID');
    await link(temporary, destination);
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}
