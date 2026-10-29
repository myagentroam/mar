import type { AgentHost, HostDescription } from '../host/contracts.js';
import type { ExtensionManager } from '../extensions/manager.js';
import type { ModelAdapter } from '../model/contracts.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import type { SessionRegistry } from './session-registry.js';
import type { SessionRuntime } from './session-runtime.js';
import type { AgentSession, CreateAgentOptions } from './types.js';

export type InternalAgentSession = AgentSession;

/** Agent-owned resources and identities shared with Session orchestration. */
export interface AgentSessionComposition {
  readonly activeExecutionAdapters: {
    add(adapter: ModelAdapter): void;
    delete(adapter: ModelAdapter): void;
  };
  readonly sessionRuntimes: SessionRegistry<SessionRuntime>;
  readonly sessionWriterOwner: object;
  readonly onExecutionRegistered: (runtime: SessionRuntime) => void;
}

export interface SessionServices {
  readonly host: AgentHost;
  readonly description: HostDescription;
  readonly settings: Pick<CreateAgentOptions, 'workspaceMapping' | 'systemInstruction'>;
  readonly store: SessionStore;
  readonly extensions: ExtensionManager;
  readonly agentResources: AgentSessionComposition;
  readonly hasCustomAdapters: boolean;
  readonly modelState: () => {
    readonly models: ReadonlyMap<string, ResolvedModelConfiguration>;
    readonly defaultModelId: string;
    readonly generation: number;
  };
  readonly createAdapter: (
    modelId: string,
    models: ReadonlyMap<string, ResolvedModelConfiguration>
  ) => ModelAdapter;
  readonly activeAdaptersExcept: (sessionId: string) => ReadonlySet<ModelAdapter>;
  readonly assertCanStart: (sessionId?: string) => void;
  readonly assertSessionAdmission: (sessionId?: string) => void;
  readonly openEpoch: (sessionId: string) => number;
  readonly canPublishSession: (sessionId: string, epoch: number) => boolean;
}
