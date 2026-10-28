import { describe, expect, it, vi } from 'vitest';
import { CredentialCatalogService } from '../../src/credential-catalog-service.js';
import { credentialRecordSchema } from '../../src/credential-document.js';

const credential = credentialRecordSchema.parse({
  id: 'credential',
  name: 'Credential',
  type: 'CODEX_OAUTH',
  ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
  status: 'ACTIVE',
  accessToken: 'access',
  refreshToken: 'refresh',
  accountId: 'account',
  accessTokenExpiresAt: null,
  lastRefreshAt: null,
  lastCheckedAt: null,
  proxy: null,
  revision: 1,
  createdAt: 0,
  updatedAt: 0
});
const response = () => new Response(JSON.stringify({ models: [] }), { status: 200 });

describe('credential catalog coordination', () => {
  it('shares in-flight reads and reloads after settlement', async () => {
    let release!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const read = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(response());
    const accept = vi.fn().mockResolvedValue(true);
    const service = new CredentialCatalogService({
      resolve: async () => credential,
      response: read,
      markReauthentication: async () => true,
      accept,
      now: () => 1
    });
    const left = service.load('credential');
    const right = service.load('credential');
    expect(left).toBe(right);
    release(response());
    expect(await left).toEqual(await right);
    expect(read).toHaveBeenCalledTimes(1);
    await service.load('credential');
    expect(read).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it('discards a stale credential snapshot and resolves a fresh one before returning', async () => {
    const replacement = { ...credential, accessToken: 'replacement', revision: 2 };
    const resolve = vi.fn().mockResolvedValueOnce(credential).mockResolvedValueOnce(replacement);
    const read = vi.fn(async (_value: typeof credential) => response());
    const accept = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const service = new CredentialCatalogService({
      resolve,
      response: read,
      markReauthentication: async () => true,
      accept,
      now: () => 1
    });
    await service.load('credential');
    expect(read.mock.calls.map(([value]) => value.accessToken)).toEqual(['access', 'replacement']);
    expect(accept).toHaveBeenCalledTimes(2);
  });
});
