import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { skillInstallMetadataSchema } from '@myagentroam/protocol';
import type { NodeConfig } from '../config.js';
import type { NodeDatabase } from '../database.js';
import { SkillDirectoryService } from './skill-directory-service.js';
import {
  SkillInstallService,
  workspaceSkillTracked,
  type InstallableSkillBundle
} from './skill-install-service.js';
import { safeErrorCode } from '../util/safe-error.js';

export class SkillNodeOperationService {
  private readonly directories = new SkillDirectoryService();
  private readonly installer = new SkillInstallService();
  private readonly activeTargets = new Set<string>();
  private readonly jobs = new Map<
    string,
    { status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; errorCode?: string; expiresAt: number }
  >();

  constructor(
    private readonly database: () => NodeDatabase,
    private readonly config: () => NodeConfig
  ) {}

  operations() {
    return {
      'node.skills.inspect': async (data: unknown) => {
        await this.installer.recoverNodeHome(homedir());
        return this.directories.inspectNodeHome(homedir(), {
          includeClaudeCompatibility: record(data)['includeClaudeCompatibility'] === true
        });
      },
      'node.skills.install': (data: unknown) => this.install('NODE', data),
      'node.skills.remove': (data: unknown) => this.remove('NODE', data),
      'workspace.skills.inspect': async (data: unknown) => {
        const workspace = this.workspacePath(record(data)['workspaceId']);
        await this.installer.recoverWorkspace(workspace);
        return this.directories.inspectWorkspace(
          workspace,
          this.database().getWorkspaceByPath(workspace)?.includeParentRepository ?? true
        );
      },
      'workspace.skills.install': (data: unknown) => this.install('WORKSPACE', data),
      'workspace.skills.remove': (data: unknown) => this.remove('WORKSPACE', data),
      'workspace.skills.git-exclude-repair': async (data: unknown) => {
        const workspace = this.workspacePath(record(data)['workspaceId']);
        await this.installer.recoverWorkspace(workspace);
        await this.installer.repairWorkspaceGitExclude(
          workspace,
          this.database().getWorkspaceByPath(workspace)?.includeParentRepository ?? true
        );
        return { repaired: true };
      },
      'skill.install.job.get': (data: unknown) => this.job(data)
    };
  }

  private async install(target: 'NODE' | 'WORKSPACE', data: unknown) {
    const input = record(data);
    const name = text(input['name'], 'SKILL_NAME_CONFLICT');
    const ticket = text(input['artifactTicket'], 'SKILL_INSTALL_FAILED');
    const metadata = skillInstallMetadataSchema.parse(input['metadata']);
    const workspace = target === 'WORKSPACE' ? this.workspacePath(input['workspaceId']) : undefined;
    if (workspace === undefined) await this.installer.recoverNodeHome(homedir());
    else await this.installer.recoverWorkspace(workspace);
    if (
      workspace !== undefined &&
      input['confirmTracked'] !== true &&
      (await workspaceSkillTracked(workspace, name))
    )
      throw new Error('WORKSPACE_SKILL_TRACKED_CONFIRM_REQUIRED');
    const targetKey = `${target}:${workspace ?? homedir()}`;
    this.cleanupJobs();
    if (this.activeTargets.has(targetKey)) throw new Error('WORKSPACE_BUSY');
    if (this.activeTargets.size >= 50) throw new Error('SKILL_TARGET_LIMIT_EXCEEDED');
    const installJobId = randomUUID();
    this.activeTargets.add(targetKey);
    this.jobs.set(installJobId, { status: 'RUNNING', expiresAt: Date.now() + 5 * 60_000 });
    void (async () => {
      let terminal: { status: 'SUCCEEDED' } | { status: 'FAILED'; errorCode: string };
      try {
        await this.performInstall({
          target,
          name,
          ticket,
          metadata,
          ...(workspace === undefined ? {} : { workspace })
        });
        terminal = { status: 'SUCCEEDED' };
      } catch (error) {
        terminal = {
          status: 'FAILED',
          errorCode: safeErrorCode(error, 'SKILL_INSTALL_FAILED')
        };
      }
      this.activeTargets.delete(targetKey);
      this.jobs.set(installJobId, { ...terminal, expiresAt: Date.now() + 5 * 60_000 });
    })();
    return { accepted: true, installJobId };
  }

  private job(data: unknown) {
    const installJobId = text(record(data)['installJobId'], 'MESSAGE_INVALID');
    this.cleanupJobs();
    const job = this.jobs.get(installJobId);
    if (job === undefined) throw new Error('SKILL_INSTALL_FAILED');
    return {
      installJobId,
      status: job.status,
      ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode })
    };
  }

  private cleanupJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) if (job.expiresAt < now) this.jobs.delete(id);
    while (this.jobs.size > 1_000) this.jobs.delete(this.jobs.keys().next().value!);
  }

  private async performInstall(input: {
    target: 'NODE' | 'WORKSPACE';
    name: string;
    ticket: string;
    metadata: Parameters<SkillInstallService['installNodeHome']>[3];
    workspace?: string;
  }): Promise<void> {
    const bundle = await this.download(input.ticket, input.metadata.contentHash);
    if (input.target === 'NODE')
      await this.installer.installNodeHome(homedir(), input.name, bundle, input.metadata);
    else
      await this.installer.installWorkspace(input.workspace!, input.name, bundle, input.metadata, {
        confirmTracked: true,
        includeParentRepository:
          this.database().getWorkspaceByPath(input.workspace!)?.includeParentRepository ?? true
      });
  }

  private async remove(target: 'NODE' | 'WORKSPACE', data: unknown) {
    const input = record(data);
    const name = text(input['name'], 'SKILL_NAME_CONFLICT');
    const workspace = target === 'WORKSPACE' ? this.workspacePath(input['workspaceId']) : undefined;
    const targetKey = `${target}:${workspace ?? homedir()}`;
    if (this.activeTargets.has(targetKey)) throw new Error('WORKSPACE_BUSY');
    this.activeTargets.add(targetKey);
    try {
      if (target === 'NODE') {
        await this.installer.recoverNodeHome(homedir());
        await this.installer.removeNodeHome(homedir(), name);
      } else {
        await this.installer.recoverWorkspace(workspace!);
        await this.installer.removeWorkspace(
          workspace!,
          name,
          this.database().getWorkspaceByPath(workspace!)?.includeParentRepository ?? true
        );
      }
    } finally {
      this.activeTargets.delete(targetKey);
    }
    return { removed: true };
  }

  private workspacePath(value: unknown): string {
    const workspace = this.database().getWorkspace(text(value, 'WORKSPACE_INVALID'));
    if (workspace === undefined) throw new Error('WORKSPACE_INVALID');
    return workspace.path;
  }

  private async download(
    ticket: string,
    expectedContentHash: string
  ): Promise<InstallableSkillBundle> {
    const config = this.config();
    if (config.nodeId === undefined || config.credential === undefined)
      throw new Error('NODE_UNAUTHENTICATED');
    const response = await fetch(
      `${config.serverUrl.replace(/\/$/u, '')}/api/skill-artifacts/${encodeURIComponent(ticket)}`,
      {
        headers: {
          'x-mar-node-id': config.nodeId,
          authorization: `Bearer ${config.credential}`
        },
        signal: AbortSignal.timeout(60_000)
      }
    );
    if (!response.ok) throw new Error('SKILL_INSTALL_FAILED');
    const bundle = (await response.json()) as InstallableSkillBundle;
    validateBundle(bundle, expectedContentHash);
    return bundle;
  }
}

function validateBundle(bundle: InstallableSkillBundle, expectedContentHash: string): void {
  if (
    bundle === null ||
    typeof bundle !== 'object' ||
    bundle.schemaVersion !== 1 ||
    !Array.isArray(bundle.files) ||
    bundle.files.length < 1 ||
    bundle.files.length > 1_000
  )
    throw new Error('SKILL_CONTENT_INVALID');
  let total = 0;
  const paths = new Set<string>();
  for (const file of bundle.files) {
    if (
      file === null ||
      typeof file !== 'object' ||
      typeof file.path !== 'string' ||
      typeof file.contentBase64 !== 'string' ||
      paths.has(file.path)
    )
      throw new Error('SKILL_CONTENT_INVALID');
    paths.add(file.path);
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.toString('base64') !== file.contentBase64 || content.length > 5 * 1024 * 1024)
      throw new Error('SKILL_CONTENT_INVALID');
    total += content.length;
    if (total > 25 * 1024 * 1024) throw new Error('SKILL_CONTENT_INVALID');
  }
  if (!paths.has('SKILL.md') || paths.has('.mar-skill-install.json'))
    throw new Error('SKILL_CONTENT_INVALID');
  const canonical = bundle.files.map((file) => `${file.path}\0${file.contentBase64}`).join('\0');
  if (createHash('sha256').update(canonical).digest('hex') !== expectedContentHash)
    throw new Error('SKILL_CONTENT_INVALID');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('MESSAGE_INVALID');
  return value as Record<string, unknown>;
}
function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}
