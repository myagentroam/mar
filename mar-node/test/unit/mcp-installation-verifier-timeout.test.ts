import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpCatalogEntry } from '../../../packages/protocol/src/mcp.js';
import { McpInstallationVerifier } from '../../src/service/mcp-installation-verifier.js';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect(): Promise<void> {
      return new Promise(() => undefined);
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
}));

afterEach(() => {
  vi.useRealTimers();
});

describe('Node MCP installation verifier timeout', () => {
  it('keeps the existing 90-second verifier deadline', async () => {
    vi.useFakeTimers();
    const entry: McpCatalogEntry = {
      id: 'fixture',
      sourceId: 'official',
      scope: 'ENTERPRISE',
      serverName: 'fixture',
      displayName: 'Fixture',
      description: 'Fixture MCP',
      version: '1.0.0',
      featured: false,
      tags: [],
      runtime: { transport: 'STDIO', command: 'fixture', args: [] },
      createdAt: 1,
      updatedAt: 1
    };
    const pending = new McpInstallationVerifier().verify({
      entry,
      configuration: {},
      secrets: {},
      cwd: process.cwd()
    });
    const assertion = expect(pending).rejects.toThrow('MCP_INSTALL_TIMEOUT');
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
