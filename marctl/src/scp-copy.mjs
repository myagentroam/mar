import { MarctlError } from './errors.mjs';
import { CHUNK, WINDOW } from './scp-protocol.mjs';

export async function copyBytes(source, destination) {
  const sizeBytes = await source.read(8);
  const size = sizeBytes.readBigUInt64BE();
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new MarctlError('Copy source is too large.');
  const metadata = await source.read(20);
  await destination.open(Number(size), metadata, async (target) => {
    if ((await target.read(1))[0] !== 1)
      throw new MarctlError('Copy target did not accept the file.');
    let remaining = Number(size);
    let acknowledged = Promise.resolve();
    const pending = [];
    for (;;) {
      const header = await source.read(4);
      const length = header.readUInt32BE();
      if (length > CHUNK || length > remaining)
        throw new MarctlError('Copy source sent an invalid chunk.');
      await target.send(header);
      if (length === 0) {
        await acknowledged;
        await target.send(await source.read(32));
        if (remaining !== 0 || (await target.read(1))[0] !== 2)
          throw new MarctlError('Copy target did not verify the file.');
        break;
      }
      await target.send(await source.read(length));
      // Keep one ordered ACK reader while sending up to a bounded window ahead.
      acknowledged = acknowledged.then(async () => {
        if ((await target.read(1))[0] !== 1)
          throw new MarctlError('Copy target rejected the chunk.');
        await source.send(Buffer.from([1]));
      });
      acknowledged.catch((error) => {
        // ACK failures use the same copy-wide cancellation as transport failures.
        source.fail(error);
      });
      pending.push(acknowledged);
      remaining -= length;
      if (pending.length >= WINDOW) await pending.shift();
    }
    await target.done();
  });
  await source.done();
}
