import { z } from 'zod';

export const MODEL_USAGE_VERSION = 1;
export const MODEL_USAGE_RETENTION_MS = 90 * 86_400_000;
export const MODEL_USAGE_OUTBOX_RETENTION_MS = 7 * 86_400_000;
export const MODEL_USAGE_BATCH_LIMIT = 64;
export const MODEL_USAGE_BATCH_BYTES = 262_144;
const identifier = z.string().min(1).max(256);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const usageCountSchema = z.string().regex(/^(0|[1-9][0-9]{0,37})$/);
export const usageRunnerSchema = z.enum(['mar-agent', 'codex', 'claude-code', 'opencode']);
export const usagePurposeSchema = z.enum([
  'conversation',
  'compact',
  'title',
  'prompt_completion',
  'other'
]);
export const modelUsageCapabilitySchema = z.object({ apiVersion: z.literal(1) }).strict();

/** A non-executable assertion, signed and verified only by the Server. */
export const modelUsageGrantClaimsSchema = z
  .object({
    audience: z.literal('model-usage-v1'),
    scopeId: z.string().uuid(),
    nodeId: identifier,
    userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mode: z.enum(['work', 'conversation']),
    issuedAt: time,
    expiresAt: time
  })
  .strict();
export const modelUsageGrantSchema = z
  .object({
    scopeId: z.string().uuid(),
    token: z.string().min(1).max(2048)
  })
  .strict();
export type ModelUsageGrant = z.infer<typeof modelUsageGrantSchema>;
export type ModelUsageGrantClaims = z.infer<typeof modelUsageGrantClaimsSchema>;

export const modelUsageRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordId: identifier,
    requestId: identifier,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    scopeId: z.string().uuid(),
    runner: usageRunnerSchema,
    sessionId: identifier,
    runId: identifier,
    modelConfigurationId: identifier.optional(),
    modelName: identifier.optional(),
    provider: identifier.optional(),
    requestedModel: identifier.optional(),
    actualModel: identifier.optional(),
    responseId: identifier.optional(),
    purpose: usagePurposeSchema,
    agentRole: z.enum(['root', 'subagent']),
    startedAt: time,
    endedAt: time.optional(),
    state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    inputTokens: usageCountSchema.optional(),
    outputTokens: usageCountSchema.optional(),
    cacheReadTokens: usageCountSchema.optional(),
    cacheWriteTokens: usageCountSchema.optional(),
    reasoningTokens: usageCountSchema.optional(),
    coverage: z.enum(['request', 'partial']).default('request')
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.state === 'running') !== (record.endedAt === undefined))
      context.addIssue({ code: 'custom', message: 'Usage outcome and end time do not match.' });
    if (record.endedAt !== undefined && record.endedAt < record.startedAt)
      context.addIssue({ code: 'custom', message: 'Usage end time precedes its start.' });
  });
export type ModelUsageRecord = z.infer<typeof modelUsageRecordSchema>;
export const modelUsageBatchSchema = z
  .object({
    apiVersion: z.literal(1),
    entries: z
      .array(z.object({ grant: modelUsageGrantSchema, record: modelUsageRecordSchema }).strict())
      .min(1)
      .max(MODEL_USAGE_BATCH_LIMIT)
  })
  .strict();
export type ModelUsageBatch = z.infer<typeof modelUsageBatchSchema>;
export const modelUsageAckSchema = z
  .object({
    apiVersion: z.literal(1),
    results: z
      .array(
        z
          .object({
            recordId: identifier,
            revision: z.number().int().positive(),
            status: z.enum(['accepted', 'rejected']),
            code: z
              .enum([
                'USAGE_GRANT_INVALID',
                'USAGE_EXPIRED',
                'USAGE_USER_DELETED',
                'USAGE_CONFLICT',
                'USAGE_TIME_INVALID'
              ])
              .optional()
          })
          .strict()
      )
      .max(MODEL_USAGE_BATCH_LIMIT)
  })
  .strict();
export type ModelUsageAck = z.infer<typeof modelUsageAckSchema>;

export const personalUsageQuerySchema = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    runner: usageRunnerSchema.optional(),
    model: z.string().min(1).max(800).optional(),
    mode: z.enum(['work', 'conversation']).optional(),
    purpose: usagePurposeSchema.optional()
  })
  .strict()
  .refine((value) => value.to > value.from && value.to - value.from <= MODEL_USAGE_RETENTION_MS, {
    message: 'Usage range must be positive and no longer than 90 days.'
  });
export type PersonalUsageQuery = z.infer<typeof personalUsageQuerySchema>;
export const personalUsagePageSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(Math.floor(Number.MAX_SAFE_INTEGER / 20));

export interface UsageTotals {
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string | null;
  cacheWriteTokens: string | null;
  totalTokens: string;
  requests: string;
  completeRequests: string;
  partialRequests: string;
  unknownRequests: string;
}
export interface UsageGroup extends UsageTotals {
  key: string;
  label: string;
}
export interface PersonalUsageOverview {
  asOf: number;
  availableFrom: number;
  firstRecordedAt: number | null;
  lastReceivedAt: number | null;
  last24Hours: UsageTotals;
  last7Days: UsageTotals;
  selected: UsageTotals;
  buckets: (UsageTotals & { from: number; to: number })[];
  runners: UsageGroup[];
  models: UsageGroup[];
  coverage: 'observed-only';
}
export interface PersonalUsageRecords {
  total: string;
  page?: number;
  records: (ModelUsageRecord & {
    ledgerId: string;
    mode: 'work' | 'conversation';
    totalTokens: string | null;
  })[];
  nextCursor: string | null;
}
