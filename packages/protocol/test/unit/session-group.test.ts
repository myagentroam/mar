import { describe, expect, it } from 'vitest';
import {
  serverNotificationSchema,
  sessionGroupChangedSchema,
  sessionGroupSchema,
  sessionRunningCountsSchema
} from '../../src/index.js';

describe('Session group protocol', () => {
  it('accepts only the MAIN and CHILD classifications', () => {
    expect(sessionGroupSchema.parse('MAIN')).toBe('MAIN');
    expect(sessionGroupSchema.parse('CHILD')).toBe('CHILD');
    expect(() => sessionGroupSchema.parse('SUBAGENT')).toThrow();
  });

  it('validates bounded non-negative running counts for both groups', () => {
    expect(sessionRunningCountsSchema.parse({ MAIN: 2, CHILD: 1 })).toEqual({
      MAIN: 2,
      CHILD: 1
    });
    for (const invalid of [
      { MAIN: -1, CHILD: 0 },
      { MAIN: 0.5, CHILD: 0 },
      { MAIN: Number.MAX_SAFE_INTEGER + 1, CHILD: 0 },
      { MAIN: 0 }
    ])
      expect(() => sessionRunningCountsSchema.parse(invalid)).toThrow();
  });

  it('carries a strict parent-clear projection without exposing the parent ID', () => {
    const changed = {
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionGroup: 'MAIN'
    } as const;
    expect(sessionGroupChangedSchema.parse(changed)).toEqual(changed);
    expect(() => sessionGroupChangedSchema.parse({ ...changed, sessionGroup: 'CHILD' })).toThrow();
    expect(() =>
      sessionGroupChangedSchema.parse({ ...changed, parentSessionId: 'parent-session' })
    ).toThrow();
  });

  it('accepts a session group on Workspace notification targets', () => {
    const notification = {
      id: 'notification-1',
      kind: 'run',
      title: 'Run completed',
      message: 'The run completed.',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 86_401_000,
      read: false,
      target: {
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        sessionGroup: 'CHILD'
      }
    } as const;
    expect(serverNotificationSchema.parse(notification)).toEqual(notification);
  });
});
