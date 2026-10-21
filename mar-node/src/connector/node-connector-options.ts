import type { NodeCapabilities } from '@myagentroam/protocol';
import type { ClaudeAgentSdkAdapter } from '../claude-agent-sdk.js';
import type { CodexAppServerClient } from '../codex-app-server.js';
import type { NodeConfig } from '../config.js';
import type { NodeDatabase } from '../database.js';
import type { FakeRunner, FakeRunnerStep } from '../fake-runner.js';
import type { RunnerUsageReader } from '../runner-usage.js';
import type { TerminalManager } from '../terminal.js';
import type { OpenCodeServerClient } from '../opencode-server.js';
import type { ConversationHostingProbe } from '../service/conversation-hosting-capability-service.js';

export interface NodeConnectorOptions {
  readonly configPath?: string;
  readonly config?: NodeConfig;
  readonly capabilities?: NodeCapabilities;
  readonly capabilityDetector?: () => NodeCapabilities | Promise<NodeCapabilities>;
  readonly reconnect?: boolean;
  readonly fakeRunner?: FakeRunner;
  readonly fakeScript?: (input: unknown, runId: string) => readonly FakeRunnerStep[];
  readonly codexClient?: CodexAppServerClient;
  readonly codexProfileClientFactory?: () => CodexAppServerClient;
  readonly codexRunClientFactory?: () => CodexAppServerClient;
  readonly claudeClient?: ClaudeAgentSdkAdapter;
  readonly openCodeClient?: OpenCodeServerClient;
  readonly database?: NodeDatabase;
  readonly claudeApprovalTimeoutMs?: number;
  readonly terminalManager?: TerminalManager;
  readonly runnerUsageReader?: RunnerUsageReader;
  readonly upgradeReady?: () => void;
  readonly conversationHostingProbe?: ConversationHostingProbe;
}
