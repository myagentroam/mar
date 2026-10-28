import { createHash } from 'node:crypto';

export interface SkillBundleFile {
  readonly path: string;
  readonly contentBase64: string;
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
  readonly archiveJson: string;
  readonly contentBytes: number;
  readonly tlsVerified: boolean;
  readonly files: readonly SkillBundleFile[];
}

export function finalizeSkillBundle(input: {
  repositoryIdentity: string;
  repositoryUrl: string;
  skillPath: string;
  commitSha: string;
  contentBytes: number;
  tlsVerified: boolean;
  files: readonly SkillBundleFile[];
}): ResolvedSkillBundle {
  const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path));
  const skillFile = files.find((file) => file.path === 'SKILL.md');
  if (skillFile === undefined || files.some((file) => file.path === '.mar-skill-install.json'))
    throw new Error('SKILL_CONTENT_INVALID');
  const metadata = parseSkillFrontmatter(
    Buffer.from(skillFile.contentBase64, 'base64').toString('utf8')
  );
  const canonicalFiles = files.map((file) => `${file.path}\0${file.contentBase64}`).join('\0');
  const archiveJson = JSON.stringify({ schemaVersion: 1, files });
  return {
    ...input,
    files,
    archiveJson,
    name: normalizeSkillName(metadata.name),
    description: metadata.description,
    contentHash: createHash('sha256').update(canonicalFiles).digest('hex'),
    archiveHash: createHash('sha256').update(archiveJson).digest('hex')
  };
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
