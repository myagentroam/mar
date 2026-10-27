import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import {
  contextGcCheckpointIntervalEligible,
  normalizeContextGcReplacements,
  parseContextGcCheckpoint,
  type ContextGcCheckpointDraft,
  type ContextGcReplacement,
  type ContextGcMetrics
} from '../../src/session/context-gc-checkpoint.js';
import {
  contextGcApplyPatchInputReplacement,
  contextGcStaleReadReplacement
} from '../../src/session/context-gc-replacements.js';
import { formatReadContextItem } from '../../src/prompts/read-context.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';

const homes: string[] = [];

const economics = {
  version: 1,
  immediatePaybackRollouts: 3,
  maximumPaybackRollouts: 20,
  contextGrowthSampleWindow: 16,
  minimumContextGrowthSamples: 6,
  minimumObservationRollouts: 1,
  stageAProtectionRollouts: 2,
  largeExecProtectionRollouts: 6,
  normalInputCostRate: 1,
  cacheReadCostRate: 0.1,
  cacheWriteCostRate: 1.25,
  outputCostRate: 1,
  minimumGrossReductionRate: 0.2,
  minimumCacheInvestmentRoi: 0.1
} as const;

const metrics: ContextGcMetrics = {
  stage: 'STAGE_A',
  beforeTokens: 10,
  afterTokens: 8,
  reclaimedTokens: 2,
  grossReductionRate: 0.2,
  cacheRebuildPenaltyCostUnits: 0,
  compactDeferralCreditCostUnits: 0,
  requiredPositiveNetRollouts: 1,
  requiredTargetRoiRollouts: 1,
  projectedRolloutsUntilCompactAfterGc: 10,
  contextGrowthSampleCount: 0,
  contextGrowthP75Tokens: 0,
  expectedNetSavedCostUnits: 2,
  cacheInvestmentRoi: 0,
  minimumObservedRollouts: 2,
  protectedCandidateTokens: 0,
  eligibleCandidateCount: 1,
  eligibleTargetCount: 1,
  cachePenaltyKnown: true
};

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function appendSuccessfulRollout(
  store: JsonlSessionStore,
  sessionId: string,
  contextInputTokens: number
) {
  await store.append(sessionId, {
    type: 'model.attempt',
    payload: {
      purpose: 'EXECUTION',
      protocol: 'ANTHROPIC_MESSAGES',
      transport: 'HTTP',
      state: 'STARTED',
      attempt: 1,
      maxAttempts: 5,
      continuation: false,
      credentialReason: 'REQUEST'
    }
  });
  const usage = await store.append(sessionId, {
    type: 'usage.updated',
    payload: {
      type: 'usage.updated',
      inputTokens: contextInputTokens,
      contextInputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
  });
  const completed = await store.append(sessionId, {
    type: 'model.attempt',
    payload: {
      purpose: 'EXECUTION',
      protocol: 'ANTHROPIC_MESSAGES',
      transport: 'HTTP',
      state: 'SUCCEEDED',
      attempt: 1,
      maxAttempts: 5,
      continuation: false,
      credentialReason: 'REQUEST'
    }
  });
  return { usage, completed };
}

async function appendPatchDraft(
  store: JsonlSessionStore,
  sessionId: string,
  input: {
    callId: string;
    path: string;
    contextInputTokens: number;
    normalRolloutOrdinal: number;
    turnId?: string;
  }
): Promise<ContextGcCheckpointDraft> {
  const patch = [
    '*** Begin Patch',
    `*** Update File: ${input.path}`,
    '@@',
    '-before',
    '+after',
    '*** End Patch'
  ].join('\n');
  const recordInput = input.turnId ? { executionId: 'execution', turnId: input.turnId } : undefined;
  const call = await store.append(sessionId, {
    type: 'model.context',
    payload: {
      role: 'tool_call',
      content: '',
      callId: input.callId,
      name: 'apply_patch',
      arguments: patch,
      inputMode: 'freeform'
    },
    ...recordInput
  });
  const data = {
    files: [
      {
        path: input.path,
        operation: 'modified',
        addedLines: 1,
        deletedLines: 1
      }
    ],
    totals: { files: 1, addedLines: 1, deletedLines: 1 }
  };
  await store.append(sessionId, {
    type: 'tool.completed',
    payload: {
      type: 'tool.completed',
      toolName: 'apply_patch',
      callId: input.callId,
      summary: 'applied',
      data
    },
    ...recordInput
  });
  const result = await store.append(sessionId, {
    type: 'model.context',
    payload: { role: 'tool', callId: input.callId, content: JSON.stringify(data) },
    ...recordInput
  });
  await appendSuccessfulRollout(store, sessionId, input.contextInputTokens);
  const latest = await appendSuccessfulRollout(store, sessionId, input.contextInputTokens);
  const draft: ContextGcCheckpointDraft = {
    version: 1,
    base: { type: 'SESSION_START', firstSequence: 1 },
    boundarySequence: latest.completed.sequence,
    replacements: [
      {
        kind: 'TOOL_CALL_INPUT',
        toolName: 'apply_patch',
        callId: input.callId,
        target: {
          sequence: call.sequence,
          recordId: call.recordId,
          role: 'tool_call',
          callId: input.callId,
          toolName: 'apply_patch'
        },
        replacementArguments: contextGcApplyPatchInputReplacement(patch, {
          files: [
            {
              path: input.path,
              operation: 'modified',
              addedLines: 1,
              deletedLines: 1
            }
          ],
          totals: { files: 1, addedLines: 1, deletedLines: 1 }
        }),
        providerAliasTargets: [],
        evidenceSequence: result.sequence
      }
    ],
    trigger: {
      usageSequence: latest.usage.sequence,
      contextInputTokens: input.contextInputTokens,
      contextWindowTokens: 10_000,
      normalRolloutOrdinal: input.normalRolloutOrdinal,
      modelId: 'coding',
      platform: 'linux'
    },
    economics,
    metrics
  };
  return draft;
}

async function createFixture(title: string) {
  const home = await mkdtemp(join(tmpdir(), 'mar-context-gc-store-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const session = await store.createSession({ workspace: '/workspace', title });
  await store.append(session.id, {
    type: 'turn.user',
    payload: { prompt: 'Update the source.' },
    executionId: 'execution',
    turnId: 'turn-1'
  });
  await store.append(session.id, {
    type: 'execution.header',
    payload: { modelId: 'coding', contextWindowTokens: 10_000, mode: 'run' },
    executionId: 'execution',
    turnId: 'turn-1'
  });
  const draft = await appendPatchDraft(store, session.id, {
    callId: 'patch-1',
    path: 'src/a.ts',
    contextInputTokens: 6_000,
    normalRolloutOrdinal: 2,
    turnId: 'turn-1'
  });
  return { home, store, session, draft };
}

describe('context GC checkpoint store', () => {
  it.each([
    { window: 10_000, growth: 1_999, rollouts: 2, allowed: false },
    { window: 10_000, growth: 2_000, rollouts: 2, allowed: true },
    { window: 100_000, growth: 4_999, rollouts: 2, allowed: false },
    { window: 100_000, growth: 5_000, rollouts: 2, allowed: true },
    { window: 100_000, growth: 5_000, rollouts: 1, allowed: false }
  ])(
    'requires both trigger thresholds: $window/$growth/$rollouts',
    ({ window, growth, rollouts, allowed }) => {
      const previous: ContextGcCheckpointDraft['trigger'] = {
        usageSequence: 100,
        contextInputTokens: 60_000,
        contextWindowTokens: window,
        normalRolloutOrdinal: 10,
        modelId: 'coding',
        platform: 'linux'
      };
      const trigger = {
        ...previous,
        normalRolloutOrdinal: previous.normalRolloutOrdinal + rollouts,
        contextInputTokens: previous.contextInputTokens + growth
      };
      expect(contextGcCheckpointIntervalEligible(trigger, previous)).toBe(allowed);
    }
  );

  it('rejects unknown replacement and target fields', async () => {
    const { store, draft } = await createFixture('Unknown checkpoint fields');
    try {
      for (const mutate of [
        (replacement: Record<string, unknown>) => {
          replacement.unexpected = true;
        },
        (replacement: Record<string, unknown>) => {
          (replacement.target as Record<string, unknown>).unexpected = true;
        },
        (replacement: Record<string, unknown>) => {
          (replacement.target as Record<string, unknown>).sourceHash = 'obsolete';
        },
        (replacement: Record<string, unknown>) => {
          replacement.providerAliasTargets = [
            {
              ...(replacement.target as Record<string, unknown>),
              role: 'provider',
              sourceHash: 'obsolete'
            }
          ];
        }
      ]) {
        const corrupted = structuredClone(draft);
        mutate(corrupted.replacements[0] as unknown as Record<string, unknown>);
        expect(normalizeContextGcReplacements(corrupted.replacements)).toBeUndefined();
      }
    } finally {
      await store.close();
    }
  });

  it('normalizes large read maps with linear evidence-field reads', () => {
    const count = 1_024;
    let reads = 0;
    const replacement: ContextGcReplacement = {
      kind: 'READ_OUTPUT_ITEMS',
      callId: 'read',
      target: { sequence: 2, recordId: 'read-result', role: 'tool', callId: 'read' },
      items: Array.from({ length: count }, (_, index) => ({
        index,
        path: `src/${index}.ts`,
        replacement: 'Re-read the path.',
        get evidenceSequence() {
          reads++;
          return index + 3;
        }
      })),
      evidenceSequences: Array.from({ length: count }, (_, index) => index + 3)
    };
    expect(normalizeContextGcReplacements([replacement])?.[0]).toEqual(replacement);
    expect(reads).toBeLessThanOrEqual(count * 8);
  });

  it.each([false, true])('merges read fragments by item index with overwrite=%s', (overwrite) => {
    const fragment = (index: number, evidenceSequence: number): ContextGcReplacement => ({
      kind: 'READ_OUTPUT_ITEMS',
      callId: 'read',
      target: { sequence: 2, recordId: 'read-result', role: 'tool', callId: 'read' },
      items: [{ index, path: `src/${index}.ts`, replacement: 'Re-read.', evidenceSequence }],
      evidenceSequences: [evidenceSequence]
    });
    const first = fragment(0, 3);
    const second = fragment(1, 4);
    const replacements = [first, second, ...(overwrite ? [fragment(0, 5)] : [])];
    const normalized = normalizeContextGcReplacements(replacements)!;
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      items: [
        { index: 0, evidenceSequence: overwrite ? 5 : 3 },
        { index: 1, evidenceSequence: 4 }
      ],
      evidenceSequences: [overwrite ? 5 : 3, 4]
    });
    expect(first).toMatchObject({ items: [{ index: 0, evidenceSequence: 3 }] });
    expect(second).toMatchObject({ items: [{ index: 1, evidenceSequence: 4 }] });
  });

  it('rejects a changed durable boundary instead of trusting the planning snapshot', async () => {
    const { store, session, draft } = await createFixture('Changed boundary');
    try {
      const records = (await store.readExecutionState(session.id)).contextRecords;
      const append = store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'New work.' }
      });
      const commit = store.commitContextGc(session.id, draft, records);
      await append;
      await expect(commit).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_CORRUPT'
      });
      expect(
        (await store.read(session.id)).some((record) => record.type === 'context.gc.completed')
      ).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('commits targets by record identity without payload hashes', async () => {
    const { store, session, draft } = await createFixture('Record identity');
    try {
      const records = (await store.readExecutionState(session.id)).contextRecords;
      const committed = await store.commitContextGc(session.id, draft, records);
      const payload = parseContextGcCheckpoint(committed)!;
      expect(payload).toBeDefined();
      expect(committed.payload).toEqual(payload);
      for (const replacement of payload.replacements) {
        expect(replacement.target).not.toHaveProperty('sourceHash');
        if (replacement.kind === 'TOOL_CALL_INPUT')
          for (const alias of replacement.providerAliasTargets)
            expect(alias).not.toHaveProperty('sourceHash');
      }
    } finally {
      await store.close();
    }
  });

  it('trusts writer serialization without rereading or hashing the complete planning history', async () => {
    const { home, store, session, draft } = await createFixture('Changed source');
    try {
      const records = (await store.readExecutionState(session.id)).contextRecords;
      const path = join(await activeSessionDirectory(home, session.id), 'events-000001.jsonl');
      const contents = await readFile(path, 'utf8');
      await writeFile(
        path,
        contents.replace('*** Update File: src/a.ts', '*** Update File: src/b.ts')
      );
      const archived = records.find((record) => record.type === 'turn.user')!;
      Object.defineProperty(archived, 'payload', {
        get() {
          throw new Error('Unrelated archived messages must not be hashed.');
        }
      });
      const read = vi.spyOn(store, 'readExecutionState');
      try {
        await expect(store.commitContextGc(session.id, draft, records)).resolves.toMatchObject({
          type: 'context.gc.completed'
        });
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    } finally {
      await store.close();
    }
  });

  it.each(['none', 'new', 'committed'] as const)(
    'validates only changed cumulative replacements with invalid replacement=%s',
    async (invalid) => {
      const { store, session, draft } = await createFixture('Cumulative plan');
      try {
        const first = parseContextGcCheckpoint(await store.commitContextGc(session.id, draft))!;
        const next = await appendPatchDraft(store, session.id, {
          callId: 'patch-2',
          path: 'src/b.ts',
          contextInputTokens: 8_000,
          normalRolloutOrdinal: 4
        });
        const records = (await store.readExecutionState(session.id)).contextRecords;
        const archived = records.find(
          (record) => record.sequence === first.replacements[0]!.target.sequence
        )!;
        const archivedInput = vi.fn(() => {
          throw new Error('Committed replacement sources must not be rebuilt.');
        });
        if (invalid !== 'committed')
          Object.defineProperty(archived.payload, 'arguments', { get: archivedInput });
        const cumulative = {
          ...next,
          replacements: [
            ...first.replacements.map((replacement) =>
              invalid === 'committed' && replacement.kind === 'TOOL_CALL_INPUT'
                ? { ...replacement, replacementArguments: 'Invalid changed replacement.' }
                : replacement
            ),
            ...next.replacements.map((replacement) =>
              invalid === 'new' && replacement.kind === 'TOOL_CALL_INPUT'
                ? { ...replacement, replacementArguments: 'Invalid new replacement.' }
                : replacement
            )
          ]
        };
        if (invalid !== 'none')
          await expect(
            store.commitContextGc(session.id, cumulative, records)
          ).rejects.toMatchObject({
            code: 'MAR_AGENT_SESSION_CORRUPT'
          });
        else {
          const committed = await store.commitContextGc(session.id, cumulative, records);
          expect(parseContextGcCheckpoint(committed)).toMatchObject({
            generation: 2,
            replacements: [
              expect.objectContaining({ callId: 'patch-1' }),
              expect.objectContaining({ callId: 'patch-2' })
            ]
          });
        }
        expect(archivedInput).not.toHaveBeenCalled();
      } finally {
        await store.close();
      }
    }
  );

  it('preserves committed read items when a later generation submits only an item delta', async () => {
    const { store, session } = await createFixture('Cumulative read');
    try {
      await store.append(session.id, {
        type: 'model.context',
        payload: { role: 'tool_call', callId: 'read', name: 'read', arguments: {} }
      });
      const read = await store.append(session.id, {
        type: 'model.context',
        payload: {
          role: 'tool',
          callId: 'read',
          content: ['b', 'c']
            .map((name, index) =>
              formatReadContextItem(
                index,
                { path: `src/${name}.ts`, pathTruncated: false },
                `before ${name}`
              )
            )
            .join('\n')
        }
      });
      const firstDraft = await appendPatchDraft(store, session.id, {
        callId: 'patch-2',
        path: 'src/b.ts',
        contextInputTokens: 8_000,
        normalRolloutOrdinal: 4
      });
      const evidence = firstDraft.replacements.find(
        (replacement) => replacement.kind === 'TOOL_CALL_INPUT'
      )!.evidenceSequence;
      const firstRead: Extract<ContextGcReplacement, { kind: 'READ_OUTPUT_ITEMS' }> = {
        kind: 'READ_OUTPUT_ITEMS',
        callId: 'read',
        target: { sequence: read.sequence, recordId: read.recordId, role: 'tool', callId: 'read' },
        items: [
          {
            index: 0,
            path: 'src/b.ts',
            replacement: contextGcStaleReadReplacement({
              path: 'src/b.ts',
              content: 'before b',
              operation: 'modified'
            }),
            evidenceSequence: evidence
          }
        ],
        evidenceSequences: [evidence]
      };
      await store.commitContextGc(session.id, {
        ...firstDraft,
        replacements: [...firstDraft.replacements, firstRead]
      });
      const next = await appendPatchDraft(store, session.id, {
        callId: 'patch-3',
        path: 'src/c.ts',
        contextInputTokens: 10_000,
        normalRolloutOrdinal: 6
      });
      const nextEvidence = next.replacements.find(
        (replacement) => replacement.kind === 'TOOL_CALL_INPUT'
      )!.evidenceSequence;
      const records = (await store.readExecutionState(session.id)).contextRecords;
      const archived = records.find(
        (record) =>
          record.type === 'tool.completed' &&
          (record.payload as { callId?: string }).callId === 'patch-2'
      )!;
      const archivedData = vi.fn(() => {
        throw new Error('Committed read-item evidence must not be replayed.');
      });
      Object.defineProperty(archived.payload, 'data', { get: archivedData });
      const committed = await store.commitContextGc(
        session.id,
        {
          ...next,
          replacements: [
            ...next.replacements,
            {
              ...firstRead,
              items: [
                {
                  index: 1,
                  path: 'src/c.ts',
                  replacement: contextGcStaleReadReplacement({
                    path: 'src/c.ts',
                    content: 'before c',
                    operation: 'modified'
                  }),
                  evidenceSequence: nextEvidence
                }
              ],
              evidenceSequences: [nextEvidence]
            }
          ]
        },
        records
      );
      const retained = parseContextGcCheckpoint(committed)!.replacements.find(
        (replacement) => replacement.kind === 'READ_OUTPUT_ITEMS'
      );
      expect(retained?.items.map((item) => item.index)).toEqual([0, 1]);
      expect(archivedData).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it.each([
    { path: '/workspace/src/b.ts', valid: true },
    { path: '/outside/src/b.ts', valid: false }
  ])(
    'validates $path against the Session Workspace at Compact-sliced commit',
    async ({ path, valid }) => {
      const { store, session } = await createFixture('Workspace validation');
      try {
        await store.compact(session.id, {
          summary: 'A new context base.',
          modelId: 'coding',
          contextWindowTokens: 10_000
        });
        await store.append(session.id, {
          type: 'model.context',
          payload: { role: 'tool_call', callId: 'read', name: 'read', arguments: {} }
        });
        const read = await store.append(session.id, {
          type: 'model.context',
          payload: {
            role: 'tool',
            callId: 'read',
            content: formatReadContextItem(0, { path, pathTruncated: false }, 'before b')
          }
        });
        const draft = await appendPatchDraft(store, session.id, {
          callId: 'patch-2',
          path: 'src/b.ts',
          contextInputTokens: 8_000,
          normalRolloutOrdinal: 2
        });
        const records = (await store.readExecutionState(session.id)).contextRecords;
        expect(records[0]?.type).toBe('compact.completed');
        expect(records.some((record) => record.type === 'session.created')).toBe(false);
        const evidenceSequence = draft.replacements.find(
          (replacement) => replacement.kind === 'TOOL_CALL_INPUT'
        )!.evidenceSequence;
        const commit = store.commitContextGc(
          session.id,
          {
            ...draft,
            base: {
              type: 'COMPACT',
              sequence: records[0]!.sequence,
              recordId: records[0]!.recordId
            },
            replacements: [
              {
                kind: 'READ_OUTPUT_ITEMS',
                callId: 'read',
                target: {
                  sequence: read.sequence,
                  recordId: read.recordId,
                  role: 'tool',
                  callId: 'read'
                },
                items: [
                  {
                    index: 0,
                    path,
                    replacement: contextGcStaleReadReplacement({
                      path,
                      content: 'before b',
                      operation: 'modified'
                    }),
                    evidenceSequence
                  }
                ],
                evidenceSequences: [evidenceSequence]
              }
            ]
          },
          records
        );
        if (valid) {
          await expect(commit).resolves.toMatchObject({ type: 'context.gc.completed' });
          const restored = await store.readExecutionState(session.id);
          expect(
            buildContextProjection(restored.contextRecords).checkpoint?.replacements
          ).toHaveLength(1);
        } else {
          await expect(commit).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
          expect(
            (await store.read(session.id)).some((record) => record.type === 'context.gc.completed')
          ).toBe(false);
        }
      } finally {
        await store.close();
      }
    }
  );

  it('restores cumulative generations from records despite obsolete GC index fields', async () => {
    const { home, store, session, draft } = await createFixture('GC');
    const first = await store.commitContextGc(session.id, draft);
    expect(first.payload).not.toHaveProperty('sourceProjectionHash');
    const secondDraft = await appendPatchDraft(store, session.id, {
      callId: 'patch-2',
      path: 'src/b.ts',
      contextInputTokens: 8_000,
      normalRolloutOrdinal: 4
    });
    const second = await store.commitContextGc(session.id, secondDraft);
    expect(second).toMatchObject({
      type: 'context.gc.completed',
      payload: expect.objectContaining({ generation: 2, checkpointId: expect.any(String) })
    });
    expect(
      (second.payload as { replacements: Array<{ callId: string }> }).replacements.map(
        (replacement) => replacement.callId
      )
    ).toEqual(['patch-1', 'patch-2']);
    const expectedProjection = buildContextProjection(
      (await store.readExecutionState(session.id)).contextRecords
    );
    await store.close();

    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    Object.assign(index.sessions.find((item: { id: string }) => item.id === session.id).resume, {
      gcSequence: first.sequence,
      gcGeneration: 999,
      gcBaseSequence: second.sequence + 100
    });
    await writeFile(indexPath, JSON.stringify(index));

    const reopened = await JsonlSessionStore.open(home);
    const state = await reopened.readExecutionState(session.id);
    expect(buildContextProjection(state.contextRecords)).toEqual(expectedProjection);
    expect(buildContextProjection(state.contextRecords).checkpoint).toMatchObject({
      checkpointId: expect.any(String),
      generation: 2
    });
    const raw = await reopened.read(session.id);
    expect(JSON.stringify(raw)).toContain('*** Update File: src/a.ts');
    expect(JSON.stringify(raw)).toContain('*** Update File: src/b.ts');
    expect(first.sequence).toBeLessThan(second.sequence);
    await reopened.append(session.id, { type: 'turn.user', payload: { prompt: 'Continue.' } });
    await reopened.close();

    const rewritten = await JsonlSessionStore.open(home);
    try {
      const restored = await rewritten.readExecutionState(session.id);
      expect(buildContextProjection(restored.contextRecords)).toEqual(expectedProjection);
      expect(restored.contextRecords.at(-1)?.payload).toEqual({ prompt: 'Continue.' });
    } finally {
      await rewritten.close();
    }
  });

  it('rejects empty checkpoints and trigger sequences that are not matching usage records', async () => {
    const { store, session, draft } = await createFixture('Invalid GC');
    await expect(
      store.commitContextGc(session.id, { ...structuredClone(draft), replacements: [] })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await expect(
      store.commitContextGc(session.id, {
        ...structuredClone(draft),
        trigger: { ...draft.trigger, usageSequence: draft.boundarySequence }
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await expect(
      store.commitContextGc(session.id, {
        ...structuredClone(draft),
        trigger: { ...draft.trigger, normalRolloutOrdinal: 99 }
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    expect(
      (await store.read(session.id)).some((record) => record.type === 'context.gc.completed')
    ).toBe(false);
    await store.close();
  });

  it('does not copy GC checkpoints into a fork even when the boundary contains one', async () => {
    const { store, session, draft } = await createFixture('Source');
    await store.commitContextGc(session.id, draft);
    await store.append(session.id, {
      type: 'message.completed',
      payload: {
        type: 'message.completed',
        itemId: 'answer',
        phase: 'final_answer',
        text: 'Done.'
      },
      executionId: 'execution',
      turnId: 'turn-1'
    });
    const fork = await store.forkSession(session.id, {
      boundaryTurnId: 'turn-1',
      title: 'Fork'
    });
    const forkRecords = await store.read(fork.id);
    expect(forkRecords.some((record) => record.type === 'context.gc.completed')).toBe(false);
    expect(JSON.stringify(forkRecords)).toContain('*** Update File: src/a.ts');
    await store.close();
  });

  it('restores the retained GC generation when rollback truncates a later generation', async () => {
    const { home, store, session, draft } = await createFixture('Rollback');
    const first = await store.commitContextGc(session.id, draft);
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'Keep this boundary.' },
      executionId: 'execution-2',
      turnId: 'turn-2'
    });
    await store.append(session.id, {
      type: 'message.completed',
      payload: {
        type: 'message.completed',
        itemId: 'answer-2',
        phase: 'final_answer',
        text: 'Kept.'
      },
      executionId: 'execution-2',
      turnId: 'turn-2'
    });
    const secondDraft = await appendPatchDraft(store, session.id, {
      callId: 'patch-2',
      path: 'src/b.ts',
      contextInputTokens: 8_000,
      normalRolloutOrdinal: 4
    });
    await store.commitContextGc(session.id, secondDraft);

    await store.rollbackSession(session.id, { boundaryTurnId: 'turn-2' });
    const state = await store.readExecutionState(session.id);
    expect(buildContextProjection(state.contextRecords).checkpoint).toMatchObject({
      generation: 1
    });
    const records = await store.read(session.id);
    expect(records.filter((record) => record.type === 'context.gc.completed')).toHaveLength(1);
    expect(records.some((record) => JSON.stringify(record.payload).includes('src/b.ts'))).toBe(
      false
    );
    await store.close();

    const reopened = await JsonlSessionStore.open(home);
    try {
      const restored = await reopened.readExecutionState(session.id);
      expect(buildContextProjection(restored.contextRecords)).toEqual(
        buildContextProjection(state.contextRecords)
      );
      expect(buildContextProjection(restored.contextRecords).checkpoint?.checkpointId).toBe(
        parseContextGcCheckpoint(first)!.checkpointId
      );
    } finally {
      await reopened.close();
    }
  });

  it('drops the active GC generation when Compact establishes a new context base', async () => {
    const { home, store, session, draft } = await createFixture('Compact');
    await store.commitContextGc(session.id, draft);
    const items = [{ id: 'resume', step: 'Continue after Compact', status: 'in_progress' }];
    const todo = await store.append(session.id, {
      type: 'todo.updated',
      payload: { revision: 1, items }
    });
    await store.compact(session.id, {
      summary: 'Continue after Compact.',
      modelId: 'coding',
      contextWindowTokens: 10_000,
      usage: {
        inputTokens: 5_000,
        contextInputTokens: 6_000,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 0,
        outputTokens: 100
      }
    });
    const state = await store.readExecutionState(session.id);
    expect(state.contextRecords[0]?.type).toBe('compact.completed');
    expect(buildContextProjection(state.contextRecords).checkpoint).toBeUndefined();
    expect(state.todo).toEqual({ revision: 1, items });
    await store.close();

    const index = JSON.parse(
      await readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
    ) as {
      sessions: Array<{
        id: string;
        resume?: { compactSequence?: number; todoSequence?: number; todoRevision: number };
      }>;
    };
    const resume = index.sessions.find((item) => item.id === session.id)?.resume;
    expect(resume).toMatchObject({
      compactSequence: state.contextRecords[0]!.sequence,
      todoSequence: todo.sequence,
      todoRevision: 1
    });
    const reopened = await JsonlSessionStore.open(home);
    try {
      const restored = await reopened.readExecutionState(session.id);
      expect(restored.todo).toEqual(state.todo);
      expect(restored.contextRecords).toEqual(state.contextRecords);
      expect(buildContextProjection(restored.contextRecords).checkpoint).toBeUndefined();
    } finally {
      await reopened.close();
    }
  });
});
