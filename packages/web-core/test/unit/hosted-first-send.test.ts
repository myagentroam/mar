import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostedConversationEntryService } from '../../src/service/hosted-conversation-entry-service.js';
import { createHostedConversationWorkspaceService } from '../../src/service/hosted-conversation-workspace-service.js';
import type { HostedConversationSnapshot } from '@myagentroam/protocol';

const template = {
  id: 't',
  nodeId: 'n',
  name: 'Template',
  description: '',
  status: 'ACTIVE',
  currentVersionId: 'v',
  available: true,
  createdAt: 1,
  updatedAt: 1
} as const;
const snapshot: HostedConversationSnapshot = {
  conversation: {
    id: 'c',
    nodeId: 'n',
    sessionId: 's',
    templateId: 't',
    templateName: 'Template',
    activeVersionId: 'v',
    title: 'New',
    titleSource: 'DEFAULT',
    pinnedAt: null,
    status: 'ACTIVE',
    activity: { status: 'IDLE', updatedAt: 0, version: 0 },
    modelId: 'm',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1
  },
  template,
  run: null,
  turns: [],
  historyNextCursor: null,
  files: [],
  models: [
    {
      id: 'm',
      name: 'Model',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://model.test',
      modelId: 'model',
      contextWindowTokens: 10000,
      maxOutputTokens: 1000,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true,
      sortOrder: 0,
      apiKeyConfigured: true
    }
  ],
  error: null,
  snapshotSequence: 1
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
});

function fixture() {
  let failWatch = false;
  let failMessage = false;
  let failCreate = false;
  let failUpload = false;
  let createGate: Promise<void> | undefined;
  let uploadGate: Promise<void> | undefined;
  let templateGate: Promise<void> | undefined;
  const writes: {
    path: string;
    body: Record<string, unknown>;
    signal?: AbortSignal | null | undefined;
  }[] = [];
  const file = {
    id: 'f',
    conversationId: 'c',
    category: 'UPLOAD',
    source: 'USER',
    displayName: 'draft.txt',
    relativePath: 'uploads/draft.txt',
    mimeType: 'text/plain',
    size: 5,
    createdAt: 1,
    updatedAt: 1
  };
  let receivedBytes = 0;
  const upload = (completed = false) => ({
    uploadId: 'u',
    conversationId: 'c',
    name: 'draft.txt',
    mimeType: 'text/plain',
    size: 5,
    receivedBytes,
    status: completed ? 'COMPLETED' : 'UPLOADING',
    ...(completed ? { file } : {})
  });
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<never> => {
    if (path === '/api/conversation-templates') {
      await templateGate;
      return { templates: [template] } as never;
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (init?.method === 'POST' && !path.endsWith('/watch'))
      writes.push({ path, body, signal: init?.signal });
    if (path.endsWith('/watch')) {
      if (init?.method === 'DELETE') return undefined as never;
      if (failWatch) throw new Error('WATCH_FAILED');
      workspace.handleWatchEvent({
        type: 'watch.hosted-conversation.snapshot',
        workbenchConnectionId: 'connection',
        watchId: body['watchId'],
        nodeGeneration: 'generation',
        nodeId: 'n',
        conversationId: 'c',
        snapshotSequence: 1,
        payload: snapshot
      });
      return {
        accepted: true,
        watchId: body['watchId'],
        nodeGeneration: 'generation',
        expiresAt: Date.now() + 45000
      } as never;
    }
    if (path === '/api/nodes/n/hosted-conversations') {
      await createGate;
      if (failCreate) throw new TypeError('Failed to fetch');
      return snapshot as never;
    }
    if (path.endsWith('/uploads/preflight'))
      return { files: [{ name: 'draft.txt', status: 'READY' }] } as never;
    if (path.endsWith('/uploads')) {
      if (failUpload) throw new TypeError('Failed to fetch');
      return { upload: upload() } as never;
    }
    if (path.endsWith('/chunks')) {
      await uploadGate;
      receivedBytes = 5;
      return { upload: upload() } as never;
    }
    if (path.endsWith('/complete')) return { upload: upload(true) } as never;
    if (path.endsWith('/messages')) {
      if (failMessage) throw new TypeError('Failed to fetch');
      return {
        conversation: snapshot.conversation,
        run: { id: 'r', status: 'RUNNING', startedAt: 2, completedAt: null }
      } as never;
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const workspace = createHostedConversationWorkspaceService({
    request,
    workbenchConnectionId: () => 'connection',
    heartbeatMs: 60000,
    requestTimeoutMs: 1000,
    confirmationTimeoutMs: 15000
  });
  const select = vi.fn(async (created: HostedConversationSnapshot) => {
    workspace.selectConversation('n', 'c', created);
    await workspace.beginSelectedConversationWatch();
  });
  const entry = createHostedConversationEntryService(request, {
    submission: { workspace, select }
  });
  entry.setTemplates([template]);
  entry.prompt.value = 'Original draft';
  entry.addFiles([new File(['draft'], 'draft.txt', { type: 'text/plain' })]);
  stops.push(() => {
    entry.dispose();
    workspace.stopSelectedConversationWatch();
  });
  return {
    entry,
    workspace,
    select,
    writes,
    request,
    setFailWatch: (v: boolean) => {
      failWatch = v;
    },
    setFailMessage: (v: boolean) => {
      failMessage = v;
    },
    setFailCreate: (v: boolean) => {
      failCreate = v;
    },
    setFailUpload: (v: boolean) => {
      failUpload = v;
    },
    setCreateGate: (v: Promise<void>) => {
      createGate = v;
    },
    setUploadGate: (v: Promise<void>) => {
      uploadGate = v;
    },
    setTemplateGate: (v: Promise<void>) => {
      templateGate = v;
    }
  };
}

describe('Hosted first message ownership', () => {
  it('retries the same first-message creation after a stale catalog refresh arrives after an unknown result', async () => {
    const f = fixture();
    const catalog = deferred();
    f.setTemplateGate(catalog.promise);
    const refresh = f.entry.loadTemplates();
    f.setFailCreate(true);
    await expect(f.entry.submit()).rejects.toThrow('Failed to fetch');
    const creationId = f.writes[0]!.body['clientRequestId'];
    catalog.resolve();
    await refresh;
    expect(f.writes).toHaveLength(1);

    f.setFailCreate(false);
    await f.entry.submit();
    expect(
      f.writes
        .filter((w) => w.path.endsWith('/hosted-conversations'))
        .map((w) => w.body['clientRequestId'])
    ).toEqual([creationId, creationId]);
    expect(f.writes.filter((w) => w.path.endsWith('/messages'))).toHaveLength(1);
    expect(f.writes.at(-1)?.body).toMatchObject({ prompt: 'Original draft', attachmentIds: ['f'] });
  });
  it('does not create without a template or send without an available model', async () => {
    const missingTemplate = fixture();
    missingTemplate.entry.setTemplates([]);
    await expect(missingTemplate.entry.submit()).rejects.toThrow(
      'HOSTED_CONVERSATION_TEMPLATE_REQUIRED'
    );
    expect(missingTemplate.writes).toEqual([]);
    const missingModel = fixture();
    missingModel.entry.removeAttachment(missingModel.entry.attachments.value[0]!.id);
    await missingModel.entry.create().then((created) => {
      missingModel.workspace.selectConversation('n', 'c', { ...created, models: [] });
      missingModel.workspace.watchReady.value = true;
      missingModel.entry.target.value = created;
    });
    await expect(missingModel.entry.submit()).rejects.toThrow('HOSTED_CONVERSATION_MODEL_REQUIRED');
    expect(missingModel.writes.filter((write) => write.path.endsWith('/messages'))).toEqual([]);
    expect(missingModel.entry.prompt.value).toBe('Original draft');
  });
  it('keeps original attachments through initial Watch failure and sends only on explicit retry after recovery', async () => {
    const f = fixture();
    f.setFailWatch(true);
    await expect(f.entry.submit()).rejects.toThrow('WATCH_FAILED');
    expect(f.workspace.snapshot.value).toBeDefined();
    await expect(
      f.workspace.sendMessage({ prompt: 'blocked', attachmentIds: [], clientMessageId: 'blocked' })
    ).rejects.toThrow('HOSTED_CONVERSATION_WATCH_NOT_READY');
    await expect(f.entry.submit()).rejects.toThrow('HOSTED_CONVERSATION_WATCH_NOT_READY');
    expect(f.writes).toHaveLength(1);
    f.setFailWatch(false);
    await f.workspace.restartSelectedConversationWatch();
    expect(f.writes).toHaveLength(1);
    await expect(f.entry.submit()).resolves.toBe(true);
    expect(f.writes.map((w) => w.path.split('/').at(-1))).toEqual([
      'hosted-conversations',
      'preflight',
      'uploads',
      'chunks',
      'complete',
      'messages'
    ]);
    expect(f.writes.at(-1)?.body).toMatchObject({ prompt: 'Original draft', attachmentIds: ['f'] });
    expect(f.entry.prompt.value).toBe('');
    expect(f.entry.attachments.value).toEqual([]);
  });
  it.each(['create', 'upload'] as const)(
    'retains the original target at the %s gate without aborting writes or taking back a newer selection',
    async (gateName) => {
      const f = fixture();
      const gate = deferred();
      if (gateName === 'create') f.setCreateGate(gate.promise);
      else f.setUploadGate(gate.promise);
      const operation = expect(f.entry.submit()).rejects.toThrow(
        'HOSTED_CONVERSATION_DRAFT_PAUSED'
      );
      await vi.waitFor(() =>
        expect(
          f.writes.some((w) =>
            w.path.endsWith(gateName === 'create' ? 'hosted-conversations' : '/chunks')
          )
        ).toBe(true)
      );
      f.entry.suspend();
      f.workspace.selectConversation('n', 'history');
      gate.resolve();
      await operation;
      expect(f.workspace.selectedConversationId.value).toBe('history');
      expect(f.writes.some((w) => w.path.endsWith('/cancel'))).toBe(false);
      expect(f.writes.some((w) => w.path.endsWith('/messages'))).toBe(false);
      expect(f.writes.every((w) => !w.signal?.aborted)).toBe(true);
      f.entry.resume();
      await f.entry.submit();
      expect(f.writes.filter((w) => w.path.endsWith('hosted-conversations'))).toHaveLength(1);
      expect(f.writes.filter((w) => w.path.endsWith('/uploads'))).toHaveLength(1);
      expect(f.writes.at(-1)?.body).toMatchObject({
        prompt: 'Original draft',
        attachmentIds: ['f']
      });
    }
  );
  it('preserves the message identity on an unknown result and never automatically repeats it', async () => {
    const f = fixture();
    f.setFailMessage(true);
    await expect(f.entry.submit()).rejects.toThrow('Failed to fetch');
    const first = f.writes.at(-1)?.body;
    expect(f.entry.prompt.value).toBe('Original draft');
    f.setFailMessage(false);
    await f.entry.submit();
    expect(f.writes.filter((w) => w.path.endsWith('/messages'))).toHaveLength(2);
    expect(f.writes.at(-1)?.body).toEqual(first);
    expect(f.writes.filter((w) => w.path.endsWith('/uploads'))).toHaveLength(1);
  });
  it('retains create and upload identities after unknown results and retries only explicit intents', async () => {
    const f = fixture();
    f.setFailCreate(true);
    await expect(f.entry.submit()).rejects.toThrow('Failed to fetch');
    expect(f.writes).toHaveLength(1);
    const createId = f.writes[0]!.body['clientRequestId'];
    f.setFailCreate(false);
    f.setFailUpload(true);
    await expect(f.entry.submit()).rejects.toThrow('Failed to fetch');
    expect(
      f.writes
        .filter((w) => w.path.endsWith('/hosted-conversations'))
        .map((w) => w.body['clientRequestId'])
    ).toEqual([createId, createId]);
    const uploadId = f.writes.at(-1)!.body['clientRequestId'];
    f.setFailUpload(false);
    await f.entry.retryAttachment(f.entry.attachments.value[0]!.id);
    expect(
      f.writes.filter((w) => w.path.endsWith('/uploads')).map((w) => w.body['clientRequestId'])
    ).toEqual([uploadId, uploadId]);
    expect(f.writes.filter((w) => w.path.endsWith('/messages'))).toEqual([]);
    await f.entry.submit();
    expect(f.writes.filter((w) => w.path.endsWith('/messages'))).toHaveLength(1);
  });
  it.each(['create', 'upload'] as const)(
    'does not abort or reclaim selection when disposed at the %s gate',
    async (stage) => {
      const f = fixture();
      const gate = deferred();
      if (stage === 'create') f.setCreateGate(gate.promise);
      else f.setUploadGate(gate.promise);
      const operation = expect(f.entry.submit()).rejects.toThrow(
        'HOSTED_CONVERSATION_DRAFT_DISPOSED'
      );
      await vi.waitFor(() =>
        expect(
          f.writes.some((w) =>
            w.path.endsWith(stage === 'create' ? '/hosted-conversations' : '/chunks')
          )
        ).toBe(true)
      );
      f.entry.dispose();
      f.workspace.selectConversation('n', 'history');
      gate.resolve();
      await operation;
      expect(f.entry.attachments.value).toEqual([]);
      expect(f.workspace.selectedConversationId.value).toBe('history');
      expect(f.writes.every((w) => !w.signal?.aborted)).toBe(true);
      expect(f.writes.some((w) => w.path.endsWith('/cancel') || w.path.endsWith('/messages'))).toBe(
        false
      );
      if (stage === 'upload') expect(f.writes.some((w) => w.path.endsWith('/complete'))).toBe(true);
    }
  );
});
