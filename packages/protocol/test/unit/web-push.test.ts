import { describe, expect, it } from 'vitest';
import { webPushRegistrationSchema } from '../../src/index.js';

const registration = {
  clientKind: 'mobile',
  clientToken: 't'.repeat(43),
  subscription: {
    endpoint: 'https://fcm.googleapis.com/fcm/send/client',
    keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) }
  }
};

describe('Web Push registration protocol', () => {
  it('accepts an explicitly mobile registration and defaults enabled', () => {
    expect(webPushRegistrationSchema.parse(registration)).toEqual({
      ...registration,
      enabled: true
    });
  });

  it('rejects legacy registrations without a client kind and unsupported client kinds', () => {
    const { clientKind: _clientKind, ...legacyRegistration } = registration;
    expect(webPushRegistrationSchema.safeParse(legacyRegistration).success).toBe(false);
    for (const clientKind of ['desktop', 'tablet', ''])
      expect(webPushRegistrationSchema.safeParse({ ...registration, clientKind }).success).toBe(
        false
      );
  });

  it('rejects unknown registration fields', () => {
    expect(webPushRegistrationSchema.safeParse({ ...registration, userId: 1 }).success).toBe(false);
  });
});
