import { expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from '@myagentroam/agent';
import { SessionObservations } from '../src/observations.js';
import {
  nativeChildSnapshot,
  projectChildEvent,
  publicChildSnapshot,
  type ChildSnapshot
} from '../src/snapshot.js';

function event(type: string, values: Record<string, unknown>): AgentEvent {
  return {
    type,
    sessionId: 'child',
    executionId: 'execution',
    eventId: 'event',
    sequence: 1,
    timestamp: '2026-01-01T00:00:00Z',
    ...values
  } as AgentEvent;
}

it.each(['execution.failed', 'execution.cancelled'] as const)(
  'does not present an earlier final message as a summary after %s',
  (terminal) => {
    const snapshot: ChildSnapshot = { changedFiles: [] };
    projectChildEvent(
      snapshot,
      event('message.completed', { phase: 'final_answer', text: 'premature', turnId: 'turn' })
    );
    projectChildEvent(snapshot, event(terminal, {}));
    expect(publicChildSnapshot(snapshot)).not.toHaveProperty('summary');

    let receive!: (value: AgentEvent) => void;
    const observations = new SessionObservations();
    observations.observe({
      id: 'child',
      subscribe(listener) {
        receive = listener;
        return { activeExecutionId: 'execution', unsubscribe() {} };
      }
    } as unknown as AgentSession);
    receive(
      event('message.completed', { phase: 'final_answer', text: 'premature', turnId: 'turn' })
    );
    receive(event(terminal, {}));
    const content = observations.collect(new AbortController().signal)[0]!.content;
    const payload = JSON.parse(content.slice(content.indexOf('\n') + 1, content.lastIndexOf('\n')));
    expect(payload).not.toHaveProperty('summary');
    observations.close();
  }
);

it('deduplicates native read evidence and excludes native-only fields from model projections', () => {
  const snapshot: ChildSnapshot = { changedFiles: [] };
  projectChildEvent(
    snapshot,
    event('tool.completed', {
      toolName: 'read',
      summary: 'read',
      data: {
        results: [
          { path: 'source.ts', startLine: 1, endLine: 3 },
          { path: 'source.ts', startLine: 1, endLine: 3 },
          { path: 'source.ts', startLine: 0, endLine: 'invalid' },
          { path: 'failed.ts', error: 'unavailable' },
          { path: 42 }
        ]
      }
    }),
    true
  );
  projectChildEvent(
    snapshot,
    event('tool.completed', { toolName: 'exec', summary: 'Verified.' }),
    true
  );
  projectChildEvent(
    snapshot,
    event('message.completed', {
      itemId: 'answer',
      phase: 'final_answer',
      text: 'done',
      turnId: 'turn'
    }),
    true
  );
  expect(nativeChildSnapshot(snapshot)).toMatchObject({
    evidence: [{ path: 'source.ts', startLine: 1, endLine: 3 }, { path: 'source.ts' }],
    verification: ['Verified.'],
    latestMessage: { text: 'done', turnId: 'turn' },
    latestActivity: { kind: 'message', phase: 'final_answer' }
  });
  expect(publicChildSnapshot(snapshot)).not.toHaveProperty('evidence');
  expect(publicChildSnapshot(snapshot)).not.toHaveProperty('verification');
  expect(publicChildSnapshot(snapshot)).not.toHaveProperty('latestMessage');
});

it('projects bounded final answers, distinct changed paths and truncation without corrupting UTF-8', () => {
  const snapshot: ChildSnapshot = { changedFiles: [] };
  projectChildEvent(
    snapshot,
    event('message.completed', { phase: 'final_answer', text: '中'.repeat(6000), turnId: 'turn' })
  );
  const files = Array.from({ length: 201 }, (_, index) => ({ path: `file-${index}` }));
  files.push({ path: 'file-1' });
  projectChildEvent(
    snapshot,
    event('tool.completed', { toolName: 'apply_patch', data: { files } })
  );
  const result = publicChildSnapshot(snapshot);
  expect(result).toMatchObject({
    summaryTruncated: true,
    turnId: 'turn',
    changedFilesTruncated: true
  });
  expect(Buffer.byteLength(result.summary!, 'utf8')).toBeLessThanOrEqual(16_384);
  expect(result.summary).not.toContain('\ufffd');
  expect(result.changedFiles).toHaveLength(200);
  expect(result.changedFiles?.filter((path) => path === 'file-1')).toHaveLength(1);
});

it('delivers final summary and changed paths once without duplicating the same final message', () => {
  let receive!: (event: AgentEvent) => void;
  const session = {
    id: 'child',
    subscribe(listener: (event: AgentEvent) => void) {
      receive = listener;
      return { activeExecutionId: 'execution', unsubscribe() {} };
    }
  } as unknown as AgentSession;
  const observations = new SessionObservations();
  observations.observe(session);
  receive(
    event('message.completed', { phase: 'final_answer', text: 'Complete answer', turnId: 'turn' })
  );
  receive(
    event('tool.completed', {
      toolName: 'apply_patch',
      data: { files: [{ path: 'old.ts', targetPath: 'new.ts' }, { path: 'old.ts' }] }
    })
  );
  receive(event('execution.completed', {}));
  const captured = observations.collect(new AbortController().signal);
  expect(captured).toHaveLength(1);
  const content = captured[0]!.content;
  expect(content).toContain('Complete answer');
  expect(content.match(/Complete answer/g)).toHaveLength(1);
  expect(content).toContain('old.ts');
  expect(content).toContain('new.ts');
  expect(content).toContain('turn');
  captured[0]!.acknowledge();
  expect(observations.collect(new AbortController().signal)).toEqual([]);
  observations.close();
});
