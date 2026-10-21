import { describe, expect, it, vi } from 'vitest';
import { OpenCodeServerClient } from '../../src/opencode-server.js';
import {
  openCodeContextLimits,
  openCodeProfileModels,
  probeOpenCode
} from '../../src/opencode-runtime.js';

describe('OpenCode runtime', () => {
  it('appends session-level personal instructions through the official Prompt system field', async () => {
    const promptAsync = vi.fn(async () => ({ data: {} }));
    const client = new OpenCodeServerClient();
    Object.assign(client, { client: { session: { promptAsync } } });

    await client.prompt({
      directory: '/workspace',
      sessionID: 'session-1',
      text: 'hello',
      model: 'provider/model',
      system: 'inspect the tests before execution'
    });

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'inspect the tests before execution' })
    );
  });

  it('injects MCP through the dynamic interface without modifying Workspace configuration', async () => {
    const add = vi.fn(async () => ({ data: {} }));
    const update = vi.fn(async () => ({ data: {} }));
    const client = new OpenCodeServerClient();
    Object.assign(client, { client: { mcp: { add }, config: { update } } });

    await client.configureMcp('/workspace', {
      browser: { type: 'local', command: ['playwright-mcp', '--headless'] }
    });

    expect(add).toHaveBeenCalledWith({
      directory: '/workspace',
      name: 'browser',
      config: { type: 'local', command: ['playwright-mcp', '--headless'] }
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('uses session.fork with session, Workspace, and message-boundary parameters', async () => {
    const fork = vi.fn(async () => ({ data: { id: 'forked-session' } }));
    const client = new OpenCodeServerClient();
    Object.assign(client, { client: { session: { fork } } });
    await expect(client.forkSession('/workspace', 'source-session', 'message-2')).resolves.toEqual({
      id: 'forked-session'
    });
    expect(fork).toHaveBeenCalledWith({
      directory: '/workspace',
      sessionID: 'source-session',
      messageID: 'message-2'
    });
  });

  it('reuses one Server startup across concurrent requests', async () => {
    const client = new OpenCodeServerClient();
    const startServer = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    Object.assign(client, { startServer });

    await Promise.all([client.start(), client.start(), client.start()]);

    expect(startServer).toHaveBeenCalledOnce();
  });

  it('exposes only connected Provider models and preserves variant', () => {
    expect(
      openCodeProfileModels({
        connected: ['custom', 'opencode'],
        default: { custom: 'coder' },
        all: [
          {
            id: 'custom',
            name: 'Custom Gateway',
            source: 'config',
            models: {
              coder: {
                id: 'coder',
                name: 'Coder',
                limit: { context: 200_000 },
                variants: { low: {}, high: {}, disabled: { disabled: true } }
              }
            }
          },
          {
            id: 'opencode',
            name: 'OpenCode Zen',
            source: 'custom',
            models: { gateway: { id: 'gateway', name: 'Gateway' } }
          },
          { id: 'offline', name: 'Offline', models: { hidden: { id: 'hidden', name: 'Hidden' } } }
        ]
      })
    ).toEqual([
      {
        id: 'custom/coder',
        label: 'Coder',
        supportedEfforts: ['low', 'high']
      }
    ]);
    expect(
      openCodeContextLimits({
        connected: ['custom', 'opencode'],
        all: [
          {
            id: 'custom',
            source: 'config',
            models: { coder: { limit: { context: 200_000 } } }
          },
          {
            id: 'opencode',
            source: 'custom',
            models: { gateway: { limit: { context: 100_000 } } }
          }
        ]
      }).get('custom/coder')
    ).toBe(200_000);
    expect(
      openCodeContextLimits({
        connected: ['opencode'],
        all: [
          {
            id: 'opencode',
            source: 'custom',
            models: { gateway: { limit: { context: 100_000 } } }
          }
        ]
      }).has('opencode/gateway')
    ).toBe(false);
  });

  it('keeps the CLI probe version aligned with the SDK', () => {
    expect(probeOpenCode()).toMatchObject({
      available: true,
      compatible: true,
      version: '1.18.20'
    });
    expect(probeOpenCode('definitely-not-installed-opencode')).toEqual({
      available: false,
      compatible: false
    });
  });
});
