import { describe, expect, it } from 'vitest';
import { createServerHttp } from '../../src/composition/server-http.js';

describe('server HTTP startup budget', () => {
  it('waits long enough for a fresh database migration to finish', async () => {
    const { app } = createServerHttp({ dataDirectory: '/tmp' });
    try {
      expect(app.initialConfig.pluginTimeout).toBe(180_000);
    } finally {
      await app.close();
    }
  });
});
