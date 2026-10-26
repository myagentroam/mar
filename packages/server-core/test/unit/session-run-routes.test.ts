import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSessionRunRoutes } from '../../src/session-run-routes.js';
import { registerRunControlRoutes } from '../../src/run-control-routes.js';
import { registerTerminalRoutes } from '../../src/terminal-routes.js';
import { registerRunnerRoutes } from '../../src/runner-routes.js';
import { hashOpaque } from '../../src/session-token.js';
import { SESSION_COOKIE_NAME } from '../../src/auth.js';
import { sendError } from '../../src/http-errors.js';
import type { ConversationAuditObserver } from '../../src/conversation-audit.js';
import type { MarAgentRuntimeModelService } from '../../src/session-run-contracts.js';
import type { MarAgentRuntimeModelConfiguration } from '@myagentroam/protocol';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(
  overrides: {
    readonly marAgentRuntimeModels?: Pick<MarAgentRuntimeModelService, 'prepare'>;
    readonly audits?: ConversationAuditObserver;
  } = {}
) {
  const app = Fastify();
  apps.push(app);
  const requestNode = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
    session: { id: 'session-one' }
  }));
  const session = {
    userId: 1,
    username: 'admin',
    isAdmin: true,
    sessionHash: 'fingerprint',
    mustChangePassword: false,
    csrfTokenHash: hashOpaque('csrf')
  };
  const input = {
    app,
    database: {
      findCurrentUserSession: (token: string) => (token === 'session' ? session : undefined),
      userDisplayName: vi.fn(async (id: number) =>
        id === 1 ? 'Current nickname' : id === 7 ? 'Recipient nickname' : undefined
      ),
      userOwnsNode: async () => true
    },
    publicOrigin: 'http://localhost',
    nodeControl: { requestNode, ownsWorkbenchConnection: () => false },
    secrets: { resolve: vi.fn(async () => ({ FIXTURE_TOKEN: 'private-value' })) },
    ...(overrides.marAgentRuntimeModels === undefined
      ? {}
      : { marAgentRuntimeModels: overrides.marAgentRuntimeModels }),
    ...(overrides.audits === undefined ? {} : { audits: overrides.audits }),
    databaseError: (reply: Parameters<typeof sendError>[0], error: unknown) =>
      sendError(reply, 403, error instanceof Error ? error.message : 'INTERNAL_ERROR')
  };
  registerSessionRunRoutes(input);
  registerRunControlRoutes(input);
  registerRunnerRoutes({ ...input, capabilities: {} as never });
  return {
    ...input,
    requestNode,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=session`,
      origin: 'http://localhost',
      'x-csrf-token': 'csrf'
    }
  };
}

describe('shared ordinary Session and Run routes', () => {
  it('relays a terminal idempotent message receipt without replacing its Run identity', async () => {
    const { app, requestNode, headers } = fixture();
    const receipt = {
      session: { id: 'session-one' },
      run: { id: 'original-run', status: 'SUCCEEDED' },
      delivery: 'STARTED',
      idempotent: true
    };
    requestNode.mockResolvedValue(receipt);
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-one/messages',
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        clientMessageId: 'original-message',
        content: 'Retry'
      }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject(receipt);
  });
  it('forwards Session Prompt partial updates only after the Node confirms support', async () => {
    const { app, requestNode, headers } = fixture();
    const url = '/api/agent-sessions/session-one/metadata';
    for (const sessionPrompt of ['Session instructions', '', null]) {
      requestNode.mockClear();
      requestNode.mockResolvedValueOnce({
        session: { runtime: { capabilities: ['session.prompt'] } }
      });
      const result = await app.inject({
        method: 'PATCH',
        url,
        headers,
        payload: { nodeId: 'node-one', sessionPrompt }
      });
      expect(result.statusCode).toBe(200);
      expect(requestNode.mock.calls[0]).toContain('session.get');
      expect(requestNode.mock.calls[1]).toContain('session.metadata.update');
      expect(requestNode.mock.calls[1]).toContainEqual({ sessionId: 'session-one', sessionPrompt });
    }
    requestNode.mockClear();
    requestNode.mockResolvedValueOnce({ session: { runtime: { capabilities: [] } } });
    const unsupported = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { nodeId: 'node-one', sessionPrompt: 'Do not ignore this' }
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error.code).toBe('NODE_OPERATION_UNSUPPORTED');
    expect(requestNode).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid and unauthorized Session Prompt updates before any Node request', async () => {
    const { app, requestNode, headers } = fixture();
    const url = '/api/agent-sessions/session-one/metadata';
    for (const sessionPrompt of [false, 42, {}, 'x'.repeat(20_001)]) {
      const result = await app.inject({
        method: 'PATCH',
        url,
        headers,
        payload: { nodeId: 'node-one', sessionPrompt }
      });
      expect(result.statusCode).toBe(400);
    }
    const noCsrf = await app.inject({
      method: 'PATCH',
      url,
      headers: { cookie: headers.cookie, origin: headers.origin },
      payload: { nodeId: 'node-one', sessionPrompt: 'Rule' }
    });
    expect(noCsrf.statusCode).toBe(403);
    const noAuth = await app.inject({
      method: 'PATCH',
      url,
      payload: { nodeId: 'node-one', sessionPrompt: 'Rule' }
    });
    expect(noAuth.statusCode).toBe(401);
    expect(requestNode).not.toHaveBeenCalled();
  });

  it('clears only the parent relationship when explicitly requested', async () => {
    const { app, requestNode, headers } = fixture();
    const url = '/api/agent-sessions/session-one/metadata';
    const cleared = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { nodeId: 'node-one', clearParent: true }
    });
    expect(cleared.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledTimes(1);
    expect(requestNode.mock.calls[0]).toContainEqual({
      sessionId: 'session-one',
      clearParent: true
    });

    requestNode.mockClear();
    for (const payload of [
      { nodeId: 'node-one', clearParent: false },
      { nodeId: 'node-one', clearParent: true, customTitle: 'Do not combine' },
      { nodeId: 'node-one', clearParent: true, parentSessionId: null },
      { nodeId: 'node-one', parentSessionId: 'another-session' }
    ]) {
      const invalid = await app.inject({ method: 'PATCH', url, headers, payload });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('SESSION_INVALID');
    }
    expect(requestNode).not.toHaveBeenCalled();
  });

  it('authorizes bounded session tool resources and rejects invalid requests before forwarding', async () => {
    const { app, requestNode, headers } = fixture();
    const resourceRef = 'c10a59dd-680f-46f6-9b75-31bfbd520506';
    const page = {
      type: 'file_changes',
      version: 1,
      resourceRef,
      format: 'unified-diff',
      byteSize: 2,
      sha256: 'a'.repeat(64),
      content: '+a'
    };
    requestNode.mockResolvedValue(page);
    const url = `/api/agent-sessions/session-one/tool-resources/${resourceRef}?nodeId=node-one&workspaceId=workspace-one`;
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.json()).toEqual(page);
    expect(requestNode.mock.calls[0]).toContain('session.tool-resource.read');
    expect(requestNode.mock.calls[0]).toContainEqual({
      workspaceId: 'workspace-one',
      sessionId: 'session-one',
      resourceRef
    });
    requestNode.mockClear();
    expect((await app.inject({ url: `${url}&maxBytes=262145`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: url.replace('&workspaceId=workspace-one', ''), headers })).statusCode
    ).toBe(400);
    expect(requestNode).not.toHaveBeenCalled();
    requestNode.mockRejectedValueOnce(new Error('WORKSPACE_FORBIDDEN'));
    expect((await app.inject({ url, headers })).statusCode).toBe(403);
  });
  it.each(['AUTO', 'RUNNER', 'CUSTOM'] as const)(
    'relays %s Session titles unchanged through list and detail reads',
    async (titleSource) => {
      const { app, requestNode, headers } = fixture();
      const session = {
        id: 'session-one',
        runner: 'mar-agent',
        runnerTitle: titleSource === 'AUTO' ? 'First user message' : 'Generated title',
        customTitle: titleSource === 'CUSTOM' ? 'Custom title' : null,
        titleSource
      };
      requestNode.mockResolvedValueOnce({ sessions: [session], nextCursor: null });
      const list = await app.inject({
        url: '/api/agent-sessions?nodeId=node-one&workspaceId=workspace-one&query=title',
        headers
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ sessions: [session], nextCursor: null });
      expect(requestNode.mock.calls[0]).toContainEqual({
        workspaceId: 'workspace-one',
        query: 'title'
      });
      requestNode.mockResolvedValueOnce({ session });
      const detail = await app.inject({
        url: '/api/agent-sessions/session-one?nodeId=node-one',
        headers
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual({ session });
      expect(requestNode.mock.calls[1]).toContainEqual({ sessionId: session.id });
    }
  );

  it('forwards only strict MAIN or CHILD session-list filters and preserves the unfiltered default', async () => {
    const { app, requestNode, headers } = fixture();
    for (const sessionGroup of ['MAIN', 'CHILD'] as const) {
      requestNode.mockClear();
      const result = await app.inject({
        url: `/api/agent-sessions?nodeId=node-one&sessionGroup=${sessionGroup}`,
        headers
      });
      expect(result.statusCode).toBe(200);
      expect(requestNode.mock.calls[0]).toContain('session.list');
      expect(requestNode.mock.calls[0]).toContainEqual(expect.objectContaining({ sessionGroup }));
    }

    requestNode.mockClear();
    const unfiltered = await app.inject({ url: '/api/agent-sessions?nodeId=node-one', headers });
    expect(unfiltered.statusCode).toBe(200);
    expect(requestNode.mock.calls[0]).toContain('session.list');
    expect(requestNode.mock.calls[0]).not.toContainEqual(
      expect.objectContaining({ sessionGroup: expect.any(String) })
    );

    for (const sessionGroup of ['main', 'BOTH', '']) {
      requestNode.mockClear();
      const invalid = await app.inject({
        url: `/api/agent-sessions?nodeId=node-one&sessionGroup=${encodeURIComponent(sessionGroup)}`,
        headers
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('SESSION_INVALID');
      expect(requestNode).not.toHaveBeenCalled();
    }
  });

  it('reads stable native sources without serving an index-based conditional cache hit', async () => {
    const { app, requestNode, headers } = fixture();
    const runId = 'native-history:session-one';
    const imageRef = 'file:session%3Aimage.png';
    const url = `/api/agent-runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageRef)}?nodeId=node-one`;
    requestNode.mockResolvedValueOnce({
      image: { mime: 'image/png', dataBase64: Buffer.from('fresh-pixels').toString('base64') }
    });
    const response = await app.inject({
      url,
      headers: { ...headers, 'if-none-match': '"old-index-etag"' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from('fresh-pixels'));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.etag).toBeUndefined();
    expect(requestNode).toHaveBeenCalledWith(
      'node-one',
      'run.image.read',
      { runId, imageRef },
      expect.anything(),
      undefined
    );
    requestNode.mockClear();
    expect(
      (
        await app.inject({
          url: `/api/agent-runs/${encodeURIComponent(runId)}/images/0?nodeId=node-one`,
          headers
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `/api/agent-runs/${encodeURIComponent('native-history:hosted:conversation')}/images/${encodeURIComponent(imageRef)}?nodeId=node-one`,
          headers
        })
      ).statusCode
    ).toBe(400);
    expect(requestNode).not.toHaveBeenCalled();
    expect((await app.inject({ url })).statusCode).toBe(401);
  });

  it('does not expose legacy model-image capability routes', async () => {
    const { app, requestNode } = fixture();
    const imageId = '0ed12c70-1a12-4c9a-a4c1-c4b6c03c761f';
    const token = 'A'.repeat(43);
    for (const url of [
      `/api/nodes/node-one/model-images/${imageId}?token=${token}`,
      `/api/nodes/node-one/model-images/${imageId}?token=bad`,
      `/api/nodes/node-one/workspaces/workspace-one/sessions/session-one/images/${'a'.repeat(64)}?expiresAt=1700000000000&signature=${token}`
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
    expect(requestNode).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'Workspace',
      scopePath: 'workspaces/workspace-one',
      scope: { workspaceId: 'workspace-one' }
    },
    {
      kind: 'hosted conversation',
      scopePath: 'conversations/conversation-one',
      scope: { conversationId: 'conversation-one' }
    }
  ])(
    'serves a signed Session image for $kind without browser authentication',
    async ({ scopePath, scope }) => {
      const { app, requestNode } = fixture();
      const sessionId = 'session-one';
      const resourceId = 'a'.repeat(64);
      const expiresAt = 1_700_000_000_000;
      const signature = 'A'.repeat(43);
      const bytes = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10, 26, 10, 65]);
      const payload = { ...scope, sessionId, resourceId, expiresAt, signature };
      requestNode.mockResolvedValueOnce({
        image: { mimeType: 'image/png', dataBase64: bytes.toString('base64') }
      });

      const response = await app.inject({
        url: `/api/nodes/node-one/${scopePath}/sessions/${sessionId}/resources/${resourceId}?expiresAt=${expiresAt}&signature=${signature}`
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(bytes);
      expect(response.headers['content-type']).toContain('image/png');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(requestNode).toHaveBeenCalledWith('node-one', 'model.resource.read', payload, {
        userId: 0,
        sessionHash: 'model-resource'
      });
    }
  );

  it('rejects malformed or structurally ambiguous model image capability queries before Node forwarding', async () => {
    const { app, requestNode } = fixture();
    const baseUrl =
      '/api/nodes/node-one/workspaces/workspace-one/sessions/session-one/resources/' +
      'a'.repeat(64);
    const expiresAt = 1_700_000_000_000;
    const signature = 'A'.repeat(43);
    const invalidUrls = [
      `${baseUrl}?signature=${signature}`,
      `${baseUrl}?expiresAt=not-a-timestamp&signature=${signature}`,
      `${baseUrl}?expiresAt=${expiresAt}.5&signature=${signature}`,
      `${baseUrl}?expiresAt=0&signature=${signature}`,
      `${baseUrl}?expiresAt=${Number.MAX_SAFE_INTEGER + 1}&signature=${signature}`,
      `${baseUrl}?expiresAt=${expiresAt}&signature=short`,
      `${baseUrl}?expiresAt=${expiresAt}&expiresAt=${expiresAt}&signature=${signature}`,
      `${baseUrl}?expiresAt=${expiresAt}&signature=${signature}&signature=${signature}`
    ];

    for (const url of invalidUrls) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('RUN_IMAGE_INVALID');
    }
    expect(requestNode).not.toHaveBeenCalled();
  });

  it('preserves private conditional caching for immutable ordinary Run input images', async () => {
    const { app, requestNode, headers } = fixture();
    const url = '/api/agent-runs/run-one/images/0?nodeId=node-one';
    requestNode.mockResolvedValueOnce({ image: { mime: 'image/png', dataBase64: 'aW1hZ2U=' } });
    const first = await app.inject({ url, headers });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, max-age=3600, must-revalidate');
    requestNode.mockClear();
    expect(
      (await app.inject({ url, headers: { ...headers, 'if-none-match': first.headers.etag! } }))
        .statusCode
    ).toBe(304);
    expect(requestNode).not.toHaveBeenCalled();
  });

  it('isolates Run image validators by preview dimensions and rejects incomplete or invalid sizes', async () => {
    const { app, requestNode, headers } = fixture();
    const originalUrl = '/api/agent-runs/run-one/images/0?nodeId=node-one';
    requestNode.mockResolvedValueOnce({
      image: { mime: 'image/png', dataBase64: Buffer.from('original').toString('base64') }
    });
    const original = await app.inject({ url: originalUrl, headers });
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload).toEqual(Buffer.from('original'));
    expect(original.headers['x-mar-image-resized']).toBeUndefined();

    const previewUrl = `${originalUrl}&maxWidth=320&maxHeight=240`;
    requestNode.mockResolvedValueOnce({
      image: {
        mime: 'image/webp',
        dataBase64: Buffer.from('preview').toString('base64'),
        resized: true
      }
    });
    const preview = await app.inject({
      url: previewUrl,
      headers: { ...headers, 'if-none-match': original.headers.etag! }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('image/webp');
    expect(preview.headers['x-mar-image-resized']).toBe('1');
    expect(preview.rawPayload).toEqual(Buffer.from('preview'));
    expect(preview.headers.etag).not.toBe(original.headers.etag);
    expect(requestNode).toHaveBeenLastCalledWith(
      'node-one',
      'run.image.read',
      { runId: 'run-one', imageIndex: 0, preview: { maxWidth: 320, maxHeight: 240 } },
      expect.anything(),
      undefined
    );

    requestNode.mockResolvedValueOnce({
      image: {
        mime: 'image/webp',
        dataBase64: Buffer.from('small-preview').toString('base64'),
        resized: false
      }
    });
    const otherSize = await app.inject({
      url: `${originalUrl}&maxWidth=160&maxHeight=120`,
      headers
    });
    expect(otherSize.statusCode).toBe(200);
    expect(otherSize.headers.etag).not.toBe(preview.headers.etag);
    expect(otherSize.headers['x-mar-image-resized']).toBe('0');

    requestNode.mockClear();
    const cached = await app.inject({
      url: previewUrl,
      headers: { ...headers, 'if-none-match': preview.headers.etag! }
    });
    expect(cached.statusCode).toBe(304);
    expect(requestNode).not.toHaveBeenCalled();

    for (const invalidUrl of [
      `${originalUrl}&maxWidth=320`,
      `${originalUrl}&maxWidth=4097&maxHeight=240`
    ]) {
      const invalid = await app.inject({ url: invalidUrl, headers });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('RUN_IMAGE_INVALID');
    }
    expect(requestNode).not.toHaveBeenCalled();
  });

  it('forwards validated occurrence pages with the authorized schedule request', async () => {
    const { app, requestNode, headers } = fixture();
    const url =
      '/api/agent-sessions/session-one/schedule?nodeId=node-one&workspaceId=workspace-one';
    requestNode.mockResolvedValueOnce({
      task: null,
      occurrences: [],
      occurrenceTotal: 25,
      occurrencePage: 3
    });
    const result = await app.inject({ url: `${url}&occurrencePage=3`, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ occurrenceTotal: 25, occurrencePage: 3 });
    expect(requestNode.mock.calls[0]).toContainEqual(
      expect.objectContaining({
        occurrencePage: 3,
        sessionId: 'session-one',
        workspaceId: 'workspace-one'
      })
    );
    requestNode.mockClear();
    for (const value of ['0', '-1', '1.5', 'abc', '', '9007199254740992', '1&occurrencePage=2']) {
      expect(
        (await app.inject({ url: `${url}&occurrencePage=${value}`, headers })).statusCode
      ).toBe(400);
    }
    expect(requestNode).not.toHaveBeenCalled();
    expect((await app.inject({ url: `${url}&occurrencePage=2` })).statusCode).toBe(401);
  });

  it('shows the authenticated and persisted scheduled notification recipients by name', async () => {
    const { app, requestNode, headers, database } = fixture();
    const url =
      '/api/agent-sessions/session-one/schedule?nodeId=node-one&workspaceId=workspace-one';
    requestNode.mockResolvedValueOnce({
      task: { ownerUserId: 7 },
      nodeTimezone: 'Asia/Shanghai'
    });
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(database.userDisplayName).not.toHaveBeenCalled();
    const existing = await app.inject({ url, headers });
    expect(existing.statusCode).toBe(200);
    expect(existing.json()).toMatchObject({
      currentUserName: 'Current nickname',
      notifyUserName: 'Recipient nickname',
      task: { ownerUserId: 7 }
    });
    requestNode.mockResolvedValueOnce({ task: { ownerUserId: 1 } });
    expect((await app.inject({ url, headers })).json()).toMatchObject({
      currentUserName: 'Current nickname',
      notifyUserName: 'Current nickname',
      task: { ownerUserId: 1 }
    });
    requestNode.mockResolvedValueOnce({ task: null });
    expect((await app.inject({ url, headers })).json()).toMatchObject({
      task: null,
      currentUserName: 'Current nickname',
      notifyUserName: null
    });
  });

  it('rejects unauthenticated reads and invalid-CSRF writes before preparing secrets', async () => {
    const { app, requestNode, headers, secrets } = fixture();
    expect((await app.inject({ url: '/api/agent-runs/run-one?nodeId=node-one' })).statusCode).toBe(
      401
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent-sessions/start',
          headers: { ...headers, 'x-csrf-token': 'wrong' },
          payload: {}
        })
      ).statusCode
    ).toBe(403);
    expect(requestNode).not.toHaveBeenCalled();
    expect(secrets.resolve).not.toHaveBeenCalled();
  });

  it('starts a scoped session using the host secret resolver without returning its values', async () => {
    const { app, requestNode, headers, secrets } = fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        runner: 'codex',
        cwd: '/workspace',
        clientMessageId: 'message-one',
        content: 'fixture message',
        computerUse: true
      }
    });
    expect(response.statusCode).toBe(201);
    expect(requestNode).toHaveBeenCalledWith(
      'node-one',
      'session.start',
      expect.objectContaining({
        workspaceId: 'workspace-one',
        computerUse: true,
        secretEnvironment: { FIXTURE_TOKEN: 'private-value', MAR_USERNAME: 'admin' }
      }),
      { userId: 1, sessionHash: 'fingerprint', workspaceId: 'workspace-one' },
      undefined
    );
    expect(secrets.resolve).toHaveBeenCalledWith(1, 'node-one', 'workspace-one');
    expect(response.body).not.toContain('private-value');
  });

  it('keeps invalid start auditing in the route without preparing or dispatching input', async () => {
    const recordSharedConversation = vi.fn().mockResolvedValue(undefined);
    const { app, requestNode, headers, secrets } = fixture({
      audits: { recordSharedConversation }
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        runner: 'codex',
        cwd: '/workspace',
        clientMessageId: 'invalid-start',
        content: ''
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('SESSION_INVALID');
    expect(requestNode).not.toHaveBeenCalled();
    expect(secrets.resolve).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(recordSharedConversation).toHaveBeenCalledTimes(1));
    expect(recordSharedConversation.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'shared_conversation_input_rejected',
      actorUserId: 1,
      nodeId: 'node-one',
      workspaceId: 'workspace-one',
      clientMessageId: 'invalid-start',
      errorCode: 'SESSION_INVALID',
      receipt: { inputMode: 'NEW_SESSION' }
    });
    expect(recordSharedConversation.mock.calls[0]?.[0]).not.toHaveProperty('userMessage');
  });

  it('audits Auto preflight failure once through the execution service', async () => {
    const recordSharedConversation = vi.fn().mockResolvedValue(undefined);
    const { app, requestNode, headers, secrets } = fixture({
      audits: { recordSharedConversation }
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        runner: 'mar-agent',
        cwd: '/workspace',
        clientMessageId: 'auto-start',
        content: 'private request',
        model: 'selected-model',
        access: 'auto'
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('MAR_AGENT_AUTO_UNSUPPORTED');
    expect(requestNode).toHaveBeenCalledTimes(1);
    expect(requestNode.mock.calls[0]?.[1]).toBe('node.workbench.capabilities');
    expect(requestNode.mock.calls.some(([, operation]) => operation === 'session.start')).toBe(
      false
    );
    expect(secrets.resolve).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(recordSharedConversation).toHaveBeenCalledTimes(1));
    expect(recordSharedConversation.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'shared_conversation_input_rejected',
      clientMessageId: 'auto-start',
      errorCode: 'MAR_AGENT_AUTO_UNSUPPORTED',
      receipt: { inputMode: 'NEW_SESSION' }
    });
    expect(recordSharedConversation.mock.calls[0]?.[0]).not.toHaveProperty('userMessage');
  });

  it('accepts attachment-only start and messages without relaxing empty input validation', async () => {
    const { app, requestNode, headers } = fixture();
    const fields = {
      nodeId: 'node-one',
      workspaceId: 'workspace-one',
      runner: 'codex',
      cwd: '/workspace',
      clientMessageId: 'files-only',
      content: ''
    };
    const empty = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: fields
    });
    expect(empty.statusCode).toBe(400);
    const start = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: { ...fields, attachmentIds: ['11111111-1111-4111-8111-111111111111'] }
    });
    expect(start.statusCode).toBe(201);
    expect(requestNode.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      'node-one',
      'session.start',
      expect.objectContaining({
        content: '',
        attachmentIds: ['11111111-1111-4111-8111-111111111111']
      })
    ]);
    const message = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-one/messages',
      headers,
      payload: {
        ...fields,
        clientMessageId: 'files-next',
        attachmentIds: ['22222222-2222-4222-8222-222222222222']
      }
    });
    expect(message.statusCode).toBe(202);
    expect(requestNode.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      'node-one',
      'session.message',
      expect.objectContaining({
        content: '',
        attachmentIds: ['22222222-2222-4222-8222-222222222222']
      })
    ]);
  });

  it('passes Workspace scope to runner profiles without putting workspaceId in Node data', async () => {
    const { app, requestNode, headers, secrets } = fixture();
    requestNode.mockResolvedValueOnce({ profiles: [] });
    const response = await app.inject({
      url: '/api/runner-profiles?nodeId=node-one&workspaceId=workspace-one&cacheOnly=true',
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(secrets.resolve).toHaveBeenCalledWith(1, 'node-one', 'workspace-one');
    expect(requestNode).toHaveBeenCalledWith(
      'node-one',
      'runner.profiles.list',
      { secretEnvironment: { FIXTURE_TOKEN: 'private-value' }, waitForRefresh: false },
      { userId: 1, sessionHash: 'fingerprint', workspaceId: 'workspace-one' },
      undefined
    );
    expect(requestNode.mock.calls[0]?.[2]).not.toHaveProperty('workspaceId');
  });

  it('passes optional Workspace scope to session config resolver and authorization context only', async () => {
    const { app, requestNode, headers, secrets } = fixture();
    requestNode.mockResolvedValueOnce({ session: { id: 'session-one' } });
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/agent-sessions/session-one/config',
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        model: 'gpt-5.6-terra',
        effort: '',
        access: 'workspace-write'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(secrets.resolve).toHaveBeenCalledWith(1, 'node-one', 'workspace-one');
    expect(requestNode).toHaveBeenCalledWith(
      'node-one',
      'session.config.update',
      expect.objectContaining({
        sessionId: 'session-one',
        model: 'gpt-5.6-terra',
        effort: '',
        access: 'workspace-write',
        secretEnvironment: { FIXTURE_TOKEN: 'private-value' }
      }),
      { userId: 1, sessionHash: 'fingerprint', workspaceId: 'workspace-one' },
      undefined
    );
    expect(requestNode.mock.calls[0]?.[2]).not.toHaveProperty('workspaceId');
  });

  it('uses the authenticated username for terminals, messages and commands instead of secret overrides', async () => {
    const input = fixture();
    const { app, requestNode, headers, secrets } = input;
    secrets.resolve.mockResolvedValue({
      FIXTURE_TOKEN: 'private-value',
      ...{ MAR_USERNAME: 'forged-secret-user' }
    });
    registerTerminalRoutes({
      ...input,
      nodeControl: {
        ...input.nodeControl,
        createTerminalTicket: vi.fn(),
        closeTerminal: vi.fn()
      }
    });
    for (const [url, operation, payload] of [
      ['/api/terminals', 'terminal.open', {}],
      [
        '/api/agent-sessions/session-one/messages',
        'session.message',
        { clientMessageId: 'message-two', content: 'message' }
      ],
      [
        '/api/agent-sessions/session-one/commands',
        'session.command.execute',
        { commandId: 'compact', input: 'compact' }
      ]
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: {
          nodeId: 'node-one',
          workspaceId: 'workspace-one',
          ...payload,
          MAR_USERNAME: 'forged-body-user'
        }
      });
      expect(response.statusCode, url).toBeLessThan(300);
      expect(requestNode).toHaveBeenLastCalledWith(
        'node-one',
        operation,
        expect.objectContaining({
          secretEnvironment: { FIXTURE_TOKEN: 'private-value', MAR_USERNAME: 'admin' }
        }),
        expect.objectContaining({ userId: 1, workspaceId: 'workspace-one' }),
        undefined
      );
      expect(secrets.resolve).toHaveBeenLastCalledWith(1, 'node-one', 'workspace-one');
      expect(response.body).not.toContain('forged');
    }
  });

  it('preserves optional Workspace scope for Browser commands and interruption', async () => {
    const prepare = vi.fn(async () => ({ runtimeScopeId: 'command-runtime', models: [] }));
    const { app, requestNode, headers, secrets } = fixture({
      marAgentRuntimeModels: { prepare }
    });
    const commandUrl = '/api/agent-sessions/session-one/commands';
    const withoutWorkspace = await app.inject({
      method: 'POST',
      url: commandUrl,
      headers,
      payload: { nodeId: 'node-one', commandId: 'compact', input: '/compact' }
    });

    expect(withoutWorkspace.statusCode).toBe(202);
    expect(secrets.resolve).toHaveBeenCalledWith(1, 'node-one', undefined);
    expect(prepare).not.toHaveBeenCalled();
    expect(requestNode).toHaveBeenLastCalledWith(
      'node-one',
      'session.command.execute',
      expect.objectContaining({
        sessionId: 'session-one',
        commandId: 'compact',
        input: '/compact'
      }),
      { userId: 1, sessionHash: 'fingerprint' },
      undefined
    );
    expect(requestNode.mock.calls.at(-1)?.[2]).not.toHaveProperty('workspaceId');
    expect(requestNode.mock.calls.at(-1)?.[2]).not.toHaveProperty('personalInstructions');

    requestNode.mockClear();
    secrets.resolve.mockClear();
    const modelWithoutWorkspace = await app.inject({
      method: 'POST',
      url: commandUrl,
      headers,
      payload: { nodeId: 'node-one', commandId: 'compact', input: '/compact', model: 'selected' }
    });
    expect(modelWithoutWorkspace.statusCode).toBe(400);
    expect(modelWithoutWorkspace.json().error.code).toBe('RUNNER_COMMAND_INVALID');
    expect(requestNode).not.toHaveBeenCalled();
    expect(secrets.resolve).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();

    const withWorkspace = await app.inject({
      method: 'POST',
      url: commandUrl,
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        commandId: 'compact',
        input: '/compact',
        model: 'selected'
      }
    });
    expect(withWorkspace.statusCode).toBe(202);
    expect(prepare).toHaveBeenCalledWith({
      userId: 1,
      nodeId: 'node-one',
      workspaceId: 'workspace-one',
      sessionId: 'session-one',
      selectedModelId: 'selected'
    });
    expect(requestNode).toHaveBeenLastCalledWith(
      'node-one',
      'session.command.execute',
      expect.objectContaining({
        sessionId: 'session-one',
        marAgentRuntimeScopeId: 'command-runtime'
      }),
      { userId: 1, sessionHash: 'fingerprint', workspaceId: 'workspace-one' },
      undefined
    );
    expect(requestNode.mock.calls.at(-1)?.[2]).not.toHaveProperty('workspaceId');

    requestNode.mockClear();
    secrets.resolve.mockClear();
    prepare.mockClear();
    const interrupt = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-one/interrupt',
      headers,
      payload: { nodeId: 'node-one' }
    });
    expect(interrupt.statusCode).toBe(202);
    expect(requestNode).toHaveBeenCalledTimes(1);
    expect(requestNode).toHaveBeenCalledWith(
      'node-one',
      'session.interrupt',
      { sessionId: 'session-one' },
      { userId: 1, sessionHash: 'fingerprint' },
      undefined
    );
    expect(secrets.resolve).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('preserves authorization failure and never retries a rejected Node operation', async () => {
    const { app, requestNode, headers } = fixture();
    requestNode.mockRejectedValueOnce(new Error('NODE_ACCESS_DENIED'));
    const response = await app.inject({ url: '/api/agent-runs/run-one?nodeId=node-one', headers });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('NODE_ACCESS_DENIED');
    expect(requestNode).toHaveBeenCalledTimes(1);
  });

  it('routes scheduled task reads and versioned writes with Workspace authorization', async () => {
    const { app, requestNode, headers } = fixture();
    const path = '/api/agent-sessions/session-one/schedule';
    const query = '?nodeId=node-one&workspaceId=workspace-one';
    expect((await app.inject({ url: `${path}${query}` })).statusCode).toBe(401);
    const read = await app.inject({ url: `${path}${query}`, headers });
    expect(read.statusCode).toBe(200);
    expect(requestNode).toHaveBeenLastCalledWith(
      'node-one',
      'session.schedule.get',
      { sessionId: 'session-one', workspaceId: 'workspace-one' },
      { userId: 1, sessionHash: 'fingerprint', workspaceId: 'workspace-one' },
      undefined
    );
    const invalid = await app.inject({
      method: 'PUT',
      url: path,
      headers: { ...headers, 'x-csrf-token': 'wrong' },
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        objective: 'Check',
        cron: '0 * * * *'
      }
    });
    expect(invalid.statusCode).toBe(403);
    expect(requestNode).toHaveBeenCalledTimes(1);
    const saved = await app.inject({
      method: 'PUT',
      url: path,
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        objective: 'Check',
        cron: '0 * * * *',
        enabled: true,
        notifyOnTerminal: true
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(requestNode).toHaveBeenLastCalledWith(
      'node-one',
      'session.schedule.save',
      expect.objectContaining({ notifyOnTerminal: true }),
      { userId: 1, sessionHash: 'fingerprint', workspaceId: 'workspace-one' },
      undefined
    );
    const clientTimezone = await app.inject({
      method: 'PUT',
      url: path,
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        objective: 'Check',
        cron: '0 * * * *',
        timezone: 'UTC'
      }
    });
    expect(clientTimezone.statusCode).toBe(400);
    expect(requestNode).toHaveBeenLastCalledWith(
      'node-one',
      'session.schedule.save',
      expect.objectContaining({
        sessionId: 'session-one',
        workspaceId: 'workspace-one',
        cron: '0 * * * *'
      }),
      { userId: 1, sessionHash: 'fingerprint', workspaceId: 'workspace-one' },
      undefined
    );
  });
});

describe('MAR Agent runtime model payload forwarding', () => {
  const mainModel: MarAgentRuntimeModelConfiguration = {
    id: 'main-model',
    name: 'Main',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://main.invalid',
    apiKey: 'fixture-main',
    modelId: 'main-model',
    contextWindowTokens: 140_000,
    maxOutputTokens: 8_192,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    titleGeneration: false,
    codeMode: false,
    enabled: true
  };
  const compactModel: MarAgentRuntimeModelConfiguration = {
    ...mainModel,
    id: 'coding-compact',
    name: 'Compact',
    protocol: 'ANTHROPIC_MESSAGES',
    apiKey: 'fixture-compact'
  };

  it('forwards the authorized prepared compact configuration with the session start payload', async () => {
    const prepare = vi.fn(async () => ({
      runtimeScopeId: 'scope-compact-1',
      model: mainModel,
      models: [mainModel, compactModel],
      compact: { model: compactModel, reasoningEffort: 'high' as const }
    }));
    const { app, requestNode, headers } = fixture({ marAgentRuntimeModels: { prepare } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        runner: 'mar-agent',
        cwd: '/workspace',
        clientMessageId: 'client-1',
        content: 'begin the task',
        model: 'main-model'
      }
    });
    expect(response.statusCode).toBe(201);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        selectedModelId: 'main-model'
      })
    );
    expect(requestNode.mock.calls[0]![2]).toMatchObject({
      marAgentRuntimeScopeId: 'scope-compact-1',
      marAgentModel: mainModel,
      marAgentModels: [mainModel, compactModel],
      marAgentCompact: { model: compactModel, reasoningEffort: 'high' }
    });
  });

  it('omits the compact key when the runtime preparation has no compactor', async () => {
    const prepare = vi.fn(async () => ({
      runtimeScopeId: 'scope-plain-1',
      model: mainModel,
      models: [mainModel]
    }));
    const { app, requestNode, headers } = fixture({ marAgentRuntimeModels: { prepare } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: {
        nodeId: 'node-one',
        workspaceId: 'workspace-one',
        runner: 'mar-agent',
        cwd: '/workspace',
        clientMessageId: 'client-2',
        content: 'begin the task',
        model: 'main-model'
      }
    });
    expect(response.statusCode).toBe(201);
    expect(requestNode.mock.calls[0]![2]).not.toHaveProperty('marAgentCompact');
  });
});
