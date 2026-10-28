import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestServerApp as createServerApp } from '../support/create-test-server-app.js';

describe('Server smoke', () => {
  it('returns an ok health response', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'myagentroam-server-smoke-'));
    const app = createServerApp({ databasePath: ':memory:', dataDirectory, logger: true });
    try {
      const response = await app.inject({ method: 'GET', url: '/health?credential=must-not-log' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      const log = await readFile(join(dataDirectory, 'logs', 'server.log'), 'utf8');
      expect(log).toContain('request_completed');
      expect(log).not.toContain('credential');
      expect(log).not.toContain('must-not-log');
    } finally {
      await app.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
