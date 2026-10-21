import { markupAttributes, markupText } from '../../prompts/markup.js';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, posix, relative, resolve } from 'node:path';
import { MarAgentError } from '../../error.js';
import type { HostSkill } from '../../host/contracts.js';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_PROJECT_BYTES = 32 * 1024;
const INSTRUCTION_FILENAMES = ['AGENTS.override.md', 'AGENTS.md'] as const;
const REPLACEMENT_NOTICE =
  'These AGENTS.md instructions replace all previously provided AGENTS.md instructions.';
const REMOVAL_NOTICE = 'The previously provided AGENTS.md instructions no longer apply.';

export interface AgentInstructionEntry {
  kind: 'user' | 'project' | 'scoped';
  label: string;
  sourcePath: string;
  displayPath: string;
  scopePath: string;
  displayScope: string;
  content: string;
  truncated: boolean;
}

interface FileAgentSkill {
  name: string;
  description: string;
  path: string;
  displayPath: string;
  boundary: string;
  source?: 'file';
}

export type AgentSkill = FileAgentSkill | (HostSkill & { source: 'host' });

export function agentSkillSource(skill: AgentSkill): string {
  return skill.source === 'host' ? 'Host-provided' : dirname(skill.displayPath);
}

export async function loadAgentInstructions(input: {
  home: string;
  workspace: string;
  workspaceDisplayPath?: string;
  availableTools?: ReadonlySet<string>;
  hostSkills?: readonly HostSkill[];
}): Promise<{
  entries: readonly AgentInstructionEntry[];
  skillCatalog: string;
  skills: ReadonlyMap<string, AgentSkill>;
}> {
  const entries: AgentInstructionEntry[] = [];
  let remaining = MAX_PROJECT_BYTES;
  const addPreferred = async (entry: {
    kind: AgentInstructionEntry['kind'];
    label: string;
    directory: string;
    boundary: string;
    displayDirectory: string;
    displayScope: string;
    scopePath: string;
  }) => {
    const maxBytes = entry.kind === 'user' ? MAX_FILE_BYTES : remaining;
    if (maxBytes === 0) return;
    const selected = await loadPreferredInstruction({
      directory: entry.directory,
      boundary: entry.boundary,
      maxBytes
    });
    if (!selected || !selected.content.trim()) return;
    entries.push({
      kind: entry.kind,
      label: selected.override ? `${entry.label} (override)` : entry.label,
      sourcePath: selected.sourcePath,
      displayPath: displayJoin(entry.displayDirectory, selected.fileName),
      scopePath: resolve(entry.scopePath),
      displayScope: entry.displayScope,
      content: selected.content,
      truncated: selected.truncated
    });
    if (entry.kind !== 'user') remaining -= selected.loadedBytes;
  };
  await addPreferred({
    kind: 'user',
    label: 'User instructions',
    directory: join(input.home, '.agents'),
    boundary: input.home,
    displayDirectory: '~/.agents',
    displayScope: '<account>',
    scopePath: input.home
  });
  const projectRoot = await nearestProjectRoot(input.workspace);
  await addPreferred({
    kind: 'project',
    label: 'Project instructions',
    directory: projectRoot,
    boundary: projectRoot,
    displayDirectory: '<project>',
    displayScope: '<project>',
    scopePath: projectRoot
  });
  for (const directory of instructionDirectories(projectRoot, input.workspace).slice(1)) {
    const relativeDirectory = relative(projectRoot, directory);
    const displayDirectory = projectDisplayPath(projectRoot, directory);
    await addPreferred({
      kind: 'scoped',
      label: `Scoped instructions: ${relativeDirectory}`,
      directory,
      boundary: projectRoot,
      displayDirectory,
      displayScope: displayDirectory,
      scopePath: directory
    });
  }

  const skills = new Map<string, AgentSkill>();
  const hostNames = new Set<string>();
  for (const skill of input.hostSkills ?? []) {
    if (!skill.name.trim() || skill.name.length > 128 || hostNames.has(skill.name))
      throw new MarAgentError(
        'MAR_AGENT_TOOL_INPUT_INVALID',
        'Host skill names must be unique and nonempty.'
      );
    hostNames.add(skill.name);
    if (skill.requiredTools.every((name) => input.availableTools?.has(name)))
      skills.set(skill.name, { ...skill, source: 'host', load: () => skill.load() });
  }
  await discoverSkills(join(input.home, '.agents', 'skills'), input.home, skills);
  const projectSkillRoot = join(projectRoot, '.agents', 'skills');
  await discoverSkills(
    projectSkillRoot,
    projectRoot,
    skills,
    displayPath(projectSkillRoot, input.workspace, input.workspaceDisplayPath)
  );
  const skillCatalog =
    skills.size === 0
      ? ''
      : `## Available skills\n\n${[...skills]
          .map(
            ([name, skill]) =>
              `- ${name}: ${skill.description} (source: ${agentSkillSource(skill)})`
          )
          .join('\n')}`;
  return { entries, skillCatalog, skills };
}

export function renderAgentInstructions(
  entries: readonly AgentInstructionEntry[],
  previousMayContainInstructions: boolean
): string | undefined {
  if (entries.length === 0 && !previousMayContainInstructions) return undefined;
  const notice =
    entries.length === 0
      ? REMOVAL_NOTICE
      : previousMayContainInstructions
        ? REPLACEMENT_NOTICE
        : '';
  const sections = entries.map((entry) =>
    [
      `## ${entry.label}`,
      `Source: ${entry.displayPath}`,
      `Scope: ${entry.displayScope}`,
      ...(entry.truncated ? ['Status: truncated to the configured instruction budget'] : []),
      '',
      entry.content
    ].join('\n')
  );
  return [
    '# AGENTS.md instructions',
    '',
    markupText('mar_instructions', ([notice, ...sections].filter(Boolean) as string[]).join('\n'))
  ].join('\n');
}

export async function loadAgentSkill(skill: AgentSkill): Promise<string> {
  if (skill.source === 'host') {
    const body = await skill.load();
    if (!body.trim() || Buffer.byteLength(body) > MAX_FILE_BYTES) return '';
    return [
      `<mar_skill${markupAttributes({ name: skill.name, source: agentSkillSource(skill) })}>`,
      '  ' +
        markupText(
          'instruction',
          'This skill has no filesystem base directory or bundled scripts.'
        ),
      '  ' + markupText('content', body.trim()),
      '</mar_skill>'
    ].join('\n');
  }
  const body = await safeRead(skill.path, skill.boundary);
  if (!body) return '';
  const base = dirname(skill.path);
  const displayBase = dirname(skill.displayPath);
  const files = await sampleSkillFiles(base);
  return [
    `<mar_skill${markupAttributes({ name: skill.name, source: agentSkillSource(skill), baseDirectory: displayBase })}>`,
    '  ' +
      markupText(
        'instruction',
        'Relative paths in this skill are relative to the base directory. The file list is a sample; read only resources needed for the task.'
      ),
    '  ' + markupText('content', body.trim()),
    ...files.map(
      (path) =>
        `  <file${markupAttributes({ path: displayDescendant(base, displayBase, path) })} />`
    ),
    '</mar_skill>'
  ].join('\n');
}

async function nearestProjectRoot(workspace: string): Promise<string> {
  let current = resolve(workspace);
  const root = parse(current).root;
  while (true) {
    try {
      await stat(join(current, '.git'));
      return current;
    } catch {
      if (current === root) return resolve(workspace);
      current = dirname(current);
    }
  }
}

function instructionDirectories(root: string, target: string): string[] {
  const relativeTarget = relative(root, resolve(target));
  if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) return [resolve(target)];
  const result = [root];
  let current = root;
  for (const part of relativeTarget.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    result.push(current);
  }
  return result;
}

async function discoverSkills(
  root: string,
  boundary: string,
  target: Map<string, AgentSkill>,
  displayRoot = root
) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(root, entry.name, 'SKILL.md');
    const content = await safeRead(path, boundary);
    if (!content) continue;
    const description = /^description:\s*(.+)$/imu.exec(content)?.[1]?.trim() ?? 'Agent skill';
    target.set(entry.name, {
      name: entry.name,
      description,
      path,
      displayPath: displayJoin(displayRoot, entry.name, 'SKILL.md'),
      boundary
    });
  }
}

async function safeRead(path: string, boundary: string): Promise<string | undefined> {
  try {
    const [resolvedPath, resolvedBoundary] = await Promise.all([
      realpath(path),
      realpath(boundary)
    ]);
    const rel = relative(resolvedBoundary, resolvedPath);
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
    const loaded = await readInstructionFile(resolvedPath, MAX_FILE_BYTES);
    return loaded && !loaded.truncated ? loaded.content : undefined;
  } catch {
    return undefined;
  }
}

async function loadPreferredInstruction(input: {
  directory: string;
  boundary: string;
  maxBytes: number;
}): Promise<
  | {
      sourcePath: string;
      fileName: (typeof INSTRUCTION_FILENAMES)[number];
      override: boolean;
      content: string;
      loadedBytes: number;
      truncated: boolean;
    }
  | undefined
> {
  for (const fileName of INSTRUCTION_FILENAMES) {
    const sourcePath = resolve(input.directory, fileName);
    const loaded = await readInstructionFile(sourcePath, input.maxBytes);
    if (!loaded) continue;
    return {
      sourcePath,
      fileName,
      override: fileName === 'AGENTS.override.md',
      ...loaded
    };
  }
  return undefined;
}

async function readInstructionFile(
  path: string,
  maxBytes: number
): Promise<{ content: string; loadedBytes: number; truncated: boolean } | undefined> {
  let handle;
  try {
    if (!(await stat(path)).isFile()) return undefined;
    handle = await open(path, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let readBytes = 0;
    while (readBytes < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        readBytes,
        buffer.length - readBytes,
        readBytes
      );
      if (bytesRead === 0) break;
      readBytes += bytesRead;
    }
    const loadedBytes = Math.min(readBytes, maxBytes);
    return {
      content: buffer.subarray(0, loadedBytes).toString('utf8'),
      loadedBytes,
      truncated: readBytes > loadedBytes
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function projectDisplayPath(projectRoot: string, directory: string): string {
  const suffix = relative(resolve(projectRoot), resolve(directory));
  return displayJoin('<project>', ...suffix.split(/[\\/]/u).filter(Boolean));
}

async function sampleSkillFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const directories = [root];
  let scannedDirectories = 0;
  while (directories.length > 0 && files.length < 10 && scannedDirectories < 128) {
    const directory = directories.shift()!;
    scannedDirectories++;
    let entries;
    try {
      entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && path !== join(root, 'SKILL.md')) files.push(path);
      if (files.length >= 10) break;
    }
  }
  return files;
}

function displayPath(
  path: string,
  physicalWorkspace: string,
  logicalWorkspace: string | undefined
): string {
  if (logicalWorkspace === undefined) return path;
  const suffix = relative(resolve(physicalWorkspace), resolve(path));
  if (suffix.startsWith('..') || isAbsolute(suffix)) return path;
  return displayJoin(logicalWorkspace, ...suffix.split(/[\\/]/u).filter(Boolean));
}

function displayDescendant(physicalRoot: string, displayRoot: string, path: string): string {
  return displayJoin(displayRoot, ...relative(physicalRoot, path).split(/[\\/]/u).filter(Boolean));
}

function displayJoin(root: string, ...parts: string[]): string {
  return root.startsWith('/') ? posix.join(root, ...parts) : join(root, ...parts);
}
