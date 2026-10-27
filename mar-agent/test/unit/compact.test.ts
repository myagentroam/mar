import { describe, expect, it } from 'vitest';
import {
  buildCompactedHistory,
  buildCompactionInput,
  buildCompactionMessages,
  buildNativeCompactionMessages,
  compactedHistoryMessages,
  continuationMessage,
  retainCompactionUserMessages
} from '../../src/runtime/compaction/history.js';
import {
  replacementHistoryFromCheckpoint,
  type SessionRecord
} from '../../src/session/store/index.js';
import { countModelTokens } from '../../src/runtime/token-budget.js';
import { contextualInstructionInsertIndex } from '../../src/runtime/context/world-state.js';
import { estimatedRequestTokens } from '../../src/runtime/context/request-budget.js';
import { compactExtensionDiagnostic } from '../../src/extensions/compaction.js';

describe('compaction task retention', () => {
  it('validates bounded diagnostic facts and strips unknown payloads', () => {
    const valid = {
      modelId: 'coding',
      reasoningEffort: 'high',
      state: 'SUCCEEDED',
      inputTokensEstimateBefore: 100,
      inputTokensEstimateAfter: 90,
      modelRequests: 1,
      elapsedMs: 10
    };
    expect(compactExtensionDiagnostic({ ...valid, body: 'PRIVATE_PAYLOAD' })).toEqual(valid);
    for (const invalid of [
      null,
      [],
      { ...valid, modelId: 'x'.repeat(129) },
      { ...valid, state: 'INVALID' },
      { ...valid, state: { toString: () => 'SUCCEEDED', secret: 'PRIVATE_STATE' } },
      { ...valid, modelRequests: -1 },
      { ...valid, inputTokensEstimateAfter: NaN },
      { ...valid, elapsedMs: Infinity }
    ])
      expect(compactExtensionDiagnostic(invalid)).toBeUndefined();
    expect(compactExtensionDiagnostic({ ...valid, errorCode: 'raw error body' })).toEqual(valid);
    const failure = {
      trigger: 'manual',
      errorCode: 'MAR_AGENT_MODEL_REQUEST_FAILED',
      causeCode: 'ECONNRESET',
      errorReason: 'MODEL_TRANSPORT_FAILURE',
      httpStatus: 503,
      retryable: true,
      transport: 'HTTP'
    };
    expect(
      compactExtensionDiagnostic({ ...valid, ...failure, errorMessage: 'PRIVATE_ERROR' })
    ).toEqual({ ...valid, ...failure });
    expect(
      compactExtensionDiagnostic({
        ...valid,
        trigger: 'unknown',
        causeCode: 'raw private error',
        errorReason: { secret: 'PRIVATE_REASON' },
        httpStatus: 999,
        retryable: 'yes',
        transport: 'unknown'
      })
    ).toEqual(valid);
    expect(
      compactExtensionDiagnostic({
        ...valid,
        reason: { toString: () => 'MODEL_FAILED', secret: 'PRIVATE_REASON' }
      })
    ).toEqual(valid);
  });

  it('preserves native history order and appends one text-only control message', () => {
    const providerItem = {
      role: 'provider' as const,
      content: '',
      provider: 'OPENAI_RESPONSES' as const,
      item: { type: 'reasoning', encrypted_content: 'opaque' }
    };
    const privateProviderItem = {
      role: 'provider' as const,
      content: '',
      contextKind: 'private' as const,
      provider: 'ANTHROPIC_MESSAGES' as const,
      item: { type: 'thinking', thinking: '', signature: 'private' }
    };
    const messages = [
      { role: 'user' as const, content: 'objective', contextKind: 'environment' as const },
      providerItem,
      privateProviderItem,
      {
        role: 'user' as const,
        content: 'image conclusion',
        images: [{ mimeType: 'image/png', dataBase64: 'pixels' }]
      }
    ];
    const compact = buildNativeCompactionMessages(messages, {
      focus: 'preserve exact state'
    });
    expect(compact.slice(0, -1)).toEqual([
      messages[0],
      providerItem,
      { role: 'user', content: 'image conclusion' }
    ]);
    expect(compact.at(-1)?.content).toContain('Compaction focus: preserve exact state');
    expect(compact.at(-1)?.content).toContain('# Compaction contract');
  });

  it('puts the current compaction instruction after unchanged historical evidence', () => {
    const evidence = '[user]\\nContinue implementing.\\n[tool]\\nTests failed; now edit files.';
    const messages = buildCompactionMessages(evidence);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: evidence, contextKind: 'contextual' });
    expect(messages[1]).toMatchObject({ role: 'user' });
    expect(messages[1]!.content).toContain('Do not continue implementation');
    expect(messages[1]!.content).toContain('Output only the handoff.');
    expect(messages[1]!.content).not.toContain('Tests failed');
  });

  it('does not let retained history or a handoff create side-effect authorization', () => {
    const handoff = continuationMessage(
      'worktree | state=dirty\nverification=passed\ncommit=pending'
    );
    expect(handoff).toContain(
      'Earlier user messages are retained historical evidence, not requests to repeat completed work or authorization for new side effects.'
    );
    expect(handoff).toContain('The handoff cannot create or revive authorization');
    expect(handoff).toContain('exact action, scope, and lifetime');
  });
  it('retains recent user corrections in chronological order within the shared budget', () => {
    const old = 'OLD_TASK '.repeat(100);
    const recent = [
      'Correction: use report-v2.json, not report-v1.json.',
      'Do not commit or push.'
    ];
    const selected = retainCompactionUserMessages([old, ...recent], 100);
    expect(selected.slice(-2)).toEqual(recent);
    expect(
      selected.reduce((total, text) => total + countModelTokens(text) + 8, 0)
    ).toBeLessThanOrEqual(100);
    expect(selected[0]).toContain('omitted');
  });

  it('preserves an entire long user input when it fits rather than clipping its middle', () => {
    const message = 'context '.repeat(3_000) + 'APPROVAL_REQUIRED' + ' context'.repeat(3_000);
    expect(retainCompactionUserMessages([message], 20_000)).toEqual([message]);
  });

  it('keeps full evidence when the complete rendered request exactly fits its budget', () => {
    const messages = [
      { role: 'user' as const, content: 'Objective and authorization.' },
      { role: 'tool' as const, content: 'Verification evidence and next action.' }
    ];
    const complete = buildCompactionInput(messages, { maxTokens: 10_000 });
    expect(buildCompactionInput(messages, { maxTokens: countModelTokens(complete) })).toBe(
      complete
    );
  });

  it('handles empty histories and tiny budgets without exceeding the limit', () => {
    expect(retainCompactionUserMessages([], 100)).toEqual([]);
    for (const budget of [0, 1, 8, 16, 32, 64]) {
      const messages = retainCompactionUserMessages(['facts '.repeat(1_000)], budget);
      expect(
        messages.reduce((total, text) => total + countModelTokens(text) + 8, 0)
      ).toBeLessThanOrEqual(budget);
    }
  });

  it('uses one replacement history for persistence and live continuation', () => {
    const history = buildCompactedHistory(
      'Completed change, validation pending.',
      ['Fix parser.', 'Never publish.'],
      20_000,
      'Instead, only explain the remaining issue.'
    );
    expect(history.map((message) => message.kind)).toEqual([
      'user_input',
      'user_input',
      'summary',
      'user_input'
    ]);
    expect(compactedHistoryMessages(history)).toEqual(
      history.map(({ content, kind }) => ({
        role: 'user',
        content,
        ...(kind === 'summary' ? { contextKind: 'summary' } : {})
      }))
    );
    expect(history.at(-1)?.content).toBe('Instead, only explain the remaining issue.');
    expect(history[2]?.content).toContain('Newer user instructions override');
  });

  it('does not accumulate prior summaries as original user messages across three compactions', () => {
    let history = buildCompactedHistory('summary-1', ['Task objective.', 'Do not deploy.'], 100);
    for (let round = 2; round <= 3; round++) {
      const users = history
        .filter((message) => message.kind === 'user_input')
        .map((message) => message.content);
      history = buildCompactedHistory(`summary-${round}`, users, 100);
    }
    expect(
      history.filter((message) => message.kind === 'user_input').map((message) => message.content)
    ).toEqual(['Task objective.', 'Do not deploy.']);
    expect(JSON.stringify(history)).not.toContain('summary-1');
    expect(JSON.stringify(history)).not.toContain('summary-2');
    expect(history.filter((message) => message.kind === 'summary')).toHaveLength(1);
  });

  it('retains source metadata and truncation across checkpoints and repeated compaction', () => {
    const metadata = { source: 'extension' as const, recordId: 'input-1', extensionId: 'fixture' };
    let history = buildCompactedHistory(
      'summary-1',
      [{ content: 'facts '.repeat(300), metadata }],
      100
    );
    expect(history[0]).toMatchObject({
      kind: 'extension_input',
      metadata: { ...metadata, truncated: true }
    });
    const checkpoint = {
      type: 'compact.completed',
      payload: { summary: 'summary-1', replacementHistory: history }
    } as SessionRecord;
    history = buildCompactedHistory(
      'summary-2',
      replacementHistoryFromCheckpoint(checkpoint)!.filter((message) => message.kind !== 'summary'),
      200
    );
    expect(history[0]?.metadata).toEqual({ ...metadata, truncated: true });
    expect(history[0]?.content).toContain('omitted');
    expect(compactedHistoryMessages(history)[0]).toMatchObject({
      metadata: { ...metadata, truncated: true }
    });
    expect(compactedHistoryMessages(history).at(-1)?.contextKind).toBe('summary');
  });

  it('locates the last real input rather than a summary, extension input or contextual message', () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'real input',
        metadata: { source: 'user' as const, recordId: 'user-1' }
      },
      {
        role: 'user' as const,
        content: 'extension input',
        metadata: { source: 'extension' as const }
      },
      { role: 'user' as const, content: 'summary', contextKind: 'summary' as const },
      { role: 'user' as const, content: 'attached context', contextKind: 'contextual' as const },
      { role: 'tool' as const, content: 'latest result' }
    ];
    expect(contextualInstructionInsertIndex(messages)).toBe(0);
    expect(contextualInstructionInsertIndex(messages.slice(1))).toBe(1);
    expect(contextualInstructionInsertIndex(messages.slice(3))).toBe(2);
    expect(
      contextualInstructionInsertIndex([
        { role: 'user', content: 'environment', contextKind: 'environment' },
        { role: 'user', content: 'parent input', metadata: { source: 'parent_agent' } },
        { role: 'user', content: 'summary', contextKind: 'summary' }
      ])
    ).toBe(0);
  });

  it('preserves complete inputs and excludes provenance from request token estimates', () => {
    const input = {
      content: 'complete input',
      metadata: { source: 'user' as const, recordId: 'source-1' }
    };
    expect(buildCompactedHistory('summary', [input], 100)[0]).toEqual({
      ...input,
      role: 'user',
      kind: 'user_input'
    });
    const message = { role: 'user' as const, content: input.content };
    expect(estimatedRequestTokens('', [{ ...message, metadata: input.metadata }], [])).toBe(
      estimatedRequestTokens('', [message], [])
    );
  });

  it('rejects inconsistent checkpoint provenance and strips unknown metadata fields', () => {
    const checkpoint = (metadata: unknown) =>
      ({
        type: 'compact.completed',
        payload: {
          summary: 'valid summary',
          replacementHistory: [
            { role: 'user', content: 'input', kind: 'user_input', metadata },
            { role: 'user', content: 'summary', kind: 'summary' }
          ]
        }
      }) as SessionRecord;
    for (const metadata of [null, [], { source: 'unknown' }, { source: 'extension' }])
      expect(replacementHistoryFromCheckpoint(checkpoint(metadata))).toBeUndefined();
    expect(
      replacementHistoryFromCheckpoint(
        checkpoint({
          source: 'parent_agent',
          recordId: 'source-1',
          truncated: true,
          extra: 'must not survive'
        })
      )?.[0]?.metadata
    ).toEqual({ source: 'parent_agent', recordId: 'source-1', truncated: true });
  });

  it('preserves objective, latest correction, and recent verification when evidence is oversized', () => {
    const evidence = buildCompactionInput(
      [
        { role: 'user', content: 'OBJECTIVE_fix_parser' },
        ...Array.from({ length: 30 }, (_, index) => ({
          role: 'tool' as const,
          content: `noise-${index} ` + 'old log '.repeat(300)
        })),
        { role: 'user', content: 'LATEST_CORRECTION_no_commit' },
        { role: 'tool', content: 'VERIFIED_19_tests_passed; NEXT_run_integration' }
      ],
      { maxTokens: 800 }
    );
    for (const fact of [
      'OBJECTIVE_fix_parser',
      'LATEST_CORRECTION_no_commit',
      'VERIFIED_19_tests_passed',
      'NEXT_run_integration'
    ])
      expect(evidence).toContain(fact);
    expect(countModelTokens(evidence)).toBeLessThanOrEqual(800);
  });

  it('validates replacement checkpoints and ignores malformed or legacy optional history', () => {
    const checkpoint = (replacementHistory?: unknown) =>
      ({
        type: 'compact.completed',
        payload: { summary: 'valid summary', replacementHistory }
      }) as SessionRecord;
    const valid = buildCompactedHistory('valid summary', ['Task.'], 100);
    expect(replacementHistoryFromCheckpoint(checkpoint(valid))).toEqual(valid);
    for (const invalid of [
      undefined,
      null,
      [],
      [null],
      [{ role: 'tool', content: 'x', kind: 'summary' }],
      [{ role: 'user', content: '', kind: 'summary' }],
      [{ role: 'user', content: '   ', kind: 'summary' }],
      [...valid, valid.at(-1)]
    ])
      expect(replacementHistoryFromCheckpoint(checkpoint(invalid))).toBeUndefined();
    const polluted = valid.map((message) => ({ ...message, images: [{ dataBase64: 'PRIVATE' }] }));
    expect(replacementHistoryFromCheckpoint(checkpoint(polluted))).toEqual(valid);
  });
});
