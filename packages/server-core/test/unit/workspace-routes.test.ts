import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWorkspaceRoutes } from '../../src/workspace-routes.js';
import { hashOpaque } from '../../src/session-token.js';
import { SESSION_COOKIE_NAME } from '../../src/auth.js';
import { sendError } from '../../src/http-errors.js';
import type { WorkspaceResourcePolicy } from '../../src/workspace-route-contracts.js';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture(resources?: WorkspaceResourcePolicy) {
  const app = Fastify();
  apps.push(app);
  const requestNode = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ workspaces: [] }));
  const ownsWorkbenchConnection = vi.fn(() => false);
  const revalidateTerminalAuthorizations = vi.fn(async () => undefined);
  const session = {
    userId: 1,
    username: 'admin',
    isAdmin: true,
    sessionHash: 'session-hash',
    mustChangePassword: false,
    csrfTokenHash: hashOpaque('csrf')
  };
  registerWorkspaceRoutes({
    app,
    database: { findCurrentUserSession: (token) => (token === 'session' ? session : undefined) },
    publicOrigin: 'http://localhost',
    nodeControl: {
      requestNode,
      ownsWorkbenchConnection,
      revalidateTerminalAuthorizations
    },
    ...(resources === undefined ? {} : { resources }),
    databaseError: (reply, error) =>
      sendError(reply, 409, error instanceof Error ? error.message : 'NODE_RESPONSE_INVALID')
  });
  return {
    app,
    requestNode,
    ownsWorkbenchConnection,
    revalidateTerminalAuthorizations,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=session`,
      origin: 'http://localhost',
      'x-csrf-token': 'csrf'
    }
  };
}
describe('Shared Workspace HTTP routes', () => {
  it.each([undefined, '', 'modules/tool'])(
    'preserves the current-file repository target %s through reads and metadata',
    async (repositoryPath) => {
      const { app, requestNode, headers } = fixture();
      const query = new URLSearchParams({ nodeId: 'node-1', path: 'same.txt' });
      if (repositoryPath !== undefined) query.set('repositoryPath', repositoryPath);
      requestNode.mockResolvedValue({ file: { size: 4, revision: 'a'.repeat(64) } });
      for (const [route, operation] of [
        ['read', 'workspace.file.read'],
        ['direct-metadata', 'workspace.file.direct.metadata']
      ]) {
        const reply = await app.inject({
          url: `/api/workspaces/workspace-1/files/${route}?${query}`,
          headers
        });
        expect(reply.statusCode).toBe(200);
        const call = requestNode.mock.calls.at(-1)!;
        expect(call[1]).toBe(operation);
        if (repositoryPath === undefined) expect(call[2]).not.toHaveProperty('repositoryPath');
        else expect(call[2]).toHaveProperty('repositoryPath', repositoryPath);
      }
    }
  );
  it.each([{ repositoryPath: '' }, { worktreePath: 'trees/feature' }])(
    'rejects Git file write target %j without relaying an ordinary write',
    async (target) => {
      const { app, requestNode, headers } = fixture();
      const reply = await app.inject({
        method: 'PUT',
        url: '/api/workspaces/workspace-1/files/write',
        headers,
        payload: {
          nodeId: 'node-1',
          path: 'same.txt',
          content: 'overwrite',
          expectedRevision: 'a'.repeat(64),
          ...target
        }
      });
      expect(reply.statusCode).toBe(400);
      expect(reply.json()).toMatchObject({ error: { code: 'FILE_WRITE_INVALID' } });
      expect(requestNode).not.toHaveBeenCalled();
    }
  );
  it('relays private attachment previews and ranges with authentication and Workspace authorization', async () => {
    const { app, requestNode, headers } = fixture();
    const path = 'mar-attachment://00000000-0000-4000-8000-000000000001/原图 with spaces.png';
    const url = `/api/workspaces/workspace-1/files/content?nodeId=node-1&path=${encodeURIComponent(path)}`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(requestNode).not.toHaveBeenCalled();
    requestNode.mockImplementation(async (...args) => {
      const data = args[2] as { path: string; offset: number; limit: number };
      return {
        file: {
          path: data.path,
          size: 10,
          offset: data.offset,
          contentBase64: Buffer.from('0123456789')
            .subarray(data.offset, data.offset + data.limit)
            .toString('base64')
        }
      };
    });
    const response = await app.inject({ url, headers: { ...headers, range: 'bytes=2-5' } });
    expect(response.statusCode).toBe(206);
    expect(response.rawPayload.toString()).toBe('2345');
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-range']).toBe('bytes 2-5/10');
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.file.content.read',
      expect.objectContaining({ workspaceId: 'workspace-1', path }),
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );
  });
  it('forwards validated preview dimensions and preserves unpreviewed file content', async () => {
    const { app, requestNode, headers } = fixture();
    const path = 'images/source.png';
    requestNode.mockResolvedValueOnce({
      image: {
        mime: 'image/webp',
        dataBase64: Buffer.from('preview').toString('base64'),
        resized: false
      }
    });
    const preview = await app.inject({
      url: `/api/workspaces/workspace-1/files/content?nodeId=node-1&path=${path}&maxWidth=320&maxHeight=240`,
      headers
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.headers['content-type']).toBe('image/webp');
    expect(preview.headers['x-mar-image-resized']).toBe('0');
    expect(preview.rawPayload).toEqual(Buffer.from('preview'));
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.file.content.read',
      expect.objectContaining({
        workspaceId: 'workspace-1',
        path,
        preview: { maxWidth: 320, maxHeight: 240 }
      }),
      expect.objectContaining({ userId: 1, workspaceId: 'workspace-1' }),
      undefined
    );

    requestNode.mockClear();
    for (const query of ['maxWidth=320', 'maxWidth=0&maxHeight=240']) {
      const invalid = await app.inject({
        url: `/api/workspaces/workspace-1/files/content?nodeId=node-1&path=${path}&${query}`,
        headers
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('RUN_IMAGE_INVALID');
    }
    expect(requestNode).not.toHaveBeenCalled();

    requestNode.mockImplementation(async (...args: unknown[]) => {
      const request = args[2] as { offset?: number; limit?: number };
      const original = Buffer.from('original');
      const offset = request.offset ?? 0;
      const limit = request.limit ?? 512 * 1024;
      return {
        file: {
          path,
          size: original.length,
          offset,
          contentBase64: original.subarray(offset, offset + limit).toString('base64')
        }
      };
    });
    const detail = await app.inject({
      url: `/api/workspaces/workspace-1/files/content?nodeId=node-1&path=${path}`,
      headers
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.rawPayload).toEqual(Buffer.from('original'));
    expect(detail.headers['x-mar-image-resized']).toBeUndefined();
    expect(requestNode.mock.calls.at(-1)?.[2]).not.toHaveProperty('preview');
  });

  it.each(['clip.mp4', 'sound.mp3'])(
    'streams %s larger than 20 MiB without requiring an initial Range header',
    async (path) => {
      const { app, requestNode, headers } = fixture();
      const size = 20 * 1024 * 1024 + 1;
      requestNode.mockImplementation(async (...args: unknown[]) => {
        const data = args[2] as { offset: number; limit: number };
        return {
          file: {
            path,
            size,
            offset: data.offset,
            contentBase64: Buffer.alloc(Math.min(data.limit, size - data.offset), 7).toString(
              'base64'
            )
          }
        };
      });
      const url = `/api/workspaces/workspace-1/files/content?nodeId=node-1&path=${path}`;
      const head = await app.inject({ method: 'HEAD', url, headers });
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-length']).toBe(String(size));
      expect(head.headers['accept-ranges']).toBe('bytes');
      expect(head.rawPayload.length).toBe(0);
      expect(requestNode).toHaveBeenCalledTimes(1);
      requestNode.mockClear();
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.equals(Buffer.alloc(size, 7))).toBe(true);
      expect(response.headers['content-type']).toBe(
        path.endsWith('.mp4') ? 'video/mp4' : 'audio/mpeg'
      );
      for (const call of requestNode.mock.calls) {
        expect(call[1]).toBe('workspace.file.content.read');
        expect((call[2] as { limit: number }).limit).toBeLessThanOrEqual(512 * 1024);
      }
    }
  );

  it.each(['bytes=524280-1048580', 'bytes=524288-', 'bytes=-16'])(
    'streams multi-chunk and seek ranges (%s) without truncation',
    async (range) => {
      const { app, requestNode, headers } = fixture();
      const size = 1024 * 1024 + 9;
      requestNode.mockImplementation(async (...args: unknown[]) => {
        const data = args[2] as { offset: number; limit: number };
        return {
          file: {
            path: 'sound.wav',
            size,
            offset: data.offset,
            contentBase64: Buffer.alloc(Math.min(data.limit, size - data.offset), 9).toString(
              'base64'
            )
          }
        };
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/workspaces/workspace-1/files/content?nodeId=node-1&path=sound.wav',
        headers: { ...headers, range }
      });
      const start = range === 'bytes=-16' ? size - 16 : Number(range.slice(6).split('-')[0]);
      const end = range === 'bytes=524280-1048580' ? 1048580 : size - 1;
      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${size}`);
      expect(response.rawPayload.equals(Buffer.alloc(end - start + 1, 9))).toBe(true);
    }
  );

  it('retains the complete non-media preview limit and rejects invalid ranges', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValue({
      file: { path: 'large.docx', size: 20 * 1024 * 1024 + 1, offset: 0, contentBase64: 'AA==' }
    });
    const url = '/api/workspaces/workspace-1/files/content?nodeId=node-1&path=large.docx';
    expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(413);
    expect(
      (await app.inject({ method: 'GET', url, headers: { ...headers, range: 'bytes=99999999-' } }))
        .statusCode
    ).toBe(416);
    expect(requestNode).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'bytes=0-', 'bytes=1-524296', 'bytes=-9'])(
    'streams complete Git previews across chunk boundaries (%s)',
    async (range) => {
      const { app, requestNode, headers } = fixture();
      const size = 512 * 1024 + 9;
      requestNode.mockImplementation(async (...args: unknown[]) => {
        const data = args[2] as { offset: number; limit: number };
        return {
          file: {
            path: 'clip.mp4',
            size,
            offset: data.offset,
            contentBase64: Buffer.alloc(Math.min(data.limit, size - data.offset), 5).toString(
              'base64'
            )
          }
        };
      });
      const url = `/api/workspaces/workspace-1/git/commits/${'a'.repeat(40)}/files/content?nodeId=node-1&path=clip.mp4`;
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { ...headers, ...(range === undefined ? {} : { range }) }
      });
      const start = range === 'bytes=-9' ? size - 9 : range === 'bytes=1-524296' ? 1 : 0;
      expect(response.statusCode).toBe(range === undefined ? 200 : 206);
      expect(response.headers['content-length']).toBe(String(size - start));
      if (range !== undefined)
        expect(response.headers['content-range']).toBe(`bytes ${start}-${size - 1}/${size}`);
      expect(response.rawPayload.equals(Buffer.alloc(size - start, 5))).toBe(true);
    }
  );

  it('rejects Git requests beyond the existing 20 MiB window before streaming', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValue({
      file: { path: 'clip.mp4', size: 20 * 1024 * 1024 + 1, offset: 0, contentBase64: 'AA==' }
    });
    const url = `/api/workspaces/workspace-1/git/commits/${'a'.repeat(40)}/files/content?nodeId=node-1&path=clip.mp4`;
    expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(413);
    expect(
      (await app.inject({ method: 'GET', url, headers: { ...headers, range: 'bytes=20971520-' } }))
        .statusCode
    ).toBe(416);
    expect(requestNode).toHaveBeenCalledTimes(2);
  });

  it.each(['bytes=0-', 'bytes=20971512-', 'bytes=20971512-20971525'])(
    'serves the allowed Git preview window for a larger blob (%s)',
    async (range) => {
      const { app, requestNode, headers } = fixture();
      const windowSize = 20 * 1024 * 1024;
      const size = windowSize + 9;
      requestNode.mockImplementation(async (_nodeId, _operation, payload) => {
        const { offset, limit } = payload as { offset: number; limit: number };
        expect(limit).toBeLessThanOrEqual(512 * 1024);
        expect(offset + limit).toBeLessThanOrEqual(windowSize);
        return {
          file: {
            path: 'clip.mp4',
            size,
            offset,
            contentBase64: Buffer.alloc(limit, 7).toString('base64')
          }
        };
      });
      const url = `/api/workspaces/workspace-1/git/commits/${'a'.repeat(40)}/files/content?nodeId=node-1&path=clip.mp4`;
      const response = await app.inject({ method: 'GET', url, headers: { ...headers, range } });
      const start = Number(range.slice(6).split('-')[0]);
      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toBe(`bytes ${start}-${windowSize - 1}/${size}`);
      expect(response.rawPayload.length).toBe(windowSize - start);
      expect(response.rawPayload[0]).toBe(7);
      expect(response.rawPayload.at(-1)).toBe(7);
    }
  );

  it('preserves Windows drive roots and directory entries through the authorized relay', async () => {
    const { app, requestNode, headers } = fixture();
    const directory = {
      homePath: 'C:\\Users\\node',
      currentPath: 'E:\\',
      parentPath: null,
      browseRoots: ['E:\\'],
      selectable: true,
      entries: [{ name: 'Projects', path: 'E:\\Projects', selectable: true }],
      truncated: false
    };
    requestNode.mockResolvedValueOnce({ directory });
    const response = await app.inject({
      method: 'GET',
      url: `/api/workspace-directories?${new URLSearchParams({ nodeId: 'node-1', path: 'E:\\' })}`,
      headers
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ directory });
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.directories.list',
      { path: 'E:\\' },
      expect.objectContaining({ userId: 1 }),
      undefined
    );
  });

  it('forwards the explicit registration Git policy without silently dropping it', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValueOnce({ workspace: { id: 'workspace-1', path: '/workspace' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { nodeId: 'node-1', path: '/workspace', preserveGitConfig: true }
    });
    expect(response.statusCode).toBe(201);
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.register',
      { path: '/workspace', preserveGitConfig: true },
      expect.objectContaining({ userId: 1 }),
      undefined
    );
  });
  it('parses bounded binary upload chunks in every product composition', async () => {
    const { app, requestNode, headers } = fixture();
    const reply = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/uploads/upload-1/chunks?nodeId=node-1&offset=0',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0, 1, 255])
    });
    expect(reply.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.files.upload.chunk',
      { workspaceId: 'workspace-1', uploadId: 'upload-1', offset: 0, dataBase64: 'AAH/' },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );
    requestNode.mockClear();
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/uploads/upload-1/chunks?nodeId=node-1&offset=0',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(512 * 1024 + 1)
    });
    expect(oversized.statusCode).toBe(413);
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('rejects a valid-origin write with an invalid CSRF token', async () => {
    const { app, requestNode, headers } = fixture();
    const reply = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { ...headers, 'x-csrf-token': 'wrong' },
      payload: { nodeId: 'node-1', path: '/workspace' }
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('CSRF_INVALID');
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('uses the composition-resolved ownership rather than browser-provided ownership', async () => {
    const resolveWorkspaceOwnership = vi.fn(async () => ({
      ownerType: 'ORGANIZATION' as const,
      ownerOrganizationId: 2
    }));
    const registerWorkspace = vi.fn(async () => undefined);
    const resources = {
      projectNodeWorkspaces: vi.fn(async (_userId, _nodeId, workspaces) => workspaces),
      resolveWorkspaceOwnership,
      registerWorkspace,
      assertCanManageWorkspace: vi.fn(async () => undefined),
      assertCanUnregisterWorkspace: vi.fn(async () => undefined),
      unregisterWorkspace: vi.fn(async () => undefined),
      changeWorkspaceOwnership: vi.fn(async () => undefined),
      renameWorkspace: vi.fn(async () => undefined),
      updateWorkspaceGroupName: vi.fn(async () => undefined),
      updateWorkspace: vi.fn(async () => undefined)
    } satisfies WorkspaceResourcePolicy;
    const { app, requestNode, headers } = fixture(resources);
    requestNode.mockResolvedValueOnce({ workspace: { id: 'workspace-1', path: '/workspace' } });

    const reply = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: {
        nodeId: 'node-1',
        path: '/workspace',
        ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
      }
    });

    expect(reply.statusCode).toBe(201);
    expect(resolveWorkspaceOwnership).toHaveBeenCalledWith(1, 'node-1', {
      ownerType: 'PERSONAL',
      ownerUserId: 1
    });
    expect(registerWorkspace).toHaveBeenCalledWith(
      1,
      'node-1',
      'workspace-1',
      { ownerType: 'ORGANIZATION', ownerOrganizationId: 2 },
      'workspace'
    );
  });
  it('writes a Workspace group through the node-level group policy without mixing management fields', async () => {
    const updateWorkspace = vi.fn(async () => undefined);
    const updateWorkspaceGroupName = vi.fn(async () => undefined);
    const resources = {
      projectNodeWorkspaces: vi.fn(async (_userId, _nodeId, workspaces) => workspaces),
      resolveWorkspaceOwnership: vi.fn(async () => ({
        ownerType: 'PERSONAL' as const,
        ownerUserId: 1
      })),
      registerWorkspace: vi.fn(async () => undefined),
      assertCanManageWorkspace: vi.fn(async () => undefined),
      assertCanUnregisterWorkspace: vi.fn(async () => undefined),
      unregisterWorkspace: vi.fn(async () => undefined),
      changeWorkspaceOwnership: vi.fn(async () => undefined),
      renameWorkspace: vi.fn(async () => undefined),
      updateWorkspaceGroupName,
      updateWorkspace
    } satisfies WorkspaceResourcePolicy;
    const { app, headers, revalidateTerminalAuthorizations } = fixture(resources);

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/workspaces/workspace-1?nodeId=node-1',
      headers,
      payload: { displayName: 'Changed', groupName: [] }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('WORKSPACE_GROUP_NAME_INVALID');
    expect(updateWorkspace).not.toHaveBeenCalled();

    const mixed = await app.inject({
      method: 'PATCH',
      url: '/api/workspaces/workspace-1?nodeId=node-1',
      headers,
      payload: { displayName: 'Changed', groupName: '  Engineering  ' }
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().error.code).toBe('WORKSPACE_GROUP_UPDATE_MIXED');

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/workspaces/workspace-1?nodeId=node-1',
      headers,
      payload: { groupName: '  Engineering  ' }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ groupName: 'Engineering' });
    expect(updateWorkspaceGroupName).toHaveBeenCalledWith(
      1,
      'node-1',
      'workspace-1',
      'Engineering'
    );
    expect(updateWorkspace).not.toHaveBeenCalled();
    expect(revalidateTerminalAuthorizations).not.toHaveBeenCalled();
  });
  it('authorizes Workspace removal with the dedicated registration-level policy', async () => {
    const assertCanManageWorkspace = vi.fn(async () => undefined);
    const assertCanUnregisterWorkspace = vi.fn(async () => undefined);
    const unregisterWorkspace = vi.fn(async () => undefined);
    const resources = {
      projectNodeWorkspaces: vi.fn(async (_userId, _nodeId, workspaces) => workspaces),
      resolveWorkspaceOwnership: vi.fn(async () => ({
        ownerType: 'PERSONAL' as const,
        ownerUserId: 1
      })),
      registerWorkspace: vi.fn(async () => undefined),
      assertCanManageWorkspace,
      assertCanUnregisterWorkspace,
      unregisterWorkspace,
      changeWorkspaceOwnership: vi.fn(async () => undefined),
      renameWorkspace: vi.fn(async () => undefined),
      updateWorkspaceGroupName: vi.fn(async () => undefined),
      updateWorkspace: vi.fn(async () => undefined)
    } satisfies WorkspaceResourcePolicy;
    const { app, headers, requestNode } = fixture(resources);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/workspaces/workspace-1?nodeId=node-1',
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(assertCanUnregisterWorkspace).toHaveBeenCalledWith(1, 'node-1', 'workspace-1');
    expect(assertCanManageWorkspace).not.toHaveBeenCalled();
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.remove',
      { workspaceId: 'workspace-1' },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );
    expect(unregisterWorkspace).toHaveBeenCalledWith(1, 'node-1', 'workspace-1');
  });
  it('rejects a Watch connection that does not belong to the current session', async () => {
    const { app, requestNode, headers } = fixture();
    const reply = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/watch',
      headers,
      payload: {
        nodeId: 'node-1',
        workbenchConnectionId: 'another-connection',
        watchId: 'watch-123',
        mode: 'initial',
        topics: {}
      }
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('WORKSPACE_WATCH_INVALID');
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('relays optional file prewarm only on an authorized initial Watch', async () => {
    const { app, requestNode, headers, ownsWorkbenchConnection } = fixture();
    const payload = {
      nodeId: 'node-1',
      workbenchConnectionId: 'connection-12345678',
      watchId: 'watch-12345678',
      mode: 'initial',
      prepareFiles: true,
      topics: { sessions: true }
    };
    const result = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/watch',
      headers,
      payload
    });
    expect(result.statusCode).toBe(400);
    expect(requestNode).not.toHaveBeenCalled();
    ownsWorkbenchConnection.mockReturnValue(true);
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/watch',
      headers,
      payload
    });
    expect(allowed.statusCode).toBe(200);
    expect(requestNode).toHaveBeenLastCalledWith(
      'node-1',
      'workspace.watch',
      {
        workspaceId: 'workspace-1',
        workbenchConnectionId: payload.workbenchConnectionId,
        watchId: payload.watchId,
        mode: 'initial',
        prepareFiles: true,
        topics: payload.topics
      },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );
    const disallowed = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/watch',
      headers,
      payload: { ...payload, mode: 'renew' }
    });
    expect(disallowed.statusCode).toBe(400);
  });
  it('requires authentication before sending any Node request', async () => {
    const { app, requestNode } = fixture();
    const reply = await app.inject({ url: '/api/workspaces?nodeId=node-1' });
    expect(reply.statusCode).toBe(401);
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('relays a validated local file manager reveal with Workspace authorization', async () => {
    const { app, requestNode, headers } = fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/files/reveal',
      headers,
      payload: { nodeId: 'node-1', path: 'folder/notes.txt' }
    });
    expect(response.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      'workspace.files.reveal',
      { workspaceId: 'workspace-1', path: 'folder/notes.txt' },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );
    requestNode.mockClear();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/files/reveal',
      headers,
      payload: { nodeId: 'node-1', path: '' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('preserves user and workspace authorization context', async () => {
    const { app, requestNode, headers } = fixture();
    const reply = await app.inject({
      url: '/api/workspaces/workspace-1/files?nodeId=node-1',
      headers
    });
    expect(reply.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.files.list',
      { workspaceId: 'workspace-1' },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );
  });
  it('relays only explicitly enabled nonblocking file searches and preserves legacy defaults', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValue({
      files: { entries: [], nextCursor: null, truncated: false, indexState: 'BUILDING' }
    });
    const response = await app.inject({
      url: '/api/workspaces/workspace-1/files/search?nodeId=node-1&q=foo&waitForIndex=false',
      headers
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().files.indexState).toBe('BUILDING');
    expect(requestNode).toHaveBeenLastCalledWith(
      'node-1',
      'workspace.files.search',
      { workspaceId: 'workspace-1', query: 'foo', waitForIndex: false },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );
    await app.inject({
      url: '/api/workspaces/workspace-1/files/search?nodeId=node-1&q=foo',
      headers
    });
    expect(requestNode).toHaveBeenLastCalledWith(
      'node-1',
      'workspace.files.search',
      { workspaceId: 'workspace-1', query: 'foo' },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );
    const count = requestNode.mock.calls.length;
    const invalid = await app.inject({
      url: '/api/workspaces/workspace-1/files/search?nodeId=node-1&q=foo&waitForIndex=true',
      headers
    });
    expect(invalid.statusCode).toBe(400);
    expect(requestNode).toHaveBeenCalledTimes(count);
  });
  it('authorizes and forwards Workspace direct file metadata requests', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValueOnce({
      file: { size: 4, revision: 'a'.repeat(64) }
    });

    const reply = await app.inject({
      url: '/api/workspaces/workspace-1/files/direct-metadata?nodeId=node-1&path=src%2Fmain.ts&worktreePath=trees%2Ffeature',
      headers
    });

    expect(reply.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.file.direct.metadata',
      {
        workspaceId: 'workspace-1',
        path: 'src/main.ts',
        worktreePath: 'trees/feature'
      },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );
  });
  it('validates and forwards bounded Workspace direct Range metadata', async () => {
    const { app, requestNode, headers } = fixture();
    const revision = 'a'.repeat(64);
    requestNode.mockResolvedValueOnce({
      file: {
        size: 12,
        revision,
        range: { offset: 4, length: 3 }
      }
    });

    const reply = await app.inject({
      url: `/api/workspaces/workspace-1/files/direct-metadata?nodeId=node-1&path=data.bin&offset=4&length=3&size=12&revision=${revision}`,
      headers
    });

    expect(reply.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.file.direct.metadata',
      {
        workspaceId: 'workspace-1',
        path: 'data.bin',
        offset: 4,
        length: 3,
        size: 12,
        revision
      },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );

    requestNode.mockClear();
    const invalid = await app.inject({
      url: `/api/workspaces/workspace-1/files/direct-metadata?nodeId=node-1&path=data.bin&offset=10&length=3&size=12&revision=${revision}`,
      headers
    });
    expect(invalid.statusCode).toBe(400);
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('validates and forwards Git commit blob direct metadata requests', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValueOnce({
      file: { size: 8, revision: 'b'.repeat(64) }
    });
    const commit = 'a'.repeat(40);

    const reply = await app.inject({
      url: `/api/workspaces/workspace-1/git/commits/${commit}/files/direct-metadata?nodeId=node-1&path=large.bin&repositoryPath=repo&refs=refs%2Fheads%2Fmain`,
      headers
    });

    expect(reply.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.git.commit.file.direct.metadata',
      {
        workspaceId: 'workspace-1',
        commit,
        path: 'large.bin',
        repositoryPath: 'repo',
        refs: ['refs/heads/main']
      },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );

    requestNode.mockClear();
    const invalid = await app.inject({
      url: `/api/workspaces/workspace-1/git/commits/not-a-commit/files/direct-metadata?nodeId=node-1&path=large.bin`,
      headers
    });
    expect(invalid.statusCode).toBe(400);
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('validates and relays bounded symbol definition requests without extending the Node timeout', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValueOnce({
      definition: {
        state: 'READY',
        targets: [
          {
            path: 'src/example.ts',
            line: 8,
            kind: 'f',
            preview: 'export function example() {}'
          }
        ],
        references: [],
        referenceTruncated: false,
        paths: [],
        truncated: false
      }
    });

    const reply = await app.inject({
      url: '/api/workspaces/workspace-1/symbols/definition?nodeId=node-1&path=src%2Fcurrent.ts&symbol=example',
      headers
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({
      definition: {
        state: 'READY',
        targets: [
          {
            path: 'src/example.ts',
            line: 8,
            kind: 'f',
            preview: 'export function example() {}'
          }
        ],
        references: [],
        referenceTruncated: false,
        paths: [],
        truncated: false
      }
    });
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.symbol.definition',
      { workspaceId: 'workspace-1', path: 'src/current.ts', symbol: 'example' },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      15_000
    );

    requestNode.mockClear();
    requestNode.mockResolvedValueOnce({
      definition: {
        state: 'READY',
        targets: [],
        references: [],
        referenceTruncated: false,
        paths: [],
        truncated: false
      }
    });
    const leadingHyphen = await app.inject({
      url: '/api/workspaces/workspace-1/symbols/definition?nodeId=node-1&path=Dockerfile&symbol=-bookworm&references=0',
      headers
    });
    expect(leadingHyphen.statusCode).toBe(200);
    expect(leadingHyphen.json().definition).toMatchObject({
      state: 'READY',
      targets: [],
      references: []
    });
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.symbol.definition',
      {
        workspaceId: 'workspace-1',
        path: 'Dockerfile',
        symbol: '-bookworm',
        includeReferences: false
      },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      15_000
    );

    requestNode.mockClear();
    requestNode.mockResolvedValueOnce({
      definition: {
        state: 'READY',
        targets: [],
        references: [],
        referenceTruncated: false,
        paths: [],
        truncated: false
      }
    });
    const withoutReferences = await app.inject({
      url: '/api/workspaces/workspace-1/symbols/definition?nodeId=node-1&path=src%2Fcurrent.ts&symbol=custom-element&references=0',
      headers
    });
    expect(withoutReferences.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.symbol.definition',
      {
        workspaceId: 'workspace-1',
        path: 'src/current.ts',
        symbol: 'custom-element',
        includeReferences: false
      },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      15_000
    );

    requestNode.mockClear();
    const invalidReferences = await app.inject({
      url: '/api/workspaces/workspace-1/symbols/definition?nodeId=node-1&path=src%2Fcurrent.ts&symbol=example&references=yes',
      headers
    });
    expect(invalidReferences.statusCode).toBe(400);
    expect(requestNode).not.toHaveBeenCalled();

    requestNode.mockResolvedValueOnce({
      definition: {
        state: 'READY',
        targets: [],
        references: [],
        referenceTruncated: false,
        paths: [{ path: 'src/model/workbench.ts', line: 1, kind: 'file' }],
        truncated: false
      }
    });
    const reference = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/symbols/definition',
      headers,
      payload: {
        nodeId: 'node-1',
        path: 'src/view/current.ts',
        reference: {
          languageId: 'ecmascript',
          extractorId: 'ecmascript.static-module',
          kind: 'relative-file',
          value: '../model/workbench.js',
          from: 15,
          to: 35,
          sourceContext: { text: 'import "../model/workbench.js";', position: 15 }
        }
      }
    });
    expect(reference.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.symbol.definition',
      {
        workspaceId: 'workspace-1',
        path: 'src/view/current.ts',
        reference: {
          languageId: 'ecmascript',
          extractorId: 'ecmascript.static-module',
          kind: 'relative-file',
          value: '../model/workbench.js',
          from: 15,
          to: 35,
          sourceContext: { text: 'import "../model/workbench.js";', position: 15 }
        }
      },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      15_000
    );

    requestNode.mockClear();
    const invalid = await app.inject({
      url: '/api/workspaces/workspace-1/symbols/definition?nodeId=node-1&path=src%2Fcurrent.ts&symbol=not.a.symbol',
      headers
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('SYMBOL_DEFINITION_INVALID');
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('starts a bounded background code-navigation preparation without blocking file preview', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValueOnce({ preparation: { state: 'BUILDING' } });

    const reply = await app.inject({
      url: '/api/workspaces/workspace-1/symbols/prepare?nodeId=node-1&path=src%2Fcurrent.ts',
      headers
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ preparation: { state: 'BUILDING' } });
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.symbol.prepare',
      { workspaceId: 'workspace-1', path: 'src/current.ts' },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      15_000
    );
  });
  it('forwards an explicit content-search regular-expression mode only', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValueOnce({
      search: { matches: [], engine: 'RIPGREP', truncated: false, skippedFiles: 0 }
    });

    const reply = await app.inject({
      url: '/api/workspaces/workspace-1/content/search?nodeId=node-1&q=%5Econst&regex=true',
      headers
    });

    expect(reply.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.content.search',
      { workspaceId: 'workspace-1', query: '^const', regex: true },
      { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
      undefined
    );

    requestNode.mockClear();
    const invalid = await app.inject({
      url: '/api/workspaces/workspace-1/content/search?nodeId=node-1&q=%5Econst&regex=false',
      headers
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('FILE_CONTENT_SEARCH_INVALID');
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('rejects cross-origin mutation before forwarding', async () => {
    const { app, requestNode, headers } = fixture();
    const reply = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { ...headers, origin: 'http://other' },
      payload: { nodeId: 'node-1', path: '/workspace' }
    });
    expect(reply.statusCode).toBe(403);
    expect(requestNode).not.toHaveBeenCalled();
  });
  it('retains the host error mapping and does not retry failed requests', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockRejectedValueOnce(new Error('NODE_OFFLINE'));
    const reply = await app.inject({ url: '/api/workspaces?nodeId=node-1', headers });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('NODE_OFFLINE');
    expect(requestNode).toHaveBeenCalledTimes(1);
  });
});
