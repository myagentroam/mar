import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, validateServerUrl } from '../../src/config.mjs';

const token = `marctl_user_e30.${'x'.repeat(43)}`;
const context = {
  MAR_CTL_CONTEXT_REQUIRED: '1',
  MAR_CTL_SERVER_URL: 'https://server.test',
  MAR_CTL_USER_TOKEN: token
};

test('uses only the scoped MAR execution credential', async () => {
  assert.deepEqual(await loadConfig({ env: { ...context, MAR_CTL_KEY: 'obsolete-key' } }), {
    serverUrl: 'https://server.test',
    key: token
  });
});

test('rejects missing context, incomplete credentials and deployment keys', async () => {
  for (const env of [
    {},
    { MAR_CTL_SERVER_URL: 'https://server.test', MAR_CTL_KEY: 'obsolete-key' },
    { ...context, MAR_CTL_CONTEXT_REQUIRED: undefined },
    { ...context, MAR_CTL_CONTEXT_REQUIRED: '0' },
    { ...context, MAR_CTL_SERVER_URL: '' },
    { ...context, MAR_CTL_USER_TOKEN: '' },
    { ...context, MAR_CTL_USER_TOKEN: `marctl_user_${'x'.repeat(43)}` },
    { ...context, MAR_CTL_USER_TOKEN: `${token}.extra` },
    { ...context, MAR_CTL_USER_TOKEN: `marctl_user_${'x'.repeat(16_384)}.${'x'.repeat(43)}` },
    { ...context, MAR_CTL_USER_TOKEN: `marctl_${'x'.repeat(43)}` },
    { ...context, MAR_CTL_USER_TOKEN: `marmgr_${'x'.repeat(43)}` }
  ]) {
    await assert.rejects(loadConfig({ env }), /no valid marctl user authorization/u);
  }
});

test('never falls back to a legacy home configuration', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'marctl-internal-'));
  try {
    await mkdir(path.join(home, '.marctl'));
    await writeFile(
      path.join(home, '.marctl/default.env'),
      'MAR_CTL_SERVER_URL=https://external.test\nMAR_CTL_KEY=obsolete-key\n',
      { mode: 0o600 }
    );
    await assert.rejects(
      loadConfig({ env: { HOME: home } }),
      /no valid marctl user authorization/u
    );
    await assert.rejects(
      loadConfig({ env: { ...context, HOME: home, MAR_CTL_USER_TOKEN: '' } }),
      /no valid marctl user authorization/u
    );
    assert.deepEqual(await loadConfig({ env: { ...context, HOME: home } }), {
      serverUrl: 'https://server.test',
      key: token
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('validates the injected Server origin and transport', async () => {
  assert.equal(validateServerUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(validateServerUrl('http://[::1]:3000'), 'http://[::1]:3000');
  assert.equal(validateServerUrl('https://example.test'), 'https://example.test');
  for (const serverUrl of [
    'http://example.test',
    'https://example.test/path',
    'https://user:password@example.test',
    'https://example.test?token=hidden',
    'not-a-url'
  ]) {
    await assert.rejects(loadConfig({ env: { ...context, MAR_CTL_SERVER_URL: serverUrl } }));
  }
});
