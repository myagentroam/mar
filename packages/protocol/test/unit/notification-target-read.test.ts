import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TARGET_READ_ID_LIMIT,
  notificationTargetReadSchema
} from '../../src/workbench-notification.js';

describe.each([
  {
    type: 'notification.session-read',
    nodeId: 'node',
    workspaceId: 'workspace',
    sessionId: 'session'
  },
  { type: 'notification.conversation-read', nodeId: 'node', conversationId: 'conversation' }
])('target read contract: $type', (target) => {
  it('requires explicit notification IDs instead of timestamp-based coverage', () => {
    expect(notificationTargetReadSchema.safeParse({ ...target, readAt: 200 }).success).toBe(false);
    expect(
      notificationTargetReadSchema.safeParse({
        ...target,
        readAt: 200,
        notificationIds: ['covered']
      }).success
    ).toBe(true);
  });

  it('bounds the confirmation payload', () => {
    const notificationIds = Array.from(
      { length: NOTIFICATION_TARGET_READ_ID_LIMIT },
      (_, i) => `id-${i}`
    );
    expect(
      notificationTargetReadSchema.safeParse({ ...target, readAt: 200, notificationIds }).success
    ).toBe(true);
    notificationIds.push('overflow');
    expect(
      notificationTargetReadSchema.safeParse({ ...target, readAt: 200, notificationIds }).success
    ).toBe(false);
  });
});
