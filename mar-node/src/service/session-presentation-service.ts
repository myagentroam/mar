import type {
  NodeCapabilities,
  SessionActivityState,
  RunnerCommandState
} from '@myagentroam/protocol';
import type { CodexSessionControl } from '../codex-app-server.js';
import type { NodeAgentSession, NodeDatabase } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { CommandStateStore } from '../runner-command-engine.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import { ScheduledSessionStore } from './scheduled-session-store.js';

export type PresentedSession = NodeAgentSession & {
  readonly sessionGroup: import('@myagentroam/protocol').SessionGroup;
  readonly control: CodexSessionControl;
  readonly activity: SessionActivityState;
  readonly runtime: {
    readonly level: CodexSessionControl['level'];
    readonly capabilities: readonly string[];
    readonly reasonCode: string | null;
  };
  readonly commandStates: readonly RunnerCommandState[];
  readonly schedule: { readonly enabled: boolean; readonly nextRunAt: number | null } | null;
};

interface SessionPresentationServiceOptions {
  readonly database: () => NodeDatabase | undefined;
  readonly runtime: NodeRuntimeState;
  readonly commands: CommandStateStore;
  readonly runners: RunnerRegistry;
  readonly capabilities: () => NodeCapabilities;
  readonly hasManagedActiveRun: (session: NodeAgentSession) => boolean;
  readonly projectionForNative: (session: NodeAgentSession) => NodeAgentSession | undefined;
}

export class SessionPresentationService {
  constructor(private readonly options: SessionPresentationServiceOptions) {}

  present(session: NodeAgentSession): PresentedSession {
    // Observers can retain pre-activation objects; Runtime owns current Session state.
    const current = this.options.runtime.getAgentSession(session.id);
    if (current !== undefined)
      session = {
        ...session,
        ...current,
        lastActivityAt: latestSessionActivityAt(current.lastActivityAt, session.lastActivityAt)
      };
    const database = this.options.database();
    if (session.externalSessionId !== null && database !== undefined) {
      const metadata = database.getNativeSessionMetadata(
        session.runner,
        session.externalSessionId,
        session.workspaceId
      );
      if (metadata !== undefined)
        session = {
          ...session,
          sessionPrompt: metadata.sessionPrompt ?? null,
          parentSessionId: metadata.parentSessionId ?? null,
          pinnedAt: metadata.pinnedAt,
          pinOrder: metadata.pinOrder
        };
    }
    const presentation = this.options.runners
      .require(session.runner)
      .presentSession(session, this.options.capabilities(), {
        managedActive: this.options.hasManagedActiveRun(session),
        commandStates: this.options.commands.list(session.id)
      });
    return {
      ...session,
      parentSessionId: session.parentSessionId ?? null,
      sessionGroup: sessionGroup(session),
      ...presentation,
      runtime: {
        ...presentation.runtime,
        capabilities:
          session.externalSessionId !== null && database !== undefined
            ? [...presentation.runtime.capabilities, 'session.schedule', 'session.prompt']
            : presentation.runtime.capabilities
      },
      schedule:
        database === undefined
          ? null
          : (() => {
              const task = new ScheduledSessionStore(database.raw).get(
                session.externalSessionId ?? session.id
              );
              return task === undefined
                ? null
                : { enabled: task.enabled, nextRunAt: task.nextRunAt };
            })()
    };
  }

  presentDiscovered(sessions: readonly NodeAgentSession[]): readonly PresentedSession[] {
    return sessions.map((session) => {
      const projected = this.options.projectionForNative(session);
      if (projected === undefined) return this.present(session);
      const synchronized =
        session.runnerTitle === null
          ? projected
          : session.titleSource === 'AUTO'
            ? this.options.runtime.setTemporaryTitleIfMissing(projected.id, session.runnerTitle)
            : this.options.runtime.setRunnerTitleFromNative(projected.id, session.runnerTitle);
      return this.present({
        ...synchronized,
        lastActivityAt: latestSessionActivityAt(synchronized.lastActivityAt, session.lastActivityAt)
      });
    });
  }
}

export function sessionGroup(
  session: Pick<NodeAgentSession, 'parentSessionId'>
): import('@myagentroam/protocol').SessionGroup {
  return session.parentSessionId ? 'CHILD' : 'MAIN';
}

export function latestSessionActivityAt(current: number, discovered: number): number {
  const known = [current, discovered].filter((value) => Number.isFinite(value) && value > 0);
  return known.length === 0 ? 0 : Math.max(...known);
}
