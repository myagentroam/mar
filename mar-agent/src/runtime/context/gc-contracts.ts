import type { ClientToolDefinition } from '../../tools/contracts.js';

import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import type { ModelUsage } from '../../model/contracts.js';

import {
  ContextGcCheckpointCache,
  type ContextGcCheckpointDraft,
  type ContextGcMetrics,
  type ContextGcPlatform,
  type ContextGcReplacement
} from '../../session/context-gc-checkpoint.js';

import type { SessionRecord } from '../../session/record-contract.js';
import type { buildContextGcProtection } from '../../session/context-gc-protection.js';

export interface ContextGcPlan {
  readonly stage: ContextGcMetrics['stage'];
  readonly draft: ContextGcCheckpointDraft;
  readonly metrics: ContextGcMetrics;
}

export interface ContextGcInspection {
  readonly plan?: ContextGcPlan;
  readonly retryAfterRollouts?: number;
}

export interface ContextGcPlannerInput {
  readonly inlineMedia?: import('../../session/inline-media.js').InlineMediaGcCandidate;
  readonly records: readonly SessionRecord[];
  readonly messages: readonly ModelMessage[];
  readonly messageSources: readonly SessionRecord[];
  readonly system: string;
  readonly tools: readonly ClientToolDefinition[];
  readonly modelId: string;
  readonly modelProtocol?: string;
  readonly responsesConfigurationUpdates?: boolean;
  readonly contextWindowTokens: number;
  readonly usage: ModelUsage;
  readonly workspace: string;
  readonly platform: ContextGcPlatform;
  readonly activeProcessIds: ReadonlySet<string>;
  readonly tokenCache?: Map<string, number>;
  readonly checkpointCache?: ContextGcCheckpointCache;
  readonly protection?: ReturnType<typeof buildContextGcProtection>;
}

export interface ContextCandidate {
  readonly replacements: readonly ContextGcReplacement[];
  readonly observedRollouts: number;
  readonly evidenceSequence: number;
}

export type CandidateSavings = (candidate: ContextCandidate) => number;

export interface ToolGroup {
  evidenceOnly?: boolean;
  readonly callId: string;
  toolName: string;
  call?: { message: ModelMessage; record: SessionRecord };
  result?: { message: ModelMessage; record: SessionRecord };
  aliases: Array<{ message: ModelMessage; record: SessionRecord }>;
  completed?: SessionRecord;
  failed?: SessionRecord;
}
