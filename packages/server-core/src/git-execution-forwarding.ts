import type { PersonalGitService } from './personal-git-service.js';

export async function prepareGitExecutionContext(
  configuration: Pick<PersonalGitService, 'getRuntime'>,
  userId: number
) {
  const runtime = await configuration.getRuntime(userId);
  return runtime.credentials.length === 0 ? {} : { gitConfiguration: runtime };
}

const EXECUTION_OPERATIONS = new Set([
  'session.start',
  'session.message',
  'session.command.execute',
  'session.channel.message',
  'terminal.open',
  'workspace.diff',
  'workspace.changes.current',
  'workspace.change.diff',
  'workspace.change.restore'
]);

/** Applied after resource authorization, before the transport-only request channel. */
export class GitExecutionForwarding {
  constructor(private readonly configuration: Pick<PersonalGitService, 'getRuntime'>) {}

  async prepare(
    nodeId: string,
    operation: string,
    data: unknown,
    userId: number
  ): Promise<unknown> {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
    const { gitConfiguration: _untrusted, ...input } = data as Record<string, unknown>;
    void _untrusted;
    if (operation.startsWith('workspace.git.settings.')) {
      return input;
    }
    if (!EXECUTION_OPERATIONS.has(operation) && !operation.startsWith('workspace.git.'))
      return input;
    return { ...input, ...(await prepareGitExecutionContext(this.configuration, userId)) };
  }
}
