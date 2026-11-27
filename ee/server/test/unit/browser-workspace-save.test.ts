import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
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
  const browserId = randomUUID();
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
  let allowed = true;
  const service = new BrowserWorkbenchService({
    workbench: { ownsActiveConnection: () => true, sendDirectConnection: send } as Pick<
      Options['workbench'],
      'ownsActiveConnection' | 'sendDirectConnection'
    > as Options['workbench'],
    direct: {} as Options['direct'],
    request,
    authorize: () => allowed,
    capability: () => ({ apiVersion: 1, ice: false, nodeGeneration: 'generation' }),
    settings: () => undefined,
    failed: vi.fn()
  });
  try {
    await service.message(
      { ...owner, workbenchConnectionId: connectionId },
      {
        type: 'browser.request',
        requestId: randomUUID(),
        request: { ...scope, action: 'attach', browserId }
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
        createBrowserDownloadTicket: service.createDownloadTicket.bind(service),
        createBrowserUploadTicket: service.createUploadTicket.bind(service),
        openBrowserDirectFile: service.openDirectFile.bind(service),
        closeBrowserDirectFile: service.closeDirectFile.bind(service)
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
        method: 'POST',
        url: `/api/browser/downloads/stream-ticket?${new URLSearchParams({ connectionId })}`,
        headers: {
          origin,
          cookie: `${SESSION_COOKIE_NAME}=fixture-session`,
          'x-csrf-token': 'fixture-csrf'
        },
        payload: { attachmentId: payload.attachmentId, id }
      });
    const info = { id, name: 'sample.bin', state: 'ready', size: 3 };
    request.mockResolvedValueOnce({ ...info, id: randomUUID() });
    const wrongFile = await download();
    expect(wrongFile.statusCode).toBe(502);
    expect(wrongFile.json()).toMatchObject({ error: { code: 'NODE_RESPONSE_INVALID' } });
    const grant = randomUUID();
    request.mockResolvedValueOnce(info).mockResolvedValueOnce({ grant });
    const responseTicket = await download();
    expect(responseTicket.statusCode).toBe(200);
    const { ticket } = responseTicket.json();
    const controller = new AbortController();
    await expect(
      service.authorizeFileStream('file-download', ticket, scope.nodeId, owner, controller.signal)
    ).resolves.toBeUndefined();
    await expect(
      service.authorizeFileStream(
        'browser-file-download',
        ticket,
        scope.nodeId,
        { ...owner, sessionHash: 'other' },
        controller.signal
      )
    ).resolves.toBeUndefined();
    const opened = await service.authorizeFileStream(
      'browser-file-download',
      ticket,
      scope.nodeId,
      owner,
      controller.signal
    );
    expect(opened).toMatchObject({ grant });
    expect(request).toHaveBeenLastCalledWith(
      scope.nodeId,
      'download',
      'generation',
      {
        workspaceId: scope.workspaceId,
        browserId,
        command: { action: 'stream', id, size: 3 }
      },
      owner
    );
    await expect(
      service.authorizeFileStream(
        'browser-file-download',
        ticket,
        scope.nodeId,
        owner,
        controller.signal
      )
    ).resolves.toBeUndefined();
    allowed = false;
    await service.revalidateFileAuthorizations();
    expect(opened).toMatchObject({ revoked: { aborted: true } });
    controller.abort();
  } finally {
    service.close();
    await app.close();
  }
});

it('admits Browser uploads and downloads without accepting HTTP file bodies', async () => {
  const app = Fastify();
  const origin = 'http://console.local';
  const user = { userId: 17, sessionHash: 'session-hash' };
  const write = vi.fn(async () => {});
  const bytes = Buffer.of(0, 0xff, 0x80);
  const ticket = { nodeId: 'node', name: 'sample.bin', size: bytes.length, ticket: randomUUID() };
  const createBrowserDownloadTicket = vi.fn(async () => ticket);
  const createBrowserUploadTicket = vi.fn(async () => ({ ticket: ticket.ticket }));
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
    {
      uploadBrowserFile: write,
      createBrowserDownloadTicket,
      createBrowserUploadTicket,
      downloadBrowserFile: vi.fn(),
      openBrowserDirectFile: vi.fn(),
      closeBrowserDirectFile: vi.fn()
    }
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
  const url = `/api/browser/uploads?${new URLSearchParams({ connectionId })}`;
  const uploadUrl = `/api/browser/uploads/stream-ticket?${new URLSearchParams({ connectionId })}`;
  const upload = { attachmentId, chooserId, command: { action: 'stream', transferId, index: 0 } };
  const prepareUpload = () =>
    app.inject({ method: 'POST', url: uploadUrl, headers, payload: upload });
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
    const binary = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: bytes
    });
    expect(binary.statusCode).toBe(415);
    const accepted = await prepareUpload();
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ ticket: ticket.ticket });
    expect(createBrowserUploadTicket).toHaveBeenCalledExactlyOnceWith(user, connectionId, upload);
    expect(write).not.toHaveBeenCalled();
    const downloadUrl = `/api/browser/downloads/stream-ticket?${new URLSearchParams({ connectionId })}`;
    const download = () =>
      app.inject({ method: 'POST', url: downloadUrl, headers, payload: { attachmentId, id } });
    const downloaded = await download();
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.json()).toEqual(ticket);
    expect(createBrowserDownloadTicket).toHaveBeenCalledExactlyOnceWith(
      user,
      connectionId,
      attachmentId,
      id
    );
    expect((await app.inject({ url: '/api/browser/downloads/file', headers })).statusCode).toBe(
      404
    );
    for (const [code, status] of [
      ['FILE_RELAY_BUSY', 429],
      ['FILE_RELAY_UNAVAILABLE', 503]
    ] as const) {
      createBrowserUploadTicket.mockRejectedValueOnce(new Error(code));
      const failed = await prepareUpload();
      expect(failed.statusCode).toBe(status);
      expect(failed.json()).toMatchObject({ error: { code } });
      createBrowserDownloadTicket.mockRejectedValueOnce(new Error(code));
      const downloadFailed = await download();
      expect(downloadFailed.statusCode).toBe(status);
      expect(downloadFailed.json()).toMatchObject({ error: { code } });
      expect(downloadFailed.headers['content-disposition']).toBeUndefined();
    }
    const invalid = await app.inject({
      method: 'POST',
      url: downloadUrl,
      headers,
      payload: { attachmentId, id: 'invalid' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'BROWSER_DOWNLOAD_INVALID' } });

    createBrowserDownloadTicket.mockResolvedValueOnce({ ...ticket, name: 'empty.bin', size: 0 });
    const empty = await download();
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ name: 'empty.bin', size: 0 });
  } finally {
    await app.close();
  }
});
