import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { McpCatalogEntry } from '../../../packages/protocol/src/mcp.js';
import { NodeDatabase } from '../../src/database.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import { McpNodeOperationService } from '../../src/service/mcp-node-operation-service.js';

const entry: McpCatalogEntry = {
  id: 'playwright',
  sourceId: 'official',
  scope: 'ENTERPRISE',
  serverName: 'io.github.microsoft/playwright-mcp',
  displayName: 'Playwright',
  description: 'Browser automation',
  version: '0.0.78',
  featured: true,
  tags: ['test'],
  runtime: {
    transport: 'STDIO',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.78', '--headless', '--isolated']
  },
  createdAt: 1,
  updatedAt: 1
};

describe('Node MCP installation configuration', () => {
  it.each(['mar_goal', 'mar/goal'])(
    'rejects the reserved name %s before verification or persistence',
    async (serverName) => {
      const database = new NodeDatabase(':memory:', 'node-mcp-reserved');
      const verify = vi.fn(async () => undefined);
      const operations = new McpNodeOperationService(() => database, { verify }).operations();
      try {
        await expect(
          operations['node.mcps.install']?.({ entry: { ...entry, serverName }, enabled: true })
        ).rejects.toMatchObject({
          code: 'MCP_RESERVED_NAMESPACE',
          message: expect.stringContaining('reserved for Node')
        });
        expect(verify).not.toHaveBeenCalled();
        expect(database.listMcpInstallations('NODE')).toEqual([]);
      } finally {
        database.close();
      }
    }
  );

  it('persists enabled configuration only after Node completes protocol validation', async () => {
    const database = new NodeDatabase(':memory:', 'node-mcp');
    const verify = vi.fn(async () => undefined);
    const operations = new McpNodeOperationService(() => database, { verify }).operations();

    await operations['node.mcps.install']?.({
      entry,
      enabled: true,
      configuration: {},
      secretEnvironment: { MCP_TOKEN: 'secret' }
    });

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ entry, secrets: { MCP_TOKEN: 'secret' } })
    );
    expect(database.listMcpInstallations('NODE')).toHaveLength(1);
    database.close();
  });

  it('does not persist MCP configuration when protocol validation fails', async () => {
    const database = new NodeDatabase(':memory:', 'node-mcp');
    const operations = new McpNodeOperationService(() => database, {
      verify: vi.fn(async () => {
        throw new Error('MCP_PROTOCOL_VALIDATION_FAILED');
      })
    }).operations();

    await expect(
      operations['node.mcps.install']?.({ entry, enabled: true, configuration: {} })
    ).rejects.toThrow('MCP_PROTOCOL_VALIDATION_FAILED');
    expect(database.listMcpInstallations('NODE')).toEqual([]);
    database.close();
  });

  it('persists a Workspace MCP only after delayed verification succeeds', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'node-mcp-delayed-success');
    const workspace = database.saveWorkspace({
      id: 'workspace-delayed-success',
      path: '/workspace-delayed-success',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    let finishVerification!: () => void;
    const operations = new McpNodeOperationService(() => database, {
      verify: vi.fn(() => new Promise<void>((resolve) => (finishVerification = resolve)))
    }).operations();
    try {
      const installation = operations['workspace.mcps.install']?.({
        workspaceId: workspace.id,
        entry,
        enabled: true,
        configuration: {}
      });
      await vi.advanceTimersByTimeAsync(15_001);
      expect(database.listMcpInstallations('WORKSPACE', workspace.id)).toEqual([]);
      finishVerification();
      await expect(installation).resolves.toMatchObject({ targetKind: 'WORKSPACE' });
      expect(database.listMcpInstallations('WORKSPACE', workspace.id)).toHaveLength(1);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('returns delayed verifier failures and Node verifier timeouts without persistence', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'node-mcp-delayed-failure');
    const workspace = database.saveWorkspace({
      id: 'workspace-delayed-failure',
      path: '/workspace-delayed-failure',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const operations = new McpNodeOperationService(() => database, {
      verify: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) =>
            setTimeout(() => reject(new Error('MCP_PROTOCOL_VALIDATION_FAILED')), 15_001)
          )
      )
    }).operations();
    const install = () =>
      operations['workspace.mcps.install']?.({
        workspaceId: workspace.id,
        entry,
        enabled: true,
        configuration: {}
      });
    try {
      const delayedFailure = install();
      const failureAssertion = expect(delayedFailure).rejects.toThrow(
        'MCP_PROTOCOL_VALIDATION_FAILED'
      );
      await vi.advanceTimersByTimeAsync(15_001);
      await failureAssertion;
      expect(database.listMcpInstallations('WORKSPACE', workspace.id)).toEqual([]);

      const timeoutService = new McpNodeOperationService(() => database, {
        verify: vi.fn(
          () =>
            new Promise<void>((_resolve, reject) =>
              setTimeout(() => reject(new Error('MCP_INSTALL_TIMEOUT')), 90_000)
            )
        )
      });
      const nodeTimeout = timeoutService.operations()['workspace.mcps.install']?.({
        workspaceId: workspace.id,
        entry,
        enabled: true,
        configuration: {}
      });
      const timeoutAssertion = expect(nodeTimeout).rejects.toThrow('MCP_INSTALL_TIMEOUT');
      await vi.advanceTimersByTimeAsync(90_000);
      await timeoutAssertion;
      expect(database.listMcpInstallations('WORKSPACE', workspace.id)).toEqual([]);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('a workspace overrides a same-named Node MCP, and a disabled entry masks the Node configuration', () => {
    const database = new NodeDatabase(':memory:', 'node-mcp', () => 100);
    const workspace = database.saveWorkspace({
      id: 'workspace-a',
      path: '/workspace-a',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveMcpInstallation({
      targetKind: 'NODE',
      entry,
      enabled: true,
      configuration: { arguments: ['--browser', 'chromium'] }
    });
    expect(database.effectiveMcpInstallations(workspace.id)).toHaveLength(1);

    database.saveMcpInstallation({
      targetKind: 'WORKSPACE',
      targetId: workspace.id,
      entry,
      enabled: false,
      configuration: {}
    });
    expect(database.effectiveMcpInstallations(workspace.id)).toEqual([]);

    database.saveMcpInstallation({
      targetKind: 'WORKSPACE',
      targetId: workspace.id,
      entry,
      enabled: true,
      configuration: { arguments: ['--browser', 'firefox'] }
    });
    expect(database.effectiveMcpInstallations(workspace.id)[0]?.configuration).toEqual({
      arguments: ['--browser', 'firefox']
    });
    database.close();
  });

  it('rejects MCP installation for an unregistered workspace', () => {
    const database = new NodeDatabase(':memory:', 'node-mcp');
    expect(() =>
      database.saveMcpInstallation({
        targetKind: 'WORKSPACE',
        targetId: 'missing',
        entry,
        enabled: true,
        configuration: {}
      })
    ).toThrow('WORKSPACE_NOT_FOUND');
    database.close();
  });

  it('marks inherited Node configuration and workspace override origin during workspace inspection', () => {
    const database = new NodeDatabase(':memory:', 'node-mcp');
    const workspace = database.saveWorkspace({
      id: 'workspace-a',
      path: '/workspace-a',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveMcpInstallation({
      targetKind: 'NODE',
      entry,
      enabled: true,
      configuration: {}
    });
    const operations = new McpNodeOperationService(() => database).operations();
    expect(operations['workspace.mcps.inspect']?.({ workspaceId: workspace.id })).toEqual(
      expect.objectContaining({
        installations: [expect.objectContaining({ origin: 'NODE', enabled: true })],
        executionBuiltIns: ['mar_schedule', 'mar_notification']
      })
    );
    database.saveMcpInstallation({
      targetKind: 'WORKSPACE',
      targetId: workspace.id,
      entry,
      enabled: false,
      configuration: {}
    });
    expect(operations['workspace.mcps.inspect']?.({ workspaceId: workspace.id })).toEqual(
      expect.objectContaining({
        installations: [expect.objectContaining({ origin: 'WORKSPACE', enabled: false })],
        executionBuiltIns: ['mar_schedule', 'mar_notification']
      })
    );
    expect(operations['node.mcps.inspect']?.({})).not.toHaveProperty('executionBuiltIns');
    database.close();
  });

  it('removes workspace MCP configuration without affecting Node configuration when the workspace is deleted', () => {
    const database = new NodeDatabase(':memory:', 'node-mcp');
    const workspace = database.saveWorkspace({
      id: 'workspace-a',
      path: '/workspace-a',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveMcpInstallation({
      targetKind: 'NODE',
      entry,
      enabled: true,
      configuration: {}
    });
    database.saveMcpInstallation({
      targetKind: 'WORKSPACE',
      targetId: workspace.id,
      entry,
      enabled: true,
      configuration: {}
    });
    database.removeWorkspace(workspace.id);
    expect(database.listMcpInstallations('WORKSPACE', workspace.id)).toEqual([]);
    expect(database.listMcpInstallations('NODE')).toHaveLength(1);
    database.close();
  });
});

describe('Runner MCP native configuration conversion', () => {
  const installations = [
    {
      catalogEntryId: entry.id,
      serverName: entry.serverName,
      displayName: entry.displayName,
      version: entry.version,
      enabled: true,
      runtime: {
        transport: 'HTTP',
        url: 'https://mcp.example.com',
        headers: { authorization: { secretName: 'MCP_TOKEN' } }
      },
      configuration: {},
      installedAt: 1
    }
  ];

  it('generates runner-specific remote MCP configuration for all three runners', () => {
    expect(new CodexRunner().mcpConfiguration(installations, { MCP_TOKEN: 'secret' })).toEqual({
      'io.github.microsoft/playwright-mcp': {
        url: 'https://mcp.example.com',
        http_headers: { authorization: 'secret' }
      }
    });
    expect(new ClaudeCodeRunner().mcpConfiguration(installations, { MCP_TOKEN: 'secret' })).toEqual(
      {
        'io.github.microsoft/playwright-mcp': {
          type: 'http',
          url: 'https://mcp.example.com',
          headers: { authorization: 'secret' }
        }
      }
    );
    expect(new OpenCodeRunner().mcpConfiguration(installations, { MCP_TOKEN: 'secret' })).toEqual({
      'io.github.microsoft/playwright-mcp': {
        type: 'remote',
        url: 'https://mcp.example.com',
        headers: { authorization: 'secret' },
        oauth: false
      }
    });
  });

  it('does not inject MCP into a Runner when a referenced secret is missing', () => {
    expect(new CodexRunner().mcpConfiguration(installations, {})).toEqual({});
  });

  it('passes only the active user CLI context to local MCP processes and fails closed without it', () => {
    const local = [
      {
        ...installations[0],
        runtime: { transport: 'STDIO', command: 'node', args: [], environment: {} }
      }
    ];
    const context = {
      MAR_USERNAME: 'alice',
      MAR_CTL_SERVER_URL: 'https://server.test',
      MAR_CTL_USER_TOKEN: 'marctl_user_token'
    };
    const expected = {
      MAR_CTL_CONTEXT_REQUIRED: '1',
      MAR_NODE_CONTEXT: '1',
      ...context
    };
    const codex = new CodexRunner().mcpConfiguration(local, context) as Record<
      string,
      { env: Record<string, string> }
    >;
    expect(codex).toMatchObject({
      [entry.serverName]: { env: expected }
    });
    expect(codex[entry.serverName]?.env['Path'] ?? codex[entry.serverName]?.env['PATH']).toContain(
      join('node_modules', '.bin')
    );
    expect(new ClaudeCodeRunner().mcpConfiguration(local, context)).toMatchObject({
      [entry.serverName]: { env: expected }
    });
    expect(new OpenCodeRunner().mcpConfiguration(local, context)).toMatchObject({
      [entry.serverName]: { environment: expected }
    });
    expect(new CodexRunner().mcpConfiguration(local, {})).toMatchObject({
      [entry.serverName]: {
        env: { MAR_CTL_CONTEXT_REQUIRED: '1', MAR_NODE_CONTEXT: '1', MAR_USERNAME: '' }
      }
    });
  });
});
