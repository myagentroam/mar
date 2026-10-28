import type { ComputerUseCapability, MarAgentResponsesServiceTier } from '@myagentroam/protocol';

export interface NodeSummary {
  readonly id: string;
  readonly displayName: string | null;
  readonly registeredAddress: string;
  readonly platform: string;
  readonly architecture: string;
  readonly nodeAppVersion: string;
  readonly nodeVersion: string;
  readonly metadata?: Readonly<Record<string, unknown>> & { readonly osRelease?: string };
  readonly connected: boolean;
  readonly disabled: boolean;
  readonly manageable?: boolean;
  readonly workspaceCreatable?: boolean;
  readonly secretManageable?: boolean;
  readonly ownership?:
    | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
    | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number };
  readonly capabilities: {
    readonly promptCompletion?: {
      readonly apiVersion: 1;
      readonly contextVersion?: 2 | 3;
      readonly automaticTriggers?: true;
    };
    readonly chatgptLogin?: { readonly apiVersion: number; readonly loopback: boolean };
    readonly codex?: { readonly available?: boolean; readonly version?: string };
    readonly claudeCode?: { readonly available?: boolean; readonly version?: string };
    readonly openCode?: { readonly available?: boolean; readonly version?: string };
    readonly marAgent?: { readonly available?: boolean; readonly version?: string };
    readonly conversationHosting?: {
      readonly state: 'DISABLED' | 'UNAVAILABLE' | 'AVAILABLE';
      readonly apiVersion: number;
      readonly sandboxBackend?: 'BUBBLEWRAP';
      readonly sandboxPolicyVersion?: number;
      readonly acceptsNewConversations: boolean;
      readonly supportsExistingConversations: boolean;
      readonly capacity: 'AVAILABLE' | 'HIGH' | 'FULL';
      readonly reasonCode?: string;
    };
    readonly computerUse?: ComputerUseCapability;
    readonly marAgentRuntimeCredentials?: {
      readonly apiVersion: number;
      readonly websocket: boolean;
      readonly serviceTiers?: readonly MarAgentResponsesServiceTier[];
      readonly namespacedTools?: boolean;
      readonly responsesHttpContinuation?: boolean;
      readonly httpVersions: readonly ('1.1' | '2')[];
    };
  };
}
