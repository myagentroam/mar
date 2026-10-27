import { AgentError } from '../error.js';
import type { ModelAdapter } from '../model/contracts.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { SubagentSessionController } from '../subagent/session-controller.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import { SessionOpenCleanupError, type SessionRegistry } from './session-registry.js';
import { SessionRuntime } from './session-runtime.js';

type StoredSession = Awaited<ReturnType<SessionStore['getSession']>>;

interface SessionOpenPorts<Handle> {
  readonly registry: SessionRegistry<SessionRuntime>;
  readonly getSession: (id: string) => Promise<StoredSession>;
  readonly generation: () => number;
  readonly createAdapter: (
    id: string,
    models: ReadonlyMap<string, ResolvedModelConfiguration>
  ) => ModelAdapter;
  readonly hasCustomAdapters: boolean;
  readonly openSubagents: (id: string, workspace: string) => Promise<SubagentSessionController>;
  readonly assertAdmission: (id: string) => void;
  readonly epoch: (id: string) => number;
  readonly canPublish: (id: string, epoch: number) => boolean;
  readonly createHandle: (
    id: string,
    runtime: SessionRuntime,
    stored: StoredSession,
    workspace?: string
  ) => Handle;
}

/** The open flow owns unpublished candidates; the registry owns only identity and barriers. */
export function createSessionOpen<Handle>(ports: SessionOpenPorts<Handle>) {
  return async (id: string, workspace?: string): Promise<Handle> => {
    ports.assertAdmission(id);
    const epoch = ports.epoch(id);
    return ports.registry.trackOpen(id, async () => {
      const runtime = await ports.registry.getOrCreate(
        id,
        epoch,
        () => ports.canPublish(id, epoch),
        async (publish) => {
          const stored = await ports.getSession(id);
          const candidate = new SessionRuntime(
            stored,
            ports.generation(),
            ports.createAdapter,
            ports.hasCustomAdapters
          );
          try {
            if (stored.source.type === 'user')
              await candidate.ensureSubagents(() => ports.openSubagents(id, stored.workspace));
            ports.createHandle(id, candidate, stored, workspace);
            if (!publish(candidate))
              throw new AgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.');
            return candidate;
          } catch (error) {
            try {
              await candidate.disposeSubagents();
            } catch (cleanupError) {
              throw new SessionOpenCleanupError(cleanupError);
            }
            throw error;
          }
        }
      );
      ports.assertAdmission(id);
      const stored = await ports.getSession(id);
      ports.assertAdmission(id);
      if (!ports.canPublish(id, epoch))
        throw new AgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.');
      if (stored.source.type === 'user' && runtime.subagents === undefined) {
        await runtime.ensureSubagents(() => ports.openSubagents(id, stored.workspace));
        if (!ports.canPublish(id, epoch))
          throw new AgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.');
      }
      return ports.createHandle(id, runtime, stored, workspace);
    });
  };
}
