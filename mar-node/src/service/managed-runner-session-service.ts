import type { NodeRuntimeState } from '../runtime-state.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import type { NodeAgentSession } from '../database.js';

/** Owns managed native-session identity and best-effort native title refresh. */
export class ManagedRunnerSessionService {
  constructor(
    private readonly runtime: NodeRuntimeState,
    private readonly runners: RunnerRegistry,
    private readonly emitSession: (session: NodeAgentSession) => void
  ) {}

  remember(nativeSessionId: string, sessionId: string): void {
    const session = this.runtime.getAgentSession(sessionId);
    if (session === undefined || session.nativeControl !== 'MAR_MANAGED') return;
    this.runners.require(session.runner).rememberManagedNative(session, nativeSessionId);
  }

  async refreshTitle(sessionId: string, externalSessionId: string, cwd: string): Promise<void> {
    const session = this.runtime.getAgentSession(sessionId);
    if (session === undefined || session.nativeControl !== 'MAR_MANAGED') return;
    try {
      const title = await this.runners
        .require(session.runner)
        .readManagedRunnerTitle({ ...session, cwd }, externalSessionId);
      if (title === undefined) return;
      const updated = this.runtime.setRunnerTitleFromNative(session.id, title);
      if (
        updated.runnerTitle !== session.runnerTitle ||
        updated.titleSource !== session.titleSource
      )
        this.emitSession(updated);
    } catch {
      // Native history is a best-effort source and cannot alter the completed Run result.
    }
  }
}
