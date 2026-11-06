import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@myagentroam/agent';
import { boundedConversationItemId } from '../../src/runner/normalization.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import { projectConversationEvent } from '../../src/session/runtime/conversation-projection.js';
import type { NodeAgentRun, NodeConversationTurn } from '../../src/runtime-model.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';

describe('Bounded runner item identities', () => {
  it.each([0, 1, 81])('preserves an already bounded ID with a %i-character value', (length) => {
    const value = 'x'.repeat(length);
    expect(boundedConversationItemId('runner', value)).toBe(`runner:${value}`);
  });

  it('distinguishes long IDs that differ only in their suffix and remains deterministic', () => {
    const prefix = 'mar-agent-reasoning';
    const common = '11111111-1111-4111-8111-111111111111:rs_'.padEnd(160, 'a');
    const values = [0, 1, 2].map((index) => `${common}:${index}`);
    const ids = values.map((value) => boundedConversationItemId(prefix, value));

    expect(new Set(ids).size).toBe(values.length);
    for (const [index, id] of ids.entries()) {
      expect(id.length).toBeLessThanOrEqual(88);
      expect(id.startsWith(`${prefix}:`)).toBe(true);
      expect(boundedConversationItemId(prefix, values[index]!)).toBe(id);
    }
  });

  it('bounds long namespaces without discarding their distinguishing suffixes', () => {
    const common = 'official:'.padEnd(120, 'a');
    const ids = ['first', 'second'].map((suffix) =>
      boundedConversationItemId(`${common}:${suffix}`, 'same-native-item')
    );

    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(88);
  });
});

describe('MAR Agent reasoning item identities', () => {
  it.each(['summary', 'visible_thinking'] as const)(
    'retains every long-ID %s record in live projection and history replay',
    (representation) => {
      const scope = '11111111-1111-4111-8111-111111111111';
      const nativeId = `rs_${'a'.repeat(48)}`;
      const identities = [
        [scope, nativeId, 0],
        [scope, nativeId, 1],
        [scope, nativeId, 2],
        [scope, `${nativeId}-next`, 0],
        ['11111111-1111-4111-8111-111111111112', nativeId, 0]
      ] as const;
      const events: Extract<AgentEvent, { type: 'reasoning.completed' }>[] = identities.map(
        ([requestScope, itemId, summaryIndex], index) => ({
          type: 'reasoning.completed',
          eventId: `reasoning-${index}`,
          sequence: index + 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: 'session',
          executionId: 'execution',
          turnId: 'turn',
          itemId: `${requestScope}:${JSON.stringify([itemId, summaryIndex])}`,
          representation,
          text: `Public reasoning ${index}`
        })
      );
      const run: NodeAgentRun = {
        id: 'run',
        sessionId: 'session',
        nodeId: 'node',
        workspaceId: 'workspace',
        runner: 'mar-agent',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        version: 1,
        clientMessageId: 'client-message',
        createdAt: 1,
        startedAt: 1,
        completedAt: null,
        updatedAt: 1
      };
      let live: NodeConversationTurn = {
        id: 'turn',
        sessionId: 'session',
        runId: run.id,
        userItemId: null,
        status: 'RUNNING',
        model: null,
        effort: null,
        access: null,
        items: [],
        startedAt: 1,
        completedAt: null
      };
      const normalizer = new MarAgentConversationNormalizer();
      const replay = [...events, events.at(-1)!];
      for (const [index, event] of replay.entries()) {
        const [item] = normalizer.normalize(event);
        expect(item).toBeDefined();
        expect(item!.itemId.length).toBeLessThanOrEqual(88);
        live = projectConversationEvent(
          live,
          run,
          {
            runId: run.id,
            sequence: index + 1,
            eventType: 'conversation.item',
            payload: item!,
            createdAt: index + 1
          },
          false
        );
        expect(live.items.map((entry) => entry.payload)).toEqual(
          events.slice(0, Math.min(index + 1, events.length)).map((entry) => ({
            representation,
            sections: [{ index: 0, text: entry.text }]
          }))
        );
      }

      const session = {
        id: 'session',
        runner: 'mar-agent',
        modelId: null,
        effort: null,
        access: null
      } as NodeAgentSession;
      const [history] = projectMarAgentHistory(
        session,
        replay.map((event, index) => ({ kind: 'event', sequence: index + 1, event }))
      );

      expect(history?.items.map((item) => item.payload)).toEqual(
        live.items.map((item) => item.payload)
      );
      expect(history?.items.map((item) => item.id)).toEqual(
        live.items.map((item) => item.id.slice(`${run.id}:`.length))
      );
    }
  );
});
