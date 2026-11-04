import { describe, expect, it } from 'vitest';
import { agentOperationPresentationSchema, subagentCallDetailSchema } from '../../src/index.js';

describe('Agent operation detail facts', () => {
  it('bounds the native current-call message independently of target result fields', () => {
    expect(subagentCallDetailSchema.parse({ message: 'hello', messageTruncated: true })).toEqual({
      message: 'hello',
      messageTruncated: true
    });
    expect(subagentCallDetailSchema.safeParse({ message: 'x'.repeat(2001) }).success).toBe(false);
  });
  it('round trips bounded per-call detail without changing the legacy form', () => {
    const legacy = { action: 'SEND', targets: [{ agentId: 'a' }] };
    expect(agentOperationPresentationSchema.parse(legacy)).toEqual(legacy);
    const current = {
      action: 'WAIT',
      detail: { message: 'hello', delivery: 'QUEUE', error: 'CODE', failed: true },
      targets: [
        {
          agentId: 'a',
          title: 'Task',
          status: 'RUNNING',
          message: 'progress',
          messageTruncated: true
        }
      ]
    };
    expect(agentOperationPresentationSchema.parse(current)).toEqual(current);
  });
  it('rejects overlong facts and unknown delivery choices', () => {
    expect(
      agentOperationPresentationSchema.safeParse({
        action: 'SEND',
        targets: [],
        detail: { message: 'x'.repeat(2001) }
      }).success
    ).toBe(false);
    expect(
      agentOperationPresentationSchema.safeParse({
        action: 'SEND',
        targets: [],
        detail: { delivery: 'OTHER' }
      }).success
    ).toBe(false);
    expect(
      agentOperationPresentationSchema.safeParse({
        action: 'WAIT',
        targets: [{ agentId: 'a', message: 'x'.repeat(801) }]
      }).success
    ).toBe(false);
  });
});
