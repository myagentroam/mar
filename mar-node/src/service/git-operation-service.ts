import { AsyncLocalStorage } from 'node:async_hooks';
import { personalGitRuntimeSchema } from '@myagentroam/protocol';
import type { NodeWorkspace } from '../database.js';
import { parseSecretEnvironment } from '../util/secret-environment.js';
import type { GitExecutionService } from './git-execution-service.js';

export const gitOperationEnvironment = new AsyncLocalStorage<Readonly<Record<string, string>>>();

/** Binds authenticated operations to the same lease mechanism as Runner queues. */
export class GitOperationService {
  private readonly commandLeases = new Map<string, () => void>();
  constructor(
    private readonly options: {
      readonly git: () => GitExecutionService;
      readonly workspace: (input: Record<string, unknown>) => Promise<NodeWorkspace | undefined>;
      readonly runActive: (id: string) => boolean;
    }
  ) {}

  async execute(
    operation: string,
    data: unknown,
    next: (data: unknown) => Promise<unknown>
  ): Promise<unknown> {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return next(data);
    const { gitConfiguration, ...input } = data as Record<string, unknown>;
    if (gitConfiguration === undefined || operation.startsWith('conversation.')) return next(input);
    if (!Number.isSafeInteger(input.__requestUserId) || Number(input.__requestUserId) < 1)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    const workspace = await this.options.workspace(input);
    if (workspace?.preserveGitConfig === true) return next(input);
    if (workspace === undefined && operation !== 'terminal.open')
      throw new Error('WORKSPACE_NOT_FOUND');
    const parsed = personalGitRuntimeSchema.safeParse(gitConfiguration);
    if (!parsed.success) throw new Error('GIT_CONFIGURATION_INVALID');
    const service = this.options.git();
    const lease = await service.acquire(
      Number(input.__requestUserId),
      parsed.data,
      parseSecretEnvironment(input.secretEnvironment)
    );
    try {
      const result = await gitOperationEnvironment.run(lease.environment, () =>
        next({ ...input, secretEnvironment: lease.environment })
      );
      if (
        operation === 'session.command.execute' &&
        result !== null &&
        typeof result === 'object' &&
        'run' in result
      ) {
        const run = result.run as { id?: unknown } | undefined;
        if (typeof run?.id === 'string' && this.options.runActive(run.id)) {
          this.commandLeases.get(run.id)?.();
          this.commandLeases.set(run.id, service.retain(lease.environment));
        }
      }
      return result;
    } finally {
      lease.release();
    }
  }

  executionFinished(id: string): void {
    this.commandLeases.get(id)?.();
    this.commandLeases.delete(id);
  }
  clear(): void {
    for (const release of this.commandLeases.values()) release();
    this.commandLeases.clear();
  }
}
