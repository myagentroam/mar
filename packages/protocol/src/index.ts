import { modelUsageGrantSchema } from './model-usage.js';
import { z } from 'zod';
import { fileChangeDiffSchema } from './tool-result-resource.js';
export * from './tool-result-resource.js';
import { resourceOwnershipSchema, type ResourceOwnership } from './enterprise.js';
import { workspaceDirectTransferCapabilitySchema } from './direct-transfer.js';
import { terminalDirectCapabilitySchema } from './terminal-direct.js';
import { chatgptLoginCapabilitySchema } from './chatgpt-oauth.js';
export * from './chatgpt-oauth.js';
export const XAI_SUBSCRIPTION_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const XAI_SUBSCRIPTION_BASE_URL = XAI_SUBSCRIPTION_PROXY_BASE_URL;
export * from './composer-tags.js';
export * from './session-shares.js';

export * from './enterprise.js';
export * from './skill.js';
export * from './mcp.js';
export * from './git-identity.js';
export * from './direct-transfer.js';
export * from './terminal-direct.js';
export * from './mail-notification.js';
export * from './notification-channels.js';
export * from './web-push.js';
export * from './workbench-notification.js';
export * from './session-group.js';
export * from './model-usage.js';
export * from './management-pagination.js';

export const healthStatusSchema = z.object({
  status: z.literal('ok')
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;

/** The only wire protocol version understood by this build. */
export const NODE_PROTOCOL_VERSION = 2;
export const WORKBENCH_PROTOCOL_VERSION = 1;

export const nodePlatformSchema = z.enum(['windows', 'linux', 'macos']);
export const runnerAvailabilitySchema = z.object({
  available: z.boolean(),
  version: z.string().optional()
});
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const boundedIdentifierSchema = z.string().trim().min(1).max(128);
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
const runtimeCredentialHttpVersionSchema = z.enum(['1.1', '2']);
export const marAgentResponsesServiceTierSchema = z.enum([
  'auto',
  'default',
  'flex',
  'priority',
  'fast',
  'ultrafast'
]);
export type MarAgentResponsesServiceTier = z.infer<typeof marAgentResponsesServiceTierSchema>;
export const marAgentRuntimeCredentialCapabilitySchema = z
  .object({
    apiVersion: z.literal(1),
    websocket: z.boolean(),
    fastMode: z.boolean().optional(),
    serviceTiers: z.array(marAgentResponsesServiceTierSchema).min(1).max(6).optional(),
    namespacedTools: z.boolean().optional(),
    responsesOptionalParameters: z.boolean().optional(),
    responsesHttpContinuation: z.boolean().optional(),
    conversationModels: z.boolean().optional(),
    httpVersions: z
      .array(runtimeCredentialHttpVersionSchema)
      .min(1)
      .max(2)
      .superRefine((versions, context) => {
        if (new Set(versions).size !== versions.length)
          context.addIssue({ code: 'custom', message: 'HTTP versions must be unique' });
      })
  })
  .strict();
export type MarAgentRuntimeCredentialCapability = z.infer<
  typeof marAgentRuntimeCredentialCapabilitySchema
>;
export const conversationHostingCapabilitySchema = z
  .object({
    state: z.enum(['DISABLED', 'UNAVAILABLE', 'AVAILABLE']),
    apiVersion: z.number().int().positive(),
    sandboxBackend: z.literal('BUBBLEWRAP').optional(),
    sandboxPolicyVersion: z.number().int().positive().optional(),
    acceptsNewConversations: z.boolean(),
    supportsExistingConversations: z.boolean(),
    capacity: z.enum(['AVAILABLE', 'HIGH', 'FULL']),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .optional()
  })
  .strict()
  .superRefine((capability, context) => {
    if (capability.state === 'AVAILABLE') {
      if (
        capability.sandboxBackend !== 'BUBBLEWRAP' ||
        capability.sandboxPolicyVersion === undefined ||
        !capability.supportsExistingConversations ||
        capability.reasonCode !== undefined
      )
        context.addIssue({
          code: 'custom',
          message: 'available conversation hosting requires a healthy Bubblewrap backend'
        });
      if (capability.acceptsNewConversations !== (capability.capacity !== 'FULL'))
        context.addIssue({
          code: 'custom',
          path: ['acceptsNewConversations'],
          message: 'conversation hosting creation availability must match capacity'
        });
      return;
    }
    if (capability.acceptsNewConversations || capability.supportsExistingConversations)
      context.addIssue({
        code: 'custom',
        message: 'disabled or unavailable conversation hosting cannot run conversations'
      });
    if (capability.state === 'UNAVAILABLE' && capability.reasonCode === undefined)
      context.addIssue({
        code: 'custom',
        message: 'unavailable conversation hosting requires a reason'
      });
    if (
      capability.state === 'DISABLED' &&
      (capability.sandboxBackend !== undefined ||
        capability.sandboxPolicyVersion !== undefined ||
        capability.reasonCode !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'disabled conversation hosting cannot expose sandbox state'
      });
  });
export type ConversationHostingCapability = z.infer<typeof conversationHostingCapabilitySchema>;
export const computerUseCapabilitySchema = z
  .object({
    apiVersion: z.literal(1),
    enabled: z.boolean(),
    state: z.enum(['DISABLED', 'INITIALIZING', 'AVAILABLE', 'UNAVAILABLE']),
    backend: z.literal('PYAUTOGUI'),
    supportsScreenshot: z.boolean(),
    supportsInput: z.boolean(),
    supportsUnicodePaste: z.boolean(),
    supportsPrimaryDisplay: z.boolean(),
    runtimeVersion: z.string().trim().min(1).max(128).optional(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .optional(),
    measuredAt: nonnegativeSafeIntegerSchema
  })
  .strict()
  .superRefine((capability, context) => {
    if (capability.state === 'DISABLED') {
      if (
        capability.enabled ||
        capability.reasonCode !== undefined ||
        capability.supportsScreenshot ||
        capability.supportsInput ||
        capability.supportsUnicodePaste ||
        capability.supportsPrimaryDisplay
      )
        context.addIssue({
          code: 'custom',
          message: 'disabled Computer Use cannot expose runtime support'
        });
      return;
    }
    if (!capability.enabled)
      context.addIssue({
        code: 'custom',
        path: ['enabled'],
        message: 'active Computer Use states require enabled configuration'
      });
    if (capability.state === 'AVAILABLE') {
      if (
        capability.reasonCode !== undefined ||
        !capability.supportsScreenshot ||
        !capability.supportsInput ||
        !capability.supportsUnicodePaste ||
        !capability.supportsPrimaryDisplay
      )
        context.addIssue({
          code: 'custom',
          message: 'available Computer Use requires complete desktop support'
        });
      return;
    }
    if (capability.state === 'INITIALIZING') {
      if (
        capability.reasonCode !== undefined ||
        capability.supportsScreenshot ||
        capability.supportsInput ||
        capability.supportsUnicodePaste ||
        capability.supportsPrimaryDisplay
      )
        context.addIssue({
          code: 'custom',
          message: 'initializing Computer Use cannot expose a completed probe'
        });
      return;
    }
    if (capability.reasonCode === undefined)
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'unavailable Computer Use requires a reason code'
      });
  });
export type ComputerUseCapability = z.infer<typeof computerUseCapabilitySchema>;
export const computerUseEnableInputSchema = z.object({ enabled: z.literal(true) }).strict();
export type ComputerUseEnableInput = z.infer<typeof computerUseEnableInputSchema>;
export const computerUseDisableInputSchema = z.object({}).strict();
export type ComputerUseDisableInput = z.infer<typeof computerUseDisableInputSchema>;
export const computerUseEnableResultSchema = z
  .object({ capability: computerUseCapabilitySchema })
  .strict();
export type ComputerUseEnableResult = z.infer<typeof computerUseEnableResultSchema>;
export const conversationHostingEnableInputSchema = z
  .object({
    enabled: z.literal(true)
  })
  .strict();
export type ConversationHostingEnableInput = z.infer<typeof conversationHostingEnableInputSchema>;
export const conversationHostingDisableInputSchema = z.object({}).strict();
export type ConversationHostingDisableInput = z.infer<typeof conversationHostingDisableInputSchema>;
export const conversationHostingEnableResultSchema = z
  .object({
    capability: conversationHostingCapabilitySchema
  })
  .strict();
export type ConversationHostingEnableResult = z.infer<typeof conversationHostingEnableResultSchema>;
export const conversationHostingStorageCapacitySchema = z
  .object({
    hostedStorageUsedBytes: nonnegativeSafeIntegerSchema,
    filesystemTotalBytes: positiveSafeIntegerSchema,
    filesystemAvailableBytes: nonnegativeSafeIntegerSchema,
    filesystemUsageBasisPoints: z.number().int().min(0).max(10_000),
    capacity: z.enum(['AVAILABLE', 'HIGH', 'FULL']),
    acceptsNewConversations: z.boolean(),
    automaticCleanupInactiveDays: z.number().int().min(1).max(365),
    measuredAt: nonnegativeSafeIntegerSchema
  })
  .strict()
  .superRefine((storage, context) => {
    if (storage.filesystemAvailableBytes > storage.filesystemTotalBytes)
      context.addIssue({
        code: 'custom',
        path: ['filesystemAvailableBytes'],
        message: 'available filesystem bytes cannot exceed total bytes'
      });
    const expectedUsageBasisPoints = Number(
      (BigInt(storage.filesystemTotalBytes - storage.filesystemAvailableBytes) * 10_000n) /
        BigInt(storage.filesystemTotalBytes)
    );
    if (storage.filesystemUsageBasisPoints !== expectedUsageBasisPoints)
      context.addIssue({
        code: 'custom',
        path: ['filesystemUsageBasisPoints'],
        message: 'filesystem usage does not match total and available bytes'
      });
    const expected =
      storage.filesystemUsageBasisPoints >= 9_500
        ? 'FULL'
        : storage.filesystemUsageBasisPoints >= 8_500
          ? 'HIGH'
          : 'AVAILABLE';
    if (storage.capacity !== expected)
      context.addIssue({
        code: 'custom',
        path: ['capacity'],
        message: 'conversation hosting capacity does not match filesystem usage'
      });
    if (storage.acceptsNewConversations !== (storage.capacity !== 'FULL'))
      context.addIssue({
        code: 'custom',
        path: ['acceptsNewConversations'],
        message: 'conversation hosting creation availability does not match capacity'
      });
  });
export type ConversationHostingStorageCapacity = z.infer<
  typeof conversationHostingStorageCapacitySchema
>;
export const conversationHostingCleanupPreviewInputSchema = z
  .object({
    inactiveDays: z.number().int().min(1).max(365)
  })
  .strict();
export type ConversationHostingCleanupPreviewInput = z.infer<
  typeof conversationHostingCleanupPreviewInputSchema
>;
export const conversationHostingCleanupExecuteInputSchema =
  conversationHostingCleanupPreviewInputSchema;
export type ConversationHostingCleanupExecuteInput = z.infer<
  typeof conversationHostingCleanupExecuteInputSchema
>;
export const conversationHostingCleanupPreviewSchema = z
  .object({
    inactiveDays: z.number().int().min(1).max(365),
    cutoffAt: nonnegativeSafeIntegerSchema,
    candidateConversationCount: nonnegativeSafeIntegerSchema,
    reclaimableBytes: nonnegativeSafeIntegerSchema,
    measuredAt: nonnegativeSafeIntegerSchema
  })
  .strict();
export type ConversationHostingCleanupPreview = z.infer<
  typeof conversationHostingCleanupPreviewSchema
>;
export const conversationHostingCleanupResultSchema = z
  .object({
    inactiveDays: z.number().int().min(1).max(365),
    cutoffAt: nonnegativeSafeIntegerSchema,
    deletedConversationCount: nonnegativeSafeIntegerSchema,
    releasedBytes: nonnegativeSafeIntegerSchema,
    skippedConversationCount: nonnegativeSafeIntegerSchema,
    completedAt: nonnegativeSafeIntegerSchema
  })
  .strict();
export type ConversationHostingCleanupResult = z.infer<
  typeof conversationHostingCleanupResultSchema
>;
export const runtimeCommandSchema = z
  .object({
    id: z.enum(['npx', 'git', 'python', 'pip']),
    command: z.string().trim().min(1).max(128),
    available: z.boolean(),
    version: z.string().trim().min(1).max(512).optional(),
    path: z.string().trim().min(1).max(2048).optional()
  })
  .strict();
export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;
export const nodeUpgradeStatusSchema = z.object({
  state: z.enum(['IDLE', 'WAITING_FOR_RUNS', 'READY_TO_RESTART', 'FAILED']),
  targetVersion: z
    .string()
    .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
    .optional(),
  activeRunCount: z.number().int().nonnegative().optional(),
  errorCode: z.string().trim().min(1).max(80).optional(),
  updatedAt: z.number().int().nonnegative()
});
export type NodeUpgradeStatus = z.infer<typeof nodeUpgradeStatusSchema>;
export const promptCompletionCapabilitySchema = z
  .object({
    apiVersion: z.literal(1),
    contextVersion: z.union([z.literal(2), z.literal(3)]).optional(),
    automaticTriggers: z.literal(true).optional()
  })
  .strict();
export const nodeMetadataSchema = z
  .object({
    platform: nodePlatformSchema.optional(),
    architecture: z.string().trim().min(1).max(128).optional(),
    nodeAppVersion: z.string().trim().min(1).max(128).optional(),
    nodeVersion: z.string().trim().min(1).max(128).optional(),
    osRelease: z.string().max(256).optional(),
    osVersion: z.string().max(256).optional(),
    codex: runnerAvailabilitySchema.optional(),
    claudeCode: runnerAvailabilitySchema.optional(),
    openCode: runnerAvailabilitySchema.optional(),
    marAgent: runnerAvailabilitySchema.optional(),
    runtimeCommands: z.array(runtimeCommandSchema).max(16).optional(),
    supervisedUpgrade: z.boolean().optional(),
    upgrade: nodeUpgradeStatusSchema.optional()
  })
  .partial()
  .strict()
  .optional();
export const nodeCapabilitiesSchema = z
  .object({
    platform: nodePlatformSchema,
    architecture: z.string().min(1).max(128),
    nodeAppVersion: z.string().trim().min(1).max(128).optional(),
    nodeVersion: z.string().min(1).max(128),
    metadata: nodeMetadataSchema,
    codex: runnerAvailabilitySchema,
    claudeCode: runnerAvailabilitySchema,
    openCode: runnerAvailabilitySchema.optional(),
    marAgent: runnerAvailabilitySchema.optional(),
    conversationHosting: conversationHostingCapabilitySchema.optional(),
    computerUse: computerUseCapabilitySchema.optional(),
    marAgentRuntimeCredentials: marAgentRuntimeCredentialCapabilitySchema.optional(),
    promptCompletion: promptCompletionCapabilitySchema.optional(),
    chatgptLogin: chatgptLoginCapabilitySchema.optional(),
    workspaceDirectTransfer: workspaceDirectTransferCapabilitySchema.optional(),
    terminalDirect: terminalDirectCapabilitySchema.optional(),
    sessionGroups: z
      .object({ apiVersion: z.literal(1) })
      .strict()
      .optional()
  })
  .superRefine((capabilities, context) => {
    if (
      capabilities.platform !== 'linux' &&
      capabilities.conversationHosting?.state === 'AVAILABLE'
    )
      context.addIssue({
        code: 'custom',
        path: ['conversationHosting'],
        message: 'conversation hosting is Linux-only'
      });
    if (
      capabilities.conversationHosting?.state === 'AVAILABLE' &&
      capabilities.marAgent?.available !== true
    )
      context.addIssue({
        code: 'custom',
        path: ['marAgent'],
        message: 'conversation hosting requires MAR Agent'
      });
  });
export type NodeCapabilities = z.infer<typeof nodeCapabilitiesSchema>;

export const workspaceKindSchema = z.enum(['DIRECTORY', 'GIT_WORKSPACE']);
export type WorkspaceKind = z.infer<typeof workspaceKindSchema>;

export const gitSummarySchema = z.object({
  repositoryRoot: z.string().optional(),
  commonDir: z.string(),
  head: z.string(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  snapshot: z.string()
});
export type GitSummary = z.infer<typeof gitSummarySchema>;

/** Runner names are deliberately closed in the first implementation. */
export const runnerNameSchema = z.enum(['codex', 'claude-code', 'opencode', 'mar-agent']);
export type RunnerName = z.infer<typeof runnerNameSchema>;
export const workspaceSessionCleanupResultSchema = z
  .object({
    deleted: nonnegativeSafeIntegerSchema,
    skipped: nonnegativeSafeIntegerSchema,
    failed: nonnegativeSafeIntegerSchema,
    deletedByRunner: z
      .object({
        codex: nonnegativeSafeIntegerSchema,
        'claude-code': nonnegativeSafeIntegerSchema,
        opencode: nonnegativeSafeIntegerSchema,
        'mar-agent': nonnegativeSafeIntegerSchema
      })
      .partial()
      .strict()
  })
  .strict()
  .superRefine((result, context) => {
    const runnerDeleted = Object.values(result.deletedByRunner).reduce<number>(
      (total, count) => total + (count ?? 0),
      0
    );
    if (runnerDeleted !== result.deleted)
      context.addIssue({
        code: 'custom',
        path: ['deletedByRunner'],
        message: 'Runner deletion counts must equal the deleted total'
      });
  });
export type WorkspaceSessionCleanupResult = z.infer<typeof workspaceSessionCleanupResultSchema>;

/** Account-level quota visibility is intentionally separate from a Runner's execution availability. */
export const runnerUsageStatusSchema = z.object({
  runner: runnerNameSchema,
  available: z.boolean(),
  reasonCode: z.string().min(1).max(80).nullable()
});
export type RunnerUsageStatus = z.infer<typeof runnerUsageStatusSchema>;

export const runnerUsageWindowSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(128),
  usedPercentage: z.number().finite().min(0).max(100),
  resetsAt: z.number().int().nonnegative().nullable()
});
export type RunnerUsageWindow = z.infer<typeof runnerUsageWindowSchema>;

export const runnerUsageSchema = z.object({
  runner: runnerNameSchema,
  windows: z.array(runnerUsageWindowSchema).min(1).max(8),
  fetchedAt: z.number().int().nonnegative(),
  cached: z.boolean()
});
export type RunnerUsage = z.infer<typeof runnerUsageSchema>;

/** What the runner can do in an existing native conversation. */
export const runnerControlLevelSchema = z.enum(['OBSERVE', 'MESSAGE', 'INTERRUPT']);
export type RunnerControlLevel = z.infer<typeof runnerControlLevelSchema>;

export const runnerCapabilitiesSchema = z.object({
  available: z.boolean(),
  version: z.string().max(128).optional(),
  controlLevel: runnerControlLevelSchema,
  supportsResume: z.boolean(),
  supportsExternalSession: z.boolean()
});
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

/** Fixed runner contracts; implementations are supplied by later runner tasks. */
export const runnerDefinitionSchema = z.object({
  name: runnerNameSchema,
  capabilities: runnerCapabilitiesSchema
});
export type RunnerDefinition = z.infer<typeof runnerDefinitionSchema>;

export const runnerDefinitions: Readonly<Record<RunnerName, RunnerDefinition>> = {
  codex: {
    name: 'codex',
    capabilities: {
      available: false,
      controlLevel: 'INTERRUPT',
      supportsResume: true,
      supportsExternalSession: true
    }
  },
  'claude-code': {
    name: 'claude-code',
    capabilities: {
      available: false,
      controlLevel: 'INTERRUPT',
      supportsResume: true,
      supportsExternalSession: true
    }
  },
  opencode: {
    name: 'opencode',
    capabilities: {
      available: false,
      controlLevel: 'INTERRUPT',
      supportsResume: true,
      supportsExternalSession: true
    }
  },
  'mar-agent': {
    name: 'mar-agent',
    capabilities: {
      available: false,
      controlLevel: 'INTERRUPT',
      supportsResume: true,
      supportsExternalSession: false
    }
  }
};

export const marAgentModelProtocolSchema = z.enum(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES']);
export const marAgentInputCapabilitySchema = z.enum(['TEXT', 'IMAGE']);
export const marAgentOutputCapabilitySchema = z.literal('TEXT');
export const marAgentReasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]);
export type MarAgentReasoningEffort = z.infer<typeof marAgentReasoningEffortSchema>;
export function resolveMarAgentDefaultReasoningEffort(
  value: unknown,
  reasoningEfforts: readonly string[]
): MarAgentReasoningEffort {
  const parsed = marAgentReasoningEffortSchema.safeParse(value);
  if (parsed.success && (reasoningEfforts.length === 0 || reasoningEfforts.includes(parsed.data)))
    return parsed.data;
  if (reasoningEfforts.includes('medium')) return 'medium';
  const first = marAgentReasoningEffortSchema.safeParse(reasoningEfforts[0]);
  return first.success ? first.data : 'medium';
}
export const marAgentResponsesTransportSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('WEBSOCKET') }).strict(),
  z
    .object({
      transport: z.literal('HTTP'),
      httpVersion: runtimeCredentialHttpVersionSchema
    })
    .strict()
]);
export type MarAgentResponsesTransport = z.infer<typeof marAgentResponsesTransportSchema>;
export const runtimeCredentialTicketSchema = z
  .object({
    userId: positiveSafeIntegerSchema,
    credentialId: boundedIdentifierSchema,
    nodeId: boundedIdentifierSchema,
    workspaceId: boundedIdentifierSchema,
    sessionId: boundedIdentifierSchema.optional(),
    runtimeScopeId: boundedIdentifierSchema,
    allowedModelIds: z.array(boundedIdentifierSchema).min(1).max(64),
    purpose: z.enum(['MODEL', 'IMAGE_GENERATION']).optional(),
    issuedAt: nonnegativeSafeIntegerSchema,
    expiresAt: positiveSafeIntegerSchema,
    nonce: z.string().min(1).max(128),
    signature: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict()
  .superRefine((ticket, context) => {
    if (new Set(ticket.allowedModelIds).size !== ticket.allowedModelIds.length)
      context.addIssue({
        code: 'custom',
        path: ['allowedModelIds'],
        message: 'allowed model IDs must be unique'
      });
    if (
      ticket.expiresAt <= ticket.issuedAt ||
      ticket.expiresAt - ticket.issuedAt > 24 * 60 * 60 * 1000
    )
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'runtime credential ticket lifetime is invalid'
      });
  });
export type RuntimeCredentialTicket = z.infer<typeof runtimeCredentialTicketSchema>;
export const runtimeCredentialResolveRequestSchema = z
  .object({
    ticket: runtimeCredentialTicketSchema,
    modelId: boundedIdentifierSchema,
    runtimeScopeId: boundedIdentifierSchema,
    executionId: boundedIdentifierSchema,
    reason: z.enum(['REQUEST', 'UNAUTHORIZED', 'RECONNECT'])
  })
  .strict()
  .superRefine((request, context) => {
    if (request.runtimeScopeId !== request.ticket.runtimeScopeId)
      context.addIssue({
        code: 'custom',
        path: ['runtimeScopeId'],
        message: 'runtime scope must match the credential ticket'
      });
    if (!request.ticket.allowedModelIds.includes(request.modelId))
      context.addIssue({
        code: 'custom',
        path: ['modelId'],
        message: 'model is not allowed by the credential ticket'
      });
  });
export type RuntimeCredentialResolveRequest = z.infer<typeof runtimeCredentialResolveRequestSchema>;
const runtimeCredentialHeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u),
    z.string().max(16_384)
  )
  .superRefine((headers, context) => {
    const entries = Object.entries(headers);
    if (entries.length > 32)
      context.addIssue({ code: 'custom', message: 'too many runtime credential headers' });
    const serializedSize = entries.reduce(
      (size, [name, value]) => size + utf8ByteLength(name) + utf8ByteLength(value),
      0
    );
    if (serializedSize > 65_536)
      context.addIssue({ code: 'custom', message: 'runtime credential headers are too large' });
  });
export const resolvedRuntimeCredentialSchema = z
  .object({
    bearer: z.string().min(1).max(65_536),
    headers: runtimeCredentialHeadersSchema,
    socks5Url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => new URL(value).protocol === 'socks5:', 'SOCKS5 URL is required')
      .optional(),
    expiresAt: positiveSafeIntegerSchema,
    revision: positiveSafeIntegerSchema
  })
  .strict();
export type ResolvedRuntimeCredential = z.infer<typeof resolvedRuntimeCredentialSchema>;
const runtimeCredentialResolveErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u),
    message: z.string().min(1).max(512),
    recoverable: z.boolean(),
    retryAfterMs: positiveSafeIntegerSchema.optional()
  })
  .strict();
export const runtimeCredentialResolveResponseSchema = z.union([
  z
    .object({
      credential: resolvedRuntimeCredentialSchema,
      nextTicket: runtimeCredentialTicketSchema
    })
    .strict(),
  z.object({ error: runtimeCredentialResolveErrorSchema }).strict()
]);
export type RuntimeCredentialResolveResponse = z.infer<
  typeof runtimeCredentialResolveResponseSchema
>;
export const scheduledRunAuthorizeRequestSchema = z
  .object({
    taskId: boundedIdentifierSchema,
    revision: positiveSafeIntegerSchema,
    occurrenceId: z.string().min(1).max(256),
    sessionId: boundedIdentifierSchema,
    workspaceId: boundedIdentifierSchema,
    ownerUserId: positiveSafeIntegerSchema,
    runner: runnerNameSchema,
    model: z.string().max(256).nullable()
  })
  .strict();
export type ScheduledRunAuthorizeRequest = z.infer<typeof scheduledRunAuthorizeRequestSchema>;
export const restartRunAuthorizeRequestSchema = scheduledRunAuthorizeRequestSchema
  .omit({ taskId: true, revision: true, occurrenceId: true })
  .extend({ handoffId: boundedIdentifierSchema, runner: z.literal('mar-agent') });
export type RestartRunAuthorizeRequest = z.infer<typeof restartRunAuthorizeRequestSchema>;
export const scheduledRunAuthorizeResponseSchema = z.union([
  z
    .object({
      context: z
        .object({
          usageGrant: modelUsageGrantSchema.optional(),
          secretEnvironment: z.record(z.string().min(1).max(256), z.string().max(65_536)),
          personalInstructions: z.unknown().optional(),
          marAgentModel: z.unknown().optional(),
          marAgentModels: z.unknown().optional(),
          marAgentCompact: z.unknown().optional(),
          marAgentRuntimeScopeId: z.unknown().optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      error: z
        .object({
          code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
          message: z.string().min(1).max(512)
        })
        .strict()
    })
    .strict()
]);
export type ScheduledRunAuthorizeResponse = z.infer<typeof scheduledRunAuthorizeResponseSchema>;
export const restartRunAuthorizeResponseSchema = scheduledRunAuthorizeResponseSchema;
export type RestartRunAuthorizeResponse = z.infer<typeof restartRunAuthorizeResponseSchema>;
const marAgentInlineApiKeyCredentialSchema = z
  .object({
    type: z.literal('INLINE_API_KEY'),
    value: z.string().min(1).max(16_384)
  })
  .strict();
export const marAgentModelCredentialSchema = z.discriminatedUnion('type', [
  marAgentInlineApiKeyCredentialSchema,
  z
    .object({
      type: z.literal('CREDENTIAL_REF'),
      credentialId: boundedIdentifierSchema
    })
    .strict()
]);
export type MarAgentModelCredential = z.infer<typeof marAgentModelCredentialSchema>;
const marAgentRuntimeCredentialSchema = z.union([
  marAgentInlineApiKeyCredentialSchema,
  z
    .object({
      type: z.literal('RUNTIME_TICKET'),
      credentialId: boundedIdentifierSchema,
      ticket: runtimeCredentialTicketSchema
    })
    .strict()
    .superRefine((credential, context) => {
      if (credential.credentialId !== credential.ticket.credentialId)
        context.addIssue({
          code: 'custom',
          path: ['credentialId'],
          message: 'credential ID must match the runtime ticket'
        });
    })
]);
const marAgentImageGenerationSchema = z
  .object({
    provider: z.string().trim().min(1).max(64).optional(),
    config: z.record(z.string().min(1).max(128), z.string().max(2048)).optional(),
    generateEndpoint: z.string().url().max(2048),
    editEndpoint: z.string().url().max(2048),
    imageModelId: z.string().trim().min(1).max(256),
    httpVersion: z.enum(['1.1', '2']),
    credential: marAgentRuntimeCredentialSchema.optional()
  })
  .strict();
export const imageGenerationUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)))
    );
  });
export const imageGenerationConfigurationSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('CODEX'),
      config: z
        .object({
          credentialId: boundedIdentifierSchema,
          modelId: z.string().trim().min(1).max(256)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      provider: z.literal('BYTED_ARK'),
      config: z
        .object({
          url: imageGenerationUrlSchema.optional(),
          modelId: z.string().trim().min(1).max(256),
          apiKey: z.string().trim().min(1).max(16384).optional(),
          hasApiKey: z.boolean().optional()
        })
        .strict()
    })
    .strict()
]);
export type ImageGenerationConfiguration = z.infer<typeof imageGenerationConfigurationSchema>;
const imageGenerationModelFields = {
  id: boundedIdentifierSchema,
  name: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
  ownership: resourceOwnershipSchema.optional(),
  sortOrder: z.number().int().optional()
};
export const imageGenerationModelSchema = z.discriminatedUnion('provider', [
  imageGenerationConfigurationSchema.options[0].extend(imageGenerationModelFields),
  imageGenerationConfigurationSchema.options[1].extend(imageGenerationModelFields)
]);
export type ImageGenerationModel = z.infer<typeof imageGenerationModelSchema>;
export const imageGenerationCatalogSchema = z
  .array(imageGenerationModelSchema)
  .max(100)
  .superRefine((models, context) => {
    if (new Set(models.map((model) => model.id)).size !== models.length)
      context.addIssue({ code: 'custom', message: 'Image model IDs must be unique.' });
  });
const marAgentModelShape = {
  id: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(128),
  protocol: marAgentModelProtocolSchema,
  modelId: z.string().trim().min(1).max(256),
  contextWindowTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  inputCapabilities: z.array(marAgentInputCapabilitySchema).min(1).max(2),
  outputCapabilities: z.tuple([marAgentOutputCapabilitySchema]),
  reasoningEfforts: z.array(marAgentReasoningEffortSchema).max(6),
  defaultReasoningEffort: marAgentReasoningEffortSchema.optional(),
  conversationModel: z.boolean().default(true),
  titleGeneration: z.boolean().default(false),
  codeMode: z.boolean().default(false),
  fastMode: z.boolean().optional(),
  serviceTier: marAgentResponsesServiceTierSchema.optional(),
  hostedWebSearch: z.boolean(),
  responsesTransport: marAgentResponsesTransportSchema.optional(),
  responsesPreviousResponseId: z.boolean().default(false),
  enabled: z.boolean()
} as const;
function refineMarAgentModel<T extends z.AnyZodObject>(schema: T) {
  return schema.superRefine((value, context) => {
    if (!value.inputCapabilities.includes('TEXT'))
      context.addIssue({ code: 'custom', message: 'TEXT input is required' });
    if (value.maxOutputTokens >= value.contextWindowTokens)
      context.addIssue({ code: 'custom', message: 'output must be smaller than context' });
    if (new Set(value.reasoningEfforts).size !== value.reasoningEfforts.length)
      context.addIssue({ code: 'custom', message: 'reasoning efforts must be unique' });
    if (
      value.defaultReasoningEffort !== undefined &&
      value.reasoningEfforts.length > 0 &&
      !value.reasoningEfforts.includes(value.defaultReasoningEffort)
    )
      context.addIssue({
        code: 'custom',
        path: ['defaultReasoningEffort'],
        message: 'default reasoning effort must be exposed when choices are configured'
      });
    if (value.protocol === 'ANTHROPIC_MESSAGES' && value.hostedWebSearch)
      context.addIssue({
        code: 'custom',
        message: 'Anthropic compatibility hosted web unsupported'
      });
    if (value.protocol !== 'OPENAI_RESPONSES' && value.responsesTransport !== undefined)
      context.addIssue({
        code: 'custom',
        message: 'Responses transport requires OpenAI Responses'
      });
    if (value.protocol !== 'OPENAI_RESPONSES' && value.responsesPreviousResponseId)
      context.addIssue({ code: 'custom', message: 'Responses continuation requires Responses' });
    if (value.protocol !== 'OPENAI_RESPONSES' && value.fastMode === true)
      context.addIssue({ code: 'custom', message: 'Fast mode requires OpenAI Responses' });
    if (value.protocol !== 'OPENAI_RESPONSES' && value.serviceTier !== undefined)
      context.addIssue({ code: 'custom', message: 'Service tier requires OpenAI Responses' });
  });
}
const marAgentModelSummaryShape = {
  ...marAgentModelShape,
  baseUrl: z.string().url().max(2048),
  sortOrder: z.number().int(),
  apiKeyConfigured: z.boolean().optional(),
  credentialType: z.enum(['INLINE_API_KEY', 'CREDENTIAL_REF']).optional(),
  credentialConfigured: z.boolean().optional(),
  lastTestedAt: z.number().int().nonnegative().nullable().optional(),
  lastTestStatus: z.enum(['UNVERIFIED', 'SUCCEEDED', 'FAILED']).nullable().optional(),
  lastTestCode: z.string().max(80).nullable().optional()
} as const;
export const marAgentNodeModelSummarySchema = refineMarAgentModel(
  z
    .object({
      ...marAgentModelSummaryShape,
      access: z.never().optional(),
      apiKey: z.never().optional(),
      credential: z.never().optional(),
      imageGeneration: z.never().optional()
    })
    .strip()
);
export const marAgentModelSummarySchema = refineMarAgentModel(
  z
    .object({
      ...marAgentModelSummaryShape,
      ownership: resourceOwnershipSchema.optional(),
      access: z.enum(['PUBLIC', 'RESTRICTED'])
    })
    .strict()
);
export interface MarAgentModelSummary {
  id: string;
  name: string;
  protocol: 'OPENAI_RESPONSES' | 'ANTHROPIC_MESSAGES';
  baseUrl: string;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  inputCapabilities: ('TEXT' | 'IMAGE')[];
  outputCapabilities: ['TEXT'];
  reasoningEfforts: MarAgentReasoningEffort[];
  defaultReasoningEffort?: MarAgentReasoningEffort;
  conversationModel?: boolean;
  titleGeneration: boolean;
  codeMode: boolean;
  fastMode?: boolean;
  serviceTier?: MarAgentResponsesServiceTier;
  hostedWebSearch: boolean;
  responsesTransport?: MarAgentResponsesTransport;
  responsesPreviousResponseId?: boolean;
  enabled: boolean;
  sortOrder: number;
  access: 'PUBLIC' | 'RESTRICTED';
  apiKeyConfigured?: boolean;
  credentialType?: 'INLINE_API_KEY' | 'CREDENTIAL_REF';
  credentialConfigured?: boolean;
  lastTestedAt?: number | null;
  lastTestStatus?: 'UNVERIFIED' | 'SUCCEEDED' | 'FAILED' | null;
  lastTestCode?: string | null;
  ownership?: ResourceOwnership;
}
export type MarAgentNodeModelSummary = Omit<MarAgentModelSummary, 'access'>;
export const marAgentRuntimeModelConfigurationSchema = refineMarAgentModel(
  z
    .object({
      ...marAgentModelShape,
      baseUrl: z.string().url().max(2048),
      apiKey: z.string().min(1).max(16_384).optional(),
      credential: marAgentRuntimeCredentialSchema.optional(),
      responsesToolNamespace: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u)
        .optional(),
      responsesConfigurationUpdates: z.boolean().optional(),
      responsesOptionalParameters: z
        .object({
          reasoningEffort: z.boolean(),
          reasoningSummary: z.boolean(),
          textVerbosity: z.boolean(),
          promptCacheKey: z.boolean(),
          nativeTools: z.boolean().optional()
        })
        .strict()
        .optional(),
      imageGeneration: marAgentImageGenerationSchema.optional()
    })
    .strip()
).superRefine((configuration, context) => {
  if (
    configuration.responsesToolNamespace !== undefined &&
    configuration.protocol !== 'OPENAI_RESPONSES'
  )
    context.addIssue({
      code: 'custom',
      path: ['responsesToolNamespace'],
      message: 'Tool namespaces require Standard OpenAI Responses'
    });
  if ((configuration.apiKey === undefined) === (configuration.credential === undefined))
    context.addIssue({
      code: 'custom',
      message: 'exactly one runtime model credential is required'
    });
  if (
    configuration.imageGeneration !== undefined &&
    configuration.imageGeneration.credential !== undefined &&
    (configuration.imageGeneration.provider === 'BYTED_ARK'
      ? configuration.imageGeneration.credential.type !== 'INLINE_API_KEY'
      : configuration.imageGeneration.credential.type !== 'RUNTIME_TICKET' ||
        configuration.imageGeneration.credential.ticket.purpose !== 'IMAGE_GENERATION')
  )
    context.addIssue({
      code: 'custom',
      path: ['imageGeneration'],
      message: 'image generation requires an image-generation runtime ticket'
    });
});
export type MarAgentRuntimeModelConfiguration = z.infer<
  typeof marAgentRuntimeModelConfigurationSchema
>;
export const marAgentCompactConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    modelId: boundedIdentifierSchema.nullable(),
    reasoningEffort: marAgentReasoningEffortSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled && (value.modelId === null || value.reasoningEffort === null))
      context.addIssue({
        code: 'custom',
        message: 'Enabled compaction requires a model and reasoning effort'
      });
  });
export type MarAgentCompactConfiguration = z.infer<typeof marAgentCompactConfigurationSchema>;
export const promptCompletionConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    modelId: boundedIdentifierSchema.nullable(),
    reasoningEffort: marAgentReasoningEffortSchema.nullable()
  })
  .strict()
  .refine((value) => (value.modelId === null) === (value.reasoningEffort === null), {
    message: 'A completion model and reasoning effort must be configured together'
  });
export type PromptCompletionConfiguration = z.infer<typeof promptCompletionConfigurationSchema>;
export const promptCompletionPreferencesSchema = z
  .object({
    work: z.boolean()
  })
  .strict();
export type PromptCompletionPreferences = z.infer<typeof promptCompletionPreferencesSchema>;

export const promptCompletionAttentionSchema = z
  .object({
    fileId: boundedIdentifierSchema.optional(),
    worktreePath: z.string().max(1024).optional(),
    kind: z.enum(['FILE', 'DIFF']),
    path: z.string().min(1).max(1024),
    observedAt: nonnegativeSafeIntegerSchema,
    revision: z.string().min(1).max(128).optional(),
    startLine: z.number().int().positive().max(10_000_000).optional(),
    endLine: z.number().int().positive().max(10_000_000).optional(),
    source: z.enum(['WORKING_TREE', 'HISTORY', 'TOOL_CHANGE']).optional()
  })
  .strict()
  .refine(
    (value) =>
      (value.startLine === undefined) === (value.endLine === undefined) &&
      (value.startLine === undefined || value.endLine! >= value.startLine),
    'Invalid visible range'
  );
export type PromptCompletionAttention = z.infer<typeof promptCompletionAttentionSchema>;

export const promptCompletionRequestSchema = z
  .object({
    trigger: z.enum(['MANUAL', 'AUTO']),
    completionMode: z.enum(['NEXT', 'COMPLETE', 'REWRITE']),
    attention: z.array(promptCompletionAttentionSchema).max(20).optional(),
    draft: z
      .string()
      .max(8192)
      .refine((value) => utf8ByteLength(value) <= 8192),
    cursorPosition: nonnegativeSafeIntegerSchema,
    draftRevision: nonnegativeSafeIntegerSchema,
    contextVersion: boundedIdentifierSchema,
    historyGeneration: boundedIdentifierSchema,
    requestId: boundedIdentifierSchema,
    pageEpoch: boundedIdentifierSchema,
    intentSequence: positiveSafeIntegerSchema,
    runner: runnerNameSchema,
    sessionId: boundedIdentifierSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.trigger === 'AUTO' && value.draft !== '')
      context.addIssue({
        code: 'custom',
        path: ['draft'],
        message: 'Automatic prediction requires an empty draft'
      });
    const offset = value.cursorPosition;
    const before = value.draft.charCodeAt(offset - 1);
    const after = value.draft.charCodeAt(offset);
    if (
      offset > value.draft.length ||
      (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['cursorPosition'],
        message: 'Invalid draft cursor'
      });
    }
    if ((value.completionMode === 'NEXT') !== (value.draft.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['completionMode'],
        message: 'Completion mode must match the draft'
      });
    }
  });
export type PromptCompletionRequest = z.infer<typeof promptCompletionRequestSchema>;
export const promptCompletionCancelSchema = z
  .object({
    requestId: boundedIdentifierSchema,
    pageEpoch: boundedIdentifierSchema,
    intentSequence: positiveSafeIntegerSchema
  })
  .strict();
export type PromptCompletionCancel = z.infer<typeof promptCompletionCancelSchema>;
export const promptCompletionContextSchema = z
  .object({
    contextVersion: boundedIdentifierSchema,
    historyGeneration: boundedIdentifierSchema,
    progressRevision: nonnegativeSafeIntegerSchema
  })
  .strict();
export type PromptCompletionContext = z.infer<typeof promptCompletionContextSchema>;
const promptCompletionResponseIdentity = {
  requestId: boundedIdentifierSchema,
  contextVersion: boundedIdentifierSchema,
  historyGeneration: boundedIdentifierSchema,
  draftRevision: nonnegativeSafeIntegerSchema,
  cursorPosition: nonnegativeSafeIntegerSchema
};
export const promptCompletionResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...promptCompletionResponseIdentity,
      status: z.literal('ready'),
      suggestion: z.string().min(1).max(4000),
      source: z.enum(['generated', 'cache']),
      expiresAt: nonnegativeSafeIntegerSchema
    })
    .strict(),
  z.object({ ...promptCompletionResponseIdentity, status: z.literal('empty') }).strict(),
  z.object({ ...promptCompletionResponseIdentity, status: z.literal('cancelled') }).strict(),
  z
    .object({
      ...promptCompletionResponseIdentity,
      status: z.literal('skipped'),
      reason: z.enum(['IN_FLIGHT', 'RATE_LIMITED', 'STALE_CONTEXT', 'UNAVAILABLE', 'CAPACITY']),
      retryAfterMs: nonnegativeSafeIntegerSchema.optional()
    })
    .strict()
]);
export type PromptCompletionResponse = z.infer<typeof promptCompletionResponseSchema>;
export const promptCompletionTargetSchema = z
  .object({ kind: z.literal('WORKSPACE'), workspaceId: boundedIdentifierSchema })
  .strict();
export type PromptCompletionTarget = z.infer<typeof promptCompletionTargetSchema>;
export const promptCompletionContextInputSchema = z
  .object({
    target: promptCompletionTargetSchema,
    runner: runnerNameSchema,
    sessionId: boundedIdentifierSchema.nullable(),
    workbenchConnectionId: boundedIdentifierSchema,
    pageEpoch: boundedIdentifierSchema
  })
  .strict();
export type PromptCompletionContextInput = z.infer<typeof promptCompletionContextInputSchema>;
export const promptCompletionGenerateInputSchema = z
  .object({
    target: promptCompletionTargetSchema,
    workbenchConnectionId: boundedIdentifierSchema,
    request: promptCompletionRequestSchema
  })
  .strict();
export type PromptCompletionGenerateInput = z.infer<typeof promptCompletionGenerateInputSchema>;
/** Server-only execution authority; never part of a browser response or Session DTO. */
export const promptCompletionRuntimeSchema = z
  .object({
    workspaceId: boundedIdentifierSchema,
    authorizationView: boundedIdentifierSchema,
    expiresAt: nonnegativeSafeIntegerSchema,
    runtimeScopeId: boundedIdentifierSchema,
    modelRevision: boundedIdentifierSchema,
    credentialScope: boundedIdentifierSchema,
    model: marAgentRuntimeModelConfigurationSchema,
    reasoningEffort: marAgentReasoningEffortSchema
  })
  .strict();
export type PromptCompletionRuntime = z.infer<typeof promptCompletionRuntimeSchema>;
export const marAgentRuntimeCompactConfigurationSchema = z
  .object({
    model: marAgentRuntimeModelConfigurationSchema,
    reasoningEffort: marAgentReasoningEffortSchema
  })
  .strict();
export type MarAgentRuntimeCompactConfiguration = z.infer<
  typeof marAgentRuntimeCompactConfigurationSchema
>;
export const marAgentModelTransportTestInputSchema = z
  .object({
    runtimeScopeId: boundedIdentifierSchema,
    executionId: boundedIdentifierSchema,
    model: marAgentRuntimeModelConfigurationSchema
  })
  .strict();
export type MarAgentModelTransportTestInput = z.infer<typeof marAgentModelTransportTestInputSchema>;
export const marAgentModelTransportTestResultSchema = z.discriminatedUnion('success', [
  z
    .object({
      success: z.literal(true),
      code: z.null(),
      message: z.null(),
      httpStatus: z.null(),
      requestId: z.string().min(1).max(128).optional()
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      code: z.string().trim().min(1).max(80),
      message: z.string().trim().min(1).max(1_000),
      httpStatus: z.number().int().min(100).max(599).nullable(),
      requestId: z.string().min(1).max(128).optional(),
      response: z
        .object({
          body: z.string().max(4096),
          bodyTruncated: z.boolean(),
          contentType: z.string().max(256).nullable(),
          requestId: z.string().max(256).nullable(),
          retryAfter: z.string().max(128).nullable()
        })
        .strict()
        .optional()
    })
    .strict()
]);
export type MarAgentModelTransportTestResult = z.infer<
  typeof marAgentModelTransportTestResultSchema
>;
export const marAgentStoredModelConfigurationSchema = refineMarAgentModel(
  z
    .object({
      ...marAgentModelShape,
      baseUrl: z.string().url().max(2048),
      credential: marAgentModelCredentialSchema
    })
    .strict()
);
export type MarAgentStoredModelConfiguration = z.infer<
  typeof marAgentStoredModelConfigurationSchema
>;

const codexCredentialProxySummarySchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }).strict(),
  z
    .object({
      configured: z.literal(true),
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65_535),
      hasUsername: z.boolean()
    })
    .strict()
]);
export const codexCredentialOwnershipSchema = z.discriminatedUnion('ownerType', [
  z.object({ ownerType: z.literal('PERSONAL'), ownerUserId: positiveSafeIntegerSchema }).strict(),
  z
    .object({
      ownerType: z.literal('ORGANIZATION'),
      ownerOrganizationId: positiveSafeIntegerSchema
    })
    .strict()
]);
export type CodexCredentialOwnership = z.infer<typeof codexCredentialOwnershipSchema>;
export const codexCredentialSummarySchema = z
  .object({
    id: boundedIdentifierSchema,
    name: z.string().trim().min(1).max(128),
    type: z.enum(['CODEX_OAUTH', 'CHATGPT_OAUTH', 'XAI_OAUTH']),
    authorization: z.enum(['AUTHORIZED', 'UNAUTHORIZED']).optional(),
    ownership: codexCredentialOwnershipSchema,
    status: z.enum(['ACTIVE', 'DEGRADED', 'REAUTH_REQUIRED']),
    accessTokenExpiresAt: nonnegativeSafeIntegerSchema.nullable(),
    earliestRefreshAt: nonnegativeSafeIntegerSchema.nullable().optional(),
    lastRefreshAt: nonnegativeSafeIntegerSchema.nullable(),
    lastCheckedAt: nonnegativeSafeIntegerSchema.nullable(),
    accountId: z.string().trim().min(1).max(512),
    proxy: codexCredentialProxySummarySchema,
    revision: positiveSafeIntegerSchema
  })
  .strict();
export type CodexCredentialSummary = z.infer<typeof codexCredentialSummarySchema>;
export const codexCredentialDetailsSchema = z
  .object({
    credential: codexCredentialSummarySchema,
    socks5Url: z.string().url().max(2048).nullable()
  })
  .strict()
  .superRefine((details, context) => {
    if (details.socks5Url === null) {
      if (details.credential.proxy.configured)
        context.addIssue({
          code: 'custom',
          path: ['socks5Url'],
          message: 'configured proxy requires a SOCKS5 URL'
        });
      return;
    }
    let url: URL;
    try {
      url = new URL(details.socks5Url);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['socks5Url'],
        message: 'valid SOCKS5 proxy URL is required'
      });
      return;
    }
    if (url.protocol !== 'socks5:') {
      context.addIssue({
        code: 'custom',
        path: ['socks5Url'],
        message: 'SOCKS5 proxy is required'
      });
      return;
    }
    const proxy = details.credential.proxy;
    if (
      !proxy.configured ||
      proxy.host !== url.hostname ||
      proxy.port !== Number(url.port || 1080) ||
      proxy.hasUsername !== url.username.length > 0
    )
      context.addIssue({
        code: 'custom',
        path: ['credential', 'proxy'],
        message: 'proxy summary must match the SOCKS5 URL'
      });
  });
export type CodexCredentialDetails = z.infer<typeof codexCredentialDetailsSchema>;
const codexUsageDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const codexUsageDailyBucketSchema = z
  .object({
    startDate: codexUsageDateSchema,
    tokens: nonnegativeSafeIntegerSchema
  })
  .strict();
export type CodexUsageDailyBucket = z.infer<typeof codexUsageDailyBucketSchema>;
export const codexUsageProfileSchema = z
  .object({
    lifetimeTokens: nonnegativeSafeIntegerSchema.nullable(),
    currentDayTokens: nonnegativeSafeIntegerSchema.nullable(),
    lastSevenDaysTokens: nonnegativeSafeIntegerSchema.nullable(),
    statsAsOf: codexUsageDateSchema.nullable(),
    dailyUsageBuckets: z.array(codexUsageDailyBucketSchema).max(730)
  })
  .strict()
  .superRefine((profile, context) => {
    const dates = profile.dailyUsageBuckets.map((bucket) => bucket.startDate);
    if (new Set(dates).size !== dates.length)
      context.addIssue({
        code: 'custom',
        path: ['dailyUsageBuckets'],
        message: 'daily usage dates must be unique'
      });
  });
export type CodexUsageProfile = z.infer<typeof codexUsageProfileSchema>;
export const codexCredentialUsageSchema = runnerUsageSchema
  .extend({
    windows: z.array(runnerUsageWindowSchema).max(8),
    profile: codexUsageProfileSchema,
    subscription: z
      .object({
        provider: z.literal('XAI'),
        period: z.enum(['WEEKLY', 'MONTHLY', 'UNKNOWN']),
        startsAt: nonnegativeSafeIntegerSchema.nullable(),
        resetsAt: nonnegativeSafeIntegerSchema.nullable(),
        usedPercentage: z.number().finite().min(0).max(100).nullable(),
        prepaidBalanceCents: nonnegativeSafeIntegerSchema.nullable()
      })
      .strict()
      .optional()
  })
  .superRefine((usage, context) => {
    if (!usage.subscription && usage.windows.length === 0)
      context.addIssue({ code: 'custom', message: 'Usage requires a window or subscription data' });
  });
export type CodexCredentialUsage = z.infer<typeof codexCredentialUsageSchema>;
export const codexLoginAttemptSchema = z
  .object({
    id: boundedIdentifierSchema,
    status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']),
    type: z.enum(['CODEX_OAUTH', 'CHATGPT_OAUTH', 'XAI_OAUTH']).optional(),
    userCode: z.string().trim().min(1).max(128).optional(),
    verificationUri: z.string().url().max(2048).optional(),
    expiresAt: nonnegativeSafeIntegerSchema.optional(),
    pollIntervalMs: positiveSafeIntegerSchema.max(60_000).optional(),
    credentialId: boundedIdentifierSchema.optional(),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/u)
      .optional(),
    message: z.string().min(1).max(512).optional()
  })
  .strict()
  .superRefine((attempt, context) => {
    if (
      attempt.status === 'PENDING' &&
      ((attempt.type !== 'CHATGPT_OAUTH' && attempt.userCode === undefined) ||
        attempt.verificationUri === undefined ||
        attempt.expiresAt === undefined ||
        attempt.pollIntervalMs === undefined)
    )
      context.addIssue({ code: 'custom', message: 'pending login attempt is incomplete' });
    if (attempt.status === 'SUCCEEDED' && attempt.credentialId === undefined)
      context.addIssue({ code: 'custom', message: 'successful login attempt needs a credential' });
    if (attempt.status !== 'SUCCEEDED' && attempt.credentialId !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['credentialId'],
        message: 'only a successful login attempt may expose a credential'
      });
  });
export type CodexLoginAttempt = z.infer<typeof codexLoginAttemptSchema>;
const codexModelCandidateSchema = z
  .object({
    upstreamModelId: z.string().trim().min(1).max(256),
    displayName: z.string().trim().min(1).max(256),
    description: z.string().max(4096).optional(),
    contextWindowTokens: positiveSafeIntegerSchema.optional(),
    maxOutputTokens: positiveSafeIntegerSchema.optional(),
    reasoningEfforts: z.array(marAgentReasoningEffortSchema).max(6),
    defaultReasoningEffort: marAgentReasoningEffortSchema.optional(),
    unsupportedReasoningEfforts: z.array(z.string().trim().min(1).max(128)).max(16),
    inputCapabilities: z.array(marAgentInputCapabilitySchema).min(1).max(2),
    hostedWebSearch: z.boolean(),
    warnings: z.array(z.string().trim().min(1).max(512)).max(32),
    requiredInputs: z.array(z.literal('contextWindowTokens')).max(1)
  })
  .strict()
  .superRefine((model, context) => {
    if (new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length)
      context.addIssue({ code: 'custom', message: 'reasoning efforts must be unique' });
    if (
      model.defaultReasoningEffort !== undefined &&
      model.reasoningEfforts.length > 0 &&
      !model.reasoningEfforts.includes(model.defaultReasoningEffort)
    )
      context.addIssue({
        code: 'custom',
        path: ['defaultReasoningEffort'],
        message: 'default reasoning effort must be exposed when choices are configured'
      });
    if (
      new Set(model.unsupportedReasoningEfforts).size !== model.unsupportedReasoningEfforts.length
    )
      context.addIssue({ code: 'custom', message: 'unsupported reasoning efforts must be unique' });
    if (new Set(model.inputCapabilities).size !== model.inputCapabilities.length)
      context.addIssue({ code: 'custom', message: 'input capabilities must be unique' });
    if (new Set(model.requiredInputs).size !== model.requiredInputs.length)
      context.addIssue({ code: 'custom', message: 'required inputs must be unique' });
    if (
      model.contextWindowTokens !== undefined &&
      model.maxOutputTokens !== undefined &&
      model.maxOutputTokens >= model.contextWindowTokens
    )
      context.addIssue({ code: 'custom', message: 'output must be smaller than context' });
    if (
      model.requiredInputs.includes('contextWindowTokens') !==
      (model.contextWindowTokens === undefined)
    )
      context.addIssue({
        code: 'custom',
        path: ['requiredInputs'],
        message: 'context window requirement does not match the catalog value'
      });
  });
export const codexModelCatalogSchema = z
  .object({
    catalogHash: z.string().regex(/^[a-f0-9]{64}$/u),
    fetchedAt: nonnegativeSafeIntegerSchema,
    models: z.array(codexModelCandidateSchema).max(256)
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = catalog.models.map((model) => model.upstreamModelId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', path: ['models'], message: 'model IDs must be unique' });
  });
export type CodexModelCatalog = z.infer<typeof codexModelCatalogSchema>;
const codexModelImportItemSchema = z
  .object({
    upstreamModelId: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(128).optional(),
    contextWindowTokens: positiveSafeIntegerSchema.optional(),
    enabled: z.boolean()
  })
  .strict();
export const codexModelImportRequestSchema = z
  .object({
    catalogHash: z.string().regex(/^[a-f0-9]{64}$/u),
    ownership: resourceOwnershipSchema.optional(),
    models: z.array(codexModelImportItemSchema).min(1).max(64)
  })
  .strict()
  .superRefine((request, context) => {
    const ids = request.models.map((model) => model.upstreamModelId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', path: ['models'], message: 'model IDs must be unique' });
  });
export type CodexModelImportRequest = z.infer<typeof codexModelImportRequestSchema>;
const codexModelImportResultItemSchema = z
  .object({
    upstreamModelId: z.string().trim().min(1).max(256),
    status: z.enum(['CREATED', 'UPDATED', 'UNCHANGED', 'BLOCKED']),
    modelId: boundedIdentifierSchema.optional(),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/u)
      .optional()
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status === 'BLOCKED') {
      if (item.modelId !== undefined)
        context.addIssue({ code: 'custom', path: ['modelId'], message: 'blocked model has no ID' });
      if (item.code === undefined)
        context.addIssue({ code: 'custom', path: ['code'], message: 'blocked model needs a code' });
      return;
    }
    if (item.modelId === undefined)
      context.addIssue({
        code: 'custom',
        path: ['modelId'],
        message: 'imported model needs an ID'
      });
    if (item.code !== undefined)
      context.addIssue({ code: 'custom', path: ['code'], message: 'imported model has no error' });
  });
export const codexModelImportResultSchema = z
  .object({
    items: z.array(codexModelImportResultItemSchema).min(1).max(64)
  })
  .strict();
export type CodexModelImportResult = z.infer<typeof codexModelImportResultSchema>;

export const agentRunStatusSchema = z.enum([
  'STARTING',
  'RUNNING',
  'CANCELLING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED'
]);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const recentRunSchema = z.object({
  runId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  workspaceName: z.string().max(128).optional(),
  sessionId: z.string().min(1).max(128),
  sessionTitle: z.string().min(1).max(160),
  sessionGroup: z.enum(['MAIN', 'CHILD']).optional(),
  userMessage: z.string().max(500).optional(),
  runner: runnerNameSchema,
  status: agentRunStatusSchema,
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  sortAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  version: z.number().int().nonnegative()
});
export type RecentRun = z.infer<typeof recentRunSchema>;

export const recentRunProjectionSchema = recentRunSchema
  .omit({ workspaceName: true })
  .extend({ userId: z.number().int().positive() });
export type RecentRunProjection = z.infer<typeof recentRunProjectionSchema>;

export const recentRunProjectionMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('UPDATE'), run: recentRunProjectionSchema }),
  z.object({ kind: z.literal('SNAPSHOT'), runs: z.array(recentRunProjectionSchema) })
]);
export type RecentRunProjectionMessage = z.infer<typeof recentRunProjectionMessageSchema>;

/** Process-local Workspace FIFO projection; queue contents never enter SQLite. */
export const workspaceQueueItemSchema = z.object({
  queueItemId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  runner: runnerNameSchema,
  clientMessageId: z.string().min(1).max(128),
  sessionTitle: z.string().max(160),
  content: z.string().min(1).max(20_000),
  createdAt: z.number().int().nonnegative()
});
export const workspaceQueueSchema = z.object({
  version: z.number().int().nonnegative(),
  paused: z.boolean(),
  items: z.array(workspaceQueueItemSchema)
});
export type WorkspaceQueue = z.infer<typeof workspaceQueueSchema>;

export const runEventSchema = z.object({
  runId: z.string().min(1).max(128),
  sequence: z.number().int().positive(),
  eventType: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  payload: z.unknown(),
  status: agentRunStatusSchema.optional(),
  createdAt: z.number().int().nonnegative().optional(),
  version: z.number().int().nonnegative().optional()
});
export type RunEvent = z.infer<typeof runEventSchema>;

/** Ephemeral metrics for the currently observed model request, never a history item. */
export const runPerformanceSchema = z
  .object({
    runId: z.string().min(1).max(128),
    latencyMs: z.number().int().nonnegative().optional(),
    tokensPerSecond: z.number().finite().nonnegative().optional()
  })
  .refine((value) => value.latencyMs !== undefined || value.tokensPerSecond !== undefined);
export type RunPerformance = z.infer<typeof runPerformanceSchema>;

/**
 * Node-to-Workbench asynchronous notifications.  This is deliberately a
 * small envelope: business payloads remain owned by the Node and Server only
 * authenticates and relays them to an Admin page connection.
 */
export const workbenchEventCategorySchema = z.enum([
  'node',
  'session',
  'conversation',
  'hosted-conversation',
  'run',
  'queue',
  'workspace'
]);
export type WorkbenchEventCategory = z.infer<typeof workbenchEventCategorySchema>;

export const workbenchEventSchema = z.object({
  sequence: z.number().int().positive(),
  category: workbenchEventCategorySchema,
  payload: z.unknown()
});
export type WorkbenchEvent = z.infer<typeof workbenchEventSchema>;

export const watchAcceptedSchema = z
  .object({
    accepted: z.literal(true),
    watchId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    nodeGeneration: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    expiresAt: z.number().int().positive()
  })
  .strict();
export type WatchAccepted = z.infer<typeof watchAcceptedSchema>;

const watchEventIdentitySchema = z
  .object({
    workbenchConnectionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    watchId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    nodeGeneration: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    nodeId: z.string().min(1).max(160)
  })
  .strict();
const hostedConversationWatchIdentitySchema = watchEventIdentitySchema.extend({
  templateId: z.string().min(1).max(160)
});

const watchFailedEventSchema = watchEventIdentitySchema
  .extend({
    type: z.literal('watch.failed'),
    watchType: z.enum(['workspace', 'session', 'hosted-conversation']),
    workspaceId: z.string().min(1).max(160).optional(),
    sessionId: z.string().min(1).max(512).optional(),
    conversationId: z.string().min(1).max(160).optional(),
    templateId: z.string().min(1).max(160).optional(),
    topic: z.enum(['sessions', 'files', 'changes']).optional(),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    message: z.string().min(1).max(1000)
  })
  .superRefine((event, context) => {
    const valid =
      (event.watchType === 'workspace' &&
        event.workspaceId !== undefined &&
        event.sessionId === undefined &&
        event.conversationId === undefined &&
        event.templateId === undefined) ||
      (event.watchType === 'session' &&
        event.workspaceId !== undefined &&
        event.sessionId !== undefined &&
        event.conversationId === undefined &&
        event.templateId === undefined &&
        event.topic === undefined) ||
      (event.watchType === 'hosted-conversation' &&
        event.workspaceId === undefined &&
        event.sessionId === undefined &&
        event.conversationId !== undefined &&
        event.templateId !== undefined &&
        event.topic === undefined);
    if (!valid)
      context.addIssue({
        code: 'custom',
        message: 'watch failure identity does not match the watch type'
      });
  });

export const watchEventSchema = z.union([
  watchEventIdentitySchema.extend({
    type: z.literal('watch.workspace.snapshot'),
    workspaceId: z.string().min(1).max(160),
    topic: z.enum(['sessions', 'files', 'changes']),
    revision: z.number().int().nonnegative(),
    snapshotSequence: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    payload: z.unknown()
  }),
  watchEventIdentitySchema.extend({
    type: z.literal('watch.session.snapshot'),
    workspaceId: z.string().min(1).max(160),
    sessionId: z.string().min(1).max(512),
    revision: z.number().int().nonnegative(),
    snapshotSequence: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    payload: z.unknown()
  }),
  watchEventIdentitySchema.extend({
    type: z.literal('watch.session.event'),
    workspaceId: z.string().min(1).max(160),
    sessionId: z.string().min(1).max(512),
    expiresAt: z.number().int().positive(),
    event: workbenchEventSchema
  }),
  hostedConversationWatchIdentitySchema.extend({
    type: z.literal('watch.hosted-conversation.snapshot'),
    conversationId: z.string().min(1).max(160),
    revision: z.number().int().nonnegative(),
    snapshotSequence: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    payload: z.unknown()
  }),
  hostedConversationWatchIdentitySchema.extend({
    type: z.literal('watch.hosted-conversation.event'),
    conversationId: z.string().min(1).max(160),
    expiresAt: z.number().int().positive(),
    event: workbenchEventSchema
  }),
  watchFailedEventSchema
]);
export type WatchEvent = z.infer<typeof watchEventSchema>;

const capabilityAvailabilityBaseSchema = z.object({
  available: z.boolean(),
  reasonCode: z.string().min(1).max(80).nullable()
});

function refineCapabilityAvailability<T extends z.AnyZodObject>(schema: T) {
  return schema.superRefine((value, context) => {
    if (value.available && value.reasonCode !== null) {
      context.addIssue({ code: 'custom', message: 'available capability cannot have reasonCode' });
    }
    if (!value.available && value.reasonCode === null) {
      context.addIssue({ code: 'custom', message: 'unavailable capability requires reasonCode' });
    }
  });
}

function capabilitySchemaWith<T extends z.ZodRawShape>(shape: T) {
  return refineCapabilityAvailability(capabilityAvailabilityBaseSchema.extend(shape));
}

export const capabilityAvailabilitySchema = refineCapabilityAvailability(
  capabilityAvailabilityBaseSchema
);
export type CapabilityAvailability = z.infer<typeof capabilityAvailabilitySchema>;

export const runnerCommandDescriptorSchema = z
  .object({
    id: z.string().min(1).max(128),
    runner: runnerNameSchema,
    label: z.string().min(1).max(128),
    stateLabel: z.string().min(1).max(128).optional(),
    description: z.string().max(500),
    /** Commands are entered exactly as the Runner documents them: `/name args`. */
    inputHint: z.string().max(200),
    source: z.enum(['CODEX_APP_SERVER', 'CLAUDE_AGENT_SDK', 'OPENCODE_SERVER', 'MAR_RUNTIME']),
    interaction: z.enum([
      'RUNNER_TEXT',
      'IMMEDIATE_ACTION',
      'DESTRUCTIVE_ACTION',
      'TOGGLE',
      'VALUE'
    ]),
    available: z.boolean(),
    reasonCode: z.string().min(1).max(80).nullable()
  })
  .superRefine((value, context) => {
    if (value.available && value.reasonCode !== null) {
      context.addIssue({ code: 'custom', message: 'available command cannot have reasonCode' });
    }
    if (!value.available && value.reasonCode === null) {
      context.addIssue({ code: 'custom', message: 'unavailable command requires reasonCode' });
    }
  });
export type RunnerCommandDescriptor = z.infer<typeof runnerCommandDescriptorSchema>;

export const runnerCommandStateSchema = z.object({
  commandId: z.string().min(1).max(128),
  active: z.boolean(),
  label: z.string().min(1).max(128),
  detail: z.string().max(500).nullable(),
  closable: z.boolean(),
  closeInput: z.string().min(2).max(20_000).nullable(),
  goal: z
    .object({
      id: z.string().uuid(),
      objective: z.string().min(1).max(20_000),
      revision: z.number().int().positive(),
      status: z.enum(['active', 'completed', 'blocked']),
      turns: z.number().int().nonnegative().optional()
    })
    .optional(),
  /** A Node-declared, fixed continuation for a completed structured result. */
  continuation: z
    .object({
      label: z.string().min(1).max(128),
      prompt: z.string().min(1).max(20_000)
    })
    .nullable()
    .optional()
});
export type RunnerCommandState = z.infer<typeof runnerCommandStateSchema>;

export const runnerProfileSchema = z.object({
  runner: runnerNameSchema,
  models: z.array(
    z.object({
      id: z.string().min(1).max(128),
      label: z.string().min(1).max(128),
      supportedEfforts: z.array(z.string().min(1).max(64)).max(32),
      isDefault: z.boolean().optional(),
      defaultEffort: z.string().min(1).max(64).optional()
    })
  ),
  accessOptions: z.array(
    z.object({
      id: z.string().min(1).max(128),
      label: z.string().min(1).max(128),
      description: z.string().max(500)
    })
  ),
  commands: z.array(runnerCommandDescriptorSchema),
  capabilities: z.array(z.string().min(1).max(80)).max(64)
});
export type RunnerProfile = z.infer<typeof runnerProfileSchema>;

/** The last explicitly chosen Composer configuration belongs to one Node Runner. */
export const runnerDefaultConfigurationSchema = z.object({
  runner: runnerNameSchema,
  model: z.string().trim().min(1).max(128),
  /** Runners without a reasoning-variant dimension persist an empty effort value. */
  effort: z.string().trim().max(64),
  access: z.string().trim().min(1).max(128)
});
export type RunnerDefaultConfiguration = z.infer<typeof runnerDefaultConfigurationSchema>;

/** A Runner command is selected from a Node-declared profile, never guessed from `/` text. */
export const runnerCommandExecutionSchema = z.object({
  commandId: z.string().min(1).max(128),
  input: z.string().min(2).max(20_000)
});
export type RunnerCommandExecution = z.infer<typeof runnerCommandExecutionSchema>;

export const serverWorkbenchCapabilitiesSchema = z.object({
  workbenchProtocolVersion: z.literal(WORKBENCH_PROTOCOL_VERSION),
  serverVersion: z.string().trim().min(1).max(128).optional(),
  conversationItemVersions: z.array(z.literal(2)).min(1),
  supportsSessionDetailStream: z.boolean(),
  supportsTerminalBrowserRelay: z.boolean(),
  supportsTerminalNodeDataChannel: z.boolean(),
  maxSseSubscriptionsPerUser: z.number().int().positive().max(128),
  maxTerminalBrowserConnectionsPerUser: z.number().int().nonnegative().max(32)
});
export type ServerWorkbenchCapabilities = z.infer<typeof serverWorkbenchCapabilitiesSchema>;

export const nodeWorkbenchCapabilitiesSchema = z.object({
  manifestVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative(),
  nodeGeneration: z.string().min(8).max(128).optional(),
  platform: nodePlatformSchema,
  architecture: z.string().min(1).max(128),
  conversation: capabilitySchemaWith({
    itemVersions: z.array(z.literal(2)).min(1),
    supportsSessionCursor: z.boolean(),
    supportsHistoryPaging: z.boolean(),
    supportsItemFinalSnapshots: z.boolean(),
    maxPageSize: z.number().int().positive().max(500)
  }),
  runners: z.array(runnerProfileSchema),
  files: capabilitySchemaWith({
    supportsList: z.boolean(),
    supportsReadRange: z.boolean(),
    supportsSearch: z.boolean(),
    maxDirectoryPageSize: z.number().int().positive().max(1000),
    maxReadBytes: z.number().int().positive(),
    maxSearchResults: z.number().int().positive().max(10000)
  }),
  directTransfer: workspaceDirectTransferCapabilitySchema.optional(),
  terminalDirect: terminalDirectCapabilitySchema.optional(),
  sessionGroups: z
    .object({ apiVersion: z.literal(1) })
    .strict()
    .optional(),
  git: capabilitySchemaWith({
    supportsCurrentChanges: z.boolean(),
    supportsTurnChanges: z.boolean(),
    supportsHistory: z.boolean().optional(),
    maxDiffBytes: z.number().int().positive()
  }),
  terminal: capabilitySchemaWith({
    supportsPty: z.boolean(),
    supportsConPty: z.boolean(),
    supportsReplay: z.boolean(),
    supportsReadonlyAttach: z.boolean(),
    supportsTakeover: z.boolean(),
    maxTerminals: z.number().int().nonnegative().max(64),
    maxReplayBytes: z.number().int().nonnegative(),
    reconnectWindowMs: z.number().int().nonnegative(),
    profiles: z.array(
      z.object({
        id: z.string().min(1).max(128),
        label: z.string().min(1).max(128),
        isDefault: z.boolean()
      })
    )
  })
});
export type NodeWorkbenchCapabilities = z.infer<typeof nodeWorkbenchCapabilitiesSchema>;

export const sessionRuntimeCapabilitySchema = z.enum([
  'history.read',
  'events.live',
  'turn.start',
  'turn.queue',
  'turn.interrupt',
  'run.cancel',
  'approval.respond',
  'user-input.respond',
  'session.rename',
  'session.rewind',
  'session.rollback',
  'session.remove',
  'session.pin',
  'session.schedule',
  'session.prompt'
]);
export const sessionRuntimeCapabilitiesSchema = z.object({
  level: z.literal('MANAGED'),
  capabilities: z.array(sessionRuntimeCapabilitySchema),
  reasonCode: z.string().min(1).max(80).nullable()
});
export type SessionRuntimeCapabilities = z.infer<typeof sessionRuntimeCapabilitiesSchema>;

export const sessionActivityStateSchema = z.enum(['MANAGED_ACTIVE', 'IDLE']);
export type SessionActivityState = z.infer<typeof sessionActivityStateSchema>;

export const eventCursorSchema = z.object({
  scope: z.enum(['RUN', 'SESSION', 'WORKSPACE_ACTIVITY']),
  streamId: z.string().min(1).max(128),
  cursor: z.string().min(1).max(1024)
});
export type EventCursor = z.infer<typeof eventCursorSchema>;

export const permissionStopSchema = z.object({
  action: z.enum(['ask', 'deny']),
  reason: z
    .string()
    .trim()
    .min(1)
    .refine((value) => [...value].length <= 240),
  source: z.object({
    sessionId: z.string().min(1).max(128),
    executionId: z.string().min(1).max(128),
    callId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    parentCallId: z.string().min(1).max(128).optional()
  })
});
export type PermissionStop = z.infer<typeof permissionStopSchema>;

export const conversationProcessGroupSchema = z.object({
  id: z.string().min(1).max(128),
  isStart: z.literal(true).optional()
});
const conversationItemBaseSchema = z.object({
  id: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128).nullable(),
  parentItemId: z.string().min(1).max(128).nullable(),
  sourceSequence: z.number().int().positive().nullable(),
  revision: z.number().int().nonnegative(),
  status: z.enum([
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED',
    'FAILED',
    'DECLINED',
    'CANCELLED',
    'INTERRUPTED'
  ]),
  startedAt: z.number().int().nonnegative().nullable(),
  completedAt: z.number().int().nonnegative().nullable(),
  segmentId: z.string().min(1).max(256).optional(),
  segmentIndex: z.number().int().nonnegative().optional(),
  processGroup: conversationProcessGroupSchema.optional(),
  permissionStop: permissionStopSchema.optional()
});

export const contextReferenceSchema = z.object({
  type: z.enum(['file', 'directory', 'changes', 'diff', 'turn', 'message', 'terminal_selection']),
  referenceId: z.string().min(1).max(128),
  label: z.string().min(1).max(500),
  path: z.string().min(1).max(4096).optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional()
});
export type ContextReference = z.infer<typeof contextReferenceSchema>;

export const imageRefSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^(?:file|reader):[^\s]+$/u);

export const conversationImageAttachmentSchema = z
  .object({
    name: z.string().trim().min(1).max(512),
    mime: z.string().regex(/^image\/[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$/u),
    byteSize: z.number().int().nonnegative().optional(),
    runId: z.string().min(1).max(128).optional(),
    imageIndex: z.number().int().nonnegative().optional(),
    imageRef: imageRefSchema.optional()
  })
  .strict()
  .superRefine((attachment, context) => {
    const selectors =
      Number(attachment.imageIndex !== undefined) + Number(attachment.imageRef !== undefined);
    if (selectors > 1 || (attachment.runId === undefined ? selectors !== 0 : selectors !== 1))
      context.addIssue({
        code: 'custom',
        message: 'runId must be paired with exactly one image selector'
      });
  });
export type ConversationImageAttachment = z.infer<typeof conversationImageAttachmentSchema>;

const assistantMessageItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('assistant_message'),
  payload: z.object({
    text: z.string(),
    format: z.literal('markdown'),
    model: z.string().max(128).nullable()
  })
});
const userMessageItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('user_message'),
  payload: z.object({
    clientMessageId: z.string().min(1).max(128).nullable(),
    text: z.string(),
    contexts: z.array(contextReferenceSchema).max(64).default([]),
    attachments: z.array(conversationImageAttachmentSchema).max(32).optional(),
    source: z.literal('SCHEDULED').optional(),
    delivery: z.enum(['PENDING', 'ACCEPTED', 'STEERED', 'QUEUED_NEXT_TURN', 'REJECTED'])
  })
});
const planItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('plan'),
  payload: z.object({
    explanation: z.string().nullable(),
    steps: z.array(
      z.object({
        id: z.string().min(1).max(128),
        text: z.string(),
        status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED'])
      })
    )
  })
});
const todoListItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('todo_list'),
  payload: z.object({
    items: z.array(
      z.object({
        id: z.string().min(1).max(128),
        text: z.string(),
        status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED'])
      })
    )
  })
});
const approvalItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('approval'),
  payload: z.object({
    approvalId: z.string().min(1).max(128),
    category: z.enum(['COMMAND', 'FILE_CHANGE', 'NETWORK', 'TOOL', 'OTHER']),
    reason: z.string().nullable(),
    expiresAt: z.number().int().nonnegative(),
    resolvedDecision: z.string().nullable()
  })
});
const summaryItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('turn_summary'),
  payload: z.object({
    status: agentRunStatusSchema,
    durationMs: z.number().int().nonnegative().nullable()
  })
});
const reasoningItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('reasoning'),
  payload: z.object({
    sections: z.array(z.object({ index: z.number().int().nonnegative(), text: z.string() })),
    representation: z.enum(['summary', 'visible_thinking', 'unspecified'])
  })
});
export const subagentOperationSchema = z.enum(['START', 'STATUS', 'CANCEL', 'MESSAGE', 'RESUME']);
export type SubagentOperation = z.infer<typeof subagentOperationSchema>;
export const subagentLatestMessageSchema = z.object({
  itemId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128),
  phase: z.enum(['commentary', 'final_answer']),
  text: z
    .string()
    .refine((value) => [...value].length <= 10_000, 'Must contain at most 10000 characters'),
  timestamp: z.string().datetime(),
  truncated: z.boolean().optional()
});
export type SubagentLatestMessage = z.infer<typeof subagentLatestMessageSchema>;
export const toolPresentationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('READ'),
    paths: z.array(z.string().min(1).max(4096)).max(16).optional()
  }),
  z.object({
    kind: z.literal('WEB_SEARCH'),
    query: z.string().max(500).optional(),
    sourceCount: z.number().int().nonnegative().optional(),
    sources: z
      .array(
        z.object({
          url: z.string().min(1).max(8192),
          title: z.string().max(1000).optional(),
          snippet: z.string().max(2000).optional()
        })
      )
      .max(20)
      .optional()
  }),
  z.object({
    kind: z.literal('WEB_FETCH'),
    requestUrl: z.string().max(8192).optional(),
    url: z.string().max(8192).optional(),
    title: z.string().max(1000).optional(),
    mode: z.enum(['http', 'browser']).optional(),
    status: z.number().int().min(100).max(599).optional(),
    contentType: z.string().max(256).optional()
  }),
  z.object({
    kind: z.literal('SKILL'),
    name: z.string().max(128).optional(),
    description: z.string().max(2000).optional(),
    source: z.string().max(4096).optional()
  }),
  z.object({
    kind: z.literal('SLEEP'),
    durationMs: z.number().int().min(1).max(1800000).optional(),
    startedAt: z.string().datetime().optional(),
    elapsedMs: z.number().int().nonnegative().optional(),
    wakeReason: z.enum(['elapsed', 'steer', 'subagent_message']).optional()
  })
]);
export type ToolPresentation = z.infer<typeof toolPresentationSchema>;
const toolCallItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('tool_call'),
  payload: z.object({
    namespace: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    title: z.string().min(1).max(500),
    inputSummary: z.string().max(10000).nullable(),
    outputSummary: z.string().max(10000).nullable(),
    progressLabel: z.string().max(500).nullable(),
    errorCode: z.string().max(80).nullable(),
    truncated: z.boolean(),
    toolCategory: z.enum(['IMAGE_GENERATION']).optional(),
    toolPresentation: toolPresentationSchema.optional(),
    subagentOperation: subagentOperationSchema.optional(),
    subagentWait: z.boolean().optional(),
    subagentId: z.string().min(1).max(128).nullable().optional(),
    subagentModelId: z.string().min(1).max(128).optional(),
    subagentModelName: z.string().min(1).max(128).optional(),
    subagentReasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    subagentLatestMessage: subagentLatestMessageSchema.optional(),
    attachments: z.array(conversationImageAttachmentSchema).max(32).optional()
  })
});
const commandExecutionItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('command_execution'),
  payload: z.object({
    title: z.string().min(1).max(128).optional(),
    command: z.string().max(10000),
    cwd: z.string().max(4096).nullable(),
    outputPreview: z.string().max(10000),
    outputRef: z.string().min(1).max(128).nullable(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    truncated: z.boolean()
  })
});
const fileChangeItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('file_change'),
  payload: z.object({
    changes: z.array(
      z.object({
        path: z.string().min(1).max(4096),
        change: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'TYPE_CHANGED']),
        additions: z.number().int().nonnegative().nullable(),
        deletions: z.number().int().nonnegative().nullable(),
        diffAvailable: z.boolean(),
        changeId: z.string().uuid().optional(),
        diff: fileChangeDiffSchema.optional()
      })
    )
  })
});
const userInputRequestItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('user_input_request'),
  payload: z.object({
    requestId: z.string().min(1).max(128),
    questions: z.array(
      z.object({
        id: z.string().min(1).max(128),
        prompt: z.string().max(5000),
        input: z.enum(['SINGLE_SELECT', 'MULTI_SELECT', 'SHORT_TEXT']),
        options: z.array(
          z.object({
            value: z.string().max(500),
            label: z.string().max(500),
            description: z.string().max(1000).nullable()
          })
        ),
        allowOther: z.boolean(),
        multiSelect: z.boolean().optional()
      })
    )
  })
});
const contextCompactionItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('context_compaction'),
  payload: z.object({
    phase: z.enum(['STARTED', 'COMPLETED']),
    summary: z.string().max(10000).nullable(),
    mode: z.enum(['BACKGROUND', 'BLOCKING']).optional(),
    stage: z.enum(['GENERATING', 'READY', 'WAITING']).optional(),
    anchorItemId: z.string().min(1).max(128).optional(),
    retainedContext: z.boolean().optional(),
    code: z.string().min(1).max(80).optional()
  })
});
const warningItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('warning'),
  payload: z.object({
    code: z.string().min(1).max(80),
    message: z.string().max(5000),
    recoverable: z.boolean()
  })
});
const errorItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('error'),
  payload: z.object({
    code: z.string().min(1).max(80),
    message: z.string().max(1000),
    httpStatus: z.number().int().min(100).max(599).nullable().optional(),
    recoverable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().nullable()
  })
});
const unknownItemSchema = conversationItemBaseSchema.extend({
  kind: z.literal('unknown'),
  payload: z.object({ sourceEventType: z.string().min(1).max(128), label: z.string().max(500) })
});

export const conversationItemSchema = z.discriminatedUnion('kind', [
  assistantMessageItemSchema,
  userMessageItemSchema,
  reasoningItemSchema,
  planItemSchema,
  todoListItemSchema,
  toolCallItemSchema,
  commandExecutionItemSchema,
  fileChangeItemSchema,
  approvalItemSchema,
  userInputRequestItemSchema,
  contextCompactionItemSchema,
  warningItemSchema,
  errorItemSchema,
  summaryItemSchema,
  unknownItemSchema
]);
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const conversationTurnSchema = z.object({
  id: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128).nullable(),
  userItemId: z.string().min(1).max(128).nullable(),
  status: z.enum([
    'PREPARING',
    'RUNNING',
    'WAITING_INPUT',
    'WAITING_APPROVAL',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'INTERRUPTED',
    'LOST'
  ]),
  model: z.string().max(128).nullable(),
  effort: z.string().max(64).nullable(),
  access: z.string().max(128).nullable(),
  rewind: z
    .object({
      before: z.string().min(1).max(256).nullable(),
      after: z.string().min(1).max(256)
    })
    .optional(),
  items: z.array(conversationItemSchema),
  startedAt: z.number().int().nonnegative().nullable(),
  completedAt: z.number().int().nonnegative().nullable()
});
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

const protocolIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const stableStorageKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,159}$/);
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const conversationRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') &&
      !/^[A-Za-z]:/u.test(path),
    'relative path is invalid'
  );
const uniqueProtocolIds = (
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[]
) => {
  if (new Set(values).size !== values.length)
    context.addIssue({ code: 'custom', path, message: 'identifiers must be unique' });
};

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const canonicalBase64 = (value: string): boolean => {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 2) return BASE64_ALPHABET.indexOf(value.at(-3)!) % 16 === 0;
  if (padding === 1) return BASE64_ALPHABET.indexOf(value.at(-2)!) % 4 === 0;
  return true;
};
const base64DecodedByteLength = (value: string): number => {
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
};

export const conversationTemplateStatusSchema = z.enum(['ACTIVE', 'ARCHIVED', 'DELETED']);
export const conversationTemplateVersionStatusSchema = z.enum([
  'AVAILABLE',
  'DISABLED',
  'CORRUPTED',
  'RETAINED'
]);
export const conversationTemplateNetworkModeSchema = z.enum(['NONE', 'UNRESTRICTED']);
export const conversationTemplateQuotaSchema = z
  .object({
    maxStorageBytes: z.number().int().positive(),
    maxUploadBytes: z.number().int().positive()
  })
  .strict()
  .superRefine((quota, context) => {
    if (quota.maxUploadBytes > quota.maxStorageBytes)
      context.addIssue({ code: 'custom', message: 'upload quota exceeds storage quota' });
  });

export const conversationTemplateModelReferenceSchema = z
  .object({
    modelId: protocolIdSchema,
    name: z.string().trim().min(1).max(128)
  })
  .strict();
export type ConversationTemplateModelReference = z.infer<
  typeof conversationTemplateModelReferenceSchema
>;

export const conversationTemplateDraftSchema = z
  .object({
    templateId: protocolIdSchema,
    nodeId: protocolIdSchema,
    workspaceId: protocolIdSchema,
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(128),
    description: z.string().max(2000),
    icon: z.string().trim().min(1).max(128).optional(),
    allowedModels: z.array(conversationTemplateModelReferenceSchema).min(1).max(128),
    defaultModelId: protocolIdSchema,
    mcpIds: z.array(protocolIdSchema).max(128),
    networkMode: conversationTemplateNetworkModeSchema,
    quotas: conversationTemplateQuotaSchema,
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((draft, context) => {
    uniqueProtocolIds(
      draft.allowedModels.map((model) => model.modelId),
      context,
      ['allowedModels']
    );
    uniqueProtocolIds(draft.mcpIds, context, ['mcpIds']);
    if (!draft.allowedModels.some((model) => model.modelId === draft.defaultModelId))
      context.addIssue({
        code: 'custom',
        path: ['defaultModelId'],
        message: 'default model must be allowed'
      });
  });
export type ConversationTemplateDraft = z.infer<typeof conversationTemplateDraftSchema>;

export const conversationTemplateSourceInspectInputSchema = z
  .object({
    mode: z.enum(['VALIDATE', 'DRAFT_TEST']),
    draft: conversationTemplateDraftSchema
  })
  .strict();
export type ConversationTemplateSourceInspectInput = z.infer<
  typeof conversationTemplateSourceInspectInputSchema
>;

export const conversationTemplateMcpOptionSchema = z
  .object({
    id: protocolIdSchema,
    serverName: z.string().trim().min(1).max(255),
    displayName: z.string().trim().min(1).max(128),
    transport: z.enum(['STDIO', 'HTTP']),
    origin: z.enum(['NODE', 'WORKSPACE'])
  })
  .strict();
export type ConversationTemplateMcpOption = z.infer<typeof conversationTemplateMcpOptionSchema>;

export const conversationTemplateSourceInspectionSchema = z
  .object({
    valid: z.boolean(),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable(),
    message: z.string().min(1).max(1000),
    checkedAt: z.number().int().nonnegative(),
    mcpServers: z.array(conversationTemplateMcpOptionSchema).max(128).default([])
  })
  .strict()
  .superRefine((inspection, context) => {
    if (inspection.valid !== (inspection.code === null))
      context.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'inspection code must match validity'
      });
    uniqueProtocolIds(
      inspection.mcpServers.map((server) => server.id),
      context,
      ['mcpServers']
    );
  });
export type ConversationTemplateSourceInspection = z.infer<
  typeof conversationTemplateSourceInspectionSchema
>;

export const conversationTemplateSummarySchema = z
  .object({
    id: protocolIdSchema,
    nodeId: protocolIdSchema,
    name: z.string().trim().min(1).max(128),
    description: z.string().max(2000),
    icon: z.string().trim().min(1).max(128).optional(),
    status: conversationTemplateStatusSchema,
    currentVersionId: protocolIdSchema.nullable(),
    available: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((template, context) => {
    if (template.available && (template.status !== 'ACTIVE' || template.currentVersionId === null))
      context.addIssue({
        code: 'custom',
        path: ['available'],
        message: 'available template requires an active published version'
      });
  });
export type ConversationTemplateSummary = z.infer<typeof conversationTemplateSummarySchema>;

export const conversationTemplateVersionSchema = z
  .object({
    id: protocolIdSchema,
    templateId: protocolIdSchema,
    version: z.number().int().positive(),
    status: conversationTemplateVersionStatusSchema,
    contentHash: contentHashSchema,
    manifestHash: contentHashSchema,
    mcpConfigHash: contentHashSchema,
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    hostPolicyVersion: z.number().int().positive(),
    publishedByUserId: z.number().int().positive(),
    publishedAt: z.number().int().nonnegative()
  })
  .strict();
export type ConversationTemplateVersion = z.infer<typeof conversationTemplateVersionSchema>;

export const conversationTemplatePublishInputSchema = z
  .object({
    templateId: protocolIdSchema,
    draftRevision: z.number().int().positive(),
    requestId: protocolIdSchema
  })
  .strict();
export type ConversationTemplatePublishInput = z.infer<
  typeof conversationTemplatePublishInputSchema
>;

export const conversationTemplatePublishRequestSchema = z
  .object({
    templateId: protocolIdSchema,
    jobId: protocolIdSchema,
    draft: conversationTemplateDraftSchema,
    requestedByUserId: z.number().int().positive()
  })
  .strict()
  .superRefine((request, context) => {
    if (request.templateId !== request.draft.templateId)
      context.addIssue({
        code: 'custom',
        path: ['templateId'],
        message: 'publish template must match the draft'
      });
  });
export type ConversationTemplatePublishRequest = z.infer<
  typeof conversationTemplatePublishRequestSchema
>;

export const conversationTemplatePublishStatusInputSchema = z
  .object({
    templateId: protocolIdSchema,
    jobId: protocolIdSchema
  })
  .strict();
export type ConversationTemplatePublishStatusInput = z.infer<
  typeof conversationTemplatePublishStatusInputSchema
>;

export const conversationTemplatePublishJobSchema = z
  .object({
    id: protocolIdSchema,
    templateId: protocolIdSchema,
    draftRevision: z.number().int().positive(),
    stage: z.enum([
      'VALIDATING',
      'ENUMERATING',
      'COPYING',
      'SCANNING',
      'MANIFEST',
      'SEALED',
      'REGISTERED'
    ]),
    status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
    versionId: protocolIdSchema.optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable(),
    errorSummary: z.string().max(1000).optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((job, context) => {
    if (
      job.status === 'SUCCEEDED' &&
      (job.stage !== 'REGISTERED' || job.versionId === undefined || job.errorCode !== null)
    )
      context.addIssue({ code: 'custom', message: 'successful publish job is incomplete' });
    if (job.status === 'FAILED' && job.errorCode === null)
      context.addIssue({ code: 'custom', message: 'failed publish job requires an error code' });
    if (job.status !== 'FAILED' && job.errorCode !== null)
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'only failed publish jobs may have an error code'
      });
  });
export type ConversationTemplatePublishJob = z.infer<typeof conversationTemplatePublishJobSchema>;

export const conversationTemplatePublishResultSchema = z
  .object({
    job: conversationTemplatePublishJobSchema,
    version: conversationTemplateVersionSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.job.status === 'SUCCEEDED') {
      if (
        result.version === undefined ||
        result.version.id !== result.job.versionId ||
        result.version.templateId !== result.job.templateId ||
        result.version.status !== 'AVAILABLE'
      )
        context.addIssue({
          code: 'custom',
          path: ['version'],
          message: 'successful publish result requires its registered version'
        });
      return;
    }
    if (result.version !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['version'],
        message: 'unfinished publish result cannot include a version'
      });
  });
export type ConversationTemplatePublishResult = z.infer<
  typeof conversationTemplatePublishResultSchema
>;

export const hostedConversationStatusSchema = z.literal('ACTIVE');
export const hostedConversationActivityStatusSchema = z.enum([
  'STARTING',
  'RUNNING',
  'CANCELLING',
  'IDLE'
]);
export const hostedConversationActivitySchema = z
  .object({
    status: hostedConversationActivityStatusSchema,
    version: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();
export type HostedConversationActivity = z.infer<typeof hostedConversationActivitySchema>;

export const hostedConversationActivityProjectionSchema = z
  .object({
    userId: z.number().int().positive(),
    templateId: protocolIdSchema,
    conversationId: protocolIdSchema,
    activity: hostedConversationActivitySchema
  })
  .strict();
export type HostedConversationActivityProjection = z.infer<
  typeof hostedConversationActivityProjectionSchema
>;

export const hostedConversationActivityMessageSchema = z
  .object({
    type: z.literal('hosted-conversation.activity'),
    nodeId: protocolIdSchema,
    conversationId: protocolIdSchema,
    activity: hostedConversationActivitySchema
  })
  .strict();
export type HostedConversationActivityMessage = z.infer<
  typeof hostedConversationActivityMessageSchema
>;

const hostedConversationBaseObjectSchema = z
  .object({
    id: protocolIdSchema,
    nodeId: protocolIdSchema,
    sessionId: protocolIdSchema,
    templateId: protocolIdSchema,
    templateName: z.string().trim().min(1).max(128),
    activeVersionId: protocolIdSchema,
    title: z.string().trim().min(1).max(160),
    titleSource: z.enum(['DEFAULT', 'AUTO', 'CUSTOM']).default('CUSTOM'),
    pinnedAt: z.number().int().nonnegative().nullable(),
    status: hostedConversationStatusSchema,
    modelId: protocolIdSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lastActivityAt: z.number().int().nonnegative()
  })
  .strict();
export const hostedConversationSummarySchema = hostedConversationBaseObjectSchema
  .extend({
    activity: hostedConversationActivitySchema.default({
      status: 'IDLE',
      version: 0,
      updatedAt: 0
    })
  })
  .strict();
export type HostedConversationSummary = z.infer<typeof hostedConversationSummarySchema>;

export const hostedConversationManifestSchema = hostedConversationBaseObjectSchema
  .extend({
    userStorageKey: stableStorageKeySchema,
    conversationStorageKey: stableStorageKeySchema,
    clientRequestId: protocolIdSchema.optional(),
    templateDeleted: z.boolean(),
    quota: z
      .object({
        usedBytes: z.number().int().nonnegative(),
        maxBytes: z.number().int().positive()
      })
      .strict()
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.quota.usedBytes > manifest.quota.maxBytes)
      context.addIssue({ code: 'custom', path: ['quota'], message: 'quota is exceeded' });
  });
export type HostedConversationManifest = z.infer<typeof hostedConversationManifestSchema>;

export const conversationFileProjectionSchema = z
  .object({
    id: protocolIdSchema,
    conversationId: protocolIdSchema,
    category: z.enum(['UPLOAD', 'OUTPUT']),
    relativePath: conversationRelativePathSchema,
    displayName: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(255),
    size: z.number().int().nonnegative(),
    source: z.enum(['USER', 'AGENT', 'SYSTEM']),
    turnId: protocolIdSchema.optional(),
    itemId: protocolIdSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();
export type ConversationFileProjection = z.infer<typeof conversationFileProjectionSchema>;

export const hostedConversationSnapshotSchema = z
  .object({
    nodeAppVersion: z.string().trim().min(1).max(128).optional(),
    conversation: hostedConversationSummarySchema,
    template: conversationTemplateSummarySchema,
    run: z
      .object({
        id: protocolIdSchema,
        status: agentRunStatusSchema,
        startedAt: z.number().int().nonnegative().nullable(),
        completedAt: z.number().int().nonnegative().nullable()
      })
      .strict()
      .nullable(),
    turns: z.array(conversationTurnSchema),
    historyNextCursor: z.string().min(1).max(2048).nullable(),
    files: z.array(conversationFileProjectionSchema),
    models: z.array(marAgentNodeModelSummarySchema),
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
        message: z.string().min(1).max(1000)
      })
      .strict()
      .nullable(),
    snapshotSequence: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((snapshot, context) => {
    uniqueProtocolIds(
      snapshot.models.map((model) => model.id),
      context,
      ['models']
    );
  });
export type HostedConversationSnapshot = z.infer<typeof hostedConversationSnapshotSchema>;

export const hostedConversationCreateInputSchema = z
  .object({
    templateId: protocolIdSchema,
    clientRequestId: protocolIdSchema
  })
  .strict();
export type HostedConversationCreateInput = z.infer<typeof hostedConversationCreateInputSchema>;

export const hostedConversationListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(2048).optional()
  })
  .strict();
export type HostedConversationListInput = z.infer<typeof hostedConversationListInputSchema>;

export const hostedConversationListPageSchema = z
  .object({
    items: z.array(hostedConversationSummarySchema).max(100),
    nextCursor: z.string().min(1).max(2048).nullable()
  })
  .strict();
export type HostedConversationListPage = z.infer<typeof hostedConversationListPageSchema>;

export const hostedConversationDirectoryPageSchema = z
  .object({
    items: z.array(hostedConversationSummarySchema),
    nextCursor: z.string().min(1).max(2048).nullable()
  })
  .strict();
export type HostedConversationDirectoryPage = z.infer<typeof hostedConversationDirectoryPageSchema>;

export const hostedConversationIdInputSchema = z
  .object({
    conversationId: protocolIdSchema
  })
  .strict();
export type HostedConversationIdInput = z.infer<typeof hostedConversationIdInputSchema>;

export const hostedConversationHistoryInputSchema = hostedConversationIdInputSchema
  .extend({
    limit: z.number().int().min(1).max(100).default(10),
    cursor: z.string().min(1).max(2048).optional()
  })
  .strict();
export type HostedConversationHistoryInput = z.infer<typeof hostedConversationHistoryInputSchema>;

export const hostedConversationHistoryPageSchema = z
  .object({
    turns: z.array(conversationTurnSchema).max(100),
    nextCursor: z.string().min(1).max(2048).nullable()
  })
  .strict();
export type HostedConversationHistoryPage = z.infer<typeof hostedConversationHistoryPageSchema>;

export const hostedConversationRollbackInputSchema = hostedConversationIdInputSchema
  .extend({
    turnId: z.string().min(1).max(128),
    boundary: z.string().min(1).max(256).nullable()
  })
  .strict();
export type HostedConversationRollbackInput = z.infer<typeof hostedConversationRollbackInputSchema>;

export const runImageReadInputSchema = z.union([
  z.object({ runId: protocolIdSchema, imageIndex: z.number().int().nonnegative() }).strict(),
  z.object({ runId: protocolIdSchema, imageRef: imageRefSchema }).strict()
]);
export type RunImageReadInput = z.infer<typeof runImageReadInputSchema>;

export const hostedConversationImageReadInputSchema = hostedConversationIdInputSchema
  .extend({
    runId: protocolIdSchema,
    imageRef: imageRefSchema
  })
  .strict();
export type HostedConversationImageReadInput = z.infer<
  typeof hostedConversationImageReadInputSchema
>;

export const hostedConversationDeleteResultSchema = z
  .object({
    deletedConversationId: protocolIdSchema
  })
  .strict();
export type HostedConversationDeleteResult = z.infer<typeof hostedConversationDeleteResultSchema>;

export const hostedConversationMessageInputSchema = z
  .object({
    conversationId: protocolIdSchema,
    clientMessageId: protocolIdSchema,
    prompt: z.string().max(100_000),
    attachmentIds: z.array(protocolIdSchema).max(32).default([]),
    modelId: protocolIdSchema.optional(),
    deliveryIntent: z.literal('REPLACE_CURRENT').optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.prompt.trim().length === 0 && input.attachmentIds.length === 0)
      context.addIssue({ code: 'custom', message: 'message requires text or attachments' });
    uniqueProtocolIds(input.attachmentIds, context, ['attachmentIds']);
  });
export type HostedConversationMessageInput = z.infer<typeof hostedConversationMessageInputSchema>;

export const hostedConversationConfigUpdateInputSchema = z
  .object({
    conversationId: protocolIdSchema,
    modelId: protocolIdSchema
  })
  .strict();
export type HostedConversationConfigUpdateInput = z.infer<
  typeof hostedConversationConfigUpdateInputSchema
>;

export const hostedConversationMetadataUpdateInputSchema = z
  .object({
    conversationId: protocolIdSchema,
    title: z.string().trim().min(1).max(160).optional(),
    pinned: z.boolean().optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.title === undefined && input.pinned === undefined)
      context.addIssue({ code: 'custom', message: 'metadata update requires a change' });
  });
export type HostedConversationMetadataUpdateInput = z.infer<
  typeof hostedConversationMetadataUpdateInputSchema
>;

export const hostedConversationWatchInputSchema = z
  .object({
    conversationId: protocolIdSchema,
    mode: z.enum(['initial', 'renew']),
    workbenchConnectionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    watchId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)
  })
  .strict();
export type HostedConversationWatchInput = z.infer<typeof hostedConversationWatchInputSchema>;

export const hostedConversationUnwatchInputSchema = z
  .object({
    conversationId: protocolIdSchema,
    workbenchConnectionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    watchId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)
  })
  .strict();
export type HostedConversationUnwatchInput = z.infer<typeof hostedConversationUnwatchInputSchema>;

const hostedConversationUploadFileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(
        (name) =>
          name !== '.' &&
          name !== '..' &&
          !name.includes('/') &&
          !name.includes('\\') &&
          !name.includes('\0'),
        'upload name is invalid'
      ),
    size: z.number().int().nonnegative(),
    mimeType: z.string().trim().min(1).max(255)
  })
  .strict();

export const hostedConversationFilesSchema = z
  .object({
    files: z.array(conversationFileProjectionSchema)
  })
  .strict();
export type HostedConversationFiles = z.infer<typeof hostedConversationFilesSchema>;

export const hostedConversationFileReadInputSchema = hostedConversationIdInputSchema
  .extend({
    fileId: protocolIdSchema,
    offset: z.number().int().nonnegative().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024)
      .optional()
  })
  .strict();
export type HostedConversationFileReadInput = z.infer<typeof hostedConversationFileReadInputSchema>;

export const hostedConversationFileDeleteInputSchema = hostedConversationIdInputSchema
  .extend({
    fileId: protocolIdSchema
  })
  .strict();
export type HostedConversationFileDeleteInput = z.infer<
  typeof hostedConversationFileDeleteInputSchema
>;

export const hostedConversationFileDeleteResultSchema = z
  .object({
    deletedFileId: protocolIdSchema,
    files: z.array(conversationFileProjectionSchema)
  })
  .strict()
  .superRefine((result, context) => {
    uniqueProtocolIds(
      result.files.map((file) => file.id),
      context,
      ['files']
    );
    if (result.files.some((file) => file.id === result.deletedFileId))
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'deleted file cannot remain projected'
      });
  });
export type HostedConversationFileDeleteResult = z.infer<
  typeof hostedConversationFileDeleteResultSchema
>;

export const hostedConversationFileReadResultSchema = z
  .object({
    file: conversationFileProjectionSchema,
    encoding: z.literal('base64'),
    content: z.string().max(Math.ceil((512 * 1024 * 4) / 3) + 4),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    eof: z.boolean()
  })
  .strict()
  .superRefine((result, context) => {
    if (!canonicalBase64(result.content))
      context.addIssue({ code: 'custom', path: ['content'], message: 'file content is invalid' });
    if (result.nextOffset !== null && result.nextOffset <= result.offset)
      context.addIssue({
        code: 'custom',
        path: ['nextOffset'],
        message: 'next offset must advance'
      });
  });
export type HostedConversationFileReadResult = z.infer<
  typeof hostedConversationFileReadResultSchema
>;

export const hostedConversationUploadPreflightInputSchema = hostedConversationIdInputSchema
  .extend({
    files: z.array(hostedConversationUploadFileSchema).min(1).max(32)
  })
  .strict();
export type HostedConversationUploadPreflightInput = z.infer<
  typeof hostedConversationUploadPreflightInputSchema
>;

export const hostedConversationUploadPreflightResultSchema = z
  .object({
    files: z.array(
      z
        .object({
          name: hostedConversationUploadFileSchema.shape.name,
          status: z.enum(['READY', 'INVALID_NAME', 'TOO_LARGE', 'QUOTA_EXCEEDED', 'CONFLICT'])
        })
        .strict()
    )
  })
  .strict();
export type HostedConversationUploadPreflightResult = z.infer<
  typeof hostedConversationUploadPreflightResultSchema
>;

export const hostedConversationUploadCreateInputSchema = hostedConversationUploadFileSchema
  .extend({
    conversationId: protocolIdSchema,
    clientRequestId: protocolIdSchema
  })
  .strict();
export type HostedConversationUploadCreateInput = z.infer<
  typeof hostedConversationUploadCreateInputSchema
>;

export const hostedConversationUploadChunkInputSchema = hostedConversationIdInputSchema
  .extend({
    uploadId: protocolIdSchema,
    offset: z.number().int().nonnegative(),
    dataBase64: z
      .string()
      .min(4)
      .max(Math.ceil((512 * 1024 * 4) / 3) + 4)
      .refine(
        (value) => canonicalBase64(value) && base64DecodedByteLength(value) <= 512 * 1024,
        'upload chunk is invalid'
      )
  })
  .strict();
export type HostedConversationUploadChunkInput = z.infer<
  typeof hostedConversationUploadChunkInputSchema
>;

export const hostedConversationUploadControlInputSchema = hostedConversationIdInputSchema
  .extend({
    uploadId: protocolIdSchema
  })
  .strict();
export type HostedConversationUploadControlInput = z.infer<
  typeof hostedConversationUploadControlInputSchema
>;

export const hostedConversationUploadSchema = z
  .object({
    uploadId: protocolIdSchema,
    conversationId: protocolIdSchema,
    name: hostedConversationUploadFileSchema.shape.name,
    mimeType: hostedConversationUploadFileSchema.shape.mimeType,
    receivedBytes: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    status: z.enum(['UPLOADING', 'COMPLETED', 'CANCELLED']),
    file: conversationFileProjectionSchema.optional()
  })
  .strict()
  .superRefine((upload, context) => {
    if (upload.receivedBytes > upload.size)
      context.addIssue({
        code: 'custom',
        path: ['receivedBytes'],
        message: 'received bytes exceed upload size'
      });
    if (upload.status === 'COMPLETED' && upload.file === undefined)
      context.addIssue({
        code: 'custom',
        path: ['file'],
        message: 'completed upload requires a file'
      });
    if (upload.status !== 'COMPLETED' && upload.file !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['file'],
        message: 'unfinished upload cannot include a file'
      });
  });
export type HostedConversationUpload = z.infer<typeof hostedConversationUploadSchema>;

export const conversationSegmentSchema = z.object({
  id: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128).nullable(),
  index: z.number().int().nonnegative(),
  status: conversationTurnSchema.shape.status,
  rewind: conversationTurnSchema.shape.rewind,
  items: z.array(conversationItemSchema),
  startedAt: z.number().int().nonnegative().nullable(),
  completedAt: z.number().int().nonnegative().nullable()
});
export type ConversationSegment = z.infer<typeof conversationSegmentSchema>;

export const conversationSegmentPageSchema = z.object({
  unit: z.literal('SEGMENT'),
  segments: z.array(conversationSegmentSchema),
  nextCursor: z.string().max(4096).nullable(),
  snapshotSequence: z.number().int().nonnegative(),
  source: z.enum(['official', 'native', 'runtime']),
  readAt: z.number().int().nonnegative(),
  latestVisibleAt: z.number().int().nonnegative(),
  deferredOlderHistory: z.boolean().optional()
});
export type ConversationSegmentPage = z.infer<typeof conversationSegmentPageSchema>;

export const conversationItemDeltaSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assistant_text_append'),
    itemId: z.string().min(1).max(128),
    itemRevision: z.number().int().nonnegative(),
    text: z.string()
  }),
  z.object({
    kind: z.literal('plan_replace'),
    itemId: z.string().min(1).max(128),
    itemRevision: z.number().int().nonnegative(),
    steps: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED'])
      })
    )
  }),
  z.object({
    kind: z.literal('tool_progress_replace'),
    itemId: z.string().min(1).max(128),
    itemRevision: z.number().int().nonnegative(),
    label: z.string().max(500)
  })
]);
export type ConversationItemDelta = z.infer<typeof conversationItemDeltaSchema>;

export const terminalDataFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attach'),
    terminalId: z.string().min(1).max(128),
    afterSequence: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal('resize'),
    terminalId: z.string().min(1).max(128),
    rows: z.number().int().positive().max(1000),
    cols: z.number().int().positive().max(1000)
  }),
  z.object({
    type: z.literal('input'),
    terminalId: z.string().min(1).max(128),
    data: z.string().max(65536)
  }),
  z.object({
    type: z.literal('output'),
    terminalId: z.string().min(1).max(128),
    sequence: z.number().int().positive(),
    data: z.string().max(65536)
  }),
  z.object({ type: z.literal('close'), terminalId: z.string().min(1).max(128) }),
  z.object({
    type: z.literal('exit'),
    terminalId: z.string().min(1).max(128),
    exitCode: z.number().int().nullable()
  }),
  z.object({
    type: z.literal('error'),
    terminalId: z.string().min(1).max(128),
    code: z.string().min(1).max(80)
  })
]);
export type TerminalDataFrame = z.infer<typeof terminalDataFrameSchema>;

export const terminalAttachTicketSchema = z
  .object({
    ticket: z.string().min(32).max(512),
    nodeId: z.string().min(1).max(128),
    terminalId: z.string().min(1).max(128),
    userSessionFingerprint: z.string().min(1).max(128),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive()
  })
  .superRefine((value, context) => {
    if (value.expiresAt <= value.issuedAt) {
      context.addIssue({ code: 'custom', message: 'terminal ticket expiry must follow issuance' });
    }
  });
export type TerminalAttachTicket = z.infer<typeof terminalAttachTicketSchema>;

export const workspaceFileEntrySchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(512),
  kind: z.enum(['FILE', 'DIRECTORY']),
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: z.number().int().nonnegative().nullable(),
  score: z.number().min(0).max(256_000).optional()
});
export const workspaceFileListSchema = z.object({
  entries: z.array(workspaceFileEntrySchema),
  nextCursor: z.string().min(1).max(1024).nullable(),
  truncated: z.boolean(),
  indexState: z.enum(['BUILDING', 'READY']).optional()
});
export const workspaceContentMatchSchema = z.object({
  path: z.string().min(1).max(4096),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  preview: z.string().max(8192)
});
export const workspaceContentSearchSchema = z.object({
  matches: z.array(workspaceContentMatchSchema).max(200),
  engine: z.enum(['RIPGREP', 'GREP', 'POWERSHELL', 'NODE']),
  truncated: z.boolean(),
  skippedFiles: z.number().int().nonnegative()
});
export type WorkspaceContentMatch = z.infer<typeof workspaceContentMatchSchema>;
export type WorkspaceContentSearch = z.infer<typeof workspaceContentSearchSchema>;
export const workspaceFileReferenceSourceContextSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .refine((value) => utf8ByteLength(value) <= 8 * 1024),
    position: z.number().int().nonnegative()
  })
  .strict();
export const workspaceFileReferenceSchema = z
  .object({
    languageId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    extractorId: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u),
    kind: z.enum(['relative-file', 'module', 'namespace', 'include']),
    anchor: z.string().min(1).max(1024).optional(),
    value: z.string().min(1).max(1024),
    from: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
    to: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    sourceContext: workspaceFileReferenceSourceContextSchema
  })
  .strict()
  .refine((reference) => reference.to > reference.from);
export type WorkspaceFileReference = z.infer<typeof workspaceFileReferenceSchema>;
export const workspaceSymbolDefinitionTargetSchema = z.object({
  path: z.string().min(1).max(4096),
  line: z.number().int().positive(),
  kind: z.string().min(1).max(128).optional(),
  scope: z.string().min(1).max(1024).optional(),
  preview: z.string().min(1).max(512).optional()
});
export const workspaceSymbolReferenceSchema = z.object({
  path: z.string().min(1).max(4096),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  preview: z.string().min(1).max(8192)
});
export const workspaceSymbolDefinitionSchema = z.object({
  state: z.enum(['UNAVAILABLE', 'BUILDING', 'READY', 'STALE', 'FAILED']),
  targets: z.array(workspaceSymbolDefinitionTargetSchema).max(20),
  references: z.array(workspaceSymbolReferenceSchema).max(100).default([]),
  referenceTruncated: z.boolean().default(false),
  paths: z.array(workspaceSymbolDefinitionTargetSchema).max(20).default([]),
  truncated: z.boolean(),
  failureCode: z.enum(['SYMBOL_INDEX_BUILD_FAILED', 'SYMBOL_INDEX_LIMIT_EXCEEDED']).optional()
});
export type WorkspaceSymbolDefinitionTarget = z.infer<typeof workspaceSymbolDefinitionTargetSchema>;
export type WorkspaceSymbolReference = z.infer<typeof workspaceSymbolReferenceSchema>;
export type WorkspaceSymbolDefinition = z.infer<typeof workspaceSymbolDefinitionSchema>;
export const workspaceSymbolIndexPreparationSchema = z
  .object({
    state: z.enum(['UNAVAILABLE', 'BUILDING', 'READY', 'STALE', 'FAILED']),
    failureCode: z.enum(['SYMBOL_INDEX_BUILD_FAILED', 'SYMBOL_INDEX_LIMIT_EXCEEDED']).optional()
  })
  .strict();
export type WorkspaceSymbolIndexPreparation = z.infer<typeof workspaceSymbolIndexPreparationSchema>;
export const workspaceFileReadSchema = z.object({
  path: z.string().min(1).max(4096),
  encoding: z.enum(['utf-8', 'base64']),
  size: z.number().int().nonnegative(),
  content: z.string(),
  truncated: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable()
});
export const workspaceUploadPreflightSchema = z.object({
  name: z.string().min(1).max(512),
  status: z.enum(['READY', 'EXISTS_FILE', 'EXISTS_DIRECTORY', 'INVALID_NAME']),
  path: z.string().min(1).max(4096).nullable()
});
export const workspaceUploadSchema = z.object({
  uploadId: z.string().uuid(),
  path: z.string().min(1).max(4096),
  receivedBytes: z.number().int().nonnegative(),
  size: z.number().int().nonnegative()
});
export const workspaceChangeSchema = z.object({
  path: z.string().min(1).max(4096),
  state: z.enum(['STAGED', 'UNSTAGED', 'UNTRACKED']),
  change: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'TYPE_CHANGED']),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
  diffAvailable: z.boolean()
});
export type WorkspaceFileEntry = z.infer<typeof workspaceFileEntrySchema>;
export type WorkspaceFileList = z.infer<typeof workspaceFileListSchema>;
export type WorkspaceFileRead = z.infer<typeof workspaceFileReadSchema>;
export type WorkspaceUploadPreflight = z.infer<typeof workspaceUploadPreflightSchema>;
export type WorkspaceUpload = z.infer<typeof workspaceUploadSchema>;
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;
export const workspaceGitWorktreeSummarySchema = z
  .object({
    directoryName: z.string().trim().min(1).max(512),
    branch: z.string().min(1).max(512).nullable(),
    head: z.string().regex(/^[0-9a-f]{40,64}$/),
    current: z.boolean(),
    status: z.enum(['CLEAN', 'DIRTY', 'UNAVAILABLE']),
    locked: z.boolean(),
    prunable: z.boolean()
  })
  .strict();
export type WorkspaceGitWorktreeSummary = z.infer<typeof workspaceGitWorktreeSummarySchema>;
export const workspaceGitTrackingSchema = z.object({
  upstream: z.string().min(1).max(512),
  ahead: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  behind: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
});
export type WorkspaceGitTracking = z.infer<typeof workspaceGitTrackingSchema>;

export const workspaceChangesRepositorySchema = z
  .object({
    repositoryPath: z.string().max(4096),
    repositoryName: z.string().min(1).max(512),
    source: z.enum(['ROOT', 'SUBMODULE', 'WORKTREE']),
    worktreePath: z.string().min(1).max(4096).optional(),
    physicalPath: z.string().min(1).max(4096).optional(),
    current: z.boolean().optional(),
    branch: z.string().max(512).nullable(),
    tracking: workspaceGitTrackingSchema.optional(),
    head: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional(),
    status: z.enum(['CLEAN', 'DIRTY', 'UNAVAILABLE']).optional(),
    locked: z.boolean().optional(),
    prunable: z.boolean().optional(),
    error: z.lazy(() => publicErrorSchema).optional(),
    changes: z.array(workspaceChangeSchema)
  })
  .superRefine((repository, context) => {
    if (repository.source === 'SUBMODULE') {
      if (repository.repositoryPath.length === 0 || repository.worktreePath !== undefined)
        context.addIssue({ code: 'custom', message: 'Invalid submodule repository target' });
      return;
    }
    if (
      repository.repositoryPath.length !== 0 ||
      repository.physicalPath === undefined ||
      repository.current === undefined ||
      repository.status === undefined ||
      repository.locked === undefined ||
      repository.prunable === undefined
    )
      context.addIssue({ code: 'custom', message: 'Incomplete worktree repository metadata' });
    if (repository.source === 'ROOT') {
      if (repository.worktreePath !== undefined || repository.current !== true)
        context.addIssue({ code: 'custom', message: 'Invalid root repository target' });
      return;
    }
    if (
      repository.worktreePath === undefined ||
      repository.current !== false ||
      repository.head === undefined
    )
      context.addIssue({ code: 'custom', message: 'Invalid linked worktree repository target' });
  });
export type WorkspaceChangesRepository = z.infer<typeof workspaceChangesRepositorySchema>;
export const workspaceChangesSummarySchema = z.object({
  branch: z.string().max(512).nullable(),
  changes: z.array(workspaceChangeSchema),
  repositories: z.array(workspaceChangesRepositorySchema),
  worktrees: z.array(workspaceGitWorktreeSummarySchema).max(128).optional(),
  worktreesTruncated: z.boolean().optional(),
  partial: z.boolean().optional(),
  errors: z
    .array(z.lazy(() => publicErrorSchema))
    .max(16)
    .optional()
});
export type WorkspaceChangesSummary = z.infer<typeof workspaceChangesSummarySchema>;

export const gitHistoryRefSchema = z.object({
  name: z.string().min(1).max(512),
  displayName: z.string().min(1).max(512),
  kind: z.enum(['LOCAL', 'REMOTE']),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/),
  current: z.boolean()
});
export type GitHistoryRef = z.infer<typeof gitHistoryRefSchema>;
export const gitHistoryCommitSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/),
  parents: z.array(z.string().regex(/^[0-9a-f]{40,64}$/)),
  subject: z.string().max(4096),
  authorName: z.string().max(512),
  authorEmail: z.string().max(512),
  committedAt: z.number().int().nonnegative(),
  refs: z.array(z.string().min(1).max(512))
});
export type GitHistoryCommit = z.infer<typeof gitHistoryCommitSchema>;
export const gitHistoryFileSchema = z.object({
  path: z.string().min(1).max(4096),
  previousPath: z.string().min(1).max(4096).optional(),
  change: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'TYPE_CHANGED'])
});
export type GitHistoryFile = z.infer<typeof gitHistoryFileSchema>;

export const workbenchNodeOperationSchema = z.enum([
  'workspace.git.settings.get',
  'workspace.git.settings.update',
  'node.workbench.capabilities',
  'runner.usage.status',
  'runner.usage.read',
  'workspace.directories.list',
  'workspace.remove',
  'workspace.watch',
  'workspace.unwatch',
  'session.unwatch',
  'session.metadata.update',
  'session.schedule.get',
  'session.schedule.list',
  'session.schedule.agent.save',
  'session.cli.context',
  'session.graph',
  'session.goal.get',
  'session.schedule.save',
  'session.schedule.remove',
  'session.schedule.proposal.resolve',
  'session.pin.move',
  'session.rewind',
  'session.rollback',
  'session.remove',
  'workspace.sessions.cleanup',
  'session.config.update',
  'session.turns.list',
  'session.events.read',
  'session.context.read',
  'session.tool-resource.read',
  'session.command.execute',
  'runner.command.execute',
  'runner.profiles.list',
  'runner.defaults.save',
  'mar-agent.model.test',
  'prompt-completion.context',
  'prompt-completion.generate',
  'prompt-completion.cancel',
  'workspace.files.list',
  'workspace.file.read',
  'workspace.file.write',
  'workspace.file.content.read',
  'workspace.file.direct.metadata',
  'workspace.files.search',
  'workspace.files.mutate',
  'workspace.content.search',
  'workspace.symbol.prepare',
  'workspace.symbol.definition',
  'workspace.files.upload.preflight',
  'workspace.files.upload.create',
  'workspace.files.upload.chunk',
  'workspace.files.upload.status',
  'workspace.files.upload.complete',
  'workspace.files.upload.cancel',
  'workspace.changes.current',
  'workspace.change.diff',
  'workspace.change.restore',
  'workspace.git.refs.list',
  'workspace.git.history.list',
  'workspace.git.commit.files',
  'workspace.git.commit.file.diff',
  'workspace.git.commit.file.content.read',
  'workspace.git.commit.file.direct.metadata',
  'run.image.read',
  'terminal.open',
  'terminal.command.open',
  'terminal.list',
  'terminal.close',
  'terminal.attach.authorize',
  'terminal.direct.preflight',
  'node.upgrade.request',
  'node.upgrade.cancel',
  'node.skills.inspect',
  'node.skills.install',
  'node.skills.remove',
  'workspace.skills.inspect',
  'workspace.skills.install',
  'workspace.skills.remove',
  'workspace.skills.git-exclude-repair',
  'skill.install.job.get',
  'node.mcps.inspect',
  'node.mcps.install',
  'node.mcps.remove',
  'workspace.mcps.inspect',
  'workspace.mcps.install',
  'workspace.mcps.remove',
  'conversation.template.source.inspect',
  'conversation.template.publish',
  'conversation.template.publish.status',
  'conversation.template.version.inspect',
  'conversation.hosting.enable',
  'conversation.hosting.disable',
  'conversation.hosting.storage.inspect',
  'conversation.hosting.cleanup.preview',
  'conversation.hosting.cleanup.execute',
  'computer.use.enable',
  'computer.use.disable',
  'conversation.hosted.list',
  'conversation.hosted.create',
  'conversation.hosted.get',
  'conversation.hosted.history',
  'conversation.hosted.watch',
  'conversation.hosted.unwatch',
  'conversation.hosted.message',
  'conversation.hosted.rollback',
  'conversation.hosted.interrupt',
  'conversation.hosted.config.update',
  'conversation.hosted.metadata.update',
  'conversation.hosted.image.read',
  'conversation.hosted.tool-resource.read',
  'conversation.hosted.files.list',
  'conversation.hosted.file.read',
  'conversation.hosted.file.delete',
  'conversation.hosted.files.upload.preflight',
  'conversation.hosted.files.upload.create',
  'conversation.hosted.files.upload.chunk',
  'conversation.hosted.files.upload.status',
  'conversation.hosted.files.upload.complete',
  'conversation.hosted.files.upload.cancel',
  'conversation.hosted.delete'
]);
export type WorkbenchNodeOperation = z.infer<typeof workbenchNodeOperationSchema>;

/**
 * A small, explicit envelope keeps WebSocket messages independently parseable
 * and makes it safe to reject future message kinds without guessing payloads.
 */
export const nodeEnvelopeSchema = z.object({
  version: z.literal(NODE_PROTOCOL_VERSION),
  id: z.string().min(1).max(128),
  type: z.string().min(1).max(80),
  replyTo: z.string().min(1).max(128).optional(),
  payload: z.unknown()
});
export type NodeEnvelope = z.infer<typeof nodeEnvelopeSchema>;

const APPLICATION_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const PUBLIC_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;

/** Accept bounded structured upstream codes without changing their case. */
export function isPublicErrorCode(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_ERROR_CODE.test(value);
}
const publicErrorTextSchema = z.string().trim().min(1).max(1_000);
const publicErrorParameterKeySchema = z.string().trim().min(1).max(128);
const publicErrorParametersSchema = z
  .record(publicErrorParameterKeySchema, z.union([z.string().max(1_000), z.number().finite()]))
  .superRefine((parameters, context) => {
    if (Object.keys(parameters).length > 32)
      context.addIssue({ code: 'custom', message: 'too many public error parameters' });
  });
export const publicErrorSchema = z
  .object({
    code: z.string().regex(PUBLIC_ERROR_CODE),
    message: publicErrorTextSchema,
    details: publicErrorTextSchema.optional(),
    parameters: publicErrorParametersSchema.optional()
  })
  .strict();
export type PublicError = z.infer<typeof publicErrorSchema>;
export const nodeResponseErrorPayloadSchema = z
  .object({
    error: z.string().regex(PUBLIC_ERROR_CODE),
    message: publicErrorTextSchema,
    details: publicErrorTextSchema.optional(),
    parameters: publicErrorParametersSchema.optional()
  })
  .strict();
export type NodeResponseErrorPayload = z.infer<typeof nodeResponseErrorPayloadSchema>;
export const httpErrorResponseSchema = z
  .object({
    error: publicErrorSchema
      .extend({
        requestId: z.string().min(1).max(128),
        upstreamRequestId: z.string().min(1).max(128).optional()
      })
      .strict()
  })
  .strict();
export type HttpErrorResponse = z.infer<typeof httpErrorResponseSchema>;

const ERROR_SUBJECT_WORDS: Readonly<Record<string, string>> = {
  API: 'API',
  APP: 'app',
  CLI: 'CLI',
  CODEX: 'Codex',
  CSRF: 'CSRF',
  GIT: 'Git',
  HTTP: 'HTTP',
  HTTPS: 'HTTPS',
  ID: 'ID',
  JSON: 'JSON',
  JSONL: 'JSONL',
  MAR: 'MAR',
  MCP: 'MCP',
  MYSQL: 'MySQL',
  NODE: 'Node',
  OAUTH: 'OAuth',
  RPC: 'RPC',
  SDK: 'SDK',
  SQL: 'SQL',
  SQLITE: 'SQLite',
  URL: 'URL',
  UUID: 'UUID',
  WEBSOCKET: 'WebSocket',
  WORKBENCH: 'Workbench',
  WORKSPACE: 'Workspace'
};
const FIXED_PUBLIC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  SESSION_RESTART_PENDING:
    'This session is being restored after a system restart. Wait before changing it.',
  NODE_STOPPED: 'This Node has stopped and cannot accept new operations.',
  GIT_CONFIGURATION_INVALID:
    'Check the Git identity, credential fields, and unique matching scopes.',
  GIT_CREDENTIAL_NOT_FOUND: 'This personal Git credential no longer exists.',
  GIT_CONFIGURATION_NODE_UNSUPPORTED: 'Update this Node to use personal Git configuration.',
  GIT_CREDENTIAL_CONTEXT_EXPIRED:
    'This Git credential context has expired. Start a new terminal or Agent execution.',
  GIT_CREDENTIAL_DIRECTORY_INVALID:
    'A private directory for Git keys could not be secured on this Node.',
  TERMINAL_GIT_OWNER_REQUIRED:
    'This terminal uses another user’s Git credentials. Open your own terminal.',
  TERMINAL_OWNER_REQUIRED: 'This terminal belongs to another user. Open your own terminal.',
  TERMINAL_COMMAND_INVALID: 'The remote command must be non-empty and at most 8 KiB.',
  TERMINAL_COMMAND_START_FAILED: 'The remote command could not be started.',
  EXTERNAL_SESSION_ACTIVE:
    'This native session is currently active in another client. Try again later.',
  RUNNER_RESUME_FAILED: 'The native session could not be activated. Try again later.',
  SESSION_ACTIVATION_REQUIRED: 'Send a regular message before using this session command.',
  SESSION_PROMPT_INVALID:
    'Session Prompt must be text of at most 20,000 characters, or null to clear.',
  GIT_ENVIRONMENT_INVALID:
    'The existing Git process configuration is invalid or exceeds its supported size.',
  INTERNAL_ERROR: 'An internal error occurred.',
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'Access is forbidden.',
  INVALID_CREDENTIALS: 'Credentials are invalid.',
  GIT_SUBMODULE_MAPPING_MISSING:
    'This directory is tracked as a submodule, but .gitmodules has no complete path and URL mapping.',
  GIT_SUBMODULE_MAPPING_INVALID: 'The .gitmodules configuration cannot be read or parsed.',
  GIT_REPOSITORY_UNREADABLE:
    'This repository cannot be read. Check its directory, Git metadata, and permissions.',
  GIT_SUBMODULE_DISCOVERY_FAILED:
    'Some submodules could not be listed. Other available repository changes are still shown.',
  GIT_WORKTREE_DISCOVERY_FAILED:
    'Linked worktrees could not be listed. Other available repository changes are still shown.',
  GIT_SUBMODULE_LIMIT_EXCEEDED:
    'The submodule discovery limit was reached. Some repositories are not shown.'
};

function publicErrorSubject(code: string): string {
  return code
    .split('_')
    .filter((word) => word.length > 0)
    .map((word, index) => {
      const fixed = ERROR_SUBJECT_WORDS[word];
      if (fixed !== undefined) return fixed;
      const lower = word.toLowerCase();
      return index === 0 ? `${lower[0]?.toUpperCase() ?? ''}${lower.slice(1)}` : lower;
    })
    .join(' ');
}

/** Generates a readable English fallback for every stable application error code. */
export function publicErrorMessage(code: string): string {
  const safeCode = isPublicErrorCode(code) ? code.toUpperCase() : 'INTERNAL_ERROR';
  const fixed = FIXED_PUBLIC_ERROR_MESSAGES[safeCode];
  if (fixed !== undefined) return fixed;
  const endings = [
    ['_ALREADY_EXISTS', 'already exists.'],
    ['_ALREADY_DECIDED', 'has already been decided.'],
    ['_NOT_FOUND', 'was not found.'],
    ['_NOT_AUTHORIZED', 'is not authorized.'],
    ['_NOT_ALLOWED', 'is not allowed.'],
    ['_NOT_PUBLISHED', 'is not published.'],
    ['_LIMIT_EXCEEDED', 'limit was exceeded.'],
    ['_LIMIT_REACHED', 'limit was reached.'],
    ['_RATE_LIMITED', 'is rate limited.'],
    ['_TOO_LARGE', 'is too large.'],
    ['_IN_USE', 'is in use.'],
    ['_UNAVAILABLE', 'is unavailable.'],
    ['_UNSUPPORTED', 'is unsupported.'],
    ['_UNAUTHENTICATED', 'is unauthenticated.'],
    ['_FORBIDDEN', 'is forbidden.'],
    ['_REQUIRED', 'is required.'],
    ['_INVALID', 'is invalid.'],
    ['_EXPIRED', 'has expired.'],
    ['_DISABLED', 'is disabled.'],
    ['_OFFLINE', 'is offline.'],
    ['_CONFLICT', 'conflicts with the current state.'],
    ['_TIMEOUT', 'timed out.'],
    ['_TIMED_OUT', 'timed out.'],
    ['_FAILED', 'failed.'],
    ['_CANCELLED', 'was cancelled.'],
    ['_CLOSED', 'is closed.'],
    ['_BUSY', 'is busy.'],
    ['_FULL', 'is full.'],
    ['_STALE', 'is stale.'],
    ['_MISSING', 'is missing.'],
    ['_IMMUTABLE', 'is immutable.'],
    ['_MISMATCH', 'does not match.'],
    ['_VIOLATION', 'was violated.'],
    ['_UNKNOWN', 'is unknown.'],
    ['_DENIED', 'was denied.'],
    ['_ERROR', 'encountered an error.']
  ] as const;
  for (const [ending, predicate] of endings) {
    if (!safeCode.endsWith(ending)) continue;
    const subject = publicErrorSubject(safeCode.slice(0, -ending.length));
    return subject.length > 0 ? `${subject} ${predicate}` : publicErrorSubject(safeCode) + '.';
  }
  return `${publicErrorSubject(safeCode)}.`;
}

/** Builds the bounded public error shape shared by Node and Server boundaries. */
export function safePublicError(error: unknown, fallback = 'INTERNAL_ERROR'): PublicError {
  const record = publicErrorRecord(error);
  const code =
    error instanceof Error && APPLICATION_ERROR_CODE.test(error.message)
      ? error.message
      : isPublicErrorCode(record?.['code'])
        ? record['code']
        : isPublicErrorCode(fallback)
          ? fallback
          : 'INTERNAL_ERROR';
  const fallbackMessage = publicErrorMessage(code);
  const requestedMessage = boundedPublicErrorText(record?.['publicMessage']);
  const message = requestedMessage ?? fallbackMessage;
  const details =
    boundedPublicErrorText(record?.['publicDetails']) ??
    (error instanceof Error && error.message !== code
      ? boundedPublicErrorText(error.message)
      : undefined) ??
    publicErrorCauseDetails(record?.['cause']);
  const parameters = boundedPublicErrorParameters(
    record?.['publicParameters'] ?? record?.['parameters']
  );
  return {
    code,
    message,
    ...(details === undefined ? {} : { details }),
    ...(parameters === undefined ? {} : { parameters })
  };
}

function publicErrorRecord(error: unknown): Record<string, unknown> | undefined {
  return error !== null && typeof error === 'object'
    ? (error as Record<string, unknown>)
    : undefined;
}

function boundedPublicErrorText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.includes('\0') ? undefined : trimmed.slice(0, 1_000);
}

function publicErrorCauseDetails(value: unknown): string | undefined {
  const cause = publicErrorRecord(value);
  if (cause === undefined) return undefined;
  return boundedPublicErrorText(cause['publicDetails']) ?? boundedPublicErrorText(cause['message']);
}

function boundedPublicErrorParameters(
  value: unknown
): Readonly<Record<string, string | number>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key.trim().length > 0 && key.length <= 128 && !key.includes('\0'))
    .flatMap(([key, item]): Array<[string, string | number]> => {
      if (typeof item === 'number' && Number.isFinite(item)) return [[key, item]];
      const text = boundedPublicErrorText(item);
      return text === undefined ? [] : [[key, text]];
    })
    .slice(0, 32);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export const nodeErrorSchema = z.object({
  code: z.enum([
    'PROTOCOL_VERSION_UNSUPPORTED',
    'MESSAGE_TYPE_UNKNOWN',
    'MESSAGE_INVALID',
    'NODE_UNAUTHENTICATED',
    'NODE_DISABLED',
    'REGISTRATION_TOKEN_INVALID',
    'WORKSPACE_INVALID',
    'RUN_NOT_FOUND',
    'RUN_STATE_INVALID',
    'RUN_LOST',
    'APPROVAL_NOT_FOUND',
    'APPROVAL_EXPIRED',
    'APPROVAL_ALREADY_DECIDED',
    'APPROVAL_ALREADY_EXISTS',
    'WORKBENCH_PROTOCOL_UNSUPPORTED',
    'CAPABILITY_UNAVAILABLE',
    'CAPABILITY_VERSION_UNSUPPORTED',
    'CAPABILITY_STALE',
    'EVENT_CURSOR_INVALID',
    'EVENT_CURSOR_GAP',
    'ITEM_REVISION_CONFLICT',
    'RUNNER_PROFILE_INVALID',
    'RUNNER_COMMAND_UNSUPPORTED',
    'FILE_NOT_FOUND',
    'FILE_NOT_REGULAR',
    'FILE_TOO_LARGE',
    'FILE_ENCODING_UNSUPPORTED',
    'FILE_PATH_ESCAPE',
    'DIRECTORY_CURSOR_INVALID',
    'FILE_SEARCH_LIMIT_EXCEEDED',
    'GIT_CHANGE_RESTORE_UNAVAILABLE',
    'TERMINAL_UNAVAILABLE',
    'TERMINAL_LIMIT_REACHED',
    'TERMINAL_NOT_FOUND',
    'TERMINAL_ATTACH_CONFLICT',
    'TERMINAL_REPLAY_GAP',
    'TERMINAL_DATA_CHANNEL_UNAVAILABLE',
    'SKILL_TARGET_OFFLINE',
    'SKILL_TARGET_LIMIT_EXCEEDED',
    'SKILL_NAME_CONFLICT',
    'SKILL_PATH_UNSAFE',
    'SKILL_CONTENT_INVALID',
    'SKILL_INSTALL_PARTIAL',
    'SKILL_INSTALL_FAILED',
    'SKILL_INSTALL_VERSION_UNKNOWN',
    'SKILL_INSTALL_RECOVERY_REQUIRED',
    'SKILL_INSTALL_INVALID_LINK',
    'NODE_SKILL_LINK_UNAVAILABLE',
    'WORKSPACE_SKILL_GIT_EXCLUDE_FAILED',
    'WORKSPACE_SKILL_TRACKED_CONFIRM_REQUIRED',
    'CONVERSATION_HOSTING_UNAVAILABLE',
    'CONVERSATION_HOSTING_STORAGE_FULL',
    'CONVERSATION_TEMPLATE_NOT_FOUND',
    'CONVERSATION_TEMPLATE_NOT_AUTHORIZED',
    'CONVERSATION_TEMPLATE_NOT_PUBLISHED',
    'CONVERSATION_TEMPLATE_REVISION_CONFLICT',
    'CONVERSATION_TEMPLATE_VERSION_CORRUPTED',
    'HOSTED_CONVERSATION_NOT_FOUND',
    'HOSTED_CONVERSATION_NOT_AUTHORIZED',
    'HOSTED_CONVERSATION_UPGRADE_FAILED',
    'HOSTED_CONVERSATION_QUOTA_EXCEEDED',
    'HOSTED_CONVERSATION_FILE_INVALID',
    'HOSTED_CONVERSATION_FILE_NOT_FOUND',
    'HOSTED_CONVERSATION_FILE_CONFLICT',
    'SANDBOX_UNAVAILABLE',
    'SANDBOX_POLICY_INVALID',
    'SANDBOX_RESOURCE_LIMIT',
    'INTERNAL_ERROR'
  ])
});

export function createEnvelope(
  type: string,
  payload: unknown,
  options: { id?: string; replyTo?: string } = {}
): NodeEnvelope {
  return {
    version: NODE_PROTOCOL_VERSION,
    id: options.id ?? crypto.randomUUID(),
    type,
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    payload
  };
}
