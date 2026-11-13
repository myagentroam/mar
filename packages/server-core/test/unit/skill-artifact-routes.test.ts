import { mkdtemp, open, rm } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import { get } from 'node:http';
import { once } from 'node:events';
import Fastify from 'fastify';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillArtifactService } from '../../src/skill-artifact-service.js';
import { registerSkillTargetRoutes } from '../../src/skill-target-routes.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Skill artifact HTTP streaming', () => {
  it('closes the cache stream when an authenticated HTTP client interrupts its download', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mar-skill-artifact-'));
    temporaryDirectories.push(directory);
    const contentHash = 'c'.repeat(64);
    const handle = await open(path.join(directory, `${contentHash}.json`), 'wx');
    try {
      await handle.truncate(16 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    const service = new SkillArtifactService(directory);
    const ticket = service.issue('node-a', { contentHash } as never);
    const consume = service.consume.bind(service);
    let stream: ReadStream | undefined;
    let closed: Promise<unknown> | undefined;
    vi.spyOn(service, 'consume').mockImplementation(async (...args) => {
      stream = await consume(...args);
      closed = once(stream, 'close');
      return stream;
    });
    const app = Fastify();
    registerSkillTargetRoutes({
      app,
      database: { authenticateNode: async () => ({ id: 'node-a' }) } as never,
      nodeControl: {} as never,
      favorites: {} as never,
      artifacts: service,
      publicOrigin: undefined
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('LISTENER_INVALID');
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) =>
        get(
          `http://127.0.0.1:${address.port}/api/skill-artifacts/${ticket}`,
          { agent: false, headers: { 'x-mar-node-id': 'node-a', authorization: 'Bearer test' } },
          resolve
        ).once('error', reject)
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      const [chunk] = await once(response, 'data');
      response.destroy();
      await closed;
      expect(chunk.length).toBeLessThan(16 * 1024 * 1024);
      expect(stream?.closed).toBe(true);
    } finally {
      await app.close();
    }
  });
});
