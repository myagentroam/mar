import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWorkspaceRoutes } from '../../src/workspace-routes.js';
import { hashOpaque } from '../../src/session-token.js';
import { SESSION_COOKIE_NAME } from '../../src/auth.js';
import { sendError } from '../../src/http-errors.js';
import { databaseError } from '../../src/domain-errors.js';
import { NodeRequestError } from '../../src/node-request-error.js';
import { NodeRequestChannel } from '../../src/node-request-channel.js';
import type { UserNodeAuthorization } from '../../src/node-access-contracts.js';
import { createEnvelope } from '@myagentroam/protocol';
import type { WorkspaceResourcePolicy } from '../../src/workspace-route-contracts.js';
import { personalWorkspacePolicy } from '../support/workspace-resource-policy.js';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture(resources?: WorkspaceResourcePolicy, handleError?: typeof databaseError) {
  const app = Fastify();
  apps.push(app);
  const requestNode = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ workspaces: [] }));
  const ownsWorkbenchConnection = vi.fn(() => false);
  const revalidateDataAuthorizations = vi.fn(async () => undefined);
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
      revalidateDataAuthorizations
    },
    resources: resources ?? personalWorkspacePolicy(),
    databaseError:
      handleError ??
      ((reply, error) =>
        sendError(reply, 409, error instanceof Error ? error.message : 'NODE_RESPONSE_INVALID'))
  });
  return {
    app,
    requestNode,
    ownsWorkbenchConnection,
    revalidateDataAuthorizations,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=session`,
      origin: 'http://localhost',
      'x-csrf-token': 'csrf'
    }
  };
}

it('relays bounded GIF previews and returns 413 without image data when Node rejects the size', async () => {
  const { app, headers, requestNode } = fixture(undefined, databaseError);
  const url =
    '/api/workspaces/workspace-1/files/content?nodeId=node-1&path=animation.gif&originalGif=1';
  const bytes = Buffer.from('GIF89a');
  requestNode.mockResolvedValueOnce({
    image: { mime: 'image/gif', dataBase64: bytes.toString('base64'), resized: false }
  });
  const ok = await app.inject({ url, headers });
  expect(ok.statusCode).toBe(200);
  expect(ok.headers['content-type']).toBe('image/gif');
  expect(ok.rawPayload).toEqual(bytes);
  expect(requestNode).toHaveBeenCalledWith(
    'node-1',
    'workspace.file.content.read',
    { workspaceId: 'workspace-1', path: 'animation.gif', preview: { originalGif: true } },
    expect.anything(),
    undefined
  );
  requestNode.mockRejectedValueOnce(
    new NodeRequestError(
      { error: 'IMAGE_PREVIEW_TOO_LARGE', message: 'The image preview is too large.' },
      'request',
      'node'
    )
  );
  const rejected = await app.inject({ url, headers });
  expect(rejected.statusCode).toBe(413);
  expect(rejected.headers['content-type']).toContain('application/json');
  expect(rejected.json().error.code).toBe('IMAGE_PREVIEW_TOO_LARGE');
  for (const query of ['&download=1', '&maxWidth=320&maxHeight=240'])
    expect((await app.inject({ url: `${url}${query}`, headers })).statusCode).toBe(400);
  expect(requestNode).toHaveBeenCalledTimes(2);
});
describe('Shared Workspace HTTP routes', () => {
  it.each([undefined, '', 'modules/tool'])(
    'forwards authenticated fetch with repository scope %s and only its result marker',
    async (repositoryPath) => {
      const { app, requestNode, headers } = fixture();
      requestNode.mockResolvedValue({ fetchFailed: true });
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspaces/workspace-1/git/fetch?nodeId=node-1',
        headers,
        payload: { nodeId: 'node-1', ...(repositoryPath === undefined ? {} : { repositoryPath }) }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ fetchFailed: true });
      expect(requestNode.mock.calls[0]).toEqual([
        'node-1',
        'workspace.git.fetch',
        { workspaceId: 'workspace-1', ...(repositoryPath === undefined ? {} : { repositoryPath }) },
        { userId: 1, sessionHash: 'session-hash', workspaceId: 'workspace-1' },
        undefined
      ]);
    }
  );

  it('rejects fetch without CSRF and rejects invalid repository scope before dispatch', async () => {
    const { app, requestNode, headers } = fixture();
    const withoutCsrf = { ...headers, 'x-csrf-token': '' };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/git/fetch',
      headers: withoutCsrf,
      payload: { nodeId: 'node-1' }
    });
    expect(denied.statusCode).toBe(403);
    for (const payload of [undefined, null, [], 'invalid']) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/workspaces/workspace-1/git/fetch',
        headers,
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
        ...(payload === undefined
          ? {}
          : { headers: { ...headers, 'content-type': 'application/json' } })
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: 'NODE_ID_REQUIRED' } });
    }
    for (const repositoryPath of [1, null, 'bad\0path']) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/workspaces/workspace-1/git/fetch',
        headers,
        payload: { nodeId: 'node-1', repositoryPath }
      });
      expect(invalid.statusCode).toBe(400);
    }
    expect(requestNode).not.toHaveBeenCalled();
  });

  it('does not relay workspace removal when the required policy rejects it', async () => {
    const resources = personalWorkspacePolicy();
    resources.assertCanUnregisterWorkspace = vi.fn(async () => {
      throw new Error('WORKSPACE_ACCESS_DENIED');
    });
    const { app, requestNode, headers } = fixture(resources);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/workspaces/workspace-1?nodeId=node-1',
      headers
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'WORKSPACE_ACCESS_DENIED' } });
    expect(requestNode).not.toHaveBeenCalled();
  });
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
          sourceRevision: 'a'.repeat(64),
          offset: data.offset,
          bytes: Buffer.from('0123456789').subarray(data.offset, data.offset + data.limit)
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
          sourceRevision: 'a'.repeat(64),
          offset,
          bytes: original.subarray(offset, offset + limit)
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

  it.each([
    ['/files/content', 'FILE_RELAY_BUSY', 429],
    [`/git/commits/${'a'.repeat(40)}/files/content`, 'FILE_RELAY_UNAVAILABLE', 503]
  ] as const)('preserves a first-chunk relay error on %s', async (route, code, status) => {
    const { app, requestNode, headers } = fixture(undefined, databaseError);
    requestNode
      .mockResolvedValueOnce({
        file: { size: 4, offset: 0, sourceRevision: 'a'.repeat(64), bytes: Buffer.of(1) }
      })
      .mockRejectedValueOnce(new Error(code));

    const response = await app.inject({
      url: `/api/workspaces/workspace-1${route}?nodeId=node-1&path=clip.mp4`,
      headers: { ...headers, range: 'bytes=1-2' }
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(requestNode.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ offset: 0, limit: 1 }),
      expect.objectContaining({ offset: 1, limit: 2 })
    ]);
  });

  it('rejects a same-size Workspace revision change before sending native preview headers', async () => {
    const { app, requestNode, headers } = fixture(undefined, databaseError);
    requestNode
      .mockResolvedValueOnce({
        file: { size: 4, offset: 0, sourceRevision: 'a'.repeat(64), bytes: Buffer.of(1) }
      })
      .mockResolvedValueOnce({
        file: { size: 4, offset: 1, sourceRevision: 'b'.repeat(64), bytes: Buffer.of(2, 3) }
      });
    const response = await app.inject({
      url: '/api/workspaces/workspace-1/files/content?nodeId=node-1&path=changed.mp4',
      headers: { ...headers, range: 'bytes=1-2' }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'NODE_RESPONSE_INVALID' } });
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('aborts a started Workspace media preview without emitting bytes from a new revision', async () => {
    const { app, requestNode, headers } = fixture(undefined, databaseError);
    const nextChunk = Promise.withResolvers<void>();
    requestNode
      .mockResolvedValueOnce({
        file: { size: 4, offset: 0, sourceRevision: 'a'.repeat(64), bytes: Buffer.of(1) }
      })
      .mockResolvedValueOnce({
        file: { size: 4, offset: 0, sourceRevision: 'a'.repeat(64), bytes: Buffer.of(1, 2) }
      })
      .mockImplementationOnce(async () => {
        await nextChunk.promise;
        return {
          file: { size: 4, offset: 2, sourceRevision: 'b'.repeat(64), bytes: Buffer.of(3, 4) }
        };
      });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(
        `${origin}/api/workspaces/workspace-1/files/content?nodeId=node-1&path=changed.mp4`,
        { headers }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe('4');
      const body = response.body!.getReader();
      expect(await body.read()).toMatchObject({ value: Uint8Array.of(1, 2), done: false });
      nextChunk.resolve();
      await expect(body.read()).rejects.toThrow();
    } finally {
      nextChunk.resolve();
    }
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
            sourceRevision: 'a'.repeat(64),
            offset: data.offset,
            bytes: Buffer.alloc(Math.min(data.limit, size - data.offset), 7)
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
            sourceRevision: 'a'.repeat(64),
            offset: data.offset,
            bytes: Buffer.alloc(Math.min(data.limit, size - data.offset), 9)
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

  it('retains the complete image preview limit and rejects invalid ranges', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockResolvedValue({
      file: {
        path: 'large.png',
        size: 20 * 1024 * 1024 + 1,
        offset: 0,
        sourceRevision: 'a'.repeat(64),
        bytes: Buffer.from([0])
      }
    });
    const url = '/api/workspaces/workspace-1/files/content?nodeId=node-1&path=large.png';
    expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(413);
    expect(
      (await app.inject({ method: 'GET', url, headers: { ...headers, range: 'bytes=99999999-' } }))
        .statusCode
    ).toBe(416);
    expect(requestNode).toHaveBeenCalledTimes(2);
  });

  it.each(['/files/content', `/git/commits/${'a'.repeat(40)}/files/content`])(
    'rejects ordinary file body requests at the native HTTP endpoint %s',
    async (route) => {
      const { app, requestNode, headers } = fixture();
      const url = `/api/workspaces/workspace-1${route}?nodeId=node-1&path=`;
      for (const method of ['GET', 'HEAD'] as const) {
        expect((await app.inject({ method, url: `${url}text.txt`, headers })).statusCode).toBe(415);
      }
      expect((await app.inject({ url: `${url}clip.mp4&download=1`, headers })).statusCode).toBe(
        400
      );
      expect(
        (await app.inject({ url: `${url}large.bin`, headers: { ...headers, range: 'bytes=0-1' } }))
          .statusCode
      ).toBe(415);
      expect(requestNode).not.toHaveBeenCalled();
    }
  );

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
            bytes: Buffer.alloc(Math.min(data.limit, size - data.offset), 5)
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
      file: { path: 'clip.mp4', size: 20 * 1024 * 1024 + 1, offset: 0, bytes: Buffer.from([0]) }
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
            bytes: Buffer.alloc(limit, 7)
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
  it('does not accept Workspace upload bodies over HTTP', async () => {
    const { app, requestNode, headers } = fixture();
    const reply = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/uploads/upload-1/chunks?nodeId=node-1&offset=0',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0, 1, 255])
    });
    expect(reply.statusCode).toBe(404);
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
      updateWorkspaceGroupName,
      updateWorkspace
    } satisfies WorkspaceResourcePolicy;
    const { app, headers, revalidateDataAuthorizations } = fixture(resources);

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
    expect(revalidateDataAuthorizations).not.toHaveBeenCalled();
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
      updateWorkspaceGroupName: vi.fn(async () => undefined),
      updateWorkspace: vi.fn(async () => undefined)
    } satisfies WorkspaceResourcePolicy;
    const { app, headers, requestNode, revalidateDataAuthorizations } = fixture(resources);

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
    expect(revalidateDataAuthorizations).toHaveBeenCalledExactlyOnceWith({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    expect(unregisterWorkspace).toHaveBeenCalledBefore(revalidateDataAuthorizations);
  });
  it('lets a currently authorized retry finish Server cleanup after Node removal and a revoked first attempt', async () => {
    const resources = personalWorkspacePolicy();
    let authorized = true;
    let serverWorkspaceExists = true;
    let nodeWorkspaceExists = true;
    resources.assertCanUnregisterWorkspace = vi.fn(async () => {
      if (!authorized) throw new Error('WORKSPACE_FORBIDDEN');
    });
    const unregister = vi.fn(async () => {
      if (!authorized) throw new Error('WORKSPACE_FORBIDDEN');
      serverWorkspaceExists = false;
    });
    resources.unregisterWorkspace = unregister;
    const { app, headers, requestNode, revalidateDataAuthorizations } = fixture(resources);
    requestNode.mockImplementation(async () => {
      if (!nodeWorkspaceExists)
        throw new NodeRequestError(
          { error: 'WORKSPACE_NOT_FOUND', message: 'Workspace was not found.' },
          'request-2',
          'node'
        );
      nodeWorkspaceExists = false;
      authorized = false;
      return { workspace: { id: 'workspace-1' } };
    });
    const request = {
      method: 'DELETE' as const,
      url: '/api/workspaces/workspace-1?nodeId=node-1',
      headers
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(409);
    expect(first.json()).toMatchObject({ error: { code: 'WORKSPACE_FORBIDDEN' } });
    expect(nodeWorkspaceExists).toBe(false);
    expect(serverWorkspaceExists).toBe(true);
    const deniedRetry = await app.inject(request);
    expect(deniedRetry.statusCode).toBe(409);
    expect(requestNode).toHaveBeenCalledTimes(1);
    expect(revalidateDataAuthorizations).not.toHaveBeenCalled();
    authorized = true;
    const retry = await app.inject(request);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({});
    expect(serverWorkspaceExists).toBe(false);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenLastCalledWith(1, 'node-1', 'workspace-1');
    expect(revalidateDataAuthorizations).toHaveBeenCalledExactlyOnceWith({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
  });

  it('finishes an authorized retry from a correlated Node response through the real request channel', async () => {
    let sent: { id: string } | undefined;
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: (raw: string) => {
        sent = JSON.parse(raw) as { id: string };
      }
    };
    const channel = new NodeRequestChannel(() => socket as never);
    const resources = personalWorkspacePolicy();
    const unregister = vi.spyOn(resources, 'unregisterWorkspace');
    const { app, headers, requestNode } = fixture(resources);
    requestNode.mockImplementationOnce(async (nodeId, operation, data, user) => {
      if (typeof nodeId !== 'string' || typeof operation !== 'string')
        throw new Error('INVALID_REQUEST');
      const result = channel.request(nodeId, operation, data, user as UserNodeAuthorization);
      if (sent === undefined) throw new Error('REQUEST_NOT_SENT');
      channel.resolve(
        nodeId,
        createEnvelope(
          'node.response',
          {
            error: 'WORKSPACE_NOT_FOUND',
            message: 'Workspace was not found.'
          },
          { replyTo: sent.id }
        )
      );
      return result;
    });
    try {
      const reply = await app.inject({
        method: 'DELETE',
        url: '/api/workspaces/workspace-1?nodeId=node-1',
        headers
      });
      expect(reply.statusCode).toBe(200);
      expect(unregister).toHaveBeenCalledWith(1, 'node-1', 'workspace-1');
    } finally {
      channel.close();
      await app.close();
    }
  });

  it.each([
    new NodeRequestError(
      { error: 'WORKSPACE_NOT_FOUND', message: 'Workspace was not found.' },
      'request',
      'transport'
    ),
    new NodeRequestError(
      { error: 'NODE_OFFLINE', message: 'Node is offline.' },
      'request',
      'transport'
    ),
    new NodeRequestError(
      { error: 'WORKSPACE_BUSY', message: 'Workspace is busy.' },
      'request',
      'node'
    ),
    new NodeRequestError(
      { error: 'NODE_ACCESS_DENIED', message: 'Node access denied.' },
      'request',
      'transport'
    ),
    new NodeRequestError(
      { error: 'NODE_REQUEST_TIMEOUT', message: 'Node request timed out.' },
      'request',
      'transport'
    )
  ])('does not infer a missing Workspace from an unrelated failure %s', async (failure) => {
    const resources = personalWorkspacePolicy();
    const unregister = vi.spyOn(resources, 'unregisterWorkspace');
    const { app, headers, requestNode } = fixture(resources);
    requestNode.mockRejectedValueOnce(failure);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/workspaces/workspace-1?nodeId=node-1',
      headers
    });
    expect(response.statusCode).toBe(409);
    expect(unregister).not.toHaveBeenCalled();
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
