import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { skillInstallMetadataSchema, type SkillInstallMetadata } from '@myagentroam/protocol';
import { hasBrokenWorkspaceSkillGitExclude } from './workspace-git-exclude-service.js';

const MAX_METADATA_BYTES = 64 * 1024;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;

export type LocalSkillStatus =
  'VALID' | 'UNKNOWN_VERSION' | 'PARTIAL' | 'INVALID' | 'INVALID_LINK' | 'GIT_EXCLUDE_BROKEN';

export interface LocalSkillInspection {
  readonly name: string;
  readonly description: string;
  readonly localStatus: LocalSkillStatus;
  readonly skillFilePath: string;
  readonly install?: SkillInstallMetadata;
}

export interface LocalSkillTargetInspection {
  readonly targetKind: 'NODE' | 'WORKSPACE';
  readonly compatibilityMode: 'SYMLINK' | 'JUNCTION' | 'MANAGED_COPY' | 'UNAVAILABLE';
  readonly skills: readonly LocalSkillInspection[];
}

interface RootEntry extends LocalSkillInspection {
  readonly source: 'AGENTS' | 'CLAUDE';
}

export class SkillDirectoryService {
  async inspectNodeHome(
    home: string,
    options: { readonly includeClaudeCompatibility?: boolean } = {}
  ): Promise<LocalSkillTargetInspection> {
    const agentsRoot = path.join(home, '.agents', 'skills');
    const claudeRoot = path.join(home, '.claude', 'skills');
    const compatibilityMode = await nodeCompatibilityMode(agentsRoot, claudeRoot);
    const agents = await scanRoot(agentsRoot, 'AGENTS');
    const claude =
      options.includeClaudeCompatibility === true && compatibilityMode !== 'UNAVAILABLE'
        ? await scanRoot(claudeRoot, 'CLAUDE')
        : [];
    return {
      targetKind: 'NODE',
      compatibilityMode,
      skills:
        options.includeClaudeCompatibility === true
          ? mergeNodeCompatibilityRoots(agents, claude)
          : agents.map(withoutSource)
    };
  }

  async inspectWorkspace(workspace: string): Promise<LocalSkillTargetInspection> {
    const agents = await scanRoot(path.join(workspace, '.agents', 'skills'), 'AGENTS');
    const claude = await scanRoot(path.join(workspace, '.claude', 'skills'), 'CLAUDE');
    const skills = mergeWorkspaceCopies(agents, claude);
    const gitExcludeBroken = await hasBrokenWorkspaceSkillGitExclude(
      workspace,
      skills.map((skill) => skill.name)
    );
    return {
      targetKind: 'WORKSPACE',
      compatibilityMode: 'MANAGED_COPY',
      skills: gitExcludeBroken
        ? skills.map((skill) => ({ ...skill, localStatus: 'GIT_EXCLUDE_BROKEN' as const }))
        : skills
    };
  }
}

async function scanRoot(root: string, source: RootEntry['source']): Promise<RootEntry[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const results: RootEntry[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.mar-')) continue;
    const itemPath = path.join(root, entry.name);
    const stat = await lstat(itemPath);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && process.platform === 'win32')) {
      results.push({
        name: entry.name,
        description: '',
        localStatus: 'INVALID_LINK',
        skillFilePath: path.join(itemPath, 'SKILL.md'),
        source
      });
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (!SKILL_NAME.test(entry.name) || WINDOWS_DEVICE_NAME.test(entry.name)) {
      results.push({
        name: entry.name,
        description: '',
        localStatus: 'INVALID',
        skillFilePath: path.join(itemPath, 'SKILL.md'),
        source
      });
      continue;
    }
    results.push({ ...(await inspectSkill(itemPath, entry.name)), source });
  }
  return results;
}

async function inspectSkill(
  directory: string,
  directoryName: string
): Promise<LocalSkillInspection> {
  try {
    const frontmatter = parseSkillFrontmatter(await readBounded(path.join(directory, 'SKILL.md')));
    if (
      frontmatter.name !== directoryName ||
      !SKILL_NAME.test(frontmatter.name) ||
      WINDOWS_DEVICE_NAME.test(frontmatter.name)
    )
      return {
        name: directoryName,
        description: frontmatter.description,
        localStatus: 'INVALID',
        skillFilePath: path.join(directory, 'SKILL.md')
      };
    const install = await readInstallMetadata(path.join(directory, '.mar-skill-install.json'));
    return {
      name: directoryName,
      description: frontmatter.description,
      localStatus: install === undefined ? 'UNKNOWN_VERSION' : 'VALID',
      skillFilePath: path.join(directory, 'SKILL.md'),
      ...(install === undefined ? {} : { install })
    };
  } catch {
    return {
      name: directoryName,
      description: '',
      localStatus: 'INVALID',
      skillFilePath: path.join(directory, 'SKILL.md')
    };
  }
}

async function readInstallMetadata(file: string): Promise<SkillInstallMetadata | undefined> {
  try {
    return skillInstallMetadataSchema.parse(JSON.parse(await readBounded(file)));
  } catch (error) {
    if (isMissing(error)) return undefined;
    return undefined;
  }
}

async function readBounded(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) throw new Error('SKILL_METADATA_INVALID');
    const buffer = Buffer.alloc(stat.size);
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (match === null) throw new Error('SKILL_METADATA_INVALID');
  const values = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^(name|description):\s*(.*?)\s*$/u.exec(line);
    if (field !== null) values.set(field[1]!, unquote(field[2]!));
  }
  const name = values.get('name');
  const description = values.get('description');
  if (name === undefined || description === undefined || description.length > 4096)
    throw new Error('SKILL_METADATA_INVALID');
  return { name, description };
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  )
    return value.slice(1, -1);
  return value;
}

function mergeWorkspaceCopies(
  agents: readonly RootEntry[],
  claude: readonly RootEntry[]
): LocalSkillInspection[] {
  const byName = new Map<string, { agents?: RootEntry; claude?: RootEntry }>();
  for (const item of agents) byName.set(item.name, { agents: item });
  for (const item of claude) byName.set(item.name, { ...byName.get(item.name), claude: item });
  return [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, copies]) => {
      if (copies.agents === undefined || copies.claude === undefined)
        return {
          ...withoutSource((copies.agents ?? copies.claude)!),
          name,
          localStatus: 'PARTIAL'
        };
      if (
        copies.agents.localStatus !== copies.claude.localStatus ||
        JSON.stringify(copies.agents.install) !== JSON.stringify(copies.claude.install)
      )
        return {
          name,
          description: copies.agents.description,
          localStatus: 'PARTIAL',
          skillFilePath: copies.agents.skillFilePath
        };
      return withoutSource(copies.agents);
    });
}

function mergeNodeCompatibilityRoots(
  agents: readonly RootEntry[],
  claude: readonly RootEntry[]
): LocalSkillInspection[] {
  const byName = new Map<string, { agents?: RootEntry; claude?: RootEntry }>();
  for (const item of agents) byName.set(item.name, { agents: item });
  for (const item of claude) byName.set(item.name, { ...byName.get(item.name), claude: item });
  return [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, copies]) => {
      if (copies.agents === undefined || copies.claude === undefined)
        return withoutSource((copies.agents ?? copies.claude)!);
      if (
        copies.agents.description !== copies.claude.description ||
        copies.agents.localStatus !== copies.claude.localStatus ||
        JSON.stringify(copies.agents.install) !== JSON.stringify(copies.claude.install)
      )
        return {
          name,
          description: copies.agents.description,
          localStatus: 'PARTIAL',
          skillFilePath: copies.agents.skillFilePath
        };
      return withoutSource(copies.agents);
    });
}

function withoutSource(entry: RootEntry): LocalSkillInspection {
  return {
    name: entry.name,
    description: entry.description,
    localStatus: entry.localStatus,
    skillFilePath: entry.skillFilePath,
    ...(entry.install === undefined ? {} : { install: entry.install })
  };
}

async function nodeCompatibilityMode(
  agentsRoot: string,
  claudeRoot: string
): Promise<LocalSkillTargetInspection['compatibilityMode']> {
  try {
    const stat = await lstat(claudeRoot);
    if (stat.isSymbolicLink()) {
      const target = await realpath(
        path.resolve(path.dirname(claudeRoot), await readlink(claudeRoot))
      );
      const agents = await realpath(agentsRoot);
      return target === agents
        ? process.platform === 'win32'
          ? 'JUNCTION'
          : 'SYMLINK'
        : 'UNAVAILABLE';
    }
    return stat.isDirectory() ? 'MANAGED_COPY' : 'UNAVAILABLE';
  } catch (error) {
    if (isMissing(error)) return 'UNAVAILABLE';
    return 'UNAVAILABLE';
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
