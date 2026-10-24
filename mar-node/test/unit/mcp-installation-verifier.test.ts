import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { McpCatalogEntry } from '../../../packages/protocol/src/mcp.js';
import { McpInstallationVerifier } from '../../src/service/mcp-installation-verifier.js';

const serverScript = String.raw`
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
    : message.method === 'tools/list'
      ? { tools: [{ name: 'fixture_tool', description: 'fixture', inputSchema: { type: 'object' } }] }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
`;

function stdioEntry(command: string, args: readonly string[]): McpCatalogEntry {
  return {
    id: 'fixture',
    sourceId: 'official',
    scope: 'ENTERPRISE',
    serverName: 'fixture',
    displayName: 'Fixture',
    description: 'Fixture MCP',
    version: '1.0.0',
    featured: false,
    tags: [],
    runtime: { transport: 'STDIO', command, args: [...args] },
    createdAt: 1,
    updatedAt: 1
  };
}

describe('Node MCP installation verification', () => {
  it('does not forward secret headers to a cross-origin redirect target', async () => {
    let receivedSecret: string | undefined;
    const target = createServer((request, response) => {
      receivedSecret = request.headers['x-mar-credential'] as string | undefined;
      response.writeHead(500).end();
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string')
      throw new Error('Fixture address unavailable');
    const source = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/mcp` }).end();
    });
    source.listen(0, '127.0.0.1');
    await once(source, 'listening');
    const sourceAddress = source.address();
    if (!sourceAddress || typeof sourceAddress === 'string')
      throw new Error('Fixture address unavailable');
    try {
      await expect(
        new McpInstallationVerifier().verify({
          entry: {
            ...stdioEntry(process.execPath, []),
            runtime: {
              transport: 'HTTP',
              url: `http://127.0.0.1:${sourceAddress.port}/mcp`
            }
          },
          configuration: { headers: { 'x-mar-credential': { secretName: 'fixture' } } },
          secrets: { fixture: 'fixture-secret' },
          cwd: process.cwd()
        })
      ).rejects.toThrow();
      expect(receivedSecret).toBeUndefined();
    } finally {
      source.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => source.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve()))
      ]);
    }
  });

  it('confirms stdio MCP availability through standard initialization and tool enumeration', async () => {
    await expect(
      new McpInstallationVerifier().verify({
        entry: stdioEntry(process.execPath, ['-e', serverScript]),
        configuration: {},
        secrets: {},
        cwd: process.cwd()
      })
    ).resolves.toBeUndefined();
  });

  it('normalizes a missing command to a stable error', async () => {
    await expect(
      new McpInstallationVerifier().verify({
        entry: stdioEntry('mar-mcp-command-does-not-exist', []),
        configuration: {},
        secrets: {},
        cwd: process.cwd()
      })
    ).rejects.toThrow('MCP_COMMAND_UNAVAILABLE');
  });

  it('rejects an MCP server with no tools', async () => {
    const noToolsScript = serverScript.replace(
      "{ tools: [{ name: 'fixture_tool', description: 'fixture', inputSchema: { type: 'object' } }] }",
      '{ tools: [] }'
    );
    await expect(
      new McpInstallationVerifier().verify({
        entry: stdioEntry(process.execPath, ['-e', noToolsScript]),
        configuration: {},
        secrets: {},
        cwd: process.cwd()
      })
    ).rejects.toThrow('MCP_TOOLS_UNAVAILABLE');
  });
});
