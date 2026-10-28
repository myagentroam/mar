import type { SessionLookup } from './session.js';
import type { WorkspaceNodeControl } from './workspace-route-contracts.js';
import type {
  MarAgentModelSummary,
  MarAgentRuntimeModelConfiguration
} from '@myagentroam/protocol';

export type SessionRunNodeControl = Pick<
  WorkspaceNodeControl,
  'requestNode' | 'ownsWorkbenchConnection'
>;
export interface SessionRunStore extends SessionLookup {
  userDisplayName(userId: number): Promise<string | undefined>;
}
export interface ProcessSecretResolver {
  resolve(
    userId: number,
    nodeId: string,
    workspaceId?: string
  ): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
}
export interface PersonalInstructionReader {
  get(userId: number): Promise<unknown>;
}
export interface RunnerModelCatalog {
  listForUser(userId: number): Promise<readonly MarAgentModelSummary[]>;
}
export interface MarAgentModelService {
  listForUser?: RunnerModelCatalog['listForUser'];
  runtimeForUser(userId: number, modelId: string): Promise<unknown>;
  runtimeConfigurationsForUser(userId: number): Promise<unknown>;
}
export interface MarAgentRuntimeModelService {
  prepare(context: {
    userId: number;
    nodeId: string;
    workspaceId: string;
    sessionId?: string;
    selectedModelId: string;
  }): Promise<{
    runtimeScopeId: string;
    model?: MarAgentRuntimeModelConfiguration;
    models: readonly MarAgentRuntimeModelConfiguration[];
    compact?: import('@myagentroam/protocol').MarAgentRuntimeCompactConfiguration;
  }>;
}
