import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { SESSION_COOKIE_NAME } from '@myagentroam/server-core/auth';
import { NodeRequestError } from '@myagentroam/server-core/node-request-error';
import { hashOpaque } from '@myagentroam/server-core/session-token';
import { expect, it, vi } from 'vitest';
import { registerBrowserFileRoutes } from '../../src/route/browser-file-routes.js';
import { BrowserWorkbenchService } from '../../src/service/browser-workbench-service.js';

it('binds Workspace save to the attachment and returns a correlated unknown outcome to HTTP', async () => {
  type Options = ConstructorParameters<typeof BrowserWorkbenchService>[0];
  const app = Fastify();
  const scope = { nodeId: 'node', workspaceId: 'workspace' };
  const owner = { userId: 17, sessionHash: 'session-hash' };
  const connectionId = randomUUID();
  const upstreamRequestId = randomUUID();
  const send = vi.fn<Options['workbench']['sendDirectConnection']>(async () => {});
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
        openBrowserDownload: vi.fn()
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
  } finally {
    service.close();
    await app.close();
  }
});
