import { realpath, rmdir } from 'node:fs/promises';
import type { NodeConfig } from '../config.js';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import type { NodeDatabase } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import {
  createWorkspaceDirectory,
  inspectWorkspace,
  listWorkspaceDirectories
} from '../workspace.js';
import { ensureWorkspaceGitExclude } from './workspace-git-exclude-service.js';
import { workspaceGitSettingsSchema } from '@myagentroam/protocol';

export class WorkspaceService {
  constructor(
    private readonly database: () => NodeDatabase,
    private readonly config: () => NodeConfig,
    private readonly runtime: NodeRuntimeState,
    private readonly onRemoved: (workspaceId: string) => void,
    private readonly onGitPolicyChanged: (workspaceId: string) => void = () => undefined
  ) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'workspace.register': (data) => this.register(data),
      'workspace.directories.list': (data) => this.listDirectories(data),
      'workspace.remove': (data) => this.remove(data),
      'workspace.git.settings.get': (data) => this.gitPolicy(data, false),
      'workspace.git.settings.update': (data) => this.gitPolicy(data, true),
      'workspace.list': () => ({ workspaces: this.database().listWorkspaces() })
    };
  }

  private async register(data: unknown): Promise<unknown> {
    const input = data as Record<string, unknown>;
    if (typeof input.path !== 'string') throw new Error('WORKSPACE_INVALID');
    if (input.preserveGitConfig !== undefined && typeof input.preserveGitConfig !== 'boolean')
      throw new Error('GIT_CONFIGURATION_INVALID');
    if (input.createDirectoryName !== undefined && typeof input.createDirectoryName !== 'string')
      throw new Error('WORKSPACE_DIRECTORY_NAME_INVALID');
    let createdPath: string | undefined;
    try {
      const path =
        typeof input.createDirectoryName === 'string'
          ? (createdPath = await createWorkspaceDirectory(
              input.path,
              input.createDirectoryName,
              this.config().allowedRoots
            ))
          : input.path;
      const canonicalPath = await realpath(path);
      const current = this.database().getWorkspaceByPath(canonicalPath);
      const includeParentRepository = current?.includeParentRepository ?? true;
      const inspected = await inspectWorkspace(
        canonicalPath,
        this.config().allowedRoots,
        includeParentRepository
      );
      let latest = this.database().getWorkspaceByPath(canonicalPath);
      if (
        latest !== undefined &&
        (latest.includeParentRepository ?? true) !== includeParentRepository
      )
        return { workspace: latest };
      if (inspected.kind === 'GIT_WORKSPACE') {
        await ensureWorkspaceGitExclude(inspected.path, includeParentRepository);
        latest = this.database().getWorkspaceByPath(canonicalPath);
        if (
          latest !== undefined &&
          (latest.includeParentRepository ?? true) !== includeParentRepository
        )
          return { workspace: latest };
      }
      return {
        workspace: this.database().saveWorkspace({
          path: inspected.path,
          kind: inspected.kind,
          gitSummary: inspected.gitSummary ?? null,
          preserveGitConfig: input.preserveGitConfig === true,
          includeParentRepository
        })
      };
    } catch (error) {
      if (createdPath !== undefined) await rmdir(createdPath).catch(() => undefined);
      throw error;
    }
  }

  private async listDirectories(data: unknown): Promise<unknown> {
    const input = data as Record<string, unknown>;
    if (input.path !== undefined && typeof input.path !== 'string')
      throw new Error('WORKSPACE_DIRECTORY_INVALID');
    return {
      directory: await listWorkspaceDirectories(
        input.path as string | undefined,
        this.config().allowedRoots
      )
    };
  }

  private remove(data: unknown): unknown {
    const input = data as Record<string, unknown>;
    if (typeof input.workspaceId !== 'string') throw new Error('WORKSPACE_NOT_FOUND');
    if (this.runtime.hasActiveWorkspaceLease(input.workspaceId)) throw new Error('WORKSPACE_BUSY');
    const workspace = this.database().removeWorkspace(input.workspaceId);
    this.runtime.removeWorkspace(input.workspaceId);
    this.onRemoved(workspace.id);
    return { workspace };
  }

  private gitPolicy(data: unknown, update: boolean): unknown {
    const input = data as Record<string, unknown>;
    if (typeof input.workspaceId !== 'string') throw new Error('WORKSPACE_NOT_FOUND');
    const current = this.database().getWorkspace(input.workspaceId);
    if (current === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    if (!update)
      return {
        preserveGitConfig: current.preserveGitConfig ?? true,
        includeParentRepository: current.includeParentRepository ?? true
      };
    const parsed = workspaceGitSettingsSchema.safeParse({
      preserveGitConfig: input.preserveGitConfig,
      includeParentRepository: input.includeParentRepository
    });
    if (!parsed.success) throw new Error('GIT_CONFIGURATION_INVALID');
    const result = this.database().setWorkspaceGitPolicy(
      input.workspaceId,
      parsed.data.preserveGitConfig,
      parsed.data.includeParentRepository
    );
    if (result.includeParentRepository !== current.includeParentRepository)
      this.onGitPolicyChanged(current.id);
    return {
      preserveGitConfig: result.preserveGitConfig,
      includeParentRepository: result.includeParentRepository
    };
  }
}
