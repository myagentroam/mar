import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InstallableSkillBundle } from './skill-install-service.js';

/** Decodes the Server's canonical v1 JSON archive to private files before installation.
 * The caller owns the returned temporary directory until both target copies finish.
 */
export async function downloadSkillBundle(
  body: ReadableStream<Uint8Array>,
  expectedContentHash: string
): Promise<InstallableSkillBundle & { dispose: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mar-skill-download-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  const reader = body.getReader();
  const json = new SkillArchiveReader(reader);
  try {
    await json.take('{');
    await json.take('"schemaVersion"');
    await json.take(':');
    await json.take('1');
    await json.take(',');
    await json.take('"files"');
    await json.take(':');
    await json.take('[');
    const files: InstallableSkillBundle['files'][number][] = [];
    const paths = new Set<string>();
    const hash = createHash('sha256');
    while ((await json.peek()) !== ']') {
      if (files.length > 0) await json.take(',');
      await json.take('{');
      await json.take('"path"');
      await json.take(':');
      const filePath = await json.string();
      if (paths.has(filePath) || filePath === '.mar-skill-install.json') invalid();
      paths.add(filePath);
      hash.update(`${files.length === 0 ? '' : '\0'}${filePath}\0`);
      await json.take(',');
      await json.take('"contentBase64"');
      await json.take(':');
      // Never use an untrusted archive path for download staging.
      const source = path.join(directory, String(files.length));
      const file = await open(source, 'wx', 0o600);
      try {
        let remainder = '';
        let padded = false;
        for await (const chunk of json.encoded()) {
          if (padded && chunk.length !== 0) invalid();
          hash.update(chunk);
          const encoded = remainder + chunk;
          const end = encoded.length - (encoded.length % 4);
          const complete = encoded.slice(0, end);
          remainder = encoded.slice(end);
          if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(complete)) invalid();
          const decoded = Buffer.from(complete, 'base64');
          if (decoded.toString('base64') !== complete) invalid();
          padded ||= complete.includes('=');
          if (padded && remainder.length !== 0) invalid();
          await file.writeFile(decoded);
        }
        if (remainder.length !== 0) invalid();
      } finally {
        await file.close();
      }
      await json.take('}');
      files.push({ path: filePath, open: () => createReadStream(source) });
    }
    await json.take(']');
    await json.take('}');
    await json.end();
    if (!paths.has('SKILL.md') || hash.digest('hex') !== expectedContentHash) invalid();
    return { schemaVersion: 1, files, dispose };
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

/** Reads only JSON framing and path strings into memory; Base64 bodies stay chunked.
 * This is the fixed Server archive grammar, not a general-purpose JSON parser.
 */
class SkillArchiveReader {
  private buffer = '';
  private ended = false;
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.reader.read();
    this.ended = next.done;
    this.buffer += next.done
      ? this.decoder.decode()
      : this.decoder.decode(next.value, { stream: true });
    return !this.ended || this.buffer.length > 0;
  }

  async peek(): Promise<string> {
    while (true) {
      this.buffer = this.buffer.trimStart();
      if (this.buffer.length > 0) return this.buffer[0]!;
      if (!(await this.fill())) invalid();
    }
  }

  async take(token: string): Promise<void> {
    await this.peek();
    while (this.buffer.length < token.length) {
      if (!token.startsWith(this.buffer) || !(await this.fill())) invalid();
    }
    if (!this.buffer.startsWith(token)) invalid();
    this.buffer = this.buffer.slice(token.length);
  }

  async string(): Promise<string> {
    await this.take('"');
    let value = '"';
    let escaped = false;
    while (true) {
      for (let index = 0; index < this.buffer.length; index += 1) {
        const character = this.buffer[index];
        if (character === '"' && !escaped) {
          value += this.buffer.slice(0, index + 1);
          this.buffer = this.buffer.slice(index + 1);
          try {
            return JSON.parse(value) as string;
          } catch {
            invalid();
          }
        }
        escaped = character === '\\' && !escaped;
      }
      value += this.buffer;
      this.buffer = '';
      if (!(await this.fill())) invalid();
    }
  }

  async *encoded(): AsyncGenerator<string> {
    await this.take('"');
    while (true) {
      const quote = this.buffer.indexOf('"');
      if (quote !== -1) {
        yield this.buffer.slice(0, quote);
        this.buffer = this.buffer.slice(quote + 1);
        return;
      }
      yield this.buffer;
      this.buffer = '';
      if (!(await this.fill())) invalid();
    }
  }

  async end(): Promise<void> {
    do {
      if (this.buffer.trim() !== '') invalid();
      this.buffer = '';
    } while (await this.fill());
  }
}

function invalid(): never {
  throw new Error('SKILL_CONTENT_INVALID');
}
