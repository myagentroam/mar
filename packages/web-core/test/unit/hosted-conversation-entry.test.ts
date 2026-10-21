import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConversationTemplateSummary } from '@myagentroam/protocol';
import { createHostedConversationEntryService } from '../../src/service/HostedConversationEntryService.js';

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
  it('Do not derive template availability from ordinary Node directories or capability projections', async () => {
    const page = await readFile(
      resolve(process.cwd(), 'src/view/conversation/HostedConversationEntryPage.vue'),
      'utf8'
    );

    expect(page).not.toContain('props.nodes');
    expect(page).not.toContain('hostedConversationEntryAvailability');
    expect(page).not.toContain('NodeSummary');
    expect(page).toContain(':disabled="creating || !template.available"');
  });

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
