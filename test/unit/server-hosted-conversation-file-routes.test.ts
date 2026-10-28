import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConversationTemplateSummary,
  MarAgentRuntimeModelConfiguration
} from '../../packages/protocol/src/index.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import { registerHostedConversationRoutes } from '../../ee/server/src/route/hosted-conversation-routes.js';
import type { ConversationTemplateService } from '../../ee/server/src/service/conversation-template-service.js';
import type { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';

const csrfToken = 'csrf-token';
const headers = {
  cookie: 'mar_user_session=session-id',
  'x-csrf-token': csrfToken
};

describe('Server hosted conversation routes', () => {
  it('authorizes each immutable resource page through the hosted boundary', async () => {
    const fixture = routeFixture();
    const resourceRef = 'c10a59dd-680f-46f6-9b75-31bfbd520506';
    const resource = {
      type: 'file_changes',
      version: 1,
      format: 'unified-diff',
      resourceRef,
      byteSize: 2,
      sha256: 'a'.repeat(64),
      content: '+a'
    };
    fixture.nodeControl.requestHostedConversationNode.mockImplementation(
      async (_nodeId: string, operation: string) => {
        if (operation === 'conversation.hosted.get') return hostedSnapshot();
        if (operation === 'conversation.hosted.tool-resource.read') return resource;
        throw new Error('UNEXPECTED_OPERATION');
      }
    );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });
    try {
      const url = `/api/nodes/node-1/hosted-conversations/conversation-1/tool-resources/${resourceRef}`;
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual(resource);
      expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
      fixture.nodeControl.requestHostedConversationNode.mockClear();
      fixture.templates.assertCanUse.mockRejectedValueOnce(
        new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED')
      );
      expect((await app.inject({ url, headers })).statusCode).toBe(403);
      expect(
        fixture.nodeControl.requestHostedConversationNode.mock.calls.some(
          (call) => call[1] === 'conversation.hosted.tool-resource.read'
        )
      ).toBe(false);
      fixture.nodeControl.requestHostedConversationNode.mockClear();
      expect((await app.inject({ url: `${url}?maxBytes=262145`, headers })).statusCode).toBe(400);
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect(fixture.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('streams large logical hosted files with range, attachment, and SVG safety semantics', async () => {
    const fixture = routeFixture();
    const imageContent = Buffer.alloc(1_980_000, 0xab);
    const svgContent = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const imageFile = {
      id: 'file-image',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'artifacts/large-preview.png',
      displayName: 'large-preview.png',
      mimeType: 'image/png',
      size: imageContent.length,
      source: 'AGENT',
      createdAt: 1_000,
      updatedAt: 1_000
    } as const;
    const svgFile = {
      id: 'file-svg',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'artifacts/diagram.svg',
      displayName: 'diagram.svg',
      mimeType: 'image/svg+xml',
      size: svgContent.length,
      source: 'AGENT',
      createdAt: 1_000,
      updatedAt: 1_000
    } as const;
    const emptyFile = {
      ...svgFile,
      id: 'file-empty',
      relativePath: 'empty.mts',
      displayName: 'empty.mts',
      mimeType: 'application/octet-stream',
      size: 0
    } as const;
    fixture.nodeControl.requestHostedConversationNode.mockImplementation(
      async (_nodeId: string, operation: string, payload: unknown) => {
        if (operation === 'conversation.hosted.get') return hostedSnapshot();
        if (operation !== 'conversation.hosted.file.read')
          throw new Error(`UNEXPECTED_OPERATION_${operation}`);
        const input = payload as {
          readonly fileId: string;
          readonly offset: number;
          readonly limit: number;
        };
        const [file, content] =
          input.fileId === imageFile.id
            ? [imageFile, imageContent]
            : input.fileId === svgFile.id
              ? [svgFile, svgContent]
              : input.fileId === emptyFile.id
                ? [emptyFile, Buffer.alloc(0)]
                : (() => {
                    throw new Error('HOSTED_CONVERSATION_FILE_NOT_FOUND');
                  })();
        const chunk = content.subarray(input.offset, input.offset + input.limit);
        const nextOffset = input.offset + chunk.length;
        return {
          file,
          encoding: 'base64',
          content: chunk.toString('base64'),
          offset: input.offset,
          nextOffset: nextOffset === content.length ? null : nextOffset,
          eof: nextOffset === content.length
        };
      }
    );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });
    const imageUrl =
      '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-image/content';

    const preview = await app.inject({
      method: 'GET',
      url: imageUrl,
      headers: { cookie: headers.cookie }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload).toEqual(imageContent);
    expect(preview.headers['content-type']).toContain('image/png');
    expect(preview.headers['content-length']).toBe(String(imageContent.length));
    expect(preview.headers['content-disposition']).toBe(
      "inline; filename*=UTF-8''large-preview.png"
    );
    expect(preview.headers['accept-ranges']).toBe('bytes');
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.headers['x-content-type-options']).toBe('nosniff');

    const ranged = await app.inject({
      method: 'GET',
      url: imageUrl,
      headers: { cookie: headers.cookie, range: 'bytes=524288-524415' }
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 524288-524415/${imageContent.length}`);
    expect(ranged.rawPayload).toEqual(imageContent.subarray(524288, 524416));

    const download = await app.inject({
      method: 'GET',
      url: `${imageUrl}?download=1`,
      headers: { cookie: headers.cookie, range: 'bytes=0-1' }
    });
    expect(download.statusCode).toBe(206);
    expect(download.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''large-preview.png"
    );

    const svg = await app.inject({
      method: 'GET',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-svg/content',
      headers: { cookie: headers.cookie, range: 'bytes=0-3' }
    });
    expect(svg.statusCode).toBe(206);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.headers['content-security-policy']).toBe('sandbox');
    expect(svg.headers['x-content-type-options']).toBe('nosniff');

    const head = await app.inject({
      method: 'HEAD',
      url: imageUrl,
      headers: { cookie: headers.cookie }
    });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload).toEqual(Buffer.alloc(0));
    expect(head.headers['content-length']).toBe(String(imageContent.length));

    const emptyUrl =
      '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-empty/content';
    const emptyHead = await app.inject({
      method: 'HEAD',
      url: emptyUrl,
      headers: { cookie: headers.cookie }
    });
    expect(emptyHead.statusCode).toBe(200);
    expect(emptyHead.headers['content-length']).toBe('0');
    expect(emptyHead.rawPayload).toEqual(Buffer.alloc(0));
    const emptyRange = await app.inject({
      method: 'GET',
      url: emptyUrl,
      headers: { cookie: headers.cookie, range: 'bytes=0-524287' }
    });
    expect(emptyRange.statusCode).toBe(416);
    expect(emptyRange.json().error.code).toBe('FILE_RANGE_INVALID');

    const fileReads = fixture.nodeControl.requestHostedConversationNode.mock.calls.filter(
      (call) => call[1] === 'conversation.hosted.file.read'
    );
    expect(fileReads.length).toBeGreaterThan(8);
    expect(fileReads.every((call) => !('path' in (call[2] as Record<string, unknown>)))).toBe(true);
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
    await app.close();
  }, 10_000);

  it('rechecks hosted ownership before each content stream and does not read a removed file', async () => {
    const fixture = routeFixture();
    fixture.templates.assertCanUse.mockRejectedValueOnce(
      new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED')
    );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });
    const url = '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-missing/content';

    const forbidden = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: headers.cookie }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(
      fixture.nodeControl.requestHostedConversationNode.mock.calls.some(
        (call) => call[1] === 'conversation.hosted.file.read'
      )
    ).toBe(false);

    fixture.nodeControl.requestHostedConversationNode.mockClear();
    fixture.nodeControl.requestHostedConversationNode.mockImplementation(
      async (_nodeId: string, operation: string) => {
        if (operation === 'conversation.hosted.get') return hostedSnapshot();
        if (operation === 'conversation.hosted.file.read')
          throw new Error('HOSTED_CONVERSATION_FILE_NOT_FOUND');
        throw new Error(`UNEXPECTED_OPERATION_${operation}`);
      }
    );
    const missing = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: headers.cookie }
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a content stream when the logical file projection changes after metadata lookup', async () => {
    const fixture = routeFixture();
    const content = Buffer.from('stable');
    const file = {
      id: 'file-changing',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'report.txt',
      displayName: 'report.txt',
      mimeType: 'text/plain',
      size: content.length,
      source: 'AGENT',
      createdAt: 1_000,
      updatedAt: 1_000
    } as const;
    fixture.nodeControl.requestHostedConversationNode.mockImplementation(
      async (_nodeId: string, operation: string, payload: unknown) => {
        if (operation === 'conversation.hosted.get') return hostedSnapshot();
        if (operation !== 'conversation.hosted.file.read')
          throw new Error(`UNEXPECTED_OPERATION_${operation}`);
        const input = payload as { readonly offset: number; readonly limit: number };
        const chunk = content.subarray(input.offset, input.offset + input.limit);
        const nextOffset = input.offset + chunk.length;
        return {
          file:
            input.limit === 1
              ? file
              : {
                  ...file,
                  updatedAt: 2_000
                },
          encoding: 'base64',
          content: chunk.toString('base64'),
          offset: input.offset,
          nextOffset: nextOffset === content.length ? null : nextOffset,
          eof: nextOffset === content.length
        };
      }
    );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-changing/content',
      headers: { cookie: headers.cookie }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'NODE_RESPONSE_INVALID' }
    });
    await app.close();
  });

  it('validates and forwards logical hosted file deletion without accepting paths', async () => {
    const fixture = routeFixture();
    const remainingFile = {
      id: 'file-remaining',
      conversationId: 'conversation-1',
      category: 'UPLOAD',
      relativePath: 'input.txt',
      displayName: 'input.txt',
      mimeType: 'text/plain',
      size: 5,
      source: 'USER',
      createdAt: 1_000,
      updatedAt: 1_000
    } as const;
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({
        deletedFileId: 'file-output',
        files: [remainingFile]
      });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-output',
      headers,
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deletedFileId: 'file-output',
      files: [remainingFile]
    });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.file.delete',
      {
        conversationId: 'conversation-1',
        fileId: 'file-output'
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );

    fixture.nodeControl.requestHostedConversationNode.mockClear();
    const invalid = await app.inject({
      method: 'DELETE',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-output',
      headers,
      payload: { relativePath: '../../outside.txt' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(fixture.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
  });

  it('forwards irreversible conversation deletion and does not expose a restore route', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce({ deletedConversationId: 'conversation-1' });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1',
      headers,
      payload: {}
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deletedConversationId: 'conversation-1' });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosted.delete',
      { conversationId: 'conversation-1' },
      expect.objectContaining({ userId: 7 }),
      undefined
    );

    fixture.nodeControl.requestHostedConversationNode.mockClear();
    const restore = await app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1/restore',
      headers,
      payload: {}
    });
    expect(restore.statusCode).toBe(404);
    expect(fixture.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
  });

  it('synchronizes deleted template retention before returning an existing conversation', async () => {
    const fixture = routeFixture();
    fixture.templates.assertCanUse.mockResolvedValue({
      ...template,
      status: 'DELETED',
      available: false
    });
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(hostedSnapshot())
      .mockResolvedValueOnce(
        hostedSnapshot({
          conversation: {
            status: 'ACTIVE'
          },
          template: {
            status: 'DELETED',
            available: false
          }
        })
      );
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1',
      headers: { cookie: headers.cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      conversation: { status: 'ACTIVE' },
      template: { status: 'DELETED', available: false }
    });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosted.get',
      {
        conversationId: 'conversation-1',
        __marAgentModels: [model],
        __sourceTemplateId: 'template-1',
        __templateDeleted: true
      },
      expect.objectContaining({ userId: 7 }),
      undefined
    );
  });

  it.each(['template', 'session'] as const)(
    'rejects a changed %s identity in the deleted-template refresh',
    async (changed) => {
      const fixture = routeFixture();
      fixture.templates.assertCanUse.mockResolvedValue({
        ...template,
        status: 'DELETED',
        available: false
      });
      const base = hostedSnapshot();
      const refreshed = {
        ...base,
        conversation: {
          ...base.conversation,
          ...(changed === 'template'
            ? { templateId: 'other-template' }
            : { sessionId: 'other-session' })
        },
        template: {
          ...base.template,
          status: 'DELETED',
          available: false,
          ...(changed === 'template' ? { id: 'other-template' } : {})
        }
      };
      fixture.nodeControl.requestHostedConversationNode
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce(refreshed);
      const app = Fastify();
      registerHostedConversationRoutes({
        app,
        database: fixture.database,
        templates: fixture.templates,
        models: fixture.models,
        nodeControl: fixture.nodeControl,
        publicOrigin: undefined
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/nodes/node-1/hosted-conversations/conversation-1',
        headers: { cookie: headers.cookie }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: 'HOSTED_CONVERSATION_NOT_AUTHORIZED' }
      });
      expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledTimes(3);
      await app.close();
    }
  );

  it('rejects a different Session between the probe and authorized snapshot', async () => {
    const fixture = routeFixture();
    const base = hostedSnapshot();
    fixture.nodeControl.requestHostedConversationNode
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({
        ...base,
        conversation: { ...base.conversation, sessionId: 'other-session' }
      });
    const app = Fastify();
    registerHostedConversationRoutes({
      app,
      database: fixture.database,
      templates: fixture.templates,
      models: fixture.models,
      nodeControl: fixture.nodeControl,
      publicOrigin: undefined
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/nodes/node-1/hosted-conversations/conversation-1',
      headers: { cookie: headers.cookie }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'HOSTED_CONVERSATION_NOT_AUTHORIZED' }
    });
    expect(fixture.nodeControl.requestHostedConversationNode).toHaveBeenCalledTimes(2);
    await app.close();
  });
});

const template: ConversationTemplateSummary = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'Research',
  description: 'Research template',
  status: 'ACTIVE',
  currentVersionId: 'version-1',
  available: true,
  createdAt: 1_000,
  updatedAt: 2_000
};

const model: MarAgentRuntimeModelConfiguration = {
  id: 'model-1',
  name: 'Model One',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test/v1',
  apiKey: 'secret',
  modelId: 'model-one',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

function hostedSnapshot(
  overrides: {
    readonly conversation?: {
      readonly status?: 'ACTIVE';
      readonly modelId?: string;
    };
    readonly template?: {
      readonly status?: 'ACTIVE' | 'DELETED';
      readonly available?: boolean;
    };
  } = {}
) {
  return {
    conversation: {
      id: 'conversation-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
      templateId: 'template-1',
      templateName: 'Research',
      activeVersionId: 'version-1',
      title: 'Research',
      titleSource: 'CUSTOM',
      pinnedAt: null,
      status: 'ACTIVE',
      modelId: 'model-1',
      createdAt: 1_000,
      updatedAt: 2_000,
      lastActivityAt: 2_000,
      activity: { status: 'IDLE', version: 0, updatedAt: 0 },
      ...overrides.conversation
    },
    template: {
      ...template,
      ...overrides.template
    },
    run: null,
    turns: [],
    historyNextCursor: null,
    files: [],
    models: [],
    error: null,
    snapshotSequence: 0
  };
}

function routeFixture() {
  const findCurrentUserSession = vi.fn(() => ({
    userId: 7,
    username: 'member',
    isAdmin: false,
    sessionHash: 'session-hash',
    mustChangePassword: false,
    csrfTokenHash: hashOpaque(csrfToken)
  }));
  const database = {
    findCurrentUserSession,
    audit: vi.fn(async () => undefined)
  } as unknown as MysqlServerDatabase;
  const nodeControl = {
    requestHostedConversationNode: vi.fn(async (_nodeId: string, operation: string) => {
      if (operation === 'conversation.hosted.get') return hostedSnapshot();
      if (operation === 'conversation.hosted.create') return hostedSnapshot();
      return { run: { id: 'run-1' } };
    }),
    requestNode: vi.fn(async () => {
      throw new Error('NODE_ACCESS_DENIED');
    }),
    listNodes: vi.fn(async () => []),
    ownsWorkbenchConnection: vi.fn(() => true)
  } as unknown as NodeControl & {
    requestHostedConversationNode: ReturnType<typeof vi.fn>;
    requestNode: ReturnType<typeof vi.fn>;
    listNodes: ReturnType<typeof vi.fn>;
    ownsWorkbenchConnection: ReturnType<typeof vi.fn>;
  };
  const templates = {
    requireForCreate: vi.fn(async () => template),
    assertCanUse: vi.fn(async (_userId: number, templateId: string) => ({
      ...template,
      id: templateId,
      nodeId: templateId.startsWith('template-node-')
        ? templateId.slice('template-'.length)
        : 'node-1'
    })),
    runtimeContext: vi.fn(async () => ({
      template,
      nodeId: 'node-1',
      workspaceId: 'workspace-source'
    }))
  } as unknown as ConversationTemplateService & {
    requireForCreate: ReturnType<typeof vi.fn>;
    assertCanUse: ReturnType<typeof vi.fn>;
    runtimeContext: ReturnType<typeof vi.fn>;
  };
  const models = {
    runtimeForUser: vi.fn(async () => model),
    runtimeConfigurationsForUser: vi.fn(async () => [model])
  } as unknown as MarAgentModelService & {
    runtimeForUser: ReturnType<typeof vi.fn>;
    runtimeConfigurationsForUser: ReturnType<typeof vi.fn>;
  };
  return { database, findCurrentUserSession, nodeControl, templates, models };
}
