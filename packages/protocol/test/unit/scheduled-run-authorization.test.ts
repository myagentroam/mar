import { describe, expect, it } from 'vitest';
import * as protocol from '../../src/index.js';

describe('Scheduled run authorization protocol', () => {
  const input = {
    taskId: 'task-1',
    revision: 1,
    occurrenceId: 'task-1:1000',
    sessionId: 'native-session',
    workspaceId: 'workspace',
    ownerUserId: 7,
    runner: 'mar-agent',
    modelId: 'model'
  };
  it('does not expose a dedicated restart authorization protocol', () => {
    expect(protocol).not.toHaveProperty('restartRunAuthorizeRequestSchema');
    expect(protocol).not.toHaveProperty('restartRunAuthorizeResponseSchema');
  });

  it('accepts only bounded scheduled requests with an authorized owner', () => {
    expect(protocol.scheduledRunAuthorizeRequestSchema.parse(input)).toEqual(input);
    for (const override of [
      { runner: 'unknown' },
      { ownerUserId: 0 },
      { sessionId: '' },
      { taskId: 'x'.repeat(201) },
      { revision: 0 },
      { occurrenceId: '' },
      { model: 'legacy-model' },
      { credential: 'do-not-send' }
    ])
      expect(
        protocol.scheduledRunAuthorizeRequestSchema.safeParse({ ...input, ...override }).success
      ).toBe(false);
  });
  it('preserves explicit authorization failures instead of accepting partial credentials', () => {
    expect(
      protocol.scheduledRunAuthorizeResponseSchema.parse({
        error: {
          code: 'WORKSPACE_ACCESS_DENIED',
          message: 'Workspace access is denied.'
        }
      })
    ).toMatchObject({ error: { code: 'WORKSPACE_ACCESS_DENIED' } });
    expect(protocol.scheduledRunAuthorizeResponseSchema.safeParse({}).success).toBe(false);
  });
});
