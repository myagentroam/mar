import { describe, expect, it } from 'vitest';
import {
  restartRunAuthorizeRequestSchema,
  restartRunAuthorizeResponseSchema
} from '../../src/index.js';

describe('Orderly restart authorization', () => {
  const input = {
    handoffId: 'handoff-1',
    sessionId: 'native-session',
    workspaceId: 'workspace',
    ownerUserId: 7,
    runner: 'mar-agent',
    model: 'model'
  };
  it('accepts only bounded MAR Agent requests with an initiating user', () => {
    expect(restartRunAuthorizeRequestSchema.parse(input)).toEqual(input);
    for (const override of [
      { runner: 'codex' },
      { runner: 'opencode' },
      { ownerUserId: 0 },
      { sessionId: '' },
      { handoffId: 'x'.repeat(201) },
      { credential: 'do-not-send' }
    ])
      expect(restartRunAuthorizeRequestSchema.safeParse({ ...input, ...override }).success).toBe(
        false
      );
  });
  it('preserves explicit authorization failures instead of accepting partial credentials', () => {
    expect(
      restartRunAuthorizeResponseSchema.parse({
        error: {
          code: 'WORKSPACE_ACCESS_DENIED',
          message: 'Workspace access is denied.'
        }
      })
    ).toMatchObject({ error: { code: 'WORKSPACE_ACCESS_DENIED' } });
    expect(restartRunAuthorizeResponseSchema.safeParse({}).success).toBe(false);
  });
});
