import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerUsageReader, USAGE_OAUTH_REQUIRED } from '../../src/runner-usage.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('Runner account usage', () => {
  it('uses only local Codex OAuth credentials for the fixed official endpoint and reuses results within the short cache', async () => {
    const home = await fixture('.codex/auth.json', {
      tokens: { access_token: 'oauth-token', account_id: 'account-1' }
    });
    const requests: { url: string; headers: Headers }[] = [];
    let now = 1_000;
    const reader = new RunnerUsageReader(
      async (url, init) => {
        requests.push({ url, headers: new Headers(init.headers) });
        return json({
          rate_limit: {
            // Window roles are not stable duration names: deliberately return
            // the weekly bucket first to verify labels follow its duration.
            primary_window: {
              used_percent: 42,
              reset_at: 2_000,
              limit_window_seconds: 7 * 24 * 60 * 60
            },
            secondary_window: {
              used_percent: 71,
              reset_at: '1970-01-01T00:00:03.000Z',
              limit_window_seconds: 5 * 60 * 60
            }
          }
        });
      },
      home,
      () => now
    );

    await expect(reader.status('codex')).resolves.toEqual({
      runner: 'codex',
      available: true,
      reasonCode: null
    });
    await expect(reader.read('codex')).resolves.toMatchObject({
      runner: 'codex',
      cached: false,
      windows: [
        {
          id: 'primary_window',
          label: '7-day limit',
          usedPercentage: 42,
          resetsAt: 2_000_000
        },
        {
          id: 'secondary_window',
          label: '5-hour limit',
          usedPercentage: 71,
          resetsAt: 3_000
        }
      ]
    });
    now += 1;
    await expect(reader.read('codex')).resolves.toMatchObject({ cached: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://chatgpt.com/backend-api/wham/usage' });
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer oauth-token');
    expect(requests[0]?.headers.get('chatgpt-account-id')).toBe('account-1');
  });

  it('accepts only official Claude Code OAuth credentials and rejects usage queries for API keys or third-party configuration', async () => {
    const home = await fixture('.claude/.credentials.json', { apiKey: 'third-party-key' });
    const reader = new RunnerUsageReader(async () => json({}), home);
    await expect(reader.status('claude-code')).resolves.toEqual({
      runner: 'claude-code',
      available: false,
      reasonCode: USAGE_OAUTH_REQUIRED
    });
    await expect(reader.read('claude-code')).rejects.toThrow(USAGE_OAUTH_REQUIRED);
  });

  it('normalizes the official Claude OAuth window without requiring Runner capability', async () => {
    const home = await fixture('.claude/.credentials.json', {
      claudeAiOauth: { accessToken: 'claude-oauth-token' }
    });
    const reader = new RunnerUsageReader(
      async () =>
        json({
          five_hour: { utilization: 35, resets_at: '2026-08-18T12:00:00.000Z' },
          seven_day: { utilization: 15, resets_at: '2026-08-20T12:00:00.000Z' }
        }),
      home
    );
    await expect(reader.read('claude-code')).resolves.toMatchObject({
      runner: 'claude-code',
      windows: [
        { id: 'five_hour', usedPercentage: 35 },
        { id: 'seven_day', usedPercentage: 15 }
      ]
    });
    await expect(reader.status('claude-code')).resolves.toEqual({
      runner: 'claude-code',
      available: true,
      reasonCode: null
    });
  });
});

async function fixture(relativePath: string, value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'myagentroam-runner-usage-'));
  temporaryDirectories.push(root);
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
  return root;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
