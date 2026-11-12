import { describe, expect, it, vi } from 'vitest';
import { createCipheriv, createECDH, createHash } from 'node:crypto';
import webPush from 'web-push';
import { WebPushConfiguration } from '../../src/web-push-configuration.js';

function fixture(stored?: string, decodedJson = true) {
  const raw = {
    execute: vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT'))
        return [
          stored === undefined ? [] : [{ setting_value: decodedJson ? JSON.parse(stored) : stored }]
        ];
      if (sql.startsWith('INSERT') && stored === undefined) stored = String(values[1]);
      if (sql.startsWith('UPDATE') && stored !== undefined)
        stored = JSON.stringify({ ...JSON.parse(stored), enabled: JSON.parse(String(values[0])) });
      return [{ affectedRows: 1 }];
    })
  };
  const make = (
    key = Buffer.alloc(32, 7),
    origin: string | undefined = 'https://console.example.test',
    available = true
  ) => new WebPushConfiguration({ raw } as never, key, origin, () => available);
  return { make, raw, stored: () => stored };
}

describe('Web Push configuration', () => {
  it('normalizes a persisted short P-256 scalar without rotating its public key', async () => {
    const pair = createECDH('prime256v1');
    pair.setPrivateKey(Buffer.from([1]));
    const applicationKey = Buffer.alloc(32, 7);
    const encryptionKey = createHash('sha256')
      .update(applicationKey)
      .update('mar:web-push:encryption:v1')
      .digest();
    const iv = Buffer.alloc(12, 9);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(pair.getPrivateKey()), cipher.final()]);
    const publicKey = pair.getPublicKey().toString('base64url');
    const f = fixture(
      JSON.stringify({
        enabled: true,
        publicKey,
        sealedPrivateKey: [iv, cipher.getAuthTag(), ciphertext]
          .map((value) => value.toString('base64url'))
          .join('.')
      })
    );
    const keys = (await f.make().delivery())!;
    const privateKey = Buffer.from(keys.privateKey, 'base64url');
    expect(privateKey).toHaveLength(32);
    expect(privateKey.subarray(0, 31).equals(Buffer.alloc(31))).toBe(true);
    expect(privateKey[31]).toBe(1);
    expect(keys.publicKey).toBe(publicKey);
    expect(() =>
      webPush.getVapidHeaders(
        'https://fcm.googleapis.com',
        keys.subject,
        keys.publicKey,
        keys.privateKey,
        'aes128gcm'
      )
    ).not.toThrow();
  });

  it('defaults off without creating keys or leaking private configuration', async () => {
    const f = fixture();
    expect(await f.make().read()).toEqual({ enabled: false, available: true, publicKey: null });
    expect(f.stored()).toBeUndefined();
    expect(await f.make().delivery()).toBeUndefined();
  });

  it.each([true, false])(
    'persists one protected key pair across restarts with decoded JSON=%s',
    async (decodedJson) => {
      const f = fixture(undefined, decodedJson);
      await f.make().setEnabled(true);
      const keys = (await f.make().delivery())!;
      expect(keys.subject).toBe('https://console.example.test');
      expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
      expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
      expect(f.stored()).not.toContain(keys.privateKey);
      expect(await f.make().read()).toEqual({
        enabled: true,
        available: true,
        publicKey: keys.publicKey
      });
      await f.make().setEnabled(false);
      expect(await f.make().delivery()).toBeUndefined();
      await f.make().setEnabled(true);
      expect(await f.make().delivery()).toEqual(keys);
      expect(JSON.stringify(await f.make().read())).not.toContain(keys.privateKey);
    }
  );

  it('rejects unavailable transports, invalid VAPID contacts and invalid flags before writing', async () => {
    const f = fixture();
    await expect(f.make(undefined, undefined, false).setEnabled(true)).rejects.toThrow(
      'WEB_PUSH_UNAVAILABLE'
    );
    await expect(f.make(undefined, 'http://console.example.test').setEnabled(true)).rejects.toThrow(
      'WEB_PUSH_CONFIGURATION_INVALID'
    );
    await expect(f.make(undefined, 'mailto:invalid').setEnabled(true)).rejects.toThrow(
      'WEB_PUSH_CONFIGURATION_INVALID'
    );
    await expect(f.make().setEnabled('true' as never)).rejects.toThrow('WEB_PUSH_INPUT_INVALID');
    expect(f.stored()).toBeUndefined();
    await f.make(undefined, undefined, false).setEnabled(false);
  });

  it.each(['mailto:admin@example.test', 'https://localhost', 'https://contact.example.test/push'])(
    'accepts an independent VAPID contact %s',
    async (subject) => {
      const f = fixture();
      await f.make(undefined, subject).setEnabled(true);
      expect((await f.make(undefined, subject).delivery())?.subject).toBe(subject);
    }
  );

  it('fails closed on an incompatible runtime key without rotating a working subscription key', async () => {
    const f = fixture();
    await f.make().setEnabled(true);
    const before = f.stored();
    await expect(f.make(Buffer.alloc(32, 8)).setEnabled(true)).rejects.toThrow(
      'WEB_PUSH_CONFIGURATION_INVALID'
    );
    await expect(f.make(Buffer.alloc(32, 8)).delivery()).rejects.toThrow(
      'WEB_PUSH_CONFIGURATION_INVALID'
    );
    expect(f.stored()).toBe(before);
    expect((await f.make().delivery())?.publicKey).toBeTruthy();
  });

  it('keeps the winning key material when first enable requests race', async () => {
    const f = fixture();
    await Promise.all([f.make().setEnabled(true), f.make().setEnabled(true)]);
    expect(await f.make().delivery()).toEqual(await f.make().delivery());
    expect(f.raw.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(2);
  });
});
