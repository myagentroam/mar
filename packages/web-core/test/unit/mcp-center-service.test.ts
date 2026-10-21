import { describe, expect, it, vi } from 'vitest';
import {
  createMcpCenterService,
  type McpCatalogCard,
  type McpInstallationCard
} from '../../src/service/McpCenterService.js';

describe('Web MCP Center Service', () => {
  const installation: McpInstallationCard = {
    catalogEntryId: 'browser-entry',
    serverName: 'browser',
    displayName: 'Browser tools',
    version: '1.0.0',
    origin: 'WORKSPACE',
    enabled: true,
    status: 'CURRENT',
    installedAt: 1
  };
  const entry: McpCatalogCard = {
    id: 'browser-entry',
    sourceId: 'registry',
    scope: 'PERSONAL',
    serverName: 'browser',
    displayName: 'Browser tools',
    description: 'Browser automation tools',
    version: '1.0.0',
    featured: false,
    tags: [],
    runtime: { transport: 'STDIO' }
  };

  it('loads enabled Workspace MCP descriptions from the authorized matching catalog version', async () => {
    const service = createMcpCenterService(
      async <T>(path: string) =>
        (path.startsWith('/api/mcp-catalog')
          ? { entries: [entry] }
          : {
              targetKind: 'WORKSPACE',
              installations: [
                installation,
                { ...installation, serverName: 'disabled', enabled: false },
                { ...installation, serverName: 'older', version: '0.9.0' },
                { ...installation, serverName: 'unavailable', catalogEntryId: 'removed' }
              ]
            }) as T
    );
    await service.loadWorkspace('node', 'workspace');
    expect(
      service.loadedInstallations.value.map(({ serverName, description }) => ({
        serverName,
        description
      }))
    ).toEqual([
      { serverName: 'browser', description: entry.description },
      { serverName: 'older', description: undefined },
      { serverName: 'unavailable', description: undefined }
    ]);
  });

  it('does not require the catalog for execution built-ins and clears previous Workspace metadata', async () => {
    const requests: string[] = [];
    const request = async <T>(path: string): Promise<T> => {
      requests.push(path);
      return (
        path.startsWith('/api/mcp-catalog')
          ? { entries: [entry] }
          : {
              targetKind: 'WORKSPACE',
              installations: path.includes('first') ? [installation] : [],
              executionBuiltIns: ['mar_schedule', 'mar_notification']
            }
      ) as T;
    };
    const service = createMcpCenterService(request);
    await service.loadWorkspace('node', 'first');
    await service.loadWorkspace('node', 'second');
    expect(service.loadedInstallations.value).toEqual([]);
    expect(service.catalog.value).toEqual([]);
    expect(service.inspection.value?.executionBuiltIns).toEqual([
      'mar_schedule',
      'mar_notification'
    ]);
    expect(requests.filter((path) => path.startsWith('/api/mcp-catalog'))).toHaveLength(1);
  });

  it('retains the current inspection without stale descriptions when catalog loading fails', async () => {
    let fail = false;
    const service = createMcpCenterService(async <T>(path: string) => {
      if (path.startsWith('/api/mcp-catalog')) {
        if (fail) throw new Error('CATALOG_UNAVAILABLE');
        return { entries: [entry] } as T;
      }
      return { targetKind: 'WORKSPACE', installations: [installation] } as T;
    });
    await service.loadWorkspace('node', 'first');
    fail = true;
    await expect(service.run(() => service.loadWorkspace('node', 'second'))).rejects.toThrow(
      'CATALOG_UNAVAILABLE'
    );
    expect(service.loading.value).toBe(false);
    expect(service.loadedInstallations.value[0]?.description).toBeUndefined();
    expect(service.inspection.value?.installations).toEqual([installation]);
  });

  it('keeps catalog scopes opaque and uses the Node target without a Workspace query', async () => {
    const requests: string[] = [];
    const entries = [{ id: 'entry', scope: 'HOST_SCOPE', displayName: 'Available entry' }];
    const service = createMcpCenterService<'HOST_SCOPE'>(async <T>(path: string) => {
      requests.push(path);
      return (
        path.startsWith('/api/mcp-catalog')
          ? { entries, page: 1, pageSize: 20, total: entries.length, hasMore: false }
          : { targetKind: 'NODE', installations: [] }
      ) as T;
    });
    await service.loadCatalog();
    expect(service.catalog.value).toEqual(entries);
    await service.inspect('NODE', 'node/a', 'unused');
    expect(requests).toEqual(['/api/mcp-catalog?page=1&limit=20', '/api/nodes/node%2Fa/mcps']);
    expect(service.inspection.value).toEqual({ targetKind: 'NODE', installations: [] });
  });

  it('Build inspection, installation, and removal requests for Node and Workspace targets', async () => {
    const calls = vi.fn();
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls(path, init);
      return { targetKind: 'WORKSPACE', installations: [] } as T;
    };
    const service = createMcpCenterService(request);

    await service.inspect('WORKSPACE', 'node/a', 'workspace/b');
    await service.install('WORKSPACE', 'node/a', 'workspace/b', 'playwright', false);
    await service.remove('WORKSPACE', 'node/a', 'workspace/b', 'vendor/browser');

    expect(calls).toHaveBeenNthCalledWith(
      1,
      '/api/workspaces/workspace%2Fb/mcps?nodeId=node%2Fa',
      undefined
    );
    expect(calls).toHaveBeenNthCalledWith(
      2,
      '/api/workspaces/workspace%2Fb/mcps?nodeId=node%2Fa',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          catalogEntryId: 'playwright',
          enabled: false,
          configuration: {}
        })
      })
    );
    expect(calls).toHaveBeenNthCalledWith(
      3,
      '/api/workspaces/workspace%2Fb/mcps/vendor%2Fbrowser?nodeId=node%2Fa',
      { method: 'DELETE' }
    );
  });

  it('Clear the loading state after an operation fails', async () => {
    const service = createMcpCenterService(async () => {
      throw new Error('FAILED');
    });

    await expect(service.run(service.loadCatalog)).rejects.toThrow('FAILED');
    expect(service.loading.value).toBe(false);
  });
});
