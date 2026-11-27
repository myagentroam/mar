import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { BROWSER_DOWNLOAD_CHUNK_BYTES } from '@myagentroam/protocol';
import { SESSION_COOKIE_NAME } from '@myagentroam/server-core/auth';
import { NodeRequestError } from '@myagentroam/server-core/node-request-error';
import { hashOpaque } from '@myagentroam/server-core/session-token';
import { expect, it, vi } from 'vitest';
import { registerBrowserFileRoutes } from '../../src/route/browser-file-routes.js';
import { BrowserWorkbenchService } from '../../src/service/browser-workbench-service.js';

it('binds Browser downloads to the attachment and preserves structured HTTP failures', async () => {
  type Options = ConstructorParameters<typeof BrowserWorkbenchService>[0];
  const app = Fastify();
  const scope = { nodeId: 'node', workspaceId: 'workspace' };
  const owner = { userId: 17, sessionHash: 'session-hash' };
  const connectionId = randomUUID();
  const upstreamRequestId = randomUUID();
  const send = vi.fn<Options['workbench']['sendDirectConnection']>(async () => 'delivered');
  const request = vi.fn<Options['request']>(async (_node, operation) => {
    if (operation === 'download')
      throw new NodeRequestError(
        { error: 'BROWSER_OUTCOME_UNKNOWN', message: 'The Workspace copy could not be confirmed.' },
        upstreamRequestId
      );
    return {};
  });
  const service = new BrowserWorkbenchService({
    workbench: { ownsActiveConnection: () => true, sendDirectConnection: send } as Pick<
      Options['workbench'],
      'ownsActiveConnection' | 'sendDirectConnection'
    > as Options['workbench'],
    direct: {} as Options['direct'],
    request,
    authorize: () => true,
    capability: () => ({ apiVersion: 1, ice: false, nodeGeneration: 'generation' }),
    settings: () => undefined,
    authenticateNode: async () => true,
    failed: vi.fn()
  });
  try {
    await service.message(
      { ...owner, workbenchConnectionId: connectionId },
      {
        type: 'browser.request',
        requestId: randomUUID(),
        request: { ...scope, action: 'attach', browserId: randomUUID() }
      }
    );
    const event = send.mock.lastCall?.[1] as { result?: { attachmentId: string } };
    expect(event.result?.attachmentId).toBeDefined();
    const origin = 'http://console.local';
    registerBrowserFileRoutes(
      app,
      {
        findCurrentUserSession: () => ({
          ...owner,
          username: 'user',
          isAdmin: false,
          mustChangePassword: false,
          csrfTokenHash: hashOpaque('fixture-csrf')
        })
      },
      origin,
      {
        downloadBrowserFile: service.download.bind(service),
        uploadBrowserFile: vi.fn(),
        openBrowserDownload: service.openDownload.bind(service)
      }
    );
    const payload = {
      attachmentId: event.result!.attachmentId,
      command: { action: 'workspace', id: randomUUID(), path: 'reports/copy.bin' }
    };
    const inject = (connection: string) =>
      app.inject({
        method: 'POST',
        url: `/api/browser/downloads/workspace?connectionId=${connection}`,
        headers: {
          origin,
          cookie: `${SESSION_COOKIE_NAME}=fixture-session`,
          'x-csrf-token': 'fixture-csrf'
        },
        payload
      });
    const denied = await inject(randomUUID());
    expect(denied.statusCode).toBe(403);
    expect(request).toHaveBeenCalledTimes(1); // Only prepare has reached the Node.
    const response = await inject(connectionId);
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({
      error: { code: 'BROWSER_OUTCOME_UNKNOWN', upstreamRequestId }
    });
    expect(request).toHaveBeenLastCalledWith(
      scope.nodeId,
      'download',
      'generation',
      payload,
      owner,
      scope.workspaceId
    );
    const id = randomUUID();
    const download = () =>
      app.inject({
        url: `/api/browser/downloads/file?${new URLSearchParams({ connectionId, attachmentId: payload.attachmentId, id })}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=fixture-session` }
      });
    const info = { id, name: 'sample.bin', state: 'ready', size: 3 };
    request.mockResolvedValueOnce({ ...info, id: randomUUID() });
    const wrongFile = await download();
    expect(wrongFile.statusCode).toBe(502);
    expect(wrongFile.json()).toMatchObject({ error: { code: 'NODE_RESPONSE_INVALID' } });
    request
      .mockResolvedValueOnce(info)
      .mockResolvedValueOnce({ offset: 'zero', bytes: Buffer.of(1, 2, 3) });
    const malformed = await download();
    expect(malformed.statusCode).toBe(502);
    expect(malformed.json()).toMatchObject({ error: { code: 'NODE_RESPONSE_INVALID' } });
  } finally {
    service.close();
    await app.close();
  }
});

it('accepts only an HTTP binary upload chunk and streams raw download bytes', async () => {
  const app = Fastify();
  const origin = 'http://console.local';
  const user = { userId: 17, sessionHash: 'session-hash' };
  const write = vi.fn(async () => {});
  const bytes = Buffer.of(0, 0xff, 0x80);
  const content = Buffer.concat([Buffer.alloc(BROWSER_DOWNLOAD_CHUNK_BYTES, 0xaa), bytes]);
  const read = vi.fn(async (offset: number, limit: number) => ({
    size: content.length,
    offset,
    bytes: content.subarray(offset, offset + limit)
  }));
  const openDownload = vi.fn(async () => ({ name: 'sample.bin', size: content.length, read }));
  registerBrowserFileRoutes(
    app,
    {
      findCurrentUserSession: () => ({
        ...user,
        username: 'user',
        isAdmin: false,
        mustChangePassword: false,
        csrfTokenHash: hashOpaque('fixture-csrf')
      })
    },
    origin,
    { uploadBrowserFile: write, openBrowserDownload: openDownload, downloadBrowserFile: vi.fn() }
  );
  const connectionId = randomUUID();
  const attachmentId = randomUUID();
  const chooserId = randomUUID();
  const transferId = randomUUID();
  const id = randomUUID();
  const headers = {
    origin,
    cookie: `${SESSION_COOKIE_NAME}=fixture-session`,
    'x-csrf-token': 'fixture-csrf'
  };
  const url = `/api/browser/uploads?${new URLSearchParams({ connectionId, attachmentId, chooserId, transferId, index: '0', offset: '0' })}`;
  try {
    const mismatched = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        attachmentId,
        chooserId,
        command: {
          action: 'chunk',
          transferId,
          index: 0,
          offset: 0,
          dataBase64: bytes.toString('base64')
        }
      }
    });
    expect(mismatched.statusCode).toBe(400);
    expect(write).not.toHaveBeenCalled();
    const accepted = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: bytes
    });
    expect(accepted.statusCode).toBe(200);
    expect(write).toHaveBeenCalledExactlyOnceWith(user, connectionId, {
      attachmentId,
      chooserId,
      command: { action: 'chunk', transferId, index: 0, offset: 0, bytes }
    });
    const downloadUrl = `/api/browser/downloads/file?${new URLSearchParams({ connectionId, attachmentId, id })}`;
    const downloaded = await app.inject({ url: downloadUrl, headers });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-length']).toBe(String(content.length));
    expect(downloaded.rawPayload.equals(content)).toBe(true);
    expect(openDownload).toHaveBeenCalledExactlyOnceWith(user, connectionId, attachmentId, id);
    expect(read.mock.calls).toEqual([
      [0, BROWSER_DOWNLOAD_CHUNK_BYTES],
      [BROWSER_DOWNLOAD_CHUNK_BYTES, bytes.length]
    ]);
    for (const [code, status] of [
      ['FILE_RELAY_BUSY', 429],
      ['FILE_RELAY_UNAVAILABLE', 503]
    ] as const) {
      write.mockRejectedValueOnce(new Error(code));
      const failed = await app.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: bytes
      });
      expect(failed.statusCode).toBe(status);
      expect(failed.json()).toMatchObject({ error: { code } });
      read.mockRejectedValueOnce(new Error(code));
      const downloadFailed = await app.inject({ url: downloadUrl, headers });
      expect(downloadFailed.statusCode).toBe(status);
      expect(downloadFailed.json()).toMatchObject({ error: { code } });
      expect(downloadFailed.headers['content-disposition']).toBeUndefined();
    }
    read.mockResolvedValueOnce({ size: bytes.length, offset: 1, bytes });
    const invalid = await app.inject({ url: downloadUrl, headers });
    expect(invalid.statusCode).toBe(502);
    expect(invalid.json()).toMatchObject({ error: { code: 'NODE_RESPONSE_INVALID' } });

    read.mockClear();
    openDownload.mockClear();
    const head = await app.inject({ method: 'HEAD', url: downloadUrl, headers });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(content.length));
    expect(head.rawPayload).toHaveLength(0);
    expect(openDownload).toHaveBeenCalledExactlyOnceWith(user, connectionId, attachmentId, id);
    expect(read).not.toHaveBeenCalled();

    openDownload.mockResolvedValueOnce({ name: 'empty.bin', size: 0, read });
    const empty = await app.inject({ url: downloadUrl, headers });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers['content-length']).toBe('0');
    expect(empty.rawPayload).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
