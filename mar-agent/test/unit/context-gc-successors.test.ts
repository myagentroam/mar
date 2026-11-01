import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatReadContextItem } from '../../src/prompts/read-context.js';
import { planContextGc } from '../../src/runtime/context/gc.js';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import type { ContextGcReplacement } from '../../src/session/context-gc-checkpoint.js';
import {
  renderObservations,
  type CodeObservation
} from '../../src/session/code-observation-projection.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

describe('GC successor visibility order', () => {
  it.each([
    { name: 'read', codeMode: false, repeatObservation: false },
    { name: 'skill', codeMode: false, repeatObservation: false },
    { name: 'tool_search', codeMode: false, repeatObservation: false },
    { name: 'read', codeMode: true, repeatObservation: false },
    { name: 'skill', codeMode: true, repeatObservation: false },
    { name: 'read', codeMode: true, repeatObservation: true },
    { name: 'skill', codeMode: true, repeatObservation: true }
  ] as const)(
    'commits and restores $name successors, codeMode=$codeMode, repeatObservation=$repeatObservation',
    async ({ name, codeMode, repeatObservation }) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-gc-successor-order-'));
      let store = await JsonlSessionStore.open(home);
      try {
        const session = await store.createSession({ workspace: '/workspace', title: name });
        const append = (type: string, payload: unknown) =>
          store.append(session.id, { type, payload, executionId: 'execution', turnId: 'turn' });
        await append('execution.header', { modelId: 'coding', contextWindowTokens: 10000 });
        const args =
          name === 'read'
            ? { reads: [{ path: '/workspace/source.ts' }] }
            : name === 'skill'
              ? { name: 'guide' }
              : { query: 'guide' };
        if (codeMode)
          await append('model.context', {
            role: 'tool_call',
            name: 'code_exec',
            callId: 'cell',
            arguments: { code: 'observe.result(result);' },
            content: ''
          });
        for (const callId of ['old', 'latest', 'middle']) {
          if (codeMode) {
            await append('tool.started', {
              type: 'tool.started',
              toolName: name,
              callId,
              parentCallId: 'cell',
              input: args
            });
            continue;
          }
          if (name === 'tool_search')
            await append('model.context', {
              role: 'provider',
              content: '',
              provider: 'OPENAI_RESPONSES',
              providerModelId: 'coding',
              item: {
                type: 'tool_search_call',
                id: `native-${callId}`,
                call_id: callId,
                execution: 'client',
                status: 'completed',
                arguments: args
              }
            });
          await append('model.context', {
            role: 'tool_call',
            name,
            callId,
            arguments: args,
            content: ''
          });
        }
        const results = new Map<string, number>();
        const observations: CodeObservation[] = [];
        for (const callId of ['old', 'middle', 'latest']) {
          await append('tool.completed', {
            type: 'tool.completed',
            toolName: name,
            callId,
            truncated: false,
            ...(codeMode ? { parentCallId: 'cell' } : {})
          });
          const body = `${callId.toUpperCase()}_INSTRUCTION `.repeat(1200);
          const content =
            name === 'read'
              ? formatReadContextItem(
                  0,
                  {
                    path: '/workspace/source.ts',
                    encoding: 'utf-8',
                    newline: 'lf',
                    startLine: 1,
                    endLine: 1,
                    eof: true,
                    truncated: false,
                    previewComplete: true
                  },
                  body
                )
              : name === 'tool_search'
                ? 'Found one tool.'
                : body;
          if (codeMode) {
            observations.push({
              type: 'tool_result',
              id: callId,
              outcome: 'completed',
              source: { callId, toolName: name, input: args },
              result: { content }
            });
            continue;
          }
          const result = await append('model.context', {
            role: 'tool',
            name,
            callId,
            content,
            ...(name === 'tool_search'
              ? {
                  toolSearchTools: [
                    {
                      name: 'mcp__example__guide',
                      description: body,
                      inputSchema: { type: 'object', properties: {} }
                    }
                  ]
                }
              : {})
          });
          results.set(callId, result.sequence);
        }
        if (codeMode) {
          if (repeatObservation)
            observations.push({ ...observations.at(-1)!, id: 'latest-repeat' });
          await append('tool.completed', {
            type: 'tool.completed',
            toolName: 'code_exec',
            callId: 'cell',
            truncated: false,
            data: { cellId: 'cell', status: 'completed' }
          });
          const result = await append('model.context', {
            role: 'tool',
            callId: 'cell',
            name: 'code_exec',
            content: renderObservations(observations),
            observations
          });
          for (const observation of observations) results.set(observation.id, result.sequence);
        }
        for (let i = 0; i < 10; i++) {
          await append('model.attempt', { purpose: 'EXECUTION', state: 'STARTED' });
          await append('model.context', {
            role: 'provider',
            content: '',
            provider: 'OPENAI_RESPONSES',
            providerModelId: 'coding',
            item: { type: 'reasoning', id: `thinking-${i}`, encrypted_content: 'opaque' }
          });
          await append('usage.updated', {
            type: 'usage.updated',
            inputTokens: 6000,
            contextInputTokens: 6000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
          });
          await append('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' });
        }
        const records = (await store.readExecutionState(session.id)).contextRecords;
        const projection = buildContextProjection(records);
        const plan = planContextGc({
          records,
          messages: projection.entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
          messageSources: projection.entries.flatMap((entry) =>
            entry.message ? [entry.record] : []
          ),
          modelId: 'coding',
          modelProtocol: 'OPENAI_RESPONSES',
          contextWindowTokens: 10000,
          usage: {
            inputTokens: 6000,
            contextInputTokens: 6000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
          },
          system: 'System.',
          tools: [],
          workspace: '/workspace',
          platform: 'linux',
          activeProcessIds: new Set()
        });
        expect(plan).toBeDefined();
        const targetsCall = (value: ContextGcReplacement, callId: string) =>
          value.target.sequence === results.get(callId) &&
          value.target.observationId === (codeMode ? callId : undefined);
        const retainedId = repeatObservation ? 'latest-repeat' : 'latest';
        expect(plan!.draft.replacements.some((value) => targetsCall(value, retainedId))).toBe(
          false
        );
        await store.commitContextGc(session.id, plan!.draft);
        for (const callId of repeatObservation ? ['old', 'middle', 'latest'] : ['old', 'middle']) {
          const replacement = plan!.draft.replacements.find((value) => targetsCall(value, callId));
          expect(replacement).toBeDefined();
          expect(
            replacement!.kind === 'READ_OUTPUT_ITEMS'
              ? replacement!.items[0]!.evidenceSequence
              : replacement!.evidenceSequence
          ).toBe(results.get(retainedId));
        }
        await store.close();
        store = await JsonlSessionStore.open(home);
        const restored = buildContextProjection(
          (await store.readExecutionState(session.id)).contextRecords
        );
        const visible = JSON.stringify(restored.entries.flatMap((entry) => entry.message ?? []));
        expect(visible).toContain('LATEST_INSTRUCTION LATEST_INSTRUCTION');
        expect(visible).not.toContain('OLD_INSTRUCTION OLD_INSTRUCTION');
        expect(visible).not.toContain('MIDDLE_INSTRUCTION MIDDLE_INSTRUCTION');
      } finally {
        await store.close();
        await rm(home, { recursive: true, force: true });
      }
    }
  );
});
