import type { RunnerDefaultConfiguration, RunnerName } from '@myagentroam/protocol';
import type { NodeWorkspace } from '../workspace/contracts.js';

/** Whether a native session ID was created by this Node or merely discovered. */
export type NativeSessionControl = 'MAR_MANAGED' | 'EXTERNAL';
export interface NodeAgentSession {
  readonly id: string;
  readonly parentSessionId?: string | null;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly runner: RunnerName;
  readonly externalSessionId: string | null;
  readonly nativeControl: NativeSessionControl;
  readonly channelToken: string | null;
  readonly cwd: string;
  /** Runner preferences chosen when this managed session was created. */
  readonly model: string | null;
  readonly effort: string | null;
  readonly access: string | null;
  readonly customTitle: string | null;
  readonly sessionPrompt?: string | null;
  readonly runnerTitle: string | null;
  readonly pinnedAt: number | null;
  readonly pinOrder?: number | null;
  /** False only for a local record absent from the current Runner discovery result. */
  readonly externalDiscovered?: boolean;
  readonly titleSource: 'AUTO' | 'RUNNER' | 'CUSTOM';
  readonly lastActivityAt: number;
  readonly createdAt: number;
}

export interface NativeSessionMetadata {
  readonly parentSessionId?: string | null;
  readonly customTitle: string | null;
  readonly sessionPrompt?: string | null;
  readonly runnerTitle: string | null;
  readonly runnerTitlePending: boolean;
  readonly pinnedAt: number | null;
  readonly pinOrder: number | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly access: string | null;
}

export type ExternalSessionActivationState = 'IDLE' | 'BUSY';

export interface NativeSessionProjectionStore {
  getWorkspace(id: string): NodeWorkspace | undefined;
  listWorkspaces(): readonly NodeWorkspace[];
  getRunnerDefaults(): readonly RunnerDefaultConfiguration[];
  getNativeSessionMetadata(
    runner: RunnerName,
    externalSessionId: string,
    workspaceId: string
  ): NativeSessionMetadata | undefined;
  saveNativeSessionMetadata(input: {
    readonly runner: RunnerName;
    readonly externalSessionId: string;
    readonly workspaceId: string;
    readonly customTitle?: string | null;
    readonly runnerTitle?: string | null;
    readonly runnerTitlePending?: boolean;
    readonly pinned?: boolean;
  }): NativeSessionMetadata;
  listSessionRecords(workspaceId: string): readonly NativeSessionRecord[];
  getSessionRecord(sessionId: string): NativeSessionRecord | undefined;
}

export interface NativeSessionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly runner: RunnerName;
  readonly pinOrder: number | null;
  readonly metadata: NativeSessionMetadata;
}
