import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerNodeRegistrationRoute } from '../../src/node-registration-route.js';
import { hashOpaque } from '../../src/session-token.js';

describe('Shared Node registration display name', () => {
  it.each([
    [undefined, 200, null],
    [' Node ', 200, 'Node'],
    ['', 400, null],
    [null, 400, null],
    [42, 400, null],
    ['x'.repeat(129), 400, null]
  ])('validates an optional supplied name: %s', async (displayName, status, expected) => {
    const app = Fastify();
    const createToken = vi.fn(async () => ({ token: 'fixture', expiresAt: 100 }));
    registerNodeRegistrationRoute({
      app,
      sessions: {
        findCurrentUserSession: () => ({
          userId: 1,
          username: 'admin',
          isAdmin: true,
          sessionHash: 'fixture',
          mustChangePassword: false,
          csrfTokenHash: hashOpaque('csrf')
        })
      },
      publicOrigin: 'http://localhost',
      requireDisplayName: false,
      authorize: () => {},
      createToken,
      onError: (reply) => reply.code(500).send({})
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/node-registration-tokens',
        headers: {
          origin: 'http://localhost',
          cookie: 'mar_user_session=fixture',
          'x-csrf-token': 'csrf'
        },
        payload: displayName === undefined ? {} : { displayName }
      });
      expect(response.statusCode).toBe(status);
      if (status === 200) {
        expect(createToken).toHaveBeenCalledWith(
          1,
          600_000,
          { ownerType: 'PERSONAL', ownerUserId: 1 },
          expected
        );
      } else {
        expect(createToken).not.toHaveBeenCalled();
        expect(response.json().error.code).toBe('NODE_DISPLAY_NAME_INVALID');
      }
    } finally {
      await app.close();
    }
  });
});
