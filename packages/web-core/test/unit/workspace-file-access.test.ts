import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceFileAccessService } from '../../src/service/workspace-file-access-service.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';

function fixture() {
  const request = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({}));
  const access = createWorkspaceFileAccessService({
    request,
    http: { request } as ScopedHttpService,
    manifest: () => undefined,
    available: () => false,
    direct: { download: vi.fn() }
  });
  return { request, access };
}

describe('Workspace attachment file access', () => {
  it('captures the full Workspace target and revalidates without a cached response', async () => {
    const { request, access } = fixture();
    const target = { nodeId: 'aside-node', workspaceId: 'aside/workspace' };
    const attachments = access.forWorkspace(target).attachments;
    target.nodeId = 'main-node';
    target.workspaceId = 'main-workspace';
    await attachments.revalidate({ path: 'images/a & b.png' });
    const [path, init] = request.mock.calls[0]!;
    const url = new URL(path, 'https://example.test');
    expect(url.pathname).toBe('/api/workspaces/aside%2Fworkspace/files/read');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      nodeId: 'aside-node',
      path: 'images/a & b.png',
      offset: '0',
      limit: '1'
    });
    expect(init).toEqual({ cache: 'no-store' });
  });

  it('shares resource URLs while preserving explicit preview generations and read failures', async () => {
    const { request, access } = fixture();
    const files = access.forWorkspace({ nodeId: 'node-2', workspaceId: 'workspace-2' });
    const file = { path: 'images/a & b.png' };
    expect(files.attachments.sourceUrl(file)).toBe(files.contentUrl(file));
    const first = new URL(files.attachments.sourceUrl(file, 7), 'https://example.test');
    expect(first.searchParams.get('nodeId')).toBe('node-2');
    expect(first.searchParams.get('path')).toBe(file.path);
    expect(first.searchParams.get('preview')).toBe('7');
    expect(files.attachments.sourceUrl(file, 8)).not.toBe(first.pathname + first.search);
    const failure = new Error('source removed');
    request.mockRejectedValueOnce(failure);
    await expect(files.attachments.revalidate(file)).rejects.toBe(failure);
  });
});
