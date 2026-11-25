import { describe, expect, it } from 'vitest';
import {
  notificationCreatedSchema,
  scheduledTaskNotificationPayloadSchema,
  serverNotificationSchema
} from '../../src/index.js';

const base = {
  id: 'notification-1',
  kind: 'run',
  title: 'Run completed',
  message: 'The run completed.',
  createdAt: 1_000,
  updatedAt: 1_000,
  expiresAt: 86_401_000,
  read: false
} as const;

describe('Server Workbench notification protocol', () => {
  it.each(['run', 'approval', 'plan', 'user-input', 'schedule', 'agent'] as const)(
    'accepts the %s notification kind with a complete Workspace target',
    (kind) => {
      const value = {
        ...base,
        kind,
        target: {
          targetType: 'WORKSPACE_SESSION',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          sessionName: 'Session one'
        }
      };
      expect(serverNotificationSchema.parse(value)).toEqual(value);
    }
  );

  it('accepts a complete hosted-conversation target and notification-created event', () => {
    const notification = {
      ...base,
      kind: 'schedule',
      target: {
        targetType: 'HOSTED_CONVERSATION',
        nodeId: 'node-1',
        conversationId: 'conversation-1',
        conversationName: 'Planning'
      }
    };
    expect(notificationCreatedSchema.parse({ type: 'notification.created', notification })).toEqual(
      { type: 'notification.created', notification }
    );
  });

  it('rejects incomplete, mismatched, or extended target variants', () => {
    const validWorkspace = {
      targetType: 'WORKSPACE_SESSION',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1'
    };
    const validHosted = {
      targetType: 'HOSTED_CONVERSATION',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      conversationName: 'Planning'
    };
    for (const target of [
      { ...validWorkspace, workspaceId: undefined },
      { ...validWorkspace, conversationId: 'conversation-1' },
      { ...validHosted, conversationId: undefined },
      { ...validHosted, workspaceId: 'workspace-1' },
      { nodeId: 'node-1', workspaceId: 'workspace-1', sessionId: 'session-1' },
      { ...validWorkspace, targetType: 'UNKNOWN' }
    ])
      expect(serverNotificationSchema.safeParse({ ...base, target }).success).toBe(false);
  });

  it('accepts task-only independent scheduler events and rejects mixed targets', () => {
    const target = {
      targetType: 'SCHEDULED_TASK',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      taskName: 'Check status'
    };
    const event = {
      ...target,
      userId: 7,
      runId: 'occurrence-1',
      occurredAt: 1000,
      notificationId: 'schedule:task-1:occurrence-1'
    };
    const occurrence = { kind: 'occurrence', id: 'occurrence-1' };
    const proposal = { kind: 'proposal', id: 'proposal-1' };
    for (const fields of [
      {
        kind: 'SCHEDULE_FAILED',
        code: 'SCHEDULE_SUBMISSION_OUTCOME_UNKNOWN',
        reference: occurrence
      },
      { kind: 'SCHEDULE_SKIPPED', code: 'SCHEDULE_EXPIRED', reference: occurrence },
      { kind: 'SCHEDULE_PROPOSAL', reference: proposal },
      { kind: 'SCHEDULE_TERMINAL', outcome: 'SUCCEEDED', reference: occurrence }
    ])
      expect(scheduledTaskNotificationPayloadSchema.parse({ ...event, ...fields })).toEqual({
        ...event,
        ...fields
      });
    for (const fields of [
      { kind: 'SCHEDULE_PROPOSAL', reference: proposal, sessionId: 'bootstrap' },
      { kind: 'SCHEDULE_PROPOSAL', reference: proposal, taskId: undefined },
      { kind: 'SCHEDULE_PROPOSAL', reference: occurrence },
      { kind: 'SCHEDULE_TERMINAL', reference: occurrence, outcome: 'RUNNING' },
      { kind: 'AGENT_MESSAGE' }
    ])
      expect(
        scheduledTaskNotificationPayloadSchema.safeParse({ ...event, ...fields }).success
      ).toBe(false);
    const notification = {
      ...base,
      kind: 'schedule',
      target: { ...target, nodeId: 'node-1', reference: occurrence }
    };
    expect(notificationCreatedSchema.parse({ type: 'notification.created', notification })).toEqual(
      { type: 'notification.created', notification }
    );
  });

  it('keeps source Web-local and rejects missing or unknown wire fields and kinds', () => {
    const valid = {
      ...base,
      target: {
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1'
      }
    };
    expect(serverNotificationSchema.safeParse({ ...valid, source: 'server' }).success).toBe(false);
    expect(serverNotificationSchema.safeParse({ ...valid, kind: 'desktop-system' }).success).toBe(
      false
    );
    const { expiresAt: _expiresAt, ...missingRequiredField } = valid;
    expect(serverNotificationSchema.safeParse(missingRequiredField).success).toBe(false);
    expect(serverNotificationSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});
