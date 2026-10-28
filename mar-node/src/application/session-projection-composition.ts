import type { NodeCapabilities } from '@myagentroam/protocol';
import type { NodeDatabase } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { CommandStateStore } from '../runner-command-engine.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import { hasManagedActiveRun } from '../service/conversation-history-service.js';
import { SessionPresentationService } from '../session/session-presentation-service.js';
import { NativeSessionProjectionService } from '../session/native-session-projection-service.js';

/** Joins native projection and presentation around their shared Session identity. */
export function composeSessionProjection(input: {
  readonly database: () => NodeDatabase | undefined;
  readonly nodeId: () => string;
  readonly runtime: NodeRuntimeState;
  readonly commands: CommandStateStore;
  readonly runners: RunnerRegistry;
  readonly capabilities: () => NodeCapabilities;
  readonly releaseResumeState: (
    directIds: ReadonlySet<string>,
    projectionIds: ReadonlySet<string>
  ) => void;
}) {
  const presentation: SessionPresentationService = new SessionPresentationService({
    database: input.database,
    runtime: input.runtime,
    commands: input.commands,
    runners: input.runners,
    capabilities: input.capabilities,
    hasManagedActiveRun: (session) => hasManagedActiveRun(input.runtime, session),
    projectionForNative: (session) => native.projectionForNative(session)
  });
  const native: NativeSessionProjectionService = new NativeSessionProjectionService({
    database: input.database,
    nodeId: input.nodeId,
    runtime: input.runtime,
    runners: input.runners,
    capabilities: input.capabilities,
    commands: input.commands,
    releaseResumeState: input.releaseResumeState,
    present: (session) => presentation.present(session)
  });
  return { presentation, native };
}
