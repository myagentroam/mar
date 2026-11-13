import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { SkillNetworkPolicy } from '../../ee/server/src/skill/skill-network-policy.js';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup }));

async function startLocalHttpsServer() {
  const fixtureDirectory = new URL('../../mar-agent/test/fixtures/', import.meta.url);
  const [key, cert] = await Promise.all([
    readFile(new URL('localhost-test-key.pem', fixtureDirectory)),
    readFile(new URL('localhost-test-cert.pem', fixtureDirectory))
  ]);
  const requests: string[] = [];
  const server = createHttpsServer({ key, cert }, (request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/plain' }).end('local response');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    requests,
    url: `https://127.0.0.1:${address.port}/skill`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
    }
  };
}

describe('Server Skill TLS policy', () => {
  it('Certificate verification stays enabled by default and risky opt-outs are explicitly persisted', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ setting_value: 'true' }], []]);
    const policy = new SkillNetworkPolicy({ raw: { execute } } as unknown as MysqlServerDatabase);

    await expect(policy.disabled()).resolves.toBe(false);
    await policy.setDisabled(true);
    await expect(policy.disabled()).resolves.toBe(true);
    expect(execute.mock.calls[1]?.[1]).toEqual([
      'skill_tls_verification_disabled',
      'true',
      expect.any(Number)
    ]);
  });

  it('requests a loopback HTTPS URL without pre-resolving and retains the TLS opt-out', async () => {
    const server = await startLocalHttpsServer();
    lookup.mockReset().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[{ setting_value: 'false' }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const policy = new SkillNetworkPolicy({ raw: { execute } } as unknown as MysqlServerDatabase);
    try {
      await expect(policy.fetch(server.url)).rejects.toThrow();
      await policy.setDisabled(true);
      const response = await policy.fetch(server.url);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('local response');
      await expect(policy.fetch(server.url.replace('https:', 'http:'))).rejects.toThrow(
        'SKILL_SOURCE_TLS_FAILED'
      );
      expect(server.requests).toEqual(['/skill']);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
