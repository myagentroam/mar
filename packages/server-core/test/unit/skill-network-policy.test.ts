import { readFile } from 'node:fs/promises';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { SkillDiscoveryService } from '../../src/skill-discovery-service.js';
import { publicHttpsFetch } from '../../src/skill-network-policy.js';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup }));

async function startLocalHttpsServer() {
  const fixtureDirectory = new URL('../../../../mar-agent/test/fixtures/', import.meta.url);
  const [key, cert] = await Promise.all([
    readFile(new URL('localhost-test-key.pem', fixtureDirectory)),
    readFile(new URL('localhost-test-cert.pem', fixtureDirectory))
  ]);
  const requests: string[] = [];
  const server = https.createServer({ key, cert }, (request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/not-followed' }).end();
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({ skills: [{ name: 'demo', skillId: 'demo', source: 'example/skills' }] })
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    requests,
    origin: `https://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
    }
  };
}

describe('Server catalog HTTPS policy', () => {
  it('uses the unverified transport for both default skills.sh discovery calls without pre-resolving', async () => {
    const server = await startLocalHttpsServer();
    const request = https.request;
    const routed = vi.spyOn(https, 'request').mockImplementation((url, options, callback) => {
      const upstream = new URL(String(url));
      expect(upstream.origin).toBe('https://skills.sh');
      return request(
        new URL(upstream.pathname + upstream.search, server.origin),
        options,
        callback
      );
    });
    lookup.mockReset().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    try {
      const source = {
        id: 'skills-sh',
        kind: 'SKILLS_SH',
        locator: 'skills.sh',
        enabled: true
      } as const;
      const discovery = new SkillDiscoveryService();
      const candidates = [expect.objectContaining({ id: 'example/skills/demo' })];
      await expect(discovery.search(source, '', 10)).resolves.toEqual(candidates);
      await expect(discovery.search(source, 'demo', 10)).resolves.toEqual(candidates);
      expect(server.requests).toEqual(['/api/skills/hot/0', '/api/search?q=demo&limit=10']);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      routed.mockRestore();
      await server.close();
    }
  });

  it('accepts untrusted certificates on arbitrary registry HTTPS URLs without following redirects', async () => {
    const server = await startLocalHttpsServer();
    try {
      const registryPath = '/custom/v0.1/servers?version=latest';
      const response = await publicHttpsFetch(server.origin + registryPath);
      expect(response.status).toBe(200);
      const redirect = await publicHttpsFetch(server.origin + '/redirect');
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('location')).toBe('/not-followed');
      expect(server.requests).toEqual([registryPath, '/redirect']);
    } finally {
      await server.close();
    }
  });

  it('still rejects non-HTTPS URLs before connecting', async () => {
    const request = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('Unexpected outbound request');
    });
    try {
      await expect(publicHttpsFetch('http://example.test/registry')).rejects.toThrow(
        'SKILL_SOURCE_TLS_FAILED'
      );
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
});
