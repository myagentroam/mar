const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { link, lstat, open, rename, unlink } = require('node:fs/promises');
const path = require('node:path');

const CHUNK = 32 * 1024;
const WINDOW = 8;
const MAX_BUFFERED_BYTES = WINDOW * (CHUNK + 4) + 64;
const [mode, encodedPath, sizeArgument, encodedMetadata, preserveArgument, encodedSourceBasename] =
  process.argv.slice(1);
const target = Buffer.from(encodedPath ?? '', 'base64url').toString('utf8');
const sourceBasename = Buffer.from(encodedSourceBasename ?? '', 'base64url').toString('utf8');
const input = process.stdin[Symbol.asyncIterator]();
let pending = Buffer.alloc(0);

async function readExact(length) {
  while (pending.length < length) {
    const next = await input.next();
    if (next.done) throw new Error('SCP_STREAM_TRUNCATED');
    pending = Buffer.concat([pending, next.value]);
    if (pending.length > MAX_BUFFERED_BYTES) throw new Error('SCP_INPUT_OVERFLOW');
  }
  const data = pending.subarray(0, length);
  pending = pending.subarray(length);
  return data;
}

async function send(data) {
  await new Promise((resolve, reject) => {
    process.stdout.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

function frameLength(size) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(size);
  return buffer;
}

function fileMetadata(stat) {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt32BE(stat.mode & 0o777, 0);
  bytes.writeDoubleBE(stat.atimeMs, 4);
  bytes.writeDoubleBE(stat.mtimeMs, 12);
  return bytes;
}

function appendFilename(directory, filename) {
  const separator =
    directory.endsWith(path.sep) || (process.platform === 'win32' && directory.endsWith('/'))
      ? ''
      : path.sep;
  return `${directory}${separator}${filename}`;
}

async function destinationPath() {
  const targetPath = process.platform === 'win32' ? path.win32 : path.posix;
  const directoryIntent = (
    process.platform === 'win32' ? /(?:^|[\\/])\.{0,2}$/u : /(?:^|\/)\.{0,2}$/u
  ).test(target);
  // A trailing slash or dot must not disguise the final directory symlink.
  let inspected = target;
  const trailingDirectorySyntax = process.platform === 'win32' ? /[\\/]+\.?$/u : /\/+\.?$/u;
  for (;;) {
    const trimmed = inspected.replace(trailingDirectorySyntax, '');
    if (trimmed === inspected || trimmed.length < targetPath.parse(inspected).root.length) break;
    inspected = trimmed;
  }
  let previous;
  try {
    previous = await lstat(inspected);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (directoryIntent) throw new Error('SCP_TARGET_INVALID');
    return target;
  }
  if (previous.isDirectory() && !previous.isSymbolicLink()) {
    if (
      !sourceBasename ||
      sourceBasename === '.' ||
      sourceBasename === '..' ||
      sourceBasename.includes('\0') ||
      targetPath.basename(sourceBasename) !== sourceBasename ||
      (process.platform === 'win32' &&
        // eslint-disable-next-line no-control-regex -- Reject control characters explicitly at the input boundary.
        (/[<>:"/\\|?*\x00-\x1f]/u.test(sourceBasename) ||
          /[. ]$/u.test(sourceBasename) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(sourceBasename)))
    )
      throw new Error('SCP_SOURCE_FILENAME_INVALID');
    return appendFilename(target, sourceBasename);
  }
  if (directoryIntent) throw new Error('SCP_TARGET_INVALID');
  return target;
}

async function source() {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size))
    throw new Error('SCP_SOURCE_INVALID');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (
      (before.dev !== current.dev && !(process.platform === 'win32' && before.dev === 0)) ||
      before.ino !== current.ino ||
      before.size !== current.size
    )
      throw new Error('SCP_SOURCE_CHANGED');
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(current.size));
    await send(size);
    await send(fileMetadata(current));
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK);
    let offset = 0;
    let acknowledged = Promise.resolve();
    const pendingAcks = [];
    while (offset < current.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(CHUNK, current.size - offset),
        offset
      );
      if (bytesRead === 0) throw new Error('SCP_SOURCE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead));
      await send(Buffer.concat([frameLength(bytesRead), buffer.subarray(0, bytesRead)]));
      // Serialize ACK reads without making each file read wait for a round trip.
      acknowledged = acknowledged.then(async () => {
        if ((await readExact(1))[0] !== 1) throw new Error('SCP_ACK_INVALID');
      });
      acknowledged.catch(() => undefined);
      pendingAcks.push(acknowledged);
      offset += bytesRead;
      if (pendingAcks.length >= WINDOW) await pendingAcks.shift();
    }
    await acknowledged;
    const after = await handle.stat();
    if (
      after.size !== current.size ||
      after.mtimeMs !== current.mtimeMs ||
      after.ctimeMs !== current.ctimeMs ||
      after.ino !== current.ino
    )
      throw new Error('SCP_SOURCE_CHANGED');
    await send(Buffer.concat([frameLength(0), hash.digest()]));
  } finally {
    await handle.close();
  }
}

async function destination() {
  const destinationTarget = await destinationPath();
  const size = Number(sizeArgument);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('SCP_SIZE_INVALID');
  const metadata = Buffer.from(encodedMetadata ?? '', 'base64url');
  if (metadata.length !== 20) throw new Error('SCP_METADATA_INVALID');
  const sourceMode = metadata.readUInt32BE(0);
  const atimeMs = metadata.readDoubleBE(4);
  const mtimeMs = metadata.readDoubleBE(12);
  if (sourceMode > 0o777 || !Number.isFinite(atimeMs) || !Number.isFinite(mtimeMs))
    throw new Error('SCP_METADATA_INVALID');
  const filename = path.basename(destinationTarget);
  const temporary = appendFilename(
    path.dirname(destinationTarget),
    `.${filename}.marctl-${randomUUID()}.tmp`
  );
  const handle = await open(temporary, 'wx', 0o600);
  let published = false;
  try {
    let previous;
    try {
      previous = await lstat(destinationTarget);
      if (!previous.isFile() || previous.isSymbolicLink()) throw new Error('SCP_TARGET_INVALID');
      const existing = await open(
        destinationTarget,
        constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
      );
      try {
        const accessible = await existing.stat();
        if (
          (!(process.platform === 'win32' && previous.dev === 0) &&
            previous.dev !== accessible.dev) ||
          previous.ino !== accessible.ino
        )
          throw new Error('SCP_TARGET_CHANGED');
      } finally {
        await existing.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await send(Buffer.from([1]));
    const hash = createHash('sha256');
    let received = 0;
    for (;;) {
      const length = (await readExact(4)).readUInt32BE();
      if (length === 0) break;
      if (length > CHUNK || received + length > size) throw new Error('SCP_SIZE_INVALID');
      const bytes = await readExact(length);
      hash.update(bytes);
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(
          bytes,
          written,
          bytes.length - written,
          received + written
        );
        written += result.bytesWritten;
      }
      received += length;
      await send(Buffer.from([1]));
    }
    const expectedHash = await readExact(32);
    if (received !== size || !hash.digest().equals(expectedHash))
      throw new Error('SCP_CHECKSUM_MISMATCH');
    if (preserveArgument === '1') await handle.utimes(new Date(atimeMs), new Date(mtimeMs));
    await handle.chmod(
      preserveArgument === '1'
        ? sourceMode
        : previous === undefined
          ? sourceMode & ~process.umask()
          : previous.mode & 0o777
    );
    await handle.sync();
    await handle.close();
    if (previous === undefined) {
      await link(temporary, destinationTarget);
    } else {
      const current = await lstat(destinationTarget);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        previous.dev !== current.dev ||
        previous.ino !== current.ino ||
        previous.size !== current.size ||
        previous.mtimeMs !== current.mtimeMs ||
        previous.ctimeMs !== current.ctimeMs
      )
        throw new Error('SCP_TARGET_CHANGED');
      await rename(temporary, destinationTarget);
    }
    published = true;
    await send(Buffer.from([2]));
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (!published) process.exitCode = 1;
  }
}

async function main() {
  if (!path.isAbsolute(target) || target.includes('\0')) throw new Error('SCP_PATH_INVALID');
  if (mode === 'read') await source();
  else if (mode === 'write') await destination();
  else throw new Error('SCP_MODE_INVALID');
}

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'SCP_FAILED'}\n`);
    process.exitCode = 1;
  })
  .finally(() => process.stdin.destroy());
