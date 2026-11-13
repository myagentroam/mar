import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export interface SkillBundleFile {
  readonly path: string;
  readonly open: () => AsyncIterable<Uint8Array>;
}

export interface ResolvedSkillBundle {
  readonly repositoryIdentity: string;
  readonly repositoryUrl: string;
  readonly skillPath: string;
  readonly name: string;
  readonly description: string;
  readonly commitSha: string;
  readonly contentHash: string;
  readonly archiveHash: string;
  readonly contentBytes: number;
  readonly tlsVerified: boolean;
  readonly fileCount: number;
  readonly archive: () => Readable;
  readonly dispose: () => Promise<void>;
}

/** Builds a disk-backed immutable archive; its consumer owns disposal after use. */
export async function finalizeSkillBundle(input: {
  repositoryIdentity: string;
  repositoryUrl: string;
  skillPath: string;
  commitSha: string;
  tlsVerified: boolean;
  files: readonly SkillBundleFile[];
}): Promise<ResolvedSkillBundle> {
  const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path));
  const skillFile = files.find((file) => file.path === 'SKILL.md');
  if (skillFile === undefined || files.some((file) => file.path === '.mar-skill-install.json'))
    throw new Error('SKILL_CONTENT_INVALID');
  const metadata = await readSkillFrontmatter(skillFile.open());
  const name = normalizeSkillName(metadata.name);
  const directory = await mkdtemp(path.join(tmpdir(), 'mar-skill-bundle-'));
  const archivePath = path.join(directory, 'archive.json');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const archive = await open(archivePath, 'wx', 0o600);
    const contentHash = createHash('sha256');
    const archiveHash = createHash('sha256');
    let contentBytes = 0;
    const write = async (text: string) => {
      archiveHash.update(text);
      await archive.writeFile(text);
    };
    try {
      await write('{"schemaVersion":1,"files":[');
      for (const [index, file] of files.entries()) {
        contentHash.update(`${index === 0 ? '' : '\0'}${file.path}\0`);
        await write(
          `${index === 0 ? '' : ','}{"path":${JSON.stringify(file.path)},"contentBase64":"`
        );
        let remainder: Buffer = Buffer.alloc(0);
        for await (const chunk of file.open()) {
          contentBytes += chunk.length;
          const buffer =
            remainder.length === 0
              ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : Buffer.concat([remainder, chunk]);
          const end = buffer.length - (buffer.length % 3);
          const encoded = buffer.subarray(0, end).toString('base64');
          contentHash.update(encoded);
          await write(encoded);
          remainder = Buffer.from(buffer.subarray(end));
        }
        const encoded = remainder.toString('base64');
        contentHash.update(encoded);
        await write(`${encoded}"}`);
      }
      await write(']}');
    } finally {
      await archive.close();
    }
    const { files: _files, ...identity } = input;
    return {
      ...identity,
      name,
      description: metadata.description,
      contentBytes,
      fileCount: files.length,
      contentHash: contentHash.digest('hex'),
      archiveHash: archiveHash.digest('hex'),
      archive: () => createReadStream(archivePath),
      dispose
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Reads only the frontmatter; iterator closure also stops the underlying Git reader. */
export async function readSkillFrontmatter(
  content: AsyncIterable<Uint8Array>
): Promise<{ name: string; description: string }> {
  const decoder = new StringDecoder('utf8');
  const lines: string[] = [];
  let pending = '';
  const line = (value: string) => {
    if (lines.length === 0 && value !== '---') throw new Error('SKILL_CONTENT_INVALID');
    lines.push(value);
    if (lines.length > 1 && value === '---') return parseSkillFrontmatter(lines.join('\n'));
    return undefined;
  };
  for await (const chunk of content) {
    pending += decoder.write(chunk);
    let end: number;
    while ((end = pending.indexOf('\n')) !== -1) {
      const value = pending.slice(0, end).replace(/\r$/u, '');
      pending = pending.slice(end + 1);
      const metadata = line(value);
      if (metadata !== undefined) return metadata;
    }
  }
  const metadata = line(pending + decoder.end());
  if (metadata === undefined) throw new Error('SKILL_CONTENT_INVALID');
  return metadata;
}

export function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (match === null) throw new Error('SKILL_CONTENT_INVALID');
  const values = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^(name|description):\s*(.*?)\s*$/u.exec(line);
    if (field !== null) values.set(field[1]!, field[2]!.replace(/^['"]|['"]$/gu, ''));
  }
  const name = values.get('name');
  const description = values.get('description');
  if (name === undefined || description === undefined || description.length > 4096)
    throw new Error('SKILL_CONTENT_INVALID');
  return { name, description };
}

export function normalizeSkillName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(normalized) ||
    normalized.length > 128
  )
    throw new Error('SKILL_CONTENT_INVALID');
  return normalized;
}
