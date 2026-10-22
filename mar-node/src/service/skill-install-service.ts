import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { skillInstallMetadataSchema, type SkillInstallMetadata } from '@myagentroam/protocol';
import { GitCommandError, resolveWorkspaceGitRoot } from '../workspace.js';
import {
  rewriteWorkspaceGitExclude,
  updateWorkspaceSkillGitExclude
} from './workspace-git-exclude-service.js';

export interface SkillBundleFile {
  readonly path: string;
  readonly contentBase64: string;
}

export interface InstallableSkillBundle {
  readonly schemaVersion: 1;
  readonly files: readonly SkillBundleFile[];
}

export class SkillInstallService {
  async recoverNodeHome(home: string): Promise<void> {
    const agentsRoot = path.join(home, '.agents', 'skills');
    const claudeRoot = path.join(home, '.claude', 'skills');
    await assertExistingContainedDirectory(home, agentsRoot);
    const roots = [agentsRoot];
    if (await exists(claudeRoot)) {
      const stat = await lstat(claudeRoot);
      if (stat.isSymbolicLink()) {
        if (
          !(await exists(agentsRoot)) ||
          (await realpath(claudeRoot)) !== (await realpath(agentsRoot))
        )
          throw new Error('NODE_SKILL_LINK_UNAVAILABLE');
      } else {
        await assertContainedDirectory(home, claudeRoot);
        roots.push(claudeRoot);
      }
    }
    await recoverTransactions(roots);
  }

  async recoverWorkspace(workspace: string): Promise<void> {
    const roots = [
      path.join(workspace, '.agents', 'skills'),
      path.join(workspace, '.claude', 'skills')
    ];
    for (const root of roots) await assertExistingContainedDirectory(workspace, root);
    await recoverTransactions(roots);
  }

  async installNodeHome(
    home: string,
    name: string,
    bundle: InstallableSkillBundle,
    metadata: SkillInstallMetadata
  ): Promise<void> {
    assertName(name);
    skillInstallMetadataSchema.parse(metadata);
    const agentsRoot = path.join(home, '.agents', 'skills');
    await mkdir(agentsRoot, { recursive: true });
    await assertContainedDirectory(home, agentsRoot);
    const claudeRoot = path.join(home, '.claude', 'skills');
    const mode = await ensureClaudeRoot(agentsRoot, claudeRoot);
    if (mode === 'MANAGED_COPY') await assertContainedDirectory(home, claudeRoot);
    await replaceDirectory(agentsRoot, name, bundle, metadata);
    if (mode === 'MANAGED_COPY') await replaceDirectory(claudeRoot, name, bundle, metadata);
  }

  async installWorkspace(
    workspace: string,
    name: string,
    bundle: InstallableSkillBundle,
    metadata: SkillInstallMetadata,
    options: { readonly confirmTracked?: boolean; readonly includeParentRepository?: boolean } = {}
  ): Promise<void> {
    assertName(name);
    skillInstallMetadataSchema.parse(metadata);
    if (!options.confirmTracked && (await workspaceSkillTracked(workspace, name)))
      throw new Error('WORKSPACE_SKILL_TRACKED_CONFIRM_REQUIRED');
    const agentsRoot = path.join(workspace, '.agents', 'skills');
    const claudeRoot = path.join(workspace, '.claude', 'skills');
    await mkdir(agentsRoot, { recursive: true });
    await mkdir(claudeRoot, { recursive: true });
    await assertContainedDirectory(workspace, agentsRoot);
    await assertContainedDirectory(workspace, claudeRoot);
    await replacePair(
      agentsRoot,
      claudeRoot,
      name,
      bundle,
      metadata,
      () =>
        updateWorkspaceSkillGitExclude(
          workspace,
          name,
          true,
          options.includeParentRepository ?? true
        ),
      () =>
        updateWorkspaceSkillGitExclude(
          workspace,
          name,
          false,
          options.includeParentRepository ?? true
        )
    );
  }

  async removeWorkspace(
    workspace: string,
    name: string,
    includeParentRepository = true
  ): Promise<void> {
    assertName(name);
    const agentsRoot = path.join(workspace, '.agents', 'skills');
    const claudeRoot = path.join(workspace, '.claude', 'skills');
    await assertExistingContainedDirectory(workspace, agentsRoot);
    await assertExistingContainedDirectory(workspace, claudeRoot);
    await removePair(
      agentsRoot,
      claudeRoot,
      name,
      () => updateWorkspaceSkillGitExclude(workspace, name, false, includeParentRepository),
      () => updateWorkspaceSkillGitExclude(workspace, name, true, includeParentRepository)
    );
  }

  async removeNodeHome(home: string, name: string): Promise<void> {
    assertName(name);
    const agentsRoot = path.join(home, '.agents', 'skills');
    const claudeRoot = path.join(home, '.claude', 'skills');
    const mode = await ensureClaudeRoot(agentsRoot, claudeRoot);
    if (mode === 'MANAGED_COPY') await assertContainedDirectory(home, claudeRoot);
    if (mode === 'MANAGED_COPY') await removePair(agentsRoot, claudeRoot, name);
    else await removeSingle(agentsRoot, name);
  }

  async repairWorkspaceGitExclude(
    workspace: string,
    includeParentRepository = true
  ): Promise<void> {
    const root = path.join(workspace, '.agents', 'skills');
    const names = new Set<string>();
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          assertName(entry.name);
          names.add(entry.name);
        } catch {
          // Invalid directory names remain visible to inspection but are never written as patterns.
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await rewriteWorkspaceGitExclude(workspace, names, includeParentRepository);
  }
}

export async function workspaceSkillTracked(workspace: string, name: string): Promise<boolean> {
  assertName(name);
  try {
    await resolveWorkspaceGitRoot(workspace);
  } catch (error) {
    if (
      (error instanceof GitCommandError && error.code === 128) ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return false;
    throw error;
  }
  try {
    const result = await promisify(execFile)(
      'git',
      ['-C', workspace, 'ls-files', '--', `.agents/skills/${name}`, `.claude/skills/${name}`],
      { timeout: 5_000, windowsHide: true }
    );
    return result.stdout.trim() !== '';
  } catch {
    throw new Error('WORKSPACE_SKILL_GIT_EXCLUDE_FAILED');
  }
}

async function replacePair(
  firstRoot: string,
  secondRoot: string,
  name: string,
  bundle: InstallableSkillBundle,
  metadata: SkillInstallMetadata,
  beforeCommit?: () => Promise<void>,
  rollbackSideEffect?: () => Promise<void>
): Promise<void> {
  const transactionId = randomUUID();
  const first = await prepare(firstRoot, name, bundle, metadata);
  let second: PreparedDirectory | undefined;
  let sideEffectApplied = false;
  try {
    second = await prepare(secondRoot, name, bundle, metadata);
    await writeTransaction([firstRoot, secondRoot], transactionId, 'PREPARED', [first, second]);
    await commitPrepared(first);
    await commitPrepared(second);
    await beforeCommit?.();
    sideEffectApplied = beforeCommit !== undefined;
    await writeTransaction([firstRoot, secondRoot], transactionId, 'COMMITTED', [first, second]);
  } catch (error) {
    if (sideEffectApplied) await rollbackSideEffect?.();
    if (second !== undefined) await rollbackPrepared(second);
    await rollbackPrepared(first);
    await removeTransaction([firstRoot, secondRoot], transactionId);
    throw error;
  }
  try {
    await cleanupPrepared(first);
    await cleanupPrepared(second);
    await removeTransaction([firstRoot, secondRoot], transactionId);
  } catch {
    // COMMITTED journal remains authoritative and the next inspect/install finishes cleanup.
  }
}

async function replaceDirectory(
  root: string,
  name: string,
  bundle: InstallableSkillBundle,
  metadata: SkillInstallMetadata
): Promise<void> {
  const transactionId = randomUUID();
  const prepared = await prepare(root, name, bundle, metadata);
  try {
    await writeTransaction([root], transactionId, 'PREPARED', [prepared]);
    await commitPrepared(prepared);
    await writeTransaction([root], transactionId, 'COMMITTED', [prepared]);
  } catch (error) {
    await rollbackPrepared(prepared);
    await removeTransaction([root], transactionId);
    throw error;
  }
  try {
    await cleanupPrepared(prepared);
    await removeTransaction([root], transactionId);
  } catch {
    // COMMITTED journal remains authoritative and the next inspect/install finishes cleanup.
  }
}

interface PreparedDirectory {
  target: string;
  staging: string;
  backup: string;
  hadTarget: boolean;
  committed: boolean;
}

interface SkillTransactionRecord {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly state: 'PREPARED' | 'COMMITTED';
  readonly roots: readonly string[];
  readonly items: readonly Pick<PreparedDirectory, 'target' | 'staging' | 'backup' | 'hadTarget'>[];
}

async function writeTransaction(
  roots: readonly string[],
  transactionId: string,
  state: SkillTransactionRecord['state'],
  items: readonly PreparedDirectory[]
): Promise<void> {
  const record: SkillTransactionRecord = {
    schemaVersion: 1,
    transactionId,
    state,
    roots,
    items: items.map(({ target, staging, backup, hadTarget }) => ({
      target,
      staging,
      backup,
      hadTarget
    }))
  };
  for (const root of roots) {
    await mkdir(root, { recursive: true });
    const destination = transactionPath(root, transactionId);
    const staging = `${destination}.tmp`;
    await writeFile(staging, JSON.stringify(record), { flag: 'w' });
    await rename(staging, destination);
  }
}

async function removeTransaction(roots: readonly string[], transactionId: string): Promise<void> {
  await Promise.all(roots.map((root) => rm(transactionPath(root, transactionId), { force: true })));
}

async function recoverTransactions(roots: readonly string[]): Promise<void> {
  const normalizedRoots = roots.map((root) => path.resolve(root));
  const records = new Map<string, SkillTransactionRecord>();
  for (const root of normalizedRoots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries.filter((name) =>
      /^\.mar-transaction-[0-9a-f-]+\.json$/u.test(name)
    )) {
      let record: SkillTransactionRecord;
      try {
        record = JSON.parse(
          await readFile(path.join(root, entry), 'utf8')
        ) as SkillTransactionRecord;
        validateTransaction(record, normalizedRoots);
      } catch {
        throw new Error('SKILL_INSTALL_RECOVERY_REQUIRED');
      }
      records.set(record.transactionId, record);
    }
  }
  for (const record of records.values()) {
    if (record.state === 'COMMITTED') {
      for (const item of record.items) {
        await rm(item.backup, { recursive: true, force: true });
        await rm(item.staging, { recursive: true, force: true });
      }
    } else {
      for (const item of [...record.items].reverse()) await recoverPrepared(item);
    }
    await removeTransaction(record.roots, record.transactionId);
  }
}

async function recoverPrepared(
  item: Pick<PreparedDirectory, 'target' | 'staging' | 'backup' | 'hadTarget'>
): Promise<void> {
  if (await exists(item.backup)) {
    await rm(item.target, { recursive: true, force: true });
    await rename(item.backup, item.target);
  } else if (!item.hadTarget && (await exists(item.target)) && !(await exists(item.staging))) {
    await rm(item.target, { recursive: true, force: true });
  }
  await rm(item.staging, { recursive: true, force: true });
}

function validateTransaction(record: SkillTransactionRecord, roots: readonly string[]): void {
  if (
    record.schemaVersion !== 1 ||
    !/^[0-9a-f-]{36}$/u.test(record.transactionId) ||
    !['PREPARED', 'COMMITTED'].includes(record.state) ||
    !Array.isArray(record.roots) ||
    record.roots.some((root) => !roots.includes(path.resolve(root))) ||
    !Array.isArray(record.items) ||
    record.items.length < 1 ||
    record.items.length > 2
  )
    throw new Error('SKILL_INSTALL_RECOVERY_REQUIRED');
  for (const item of record.items) {
    const root = path.dirname(item.target);
    if (
      !roots.includes(path.resolve(root)) ||
      path.dirname(item.staging) !== root ||
      path.dirname(item.backup) !== root ||
      !path.basename(item.staging).startsWith('.mar-staging-') ||
      !path.basename(item.backup).startsWith('.mar-backup-')
    )
      throw new Error('SKILL_INSTALL_RECOVERY_REQUIRED');
  }
}

function transactionPath(root: string, transactionId: string): string {
  return path.join(root, `.mar-transaction-${transactionId}.json`);
}

async function prepare(
  root: string,
  name: string,
  bundle: InstallableSkillBundle,
  metadata: SkillInstallMetadata
): Promise<PreparedDirectory> {
  await mkdir(root, { recursive: true });
  const caseCollision = (await readdir(root)).find(
    (entry) => entry.toLowerCase() === name && entry !== name
  );
  if (caseCollision !== undefined) throw new Error('SKILL_NAME_CONFLICT');
  const target = path.join(root, name);
  const staging = path.join(root, `.mar-staging-${randomUUID()}`);
  const backup = path.join(root, `.mar-backup-${randomUUID()}`);
  const hadTarget = await exists(target);
  if (hadTarget) {
    const targetStat = await lstat(target);
    if (!targetStat.isDirectory() && !targetStat.isSymbolicLink())
      throw new Error('SKILL_INSTALL_INVALID_LINK');
  }
  await mkdir(staging, { recursive: false });
  try {
    if (bundle.schemaVersion !== 1 || bundle.files.length === 0 || bundle.files.length > 1_000)
      throw new Error('SKILL_CONTENT_INVALID');
    const paths = new Set<string>();
    for (const file of bundle.files) {
      assertRelative(file.path);
      if (paths.has(file.path)) throw new Error('SKILL_CONTENT_INVALID');
      paths.add(file.path);
      const destination = path.join(staging, ...file.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.contentBase64, 'base64'), { flag: 'wx' });
    }
    await writeFile(path.join(staging, '.mar-skill-install.json'), JSON.stringify(metadata), {
      flag: 'wx'
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { target, staging, backup, hadTarget, committed: false };
}

async function assertContainedDirectory(container: string, directory: string): Promise<void> {
  const [containerReal, directoryReal] = await Promise.all([
    realpath(container),
    realpath(directory)
  ]);
  const relative = path.relative(containerReal, directoryReal);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('SKILL_PATH_UNSAFE');
}

async function assertExistingContainedDirectory(
  container: string,
  directory: string
): Promise<void> {
  if (await exists(directory)) await assertContainedDirectory(container, directory);
}

async function removeSingle(root: string, name: string): Promise<void> {
  const target = path.join(root, name);
  if (!(await exists(target))) return;
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SKILL_INSTALL_INVALID_LINK');
  const backup = path.join(root, `.mar-delete-${randomUUID()}`);
  await rename(target, backup);
  await rm(backup, { recursive: true, force: true });
}

async function commitPrepared(item: PreparedDirectory): Promise<void> {
  if (item.hadTarget) await rename(item.target, item.backup);
  await rename(item.staging, item.target);
  item.committed = true;
}

async function rollbackPrepared(item: PreparedDirectory): Promise<void> {
  if (item.committed) await rm(item.target, { recursive: true, force: true });
  if (await exists(item.backup)) await rename(item.backup, item.target);
  await rm(item.staging, { recursive: true, force: true });
}

async function cleanupPrepared(item: PreparedDirectory): Promise<void> {
  await rm(item.backup, { recursive: true, force: true });
}

async function removePair(
  firstRoot: string,
  secondRoot: string,
  name: string,
  beforeCommit?: () => Promise<void>,
  rollbackSideEffect?: () => Promise<void>
): Promise<void> {
  const first = path.join(firstRoot, name);
  const second = path.join(secondRoot, name);
  for (const target of [first, second]) {
    if (!(await exists(target))) continue;
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SKILL_INSTALL_INVALID_LINK');
  }
  const firstBackup = `${first}.mar-delete-${randomUUID()}`;
  const secondBackup = `${second}.mar-delete-${randomUUID()}`;
  let sideEffectApplied = false;
  try {
    if (await exists(first)) await rename(first, firstBackup);
    if (await exists(second)) await rename(second, secondBackup);
    await beforeCommit?.();
    sideEffectApplied = beforeCommit !== undefined;
    await rm(firstBackup, { recursive: true, force: true });
    await rm(secondBackup, { recursive: true, force: true });
  } catch (error) {
    if (sideEffectApplied) await rollbackSideEffect?.();
    if (await exists(firstBackup)) await rename(firstBackup, first);
    if (await exists(secondBackup)) await rename(secondBackup, second);
    throw error;
  }
}

async function ensureClaudeRoot(
  agentsRoot: string,
  claudeRoot: string
): Promise<'LINK' | 'MANAGED_COPY'> {
  try {
    const stat = await lstat(claudeRoot);
    if (stat.isSymbolicLink()) {
      const linked = await realpath(
        path.resolve(path.dirname(claudeRoot), await readlink(claudeRoot))
      );
      const agents = await realpath(agentsRoot);
      if (linked !== agents) throw new Error('NODE_SKILL_LINK_UNAVAILABLE');
      return 'LINK';
    }
    if (stat.isDirectory()) return 'MANAGED_COPY';
    throw new Error('NODE_SKILL_LINK_UNAVAILABLE');
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path.dirname(claudeRoot), { recursive: true });
    try {
      await symlink(agentsRoot, claudeRoot, process.platform === 'win32' ? 'junction' : 'dir');
      return 'LINK';
    } catch (linkError) {
      if (process.platform !== 'win32') throw linkError;
      await mkdir(claudeRoot, { recursive: true });
      return 'MANAGED_COPY';
    }
  }
}

function assertName(name: string): void {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(name)
  )
    throw new Error('SKILL_NAME_CONFLICT');
}
function assertRelative(value: string): void {
  if (
    value === '' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('SKILL_PATH_UNSAFE');
}
async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
