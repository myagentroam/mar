import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationTemplateSummary } from '@myagentroam/protocol';
import { createHostedConversationEntryService } from '../../src/service/hosted-conversation-entry-service.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const template: ConversationTemplateSummary = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'Code Review',
  description: 'Review changes in an isolated conversation.',
  status: 'ACTIVE',
  currentVersionId: 'version-1',
  available: true,
  createdAt: 1,
  updatedAt: 1
};

const snapshot = {
  conversation: {
    id: 'conversation-1',
    nodeId: 'node-1',
    sessionId: 'session-1',
    templateId: template.id,
    templateName: template.name,
    activeVersionId: 'version-1',
    title: 'New conversation',
    titleSource: 'DEFAULT',
    pinnedAt: null,
    status: 'ACTIVE',
    activity: { status: 'IDLE', updatedAt: 0, version: 0 },
    modelId: 'model-1',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1
  },
  template,
  run: null,
  turns: [],
  historyNextCursor: null,
  files: [],
  models: [],
  error: null,
  snapshotSequence: 0
};

function modelSummary(id: string, name: string) {
  return {
    id,
    name,
    protocol: 'OPENAI_RESPONSES' as const,
    baseUrl: 'https://models.example.test/v1',
    modelId: 'gpt-5.6-sol',
    contextWindowTokens: 100000,
    maxOutputTokens: 8192,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high' as const,
    titleGeneration: false,
    codeMode: false,
    conversationModel: true,
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true,
    sortOrder: 0,
    apiKeyConfigured: true
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: resolvePromise
  };
}

function preferenceStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: () => value,
    setItem: (_key: string, nextValue: string) => {
      value = nextValue;
    },
    value: () => value
  };
}

describe('Web Hosted Conversation Portal', () => {
  it('Preselect a single template without sending a request until conversation creation', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const service = createHostedConversationEntryService(async (path, init) => {
      recordRequest(requests, path, init);
      return snapshot as never;
    });

    service.setTemplates([template]);

    expect(service.selectedTemplateId.value).toBe(template.id);
    expect(requests).toHaveLength(0);

    await expect(service.create('request-1')).resolves.toMatchObject({
      conversation: { id: 'conversation-1', titleSource: 'DEFAULT' }
    });
    expect(requests).toEqual([
      {
        path: '/api/nodes/node-1/hosted-conversations',
        init: {
          method: 'POST',
          body: JSON.stringify({ templateId: template.id, clientRequestId: 'request-1' })
        }
      }
    ]);
  });

  it('Loads the selected template models and creates with the chosen configuration', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const service = createHostedConversationEntryService(async (path, init) => {
      recordRequest(requests, path, init);
      if (path.endsWith('/model-options')) {
        return {
          models: [modelSummary('model-1', 'Model One'), modelSummary('model-2', 'Model Two')],
          defaultModelId: 'model-1'
        } as never;
      }
      return snapshot as never;
    });
    service.setTemplates([template]);

    await service.loadModelOptions();
    expect(service.modelOptionsLoaded.value).toBe(true);
    expect(service.selectedModelId.value).toBe('model-1');
    service.selectModel('model-2');
    await service.create('request-1');

    expect(requests[0]?.path).toBe(
      '/api/nodes/node-1/conversation-templates/template-1/model-options'
    );
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      templateId: template.id,
      clientRequestId: 'request-1',
      modelId: 'model-2'
    });
  });

  it('Ignores model options returned for a previously selected template', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let requestCount = 0;
    const service = createHostedConversationEntryService(async () => {
      requestCount += 1;
      return (requestCount === 1 ? first.promise : second.promise) as never;
    });
    const secondTemplate = { ...template, id: 'template-2', name: 'Implementation' };
    service.setTemplates([template, secondTemplate]);
    service.selectTemplate(template.id);

    const firstLoad = service.loadModelOptions();
    service.selectTemplate(secondTemplate.id);
    const secondLoad = service.loadModelOptions();
    second.resolve({ models: [modelSummary('model-2', 'Model Two')], defaultModelId: 'model-2' });
    await secondLoad;
    first.resolve({ models: [modelSummary('model-1', 'Model One')], defaultModelId: 'model-1' });
    await firstLoad;

    expect(service.selectedTemplateId.value).toBe(secondTemplate.id);
    expect(service.models.value.map((model) => model.id)).toEqual(['model-2']);
    expect(service.selectedModelId.value).toBe('model-2');
  });

  it('Keeps the selected model and creation identity across a late model refresh', async () => {
    const refreshed = deferred<unknown>();
    let refreshModels = false;
    const bodies: Array<{ clientRequestId: string; modelId: string }> = [];
    const service = createHostedConversationEntryService(async (path, init) => {
      if (path.endsWith('/model-options')) {
        if (refreshModels) return refreshed.promise as never;
        return {
          models: [modelSummary('model-1', 'Model One'), modelSummary('model-2', 'Model Two')],
          defaultModelId: 'model-1'
        } as never;
      }
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      if (bodies.length === 1) throw new TypeError('Failed to fetch');
      return snapshot as never;
    });
    service.setTemplates([template]);
    await service.loadModelOptions();
    service.selectModel('model-2');

    refreshModels = true;
    const refresh = service.loadModelOptions();
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    refreshed.resolve({
      models: [modelSummary('model-1', 'Model One'), modelSummary('model-2', 'Model Two')],
      defaultModelId: 'model-1'
    });
    await refresh;
    await service.create();

    expect(service.selectedModelId.value).toBe('model-2');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]?.modelId).toBe('model-2');
  });

  it('Remember the recent template locally and restore it only while it remains in the current list', () => {
    const secondTemplate = {
      ...template,
      id: 'template-2',
      name: 'Implementation'
    };
    const storage = preferenceStorage(secondTemplate.id);
    const service = createHostedConversationEntryService(async () => snapshot as never, {
      storage
    });

    service.setTemplates([template, secondTemplate]);
    expect(service.selectedTemplateId.value).toBe(secondTemplate.id);

    service.selectTemplate(template.id);
    expect(storage.value()).toBe(template.id);

    const restored = createHostedConversationEntryService(async () => snapshot as never, {
      storage
    });
    restored.setTemplates([template, secondTemplate]);
    expect(restored.selectedTemplateId.value).toBe(template.id);

    const missingPreference = preferenceStorage('removed-template');
    const fallback = createHostedConversationEntryService(async () => snapshot as never, {
      storage: missingPreference
    });
    fallback.setTemplates([template, secondTemplate]);
    expect(fallback.selectedTemplateId.value).toBeUndefined();
    fallback.setTemplates([template]);
    expect(fallback.selectedTemplateId.value).toBe(template.id);
  });

  it('Allow template selection when browser storage is unavailable', () => {
    const service = createHostedConversationEntryService(async () => snapshot as never, {
      storage: {
        getItem: () => {
          throw new Error('STORAGE_UNAVAILABLE');
        },
        setItem: () => {
          throw new Error('STORAGE_UNAVAILABLE');
        }
      }
    });

    service.setTemplates([template]);
    expect(() => service.selectTemplate(template.id)).not.toThrow();
    expect(service.selectedTemplateId.value).toBe(template.id);
  });

  it('Reuse the same clientRequestId when retrying after a lost create response', async () => {
    const clientRequestIds: string[] = [];
    let attempt = 0;
    const service = createHostedConversationEntryService(async (_path, init) => {
      const body = JSON.parse(String(init?.body)) as { clientRequestId: string };
      clientRequestIds.push(body.clientRequestId);
      attempt += 1;
      if (attempt === 1) throw new Error('NETWORK_RESPONSE_LOST');
      return snapshot as never;
    });
    service.setTemplates([template]);

    await expect(service.create()).rejects.toThrow('NETWORK_RESPONSE_LOST');
    await expect(service.create()).resolves.toMatchObject({
      conversation: { id: 'conversation-1' }
    });

    expect(clientRequestIds).toHaveLength(2);
    expect(clientRequestIds[0]).toBeTruthy();
    expect(clientRequestIds[1]).toBe(clientRequestIds[0]);
  });

  it('Start a new creation intent after switching templates or reloading the list', async () => {
    const clientRequestIds: string[] = [];
    const service = createHostedConversationEntryService(async (_path, init) => {
      const body = JSON.parse(String(init?.body)) as { clientRequestId: string };
      clientRequestIds.push(body.clientRequestId);
      throw new Error('NETWORK_RESPONSE_LOST');
    });
    const secondTemplate = {
      ...template,
      id: 'template-2',
      name: 'Implementation'
    };
    service.setTemplates([template, secondTemplate]);

    service.selectTemplate(template.id);
    await expect(service.create()).rejects.toThrow('NETWORK_RESPONSE_LOST');
    await expect(service.create()).rejects.toThrow('NETWORK_RESPONSE_LOST');

    service.selectTemplate(secondTemplate.id);
    await expect(service.create()).rejects.toThrow('NETWORK_RESPONSE_LOST');
    await expect(service.create()).rejects.toThrow('NETWORK_RESPONSE_LOST');

    service.setTemplates([template]);
    await expect(service.create()).rejects.toThrow('NETWORK_RESPONSE_LOST');

    expect(clientRequestIds[1]).toBe(clientRequestIds[0]);
    expect(clientRequestIds[3]).toBe(clientRequestIds[2]);
    expect(new Set(clientRequestIds)).toHaveLength(3);
  });

  it.each(['pending', 'unknown'] as const)(
    'applies a late catalog refresh without clearing a newer %s creation intent',
    async (outcome) => {
      const catalog = deferred<unknown>();
      const creation = deferred<void>();
      const clientRequestIds: string[] = [];
      const service = createHostedConversationEntryService(async (path, init) => {
        if (path === '/api/conversation-templates') return catalog.promise as never;
        clientRequestIds.push(JSON.parse(String(init?.body)).clientRequestId as string);
        if (clientRequestIds.length === 1) {
          await creation.promise;
          throw new TypeError('Failed to fetch');
        }
        return snapshot as never;
      });
      service.setTemplates([template]);

      const refresh = service.loadTemplates();
      const attempt = expect(service.create()).rejects.toThrow('Failed to fetch');
      if (outcome === 'unknown') {
        creation.resolve(undefined);
        await attempt;
      }
      catalog.resolve({ templates: [{ ...template, name: 'Updated catalog name' }] });
      await refresh;
      if (outcome === 'pending') {
        creation.resolve(undefined);
        await attempt;
      }

      expect(service.templates.value[0]?.name).toBe('Updated catalog name');
      expect(clientRequestIds).toHaveLength(1);
      await service.create();
      expect(clientRequestIds).toHaveLength(2);
      expect(clientRequestIds[1]).toBe(clientRequestIds[0]);
    }
  );

  it('keeps an explicit retry identity when a previously started refresh resolves later', async () => {
    const catalog = deferred<unknown>();
    const clientRequestIds: string[] = [];
    const service = createHostedConversationEntryService(async (path, init) => {
      if (path === '/api/conversation-templates') return catalog.promise as never;
      clientRequestIds.push(JSON.parse(String(init?.body)).clientRequestId as string);
      throw new TypeError('Failed to fetch');
    });
    service.setTemplates([template]);
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    const refresh = service.loadTemplates();
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    catalog.resolve({ templates: [template] });
    await refresh;
    expect(clientRequestIds).toHaveLength(2);
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    expect(new Set(clientRequestIds)).toHaveLength(1);
  });

  it('ends the old unknown creation intent when a normal catalog refresh completes first', async () => {
    const clientRequestIds: string[] = [];
    const service = createHostedConversationEntryService(async (path, init) => {
      if (path === '/api/conversation-templates') return { templates: [template] } as never;
      clientRequestIds.push(JSON.parse(String(init?.body)).clientRequestId as string);
      throw new TypeError('Failed to fetch');
    });
    service.setTemplates([template]);
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    await service.loadTemplates();
    expect(clientRequestIds).toHaveLength(1);
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    expect(new Set(clientRequestIds)).toHaveLength(2);
  });

  it('preserves an unknown creation identity when refreshing the catalog fails', async () => {
    const clientRequestIds: string[] = [];
    const service = createHostedConversationEntryService(async (path, init) => {
      if (path !== '/api/conversation-templates')
        clientRequestIds.push(JSON.parse(String(init?.body)).clientRequestId as string);
      throw new TypeError('Failed to fetch');
    });
    service.setTemplates([template]);
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    await expect(service.loadTemplates()).rejects.toThrow('Failed to fetch');
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    expect(clientRequestIds).toHaveLength(2);
    expect(clientRequestIds[1]).toBe(clientRequestIds[0]);
  });

  it('does not let an older refresh clear the newer template selection and creation identity', async () => {
    const catalog = deferred<unknown>();
    const secondTemplate = { ...template, id: 'template-2', name: 'Implementation' };
    const bodies: Array<{ templateId: string; clientRequestId: string }> = [];
    const service = createHostedConversationEntryService(async (path, init) => {
      if (path === '/api/conversation-templates') return catalog.promise as never;
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      throw new TypeError('Failed to fetch');
    });
    service.setTemplates([template, secondTemplate]);
    service.selectTemplate(template.id);
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    const refresh = service.loadTemplates();
    service.selectTemplate(secondTemplate.id);
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    catalog.resolve({ templates: [template, secondTemplate] });
    await refresh;
    await expect(service.create()).rejects.toThrow('Failed to fetch');

    expect(service.selectedTemplateId.value).toBe(secondTemplate.id);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]!.clientRequestId).not.toBe(bodies[0]!.clientRequestId);
    expect(bodies[2]).toEqual(bodies[1]);
  });

  it('uses a new identity for an explicit creation after an acknowledged creation', async () => {
    const clientRequestIds: string[] = [];
    const service = createHostedConversationEntryService(async (_path, init) => {
      clientRequestIds.push(JSON.parse(String(init?.body)).clientRequestId as string);
      return snapshot as never;
    });
    service.setTemplates([template]);
    await service.create();
    expect(clientRequestIds).toHaveLength(1);
    await service.create();
    expect(clientRequestIds).toHaveLength(2);
    expect(clientRequestIds[1]).not.toBe(clientRequestIds[0]);
  });

  it('ends the previous template intent when a late catalog changes the selection', async () => {
    const catalog = deferred<unknown>();
    const secondTemplate = { ...template, id: 'template-2', name: 'Implementation' };
    const bodies: Array<{ templateId: string; clientRequestId: string }> = [];
    const service = createHostedConversationEntryService(async (path, init) => {
      if (path === '/api/conversation-templates') return catalog.promise as never;
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      throw new TypeError('Failed to fetch');
    });
    service.setTemplates([template]);
    const refresh = service.loadTemplates();
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    catalog.resolve({ templates: [secondTemplate] });
    await refresh;
    await expect(service.create()).rejects.toThrow('Failed to fetch');

    expect(bodies.map((body) => body.templateId)).toEqual([template.id, secondTemplate.id]);
    expect(bodies[1]!.clientRequestId).not.toBe(bodies[0]!.clientRequestId);
  });

  it('does not let an older creation acknowledgement clear a newer unknown intent', async () => {
    const acknowledgement = deferred<unknown>();
    const secondTemplate = { ...template, id: 'template-2', name: 'Implementation' };
    const clientRequestIds: string[] = [];
    const service = createHostedConversationEntryService(async (_path, init) => {
      clientRequestIds.push(JSON.parse(String(init?.body)).clientRequestId as string);
      if (clientRequestIds.length === 1) return acknowledgement.promise as never;
      throw new TypeError('Failed to fetch');
    });
    service.setTemplates([template, secondTemplate]);
    service.selectTemplate(template.id);
    const first = service.create();
    service.selectTemplate(secondTemplate.id);
    await expect(service.create()).rejects.toThrow('Failed to fetch');
    acknowledgement.resolve(snapshot);
    await first;
    await expect(service.create()).rejects.toThrow('Failed to fetch');

    expect(clientRequestIds[1]).not.toBe(clientRequestIds[0]);
    expect(clientRequestIds[2]).toBe(clientRequestIds[1]);
  });

  it('Do not let an older template response overwrite a newer list or selection intent', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let requestCount = 0;
    const service = createHostedConversationEntryService(async () => {
      requestCount += 1;
      return (requestCount === 1 ? first.promise : second.promise) as never;
    });
    const secondTemplate = {
      ...template,
      id: 'template-2',
      name: 'Implementation'
    };

    const firstLoad = service.loadTemplates();
    const secondLoad = service.loadTemplates();
    second.resolve({ templates: [secondTemplate] });
    await secondLoad;
    first.resolve({ templates: [template] });
    await firstLoad;

    expect(service.templates.value).toEqual([secondTemplate]);
    expect(service.selectedTemplateId.value).toBe(secondTemplate.id);
  });
});

function recordRequest(
  requests: Array<{ path: string; init?: RequestInit }>,
  path: string,
  init?: RequestInit
): void {
  requests.push(init === undefined ? { path } : { path, init });
}
