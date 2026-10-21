import { describe, expect, it } from 'vitest';
import { conversationItemSchema, permissionStopSchema } from '../../src/index.js';

const stop = {
  action: 'ask',
  reason: 'Confirm the shared target.',
  source: {
    sessionId: 'session-1',
    executionId: 'execution-1',
    callId: 'call-1',
    toolName: 'exec',
    parentCallId: 'cell-1'
  }
};
describe('Permission stop projection', () => {
  it('preserves a bounded stop in current and historical conversation items', () => {
    const item = {
      id: 'item-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: null,
      parentItemId: null,
      sourceSequence: 1,
      revision: 0,
      status: 'COMPLETED',
      startedAt: 1,
      completedAt: 2,
      kind: 'assistant_message',
      payload: { text: '', format: 'markdown', model: null },
      permissionStop: stop
    };
    expect(conversationItemSchema.parse(item).permissionStop).toEqual(stop);
    expect(
      conversationItemSchema.parse({ ...item, permissionStop: undefined }).permissionStop
    ).toBeUndefined();
  });
  it('rejects allow, empty reasons and unbounded public metadata', () => {
    for (const changed of [
      { action: 'allow' },
      { reason: '' },
      { reason: ' '.repeat(2) },
      { reason: 'x'.repeat(241) },
      { source: { ...stop.source, callId: '' } }
    ])
      expect(permissionStopSchema.safeParse({ ...stop, ...changed }).success).toBe(false);
  });
});
