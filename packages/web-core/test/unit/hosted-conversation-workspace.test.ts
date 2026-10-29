import { describe, expect, it, vi } from 'vitest';
import { ref, watch } from 'vue';
import { ApiError } from '../../src/util/api-error.js';
import { createHostedConversationFilePreviewService } from '../../src/service/hosted-conversation-file-preview-service.js';
import { createHostedConversationWatchService } from '../../src/service/hosted-conversation-watch-service.js';
import {
  createHostedConversationWorkspaceService,
  hostedConversationFileForPath,
  type HostedConversationRequest
} from '../../src/service/hosted-conversation-workspace-service.js';

const conversation = {
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
  activity: { status: 'IDLE', version: 0, updatedAt: 0 },
  modelId: 'model-1',
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1
} as const;

const template = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'Research',
  description: 'Research in an isolated environment.',
  status: 'ACTIVE',
  currentVersionId: 'version-1',
  available: true,
  createdAt: 1,
  updatedAt: 1
} as const;

it('Retains the ready hosted directory and its cursor when refresh fails', async () => {
  const failure = new Error('Directory temporarily unavailable');
  const request = vi
    .fn()
    .mockResolvedValueOnce({ items: [conversation], nextCursor: 'retained-cursor' })
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ items: [], nextCursor: null });
  const workspace = service(request as HostedConversationRequest);
  await workspace.loadConversations();
  await expect(workspace.loadConversations()).rejects.toBe(failure);
  expect(workspace.conversationsLoaded.value).toBe(true);
  expect(workspace.conversations.value).toHaveLength(1);
  expect(workspace.hasMoreConversations.value).toBe(true);
  await workspace.loadMoreConversations();
  expect(request.mock.calls[2]?.[0]).toContain('cursor=retained-cursor');
  expect(workspace.hasMoreConversations.value).toBe(false);
});

const snapshot = {
  conversation,
  template,
  run: null,
  turns: [],
  historyNextCursor: null,
  files: [],
  models: [
    {
      id: 'model-1',
      name: 'Model One',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://models.example.test/v1',
      modelId: 'model-one',
      contextWindowTokens: 100_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true,
      sortOrder: 0
    }
  ],
  error: null,
  snapshotSequence: 1
} as const;

function hostedTurn(id: string, at: number, text: string) {
  return {
    id,
    sessionId: 'session-1',
    runId: null,
    userItemId: `${id}:user`,
    status: 'SUCCEEDED' as const,
    model: 'model-1',
    effort: null,
    access: 'full-access' as const,
    rewind: { before: null, after: id },
    items: [
      {
        id: `${id}:user`,
        sessionId: 'session-1',
        turnId: id,
        runId: null,
        parentItemId: null,
        sourceSequence: null,
        revision: 0,
        kind: 'user_message' as const,
        status: 'COMPLETED' as const,
        payload: {
          text,
          contexts: [],
          delivery: 'ACCEPTED' as const,
          clientMessageId: null
        },
        startedAt: at,
        completedAt: at
      }
    ],
    startedAt: at,
    completedAt: at
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function service(request: HostedConversationRequest) {
  return createHostedConversationWorkspaceService({
    request,
    workbenchConnectionId: () => 'connection-current',
    heartbeatMs: 60_000,
    requestTimeoutMs: 1_000,
    confirmationTimeoutMs: 60_000
  });
}

function recoveryHarness() {
  const requests: { mode: string; watchId: string }[] = [];
  let failure: unknown;
  let recoveringFailure: unknown;
  const expired = vi.fn();
  const workspace = createHostedConversationWorkspaceService({
    request: async (path, init) => {
      expect(path).toMatch(/\/watch$/u);
      if (init?.method === 'DELETE') return undefined as never;
      const body = JSON.parse(String(init?.body)) as { mode: string; watchId: string };
      requests.push(body);
      if (body.mode === 'renew' && failure !== undefined) throw failure;
      if (body.mode === 'initial' && requests.length > 1 && recoveringFailure !== undefined)
        throw recoveringFailure;
      return (
        body.mode === 'initial'
          ? {
              accepted: true,
              watchId: body.watchId,
              nodeGeneration: 'generation-current',
              expiresAt: Date.now() + 45_000
            }
          : undefined
      ) as never;
    },
    workbenchConnectionId: () => 'connection-current',
    heartbeatMs: 100,
    requestTimeoutMs: 50,
    confirmationTimeoutMs: 300,
    onWatchExpired: expired
  });
  const frame = (watchId = requests.at(-1)!.watchId, run: unknown = null) => ({
    type: 'watch.hosted-conversation.snapshot',
    workbenchConnectionId: 'connection-current',
    watchId,
    nodeGeneration: 'generation-current',
    nodeId: 'node-1',
    conversationId: 'conversation-1',
    revision: 1,
    snapshotSequence: 1,
    expiresAt: Date.now() + 45_000,
    payload: { ...snapshot, run }
  });
  const begin = async () => {
    workspace.selectConversation('node-1', 'conversation-1');
    const pending = workspace.beginSelectedConversationWatch();
    workspace.handleWatchEvent(
      frame(undefined, { id: 'run-1', status: 'RUNNING', startedAt: 2, completedAt: null })
    );
    await pending;
  };
  return {
    workspace,
    requests,
    expired,
    frame,
    begin,
    failRenew: (error: unknown) => {
      failure = error;
    },
    failRecovery: (error: unknown) => {
      recoveringFailure = error;
    }
  };
}

describe('Web Hosted Conversation Workspace Service', () => {
  it('does not let a late old Watch response cancel the new initial waiter', async () => {
    const requests = new Map<string, ReturnType<typeof deferred<unknown>>>();
    const node = ref<string | undefined>('node-1');
    const selected = ref<string | undefined>('conversation-1');
    const owner = createHostedConversationWatchService({
      request: async (_path, init) => {
        if (init?.method === 'DELETE') return undefined as never;
        const { watchId } = JSON.parse(String(init?.body)) as { watchId: string };
        const response = deferred<unknown>();
        requests.set(watchId, response);
        return response.promise as never;
      },
      selectedNodeId: node,
      selectedConversationId: selected,
      workbenchConnectionId: () => 'connection-current',
      heartbeatMs: 60_000,
      requestTimeoutMs: 1_000,
      confirmationTimeoutMs: 60_000,
      installSnapshot: () => {},
      applyHostedPayload: () => {}
    });
    const first = owner.beginSelectedConversationWatch().catch(() => {});
    const oldId = owner.selectedWatchId()!;
    owner.stopSelectedConversationWatch();
    selected.value = 'conversation-2';
    const second = owner.beginSelectedConversationWatch();
    const newId = owner.selectedWatchId()!;
    const accept = (id: string) =>
      requests.get(id)!.resolve({
        accepted: true,
        watchId: id,
        nodeGeneration: 'generation-current',
        expiresAt: Date.now() + 45_000
      });
    accept(newId);
    await new Promise((resolve) => setImmediate(resolve));
    accept(oldId);
    await new Promise((resolve) => setImmediate(resolve));
    owner.handleWatchEvent({
      type: 'watch.hosted-conversation.snapshot',
      workbenchConnectionId: 'connection-current',
      watchId: newId,
      nodeGeneration: 'generation-current',
      nodeId: 'node-1',
      conversationId: 'conversation-2',
      snapshotSequence: 1,
      payload: { ...snapshot, conversation: { ...conversation, id: 'conversation-2' } }
    });
    await expect(second).resolves.toBeUndefined();
    expect(owner.watchReady.value).toBe(true);
    owner.stopSelectedConversationWatch();
    await first;
  });

  it('does not publish old Watch readiness after snapshot installation synchronously changes selection', async () => {
    const node = ref<string | undefined>('node-1');
    const selected = ref<string | undefined>('conversation-1');
    let second: Promise<void> | undefined;
    const owner = createHostedConversationWatchService({
      request: async (_path, init) => {
        if (init?.method === 'DELETE') return undefined as never;
        const { watchId } = JSON.parse(String(init?.body)) as { watchId: string };
        return {
          accepted: true,
          watchId,
          nodeGeneration: 'generation-current',
          expiresAt: Date.now() + 45_000
        } as never;
      },
      selectedNodeId: node,
      selectedConversationId: selected,
      workbenchConnectionId: () => 'connection-current',
      heartbeatMs: 60_000,
      requestTimeoutMs: 1_000,
      confirmationTimeoutMs: 60_000,
      installSnapshot: () => {
        owner.stopSelectedConversationWatch();
        selected.value = 'conversation-2';
        second = owner.beginSelectedConversationWatch();
      },
      applyHostedPayload: () => {}
    });
    const first = owner.beginSelectedConversationWatch().catch(() => {});
    const oldId = owner.selectedWatchId()!;
    owner.handleWatchEvent({
      type: 'watch.hosted-conversation.snapshot',
      workbenchConnectionId: 'connection-current',
      watchId: oldId,
      nodeGeneration: 'generation-current',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      snapshotSequence: 1,
      payload: snapshot
    });
    expect(owner.selectedWatchId()).not.toBe(oldId);
    expect(owner.watchReady.value).toBe(false);
    let secondSettled = false;
    void second!.finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    owner.stopSelectedConversationWatch();
    await second;
    await first;
  });
  it('never pairs a newly selected hosted identity with the previous conversation snapshot', () => {
    const workspace = service(async () => undefined as never);
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);
    const mismatches: string[] = [];
    const stop = watch(
      [workspace.selectedConversationId, workspace.snapshot],
      ([selected, current]) => {
        if (selected !== undefined && current !== undefined && selected !== current.conversation.id)
          mismatches.push(`${selected}:${current.conversation.id}`);
      },
      { flush: 'sync' }
    );
    try {
      workspace.selectConversation('node-1', 'conversation-2');
      expect(mismatches).toEqual([]);
    } finally {
      stop();
    }
  });

  it('installs the supplied hosted snapshot before publishing its new identity', () => {
    const workspace = service(async () => undefined as never);
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);
    const observations: Array<string | undefined> = [];
    const stop = watch(
      workspace.selectedConversationId,
      (id) => {
        if (id === 'conversation-2') observations.push(workspace.snapshot.value?.conversation.id);
      },
      { flush: 'sync' }
    );
    try {
      workspace.selectConversation('node-1', 'conversation-2', {
        ...snapshot,
        conversation: { ...conversation, id: 'conversation-2' }
      } as never);
      expect(observations).toEqual(['conversation-2']);
    } finally {
      stop();
    }
  });
  it('exposes a read-only hosted conversation window', () => {
    const workspace = service(async () => undefined as never);
    if (false) {
      // @ts-expect-error Hosted consumers cannot replace the projection window.
      workspace.turns.value = [];
      // @ts-expect-error Hosted consumers cannot mutate the projected turn list.
      workspace.turns.value.push(workspace.turns.value[0]!);
      // @ts-expect-error Hosted consumers cannot replace the projection cursor.
      workspace.historyNextCursor.value = null;
    }
    expect(workspace.turns.value).toEqual([]);
  });
  it.each([
    new ApiError('SESSION_WATCH_NOT_FOUND', 'The observation lease no longer exists.'),
    new ApiError('WATCH_REQUEST_TIMEOUT', 'The watch request timed out.'),
    new TypeError('Failed to fetch'),
    new DOMException('The request was aborted.', 'AbortError')
  ])(
    'Automatic solo rebuild initial after renewal failure and exit the run state with an authoritative snapshot: %s',
    async (error) => {
      vi.useFakeTimers();
      const h = recoveryHarness();
      try {
        await h.begin();
        const oldWatchId = h.requests[0]!.watchId;
        h.failRenew(error);
        await vi.advanceTimersByTimeAsync(100);
        expect(h.workspace.watchFailureCode.value).toBeDefined();
        expect(h.workspace.snapshot.value?.run?.status).toBe('RUNNING');
        await vi.advanceTimersByTimeAsync(100);
        expect(h.requests.map((request) => request.mode)).toEqual(['initial', 'renew', 'initial']);
        expect(h.requests[2]!.watchId).not.toBe(oldWatchId);
        expect(h.workspace.watchFailureCode.value).toBeDefined();
        expect(h.workspace.handleWatchEvent(h.frame(oldWatchId))).toBe(false);
        const completed = h.frame();
        expect(
          h.workspace.handleWatchEvent({
            ...completed,
            payload: {
              ...completed.payload,
              turns: [
                {
                  id: 'turn-1',
                  sessionId: 'session-1',
                  runId: 'run-1',
                  userItemId: null,
                  status: 'SUCCEEDED',
                  model: 'model-1',
                  effort: null,
                  access: 'full-access',
                  startedAt: 2,
                  completedAt: 3,
                  items: [
                    {
                      id: 'answer-1',
                      sessionId: 'session-1',
                      turnId: 'turn-1',
                      runId: 'run-1',
                      parentItemId: null,
                      kind: 'assistant_message',
                      status: 'COMPLETED',
                      startedAt: 2,
                      completedAt: 3,
                      sourceSequence: 2,
                      revision: 1,
                      payload: {
                        text: 'Completed while disconnected.',
                        format: 'markdown',
                        model: null
                      }
                    }
                  ]
                }
              ]
            }
          })
        ).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.workspace.snapshot.value?.run).toBeNull();
        expect(h.workspace.watchFailureCode.value).toBeUndefined();
        expect(h.workspace.turns.value[0]?.items[0]?.payload).toMatchObject({
          text: 'Completed while disconnected.'
        });
        h.failRenew(undefined);
        await vi.advanceTimersByTimeAsync(300);
        expect(h.requests.slice(3).every((request) => request.mode === 'renew')).toBe(true);
        expect(h.expired).not.toHaveBeenCalled();
      } finally {
        h.workspace.stopSelectedConversationWatch();
        vi.useRealTimers();
      }
    }
  );

  it('stops automatic initial-watch recovery after the consecutive-failure limit and shows one prompt', async () => {
    vi.useFakeTimers();
    const h = recoveryHarness();
    try {
      await h.begin();
      h.failRenew(new ApiError('SESSION_WATCH_NOT_FOUND', 'The lease is missing.'));
      h.failRecovery(new TypeError('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.requests.map((request) => request.mode)).toEqual([
        'initial',
        'renew',
        'initial',
        'initial',
        'initial'
      ]);
      expect(h.workspace.snapshot.value?.run?.status).toBe('RUNNING');
      expect(h.workspace.watchFailureCode.value).toBeDefined();
      expect(h.expired).toHaveBeenCalledOnce();
    } finally {
      h.workspace.stopSelectedConversationWatch();
      vi.useRealTimers();
    }
  });

  it.each(['renew', 'recovery'] as const)(
    'Authorization failed Do not automatically restore and keep read-only content: %s',
    async (phase) => {
      vi.useFakeTimers();
      const h = recoveryHarness();
      try {
        await h.begin();
        const denied = new ApiError('CONVERSATION_TEMPLATE_NOT_AUTHORIZED', 'Access denied.');
        h.failRenew(phase === 'renew' ? denied : new TypeError('Failed to fetch'));
        h.failRecovery(denied);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.requests.map((request) => request.mode)).toEqual(
          phase === 'renew' ? ['initial', 'renew'] : ['initial', 'renew', 'initial']
        );
        expect(h.workspace.watchFailureCode.value).toBe('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
        expect(h.workspace.snapshot.value?.run?.status).toBe('RUNNING');
        expect(h.workspace.handleWatchEvent(h.frame())).toBe(false);
        expect(h.workspace.watchFailureCode.value).toBe('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
      } finally {
        h.workspace.stopSelectedConversationWatch();
        vi.useRealTimers();
      }
    }
  );

  it.each(['pause', 'stop', 'switch'] as const)(
    'Lifecycle Change Cancel Pending Recovery: %s',
    async (action) => {
      vi.useFakeTimers();
      const h = recoveryHarness();
      try {
        await h.begin();
        h.failRenew(new TypeError('Failed to fetch'));
        await vi.advanceTimersByTimeAsync(100);
        if (action === 'pause') h.workspace.pauseSelectedConversationWatch();
        else if (action === 'stop') h.workspace.stopSelectedConversationWatch();
        else h.workspace.selectConversation('node-1', 'conversation-2');
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.requests.map((request) => request.mode)).toEqual(['initial', 'renew']);
      } finally {
        h.workspace.stopSelectedConversationWatch();
        vi.useRealTimers();
      }
    }
  );

  it('retries initial-watch recovery after an HTTP acknowledgment without a snapshot and does not restore writability prematurely', async () => {
    vi.useFakeTimers();
    const h = recoveryHarness();
    try {
      await h.begin();
      h.failRenew(new TypeError('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.requests.map((request) => request.mode)).toEqual([
        'initial',
        'renew',
        'initial',
        'initial',
        'initial'
      ]);
      expect(h.workspace.watchFailureCode.value).toBeDefined();
      expect(h.expired).toHaveBeenCalledOnce();
    } finally {
      h.workspace.stopSelectedConversationWatch();
      vi.useRealTimers();
    }
  });

  it('Restore initial Stop retrying after receiving illegal snapshot, late snapshot cannot be unread-only', async () => {
    vi.useFakeTimers();
    const h = recoveryHarness();
    try {
      await h.begin();
      h.failRenew(new TypeError('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(200);
      h.workspace.handleWatchEvent({ ...h.frame(), payload: {} });
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.requests.map((request) => request.mode)).toEqual(['initial', 'renew', 'initial']);
      expect(h.workspace.watchFailureCode.value).toBe('HOSTED_CONVERSATION_RESPONSE_INVALID');
      expect(h.workspace.handleWatchEvent(h.frame())).toBe(false);
    } finally {
      h.workspace.stopSelectedConversationWatch();
      vi.useRealTimers();
    }
  });

  it('Retain authorization error when resuming initial receipt of watch.failed, not overwritten by cancel error', async () => {
    vi.useFakeTimers();
    const h = recoveryHarness();
    try {
      await h.begin();
      h.failRenew(new TypeError('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(200);
      expect(
        h.workspace.handleWatchEvent({
          ...h.frame(),
          type: 'watch.failed',
          watchType: 'hosted-conversation',
          code: 'CONVERSATION_TEMPLATE_NOT_AUTHORIZED'
        })
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.requests.map((request) => request.mode)).toEqual(['initial', 'renew', 'initial']);
      expect(h.workspace.watchFailureCode.value).toBe('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
      expect(h.workspace.handleWatchEvent(h.frame())).toBe(false);
    } finally {
      h.workspace.stopSelectedConversationWatch();
      vi.useRealTimers();
    }
  });

  it('Only explicit dialog file paths are resolved to the current authoritative file projection', () => {
    const files = [
      {
        id: 'output-file',
        conversationId: 'conversation-1',
        category: 'OUTPUT',
        relativePath: 'reports/result.txt',
        displayName: 'result.txt',
        mimeType: 'text/plain',
        size: 6,
        source: 'AGENT',
        turnId: 'turn-1',
        itemId: 'item-1',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'upload-file',
        conversationId: 'conversation-1',
        category: 'UPLOAD',
        relativePath: 'input.txt',
        displayName: 'input.txt',
        mimeType: 'text/plain',
        size: 5,
        source: 'USER',
        createdAt: 1,
        updatedAt: 1
      }
    ] as const;

    expect(hostedConversationFileForPath(files, '/workspace/output/reports/result.txt')?.id).toBe(
      'output-file'
    );
    expect(hostedConversationFileForPath(files, 'output/reports/result.txt')?.id).toBe(
      'output-file'
    );
    expect(hostedConversationFileForPath(files, '/workspace/inbox/input.txt')?.id).toBe(
      'upload-file'
    );
    expect(hostedConversationFileForPath(files, 'reports/result.txt')?.id).toBe('output-file');
    expect(
      hostedConversationFileForPath(
        [...files, { ...files[1], id: 'duplicate-upload', relativePath: 'reports/result.txt' }],
        'reports/result.txt'
      )
    ).toBeUndefined();
    expect(hostedConversationFileForPath(files, '/workspace/output/missing.txt')).toBeUndefined();
    expect(hostedConversationFileForPath(files, '/output/reports/result.txt')).toBeUndefined();
    expect(hostedConversationFileForPath(files, '/reports/result.txt')).toBeUndefined();
  });

  it('Binary previews and downloads use controlled content URLs without reading or stitching Base64 shards', async () => {
    const file = {
      id: 'file-large-image',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'artifacts/large-preview.png',
      displayName: 'large-preview.png',
      mimeType: 'image/png',
      size: 1_980_000,
      source: 'AGENT',
      createdAt: 1,
      updatedAt: 1
    } as const;
    const readFile = vi.fn(async () => {
      throw new Error('BINARY_BASE64_READ_FORBIDDEN');
    });
    const contentUrl = vi.fn(
      (candidate: { readonly id: string }, download = false) =>
        `/api/nodes/node-1/hosted-conversations/conversation-1/files/${candidate.id}/content${
          download ? '?download=1' : ''
        }`
    );
    const triggerDownload = vi.fn();
    const preview = createHostedConversationFilePreviewService({
      source: {
        selectedConversationId: ref('conversation-1'),
        readFile,
        contentUrl
      },
      onError: vi.fn(),
      triggerDownload
    });

    await preview.openFile(file);

    expect(readFile).not.toHaveBeenCalled();
    expect(preview.visible.value).toBe(true);
    expect(preview.kind.value).toBe('image');
    expect(preview.contentUrl.value).toBe(
      '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-large-image/content'
    );
    await preview.download();
    expect(triggerDownload).toHaveBeenCalledWith(
      '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-large-image/content?download=1',
      'large-preview.png'
    );
    expect(contentUrl).toHaveBeenNthCalledWith(1, file);
    expect(contentUrl).toHaveBeenNthCalledWith(2, file, true);
    expect(readFile).not.toHaveBeenCalled();

    const workspace = service(async () => undefined as never);
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);
    expect(workspace.contentUrl(file)).toBe(
      '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-large-image/content'
    );
    expect(workspace.contentUrl(file, true)).toBe(
      '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-large-image/content?download=1'
    );
  });

  it('rejects same-size hosted text changes between the probe and full preview read', async () => {
    const file = {
      id: 'file-changing-text',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'reports/changing.txt',
      displayName: 'changing.txt',
      mimeType: 'text/plain',
      size: 8_000,
      source: 'AGENT',
      createdAt: 1,
      updatedAt: 1
    } as const;
    const probe = {
      file,
      offset: 0,
      encoding: 'base64' as const,
      content: btoa('before'),
      nextOffset: 6,
      eof: false
    };
    const readFile = vi
      .fn()
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce({
        ...probe,
        file: { ...file, updatedAt: 2 },
        content: btoa('after!')
      });
    const onError = vi.fn();
    const preview = createHostedConversationFilePreviewService({
      source: { selectedConversationId: ref(file.conversationId), readFile, contentUrl: vi.fn() },
      onError
    });

    await preview.openFile(file);

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error('FILE_PREVIEW_REVISION_CHANGED'));
    expect(preview.visible.value).toBe(false);
    expect(preview.content.value).toBeUndefined();
    preview.dispose();
  });

  it('probes 4 KiB before loading a larger read-only hosted text preview', async () => {
    const file = {
      id: 'file-large-text',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'reports/large.txt',
      displayName: 'large.txt',
      mimeType: 'text/plain',
      size: 700_000,
      source: 'AGENT',
      createdAt: 1,
      updatedAt: 1
    } as const;
    const readFile = vi.fn(async () => ({
      file,
      offset: 0,
      encoding: 'base64' as const,
      content: btoa('preview'),
      nextOffset: 7,
      eof: false
    }));
    const preview = createHostedConversationFilePreviewService({
      source: {
        selectedConversationId: ref('conversation-1'),
        readFile,
        contentUrl: vi.fn()
      },
      onError: vi.fn()
    });

    await preview.openFile(file, 23, 7);

    expect(readFile).toHaveBeenNthCalledWith(1, file.id, 0, 4096);
    expect(readFile).toHaveBeenNthCalledWith(2, file.id, 0, 512 * 1024);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(preview.content.value).toMatchObject({
      path: 'output/reports/large.txt',
      content: 'preview',
      truncated: true
    });
    expect(preview.targetLine.value).toBe(23);
    expect(preview.targetColumn.value).toBe(7);
  });

  it('uses the shared legacy text fallback for hosted source previews', async () => {
    const file = {
      id: 'legacy-source',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'DisplayBoard.c',
      displayName: 'DisplayBoard.c',
      mimeType: 'application/octet-stream',
      size: 7,
      source: 'AGENT',
      createdAt: 1,
      updatedAt: 1
    } as const;
    const preview = createHostedConversationFilePreviewService({
      source: {
        selectedConversationId: ref(file.conversationId),
        readFile: async () => ({
          file,
          offset: 0,
          encoding: 'base64',
          content: Buffer.from([47, 47, 32, 0xd6, 0xd0, 0xce, 0xc4]).toString('base64'),
          nextOffset: null,
          eof: true
        }),
        contentUrl: vi.fn()
      },
      onError: vi.fn()
    });
    await preview.openFile(file);
    expect(preview.kind.value).toBe('text');
    expect(preview.content.value).toMatchObject({ content: '// 中文', previewEncoding: 'gb18030' });
    preview.dispose();
  });

  it.each([
    [
      'script.mts',
      'application/octet-stream',
      new TextEncoder().encode('export const value = 1;'),
      true
    ],
    ['LICENSE', 'application/octet-stream', new TextEncoder().encode('license text'), true],
    ['notes.custom', 'application/octet-stream', new Uint8Array(), true],
    ['script.mts', 'text/plain', new Uint8Array([65, 0, 66]), false],
    ['script.cts', 'application/octet-stream', new Uint8Array([0xff]), false]
  ] as const)('detects hosted preview content for %s (%s)', async (path, mimeType, bytes, text) => {
    const file = {
      id: 'file-probe',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: path,
      displayName: path,
      mimeType,
      size: bytes.length,
      source: 'AGENT',
      createdAt: 1,
      updatedAt: 1
    } as const;
    const readFile = vi.fn(async () => ({
      file,
      offset: 0,
      encoding: 'base64' as const,
      content: Buffer.from(bytes).toString('base64'),
      nextOffset: null,
      eof: true
    }));
    const onError = vi.fn();
    const contentUrl = vi.fn(() => '/controlled-content');
    const preview = createHostedConversationFilePreviewService({
      source: { selectedConversationId: ref('conversation-1'), readFile, contentUrl },
      onError
    });

    await preview.openFile(file);

    expect(readFile).toHaveBeenCalledExactlyOnceWith(file.id, 0, 4096);
    expect(preview.visible.value).toBe(true);
    expect(preview.kind.value).toBe(text ? 'text' : 'unsupported');
    expect(preview.content.value?.content).toBe(text ? new TextDecoder().decode(bytes) : '');
    expect(contentUrl).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('Consume only a single opaque cursor for Server aggregation and reject unknown response fields', async () => {
    const requests: string[] = [];
    const workspace = service(async (path) => {
      requests.push(path);
      const page = path.includes('cursor=');
      return {
        items: page
          ? []
          : [
              {
                ...conversation,
                id: 'conversation-node-2',
                nodeId: 'node-2',
                sessionId: 'session-node-2',
                lastActivityAt: 2
              },
              {
                ...conversation,
                id: 'conversation-node-1',
                nodeId: 'node-1',
                sessionId: 'session-node-1',
                lastActivityAt: 1
              }
            ],
        nextCursor: page ? null : 'server+/cursor=='
      } as never;
    });

    await workspace.loadConversations();
    await workspace.loadMoreConversations();

    expect(requests).toEqual([
      '/api/hosted-conversations?limit=20',
      '/api/hosted-conversations?limit=20&cursor=server%2B%2Fcursor%3D%3D'
    ]);
    expect(workspace.conversations.value.map((item) => item.nodeId)).toEqual(['node-2', 'node-1']);
    expect(workspace.hasMoreConversations.value).toBe(false);

    const invalid = service(
      async () =>
        ({
          items: [{ ...conversation, leakedPath: '/srv/private' }],
          nextCursor: null
        }) as never
    );
    await expect(invalid.loadConversations()).rejects.toThrow(
      'HOSTED_CONVERSATION_RESPONSE_INVALID'
    );
  });

  it('Retains hosted conversations and cursor on append failure or no progress, then retries', async () => {
    const error = new TypeError('Hosted conversation page unavailable');
    const added = { ...conversation, id: 'conversation-2', sessionId: 'session-2' };
    let pageAttempt = 0;
    const appendRequests: string[] = [];
    const workspace = service(async (path) => {
      if (!path.includes('cursor='))
        return { items: [conversation], nextCursor: 'directory-cursor' } as never;
      appendRequests.push(path);
      pageAttempt += 1;
      if (pageAttempt === 1) throw error;
      if (pageAttempt === 2) return { items: [added], nextCursor: 'directory-cursor' } as never;
      return { items: [added], nextCursor: null } as never;
    });

    await workspace.loadConversations();
    await workspace.loadMoreConversations();

    expect(workspace.conversations.value.map((item) => item.id)).toEqual([conversation.id]);
    expect(workspace.loadMoreConversationsError.value).toBe(error);
    expect(workspace.hasMoreConversations.value).toBe(true);
    expect(workspace.loadingMoreConversations.value).toBe(false);

    const nonAdvancingPage = workspace.loadMoreConversations();
    expect(workspace.loadMoreConversationsError.value).toBeUndefined();
    expect(workspace.loadingMoreConversations.value).toBe(true);
    await nonAdvancingPage;
    expect(workspace.conversations.value.map((item) => item.id)).toEqual([conversation.id]);
    expect(workspace.loadMoreConversationsError.value).toMatchObject({
      message: 'SESSION_PAGINATION_NO_PROGRESS'
    });
    expect(workspace.hasMoreConversations.value).toBe(true);

    const retry = workspace.loadMoreConversations();
    expect(workspace.loadMoreConversationsError.value).toBeUndefined();
    await retry;
    expect(workspace.conversations.value.map((item) => item.id)).toEqual([
      conversation.id,
      added.id
    ]);
    expect(workspace.loadMoreConversationsError.value).toBeUndefined();
    expect(workspace.hasMoreConversations.value).toBe(false);
    expect(workspace.loadingMoreConversations.value).toBe(false);
    expect(appendRequests).toEqual([
      '/api/hosted-conversations?limit=20&cursor=directory-cursor',
      '/api/hosted-conversations?limit=20&cursor=directory-cursor',
      '/api/hosted-conversations?limit=20&cursor=directory-cursor'
    ]);
  });

  it('Merge independent runtime projections by version, and the active state does not depend on ordinary Node directories', async () => {
    const page = deferred<unknown>();
    const workspace = service(async () => page.promise as never);
    const loading = workspace.loadConversations();
    expect(
      workspace.projectActivityMessage({
        type: 'hosted-conversation.activity',
        nodeId: 'node-1',
        conversationId: 'conversation-1',
        activity: { status: 'RUNNING', version: 2, updatedAt: 2 }
      })
    ).toBe(true);
    page.resolve({
      items: [
        {
          ...conversation,
          activity: { status: 'IDLE', version: 0, updatedAt: 0 }
        }
      ],
      nextCursor: null
    });
    await loading;

    expect(workspace.conversations.value[0]?.activity).toEqual({
      status: 'RUNNING',
      version: 2,
      updatedAt: 2
    });
    expect(workspace.conversationIsRunning(workspace.conversations.value[0]!)).toBe(true);
    workspace.projectActivityMessage({
      type: 'hosted-conversation.activity',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      activity: { status: 'IDLE', version: 1, updatedAt: 3 }
    });
    expect(workspace.conversations.value[0]?.activity.status).toBe('RUNNING');
    workspace.projectActivityMessage({
      type: 'hosted-conversation.activity',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      activity: { status: 'IDLE', version: 3, updatedAt: 4 }
    });
    expect(workspace.conversations.value[0]?.activity.status).toBe('IDLE');
    expect(workspace.conversationIsRunning(workspace.conversations.value[0]!)).toBe(false);
  });

  it('Overwrite legacy old Node runtime version before request start with new directory response', async () => {
    let loadCount = 0;
    const workspace = service(async () => {
      loadCount += 1;
      return {
        items: [
          {
            ...conversation,
            activity:
              loadCount === 1
                ? { status: 'RUNNING', version: 7, updatedAt: 7 }
                : { status: 'IDLE', version: 0, updatedAt: 0 }
          }
        ],
        nextCursor: null
      } as never;
    });
    await workspace.loadConversations();
    workspace.projectActivityMessage({
      type: 'hosted-conversation.activity',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      activity: { status: 'RUNNING', version: 8, updatedAt: 8 }
    });

    await workspace.loadConversations();

    expect(workspace.conversations.value[0]?.activity).toEqual({
      status: 'IDLE',
      version: 0,
      updatedAt: 0
    });
  });

  it('When refreshing the aggregated directory, the old list response must not overwrite the updated Server first screen', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let requestCount = 0;
    const workspace = service(async () => {
      requestCount += 1;
      return (requestCount === 1 ? first.promise : second.promise) as never;
    });
    const secondConversation = {
      ...conversation,
      id: 'conversation-2',
      nodeId: 'node-2',
      sessionId: 'session-2'
    };

    const firstLoad = workspace.loadConversations();
    const secondLoad = workspace.loadConversations();
    second.resolve({ items: [secondConversation], nextCursor: null });
    await secondLoad;
    first.resolve({ items: [conversation], nextCursor: null });
    await firstLoad;

    expect(workspace.conversations.value).toEqual([
      {
        ...secondConversation,
        activity: { status: 'IDLE', version: 0, updatedAt: 0 }
      }
    ]);
  });

  it('Show normal empty directory when Server aggregation first screen is empty, do not keep the failed Node state', async () => {
    let firstLoad = true;
    const secondConversation = {
      ...conversation,
      id: 'conversation-2',
      nodeId: 'node-2',
      sessionId: 'session-2',
      lastActivityAt: 2
    };
    const workspace = service(async () => {
      if (firstLoad) {
        firstLoad = false;
        return { items: [secondConversation, conversation], nextCursor: null } as never;
      }
      return { items: [], nextCursor: null } as never;
    });

    await workspace.loadConversations();
    workspace.selectConversation('node-1', conversation.id, snapshot as never);
    await expect(workspace.loadConversations()).resolves.toBeUndefined();

    expect(workspace.conversations.value).toEqual([]);
    expect(workspace).not.toHaveProperty('directoryFailureNodeIds');
  });

  it.each(['resolve', 'reject'] as const)(
    'Directory refresh expires an old paging request when it later %s and does not block the current cursor',
    async (completion) => {
      const stalePage = deferred<unknown>();
      const requests: string[] = [];
      let firstPageCount = 0;
      const workspace = service(async (path) => {
        requests.push(path);
        if (!path.includes('cursor=')) {
          firstPageCount += 1;
          return {
            items: [conversation],
            nextCursor: firstPageCount === 1 ? 'cursor-stale' : 'cursor-current'
          } as never;
        }
        if (path.includes('cursor=cursor-stale')) return stalePage.promise as never;
        return { items: [], nextCursor: null } as never;
      });

      await workspace.loadConversations();
      const staleLoadMore = workspace.loadMoreConversations();
      await workspace.loadConversations();
      if (completion === 'resolve') stalePage.resolve({ items: [], nextCursor: null });
      else stalePage.reject(new Error('Stale page failed'));
      await staleLoadMore;
      await workspace.loadMoreConversations();

      expect(requests.at(-1)).toContain('cursor=cursor-current');
      expect(workspace.loadMoreConversationsError.value).toBeUndefined();
      expect(workspace.loadingMoreConversations.value).toBe(false);
      expect(workspace.hasMoreConversations.value).toBe(false);
    }
  );

  it('Keep selected follow-up page conversations when refreshing the first screen to avoid misjudging pagination absences as deleted', async () => {
    const selected = {
      ...conversation,
      id: 'conversation-selected',
      sessionId: 'session-selected',
      title: 'Selected conversation'
    };
    const firstPageConversation = {
      ...conversation,
      id: 'conversation-first-page',
      sessionId: 'session-first-page',
      title: 'First page conversation',
      updatedAt: 2,
      lastActivityAt: 2
    };
    const workspace = service(
      async () => ({ items: [firstPageConversation], nextCursor: 'next-page' }) as never
    );
    workspace.selectConversation('node-1', selected.id, {
      ...snapshot,
      conversation: selected
    } as never);

    await workspace.loadConversations();

    expect(workspace.conversations.value.map((item) => item.id)).toEqual([
      firstPageConversation.id,
      selected.id
    ]);
    expect(workspace.selectedConversationId.value).toBe(selected.id);
  });

  it('Catalog refresh must not override header and sticky updates completed during the request', async () => {
    const firstPage = deferred<unknown>();
    const workspace = service(async (path, init) => {
      if (path.includes('/hosted-conversations?')) return firstPage.promise as never;
      if (init?.method === 'PATCH')
        return {
          conversation: {
            ...conversation,
            title: 'Updated while refreshing',
            pinnedAt: 3,
            updatedAt: 3
          }
        } as never;
      throw new Error('UNEXPECTED_REQUEST');
    });
    workspace.selectConversation('node-1', conversation.id, snapshot as never);

    const refresh = workspace.loadConversations();
    await workspace.updateMetadata({ title: 'Updated while refreshing', pinned: true });
    firstPage.resolve({
      items: [{ ...conversation, title: 'Stale directory title', updatedAt: 2 }],
      nextCursor: null
    });
    await refresh;

    expect(workspace.conversations.value[0]).toMatchObject({
      title: 'Updated while refreshing',
      pinnedAt: 3,
      updatedAt: 3
    });
  });

  it('Directory local updates must be kept top priority and sorted within the group by most recent activity time', async () => {
    const older = { ...conversation, id: 'conversation-older', lastActivityAt: 1 };
    const newer = {
      ...conversation,
      id: 'conversation-newer',
      sessionId: 'session-newer',
      updatedAt: 2,
      lastActivityAt: 2
    };
    const pinned = {
      ...conversation,
      id: 'conversation-pinned',
      sessionId: 'session-pinned',
      pinnedAt: 4,
      lastActivityAt: 0
    };
    const workspace = service(async (path) => {
      if (path.includes('/hosted-conversations?'))
        return { items: [newer, older, pinned], nextCursor: null } as never;
      return {
        conversation: { ...older, updatedAt: 3, lastActivityAt: 3 }
      } as never;
    });

    await workspace.loadConversations();
    workspace.selectConversation('node-1', older.id, {
      ...snapshot,
      conversation: older
    } as never);
    await workspace.updateConfiguration({ modelId: 'model-1' });

    expect(workspace.conversations.value.map((item) => item.id)).toEqual([
      pinned.id,
      older.id,
      newer.id
    ]);
  });

  it('Hosted Watch events must match connection, watch, Node, Conversation and current lease', async () => {
    let watchBody:
      | {
          mode: 'initial';
          workbenchConnectionId: string;
          watchId: string;
        }
      | undefined;
    const workspace = service(async (path, init) => {
      if (!path.endsWith('/watch')) return { items: [], nextCursor: null } as never;
      watchBody = JSON.parse(String(init?.body));
      return {
        accepted: true,
        watchId: watchBody!.watchId,
        nodeGeneration: 'generation-current',
        expiresAt: Date.now() + 45_000
      } as never;
    });
    workspace.selectConversation('node-1', 'conversation-1');
    const initial = workspace.beginSelectedConversationWatch();
    await Promise.resolve();

    const frame = {
      type: 'watch.hosted-conversation.snapshot',
      workbenchConnectionId: 'connection-current',
      watchId: watchBody!.watchId,
      nodeGeneration: 'generation-current',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      revision: 1,
      snapshotSequence: 1,
      expiresAt: Date.now() + 45_000,
      payload: snapshot
    };

    expect(
      workspace.handleWatchEvent({ ...frame, workbenchConnectionId: 'connection-stale' })
    ).toBe(false);
    expect(workspace.handleWatchEvent({ ...frame, watchId: 'watch-stale' })).toBe(false);
    expect(workspace.handleWatchEvent({ ...frame, nodeId: 'node-2' })).toBe(false);
    expect(workspace.handleWatchEvent({ ...frame, conversationId: 'conversation-2' })).toBe(false);

    workspace.selectConversation('node-1', 'conversation-2');
    expect(workspace.handleWatchEvent(frame)).toBe(false);
    workspace.selectConversation('node-1', 'conversation-1');
    expect(workspace.handleWatchEvent(frame)).toBe(false);

    const restarted = workspace.beginSelectedConversationWatch();
    await Promise.resolve();
    const currentFrame = {
      ...frame,
      watchId: watchBody!.watchId
    };
    expect(workspace.handleWatchEvent(currentFrame)).toBe(true);
    await expect(restarted).resolves.toBeUndefined();
    await expect(initial).resolves.toBeUndefined();
  });

  it('preserves authoritative work process metadata when projecting a hosted snapshot', () => {
    const workspace = service(async () => {
      throw new Error('Unexpected request');
    });
    const turn = hostedTurn('turn-process', 20, 'Request');
    const processGroup = { id: 'process-hosted', isStart: true };
    workspace.selectConversation('node-1', 'conversation-1', {
      ...snapshot,
      turns: [
        {
          ...turn,
          items: [
            ...turn.items,
            {
              ...turn.items[0],
              id: 'reasoning-hosted',
              kind: 'reasoning',
              processGroup,
              payload: { representation: 'summary', sections: [{ index: 0, text: 'Inspect.' }] }
            }
          ]
        }
      ]
    } as never);
    expect(workspace.turns.value[0]?.items[1]?.processGroup).toEqual(processGroup);
  });

  it('loads older hosted turns by cursor and preserves them when a recent Watch snapshot arrives', async () => {
    let watchId = '';
    const latest = hostedTurn('turn-latest', 20, 'Latest');
    const older = hostedTurn('turn-older', 10, 'Older');
    const workspace = service(async (path, init) => {
      if (path.includes('/history?')) {
        expect(path).toContain('limit=10');
        expect(path).toContain('cursor=older-cursor');
        return { turns: [older], nextCursor: null } as never;
      }
      if (path.endsWith('/watch')) {
        if (init?.method === 'DELETE') return undefined as never;
        watchId = (JSON.parse(String(init?.body)) as { watchId: string }).watchId;
        return {
          accepted: true,
          watchId,
          nodeGeneration: 'generation-current',
          expiresAt: Date.now() + 45_000
        } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    workspace.selectConversation('node-1', 'conversation-1', {
      ...snapshot,
      turns: [latest],
      historyNextCursor: 'older-cursor'
    } as never);
    expect(workspace.watchReady.value).toBe(false);

    await workspace.loadOlderHistory();
    expect(workspace.turns.value.map((turn) => turn.id)).toEqual(['turn-older', 'turn-latest']);
    expect(workspace.historyNextCursor.value).toBeNull();

    const initial = workspace.beginSelectedConversationWatch();
    await Promise.resolve();
    expect(workspace.watchReady.value).toBe(false);
    expect(
      workspace.handleWatchEvent({
        type: 'watch.hosted-conversation.snapshot',
        workbenchConnectionId: 'connection-current',
        watchId,
        nodeGeneration: 'generation-current',
        nodeId: 'node-1',
        conversationId: 'conversation-1',
        revision: 1,
        snapshotSequence: 2,
        expiresAt: Date.now() + 45_000,
        payload: {
          ...snapshot,
          turns: [{ ...latest, completedAt: 21 }],
          historyNextCursor: 'older-cursor',
          snapshotSequence: 2
        }
      })
    ).toBe(true);
    await initial;
    expect(workspace.watchReady.value).toBe(true);
    expect(workspace.turns.value.map((turn) => turn.id)).toEqual(['turn-older', 'turn-latest']);
    expect(workspace.historyNextCursor.value).toBeNull();
    workspace.pauseSelectedConversationWatch();
    expect(workspace.watchReady.value).toBe(false);
  });

  it('Keeps older history errors scoped to the selected conversation and retries only on explicit load', async () => {
    let rejectOldHistory!: (error: Error) => void;
    const oldHistory = new Promise<never>((_resolve, reject) => {
      rejectOldHistory = reject;
    });
    const current = hostedTurn('turn-current-2', 20, 'Current');
    const older = hostedTurn('turn-older-2', 10, 'Older');
    const requests: string[] = [];
    let currentHistoryRequests = 0;
    const workspace = service(async (path) => {
      if (!path.includes('/history?')) throw new Error(`unexpected request: ${path}`);
      requests.push(path);
      if (path.includes('conversation-1')) return oldHistory as never;
      currentHistoryRequests += 1;
      if (currentHistoryRequests === 1) throw new Error('temporary history failure');
      return { turns: [older], nextCursor: null } as never;
    });
    workspace.selectConversation('node-1', 'conversation-1', {
      ...snapshot,
      turns: [hostedTurn('turn-current-1', 30, 'Old selection')],
      historyNextCursor: 'cursor-one'
    } as never);

    const staleLoad = workspace.loadOlderHistory();
    workspace.selectConversation('node-1', 'conversation-2', {
      ...snapshot,
      conversation: { ...conversation, id: 'conversation-2' },
      turns: [current],
      historyNextCursor: 'cursor-two'
    } as never);
    rejectOldHistory(new Error('stale selection failed'));
    await staleLoad;

    expect(workspace.turns.value.map((turn) => turn.id)).toEqual(['turn-current-2']);
    expect(workspace.historyNextCursor.value).toBe('cursor-two');
    expect(workspace.olderHistoryError.value).toBeUndefined();
    expect(requests).toHaveLength(1);

    await workspace.loadOlderHistory();
    expect(workspace.olderHistoryError.value).toBeInstanceOf(Error);
    expect(requests).toHaveLength(2);

    await workspace.loadOlderHistory();
    expect(requests).toHaveLength(3);
    expect(workspace.turns.value.map((turn) => turn.id)).toEqual([
      'turn-older-2',
      'turn-current-2'
    ]);
    expect(workspace.historyNextCursor.value).toBeNull();
    expect(workspace.olderHistoryError.value).toBeUndefined();
  });

  it('Clears hosted older loading when rollback replaces the authoritative history window', async () => {
    const olderResponse = deferred<unknown>();
    const rollbackResponse = deferred<unknown>();
    const current = hostedTurn('turn-current', 20, 'Current');
    const older = hostedTurn('turn-older', 10, 'Older');
    const request = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.includes('/history?')) return olderResponse.promise as never;
      if (path.endsWith('/rollback')) return rollbackResponse.promise as never;
      throw new Error(`unexpected request: ${path}`);
    });
    const workspace = service(request as HostedConversationRequest);
    workspace.selectConversation('node-1', 'conversation-1', {
      ...snapshot,
      turns: [current],
      historyNextCursor: 'older-cursor'
    } as never);

    const loading = workspace.loadOlderHistory();
    expect(workspace.loadingOlderHistory.value).toBe(true);
    const rollback = workspace.rollback(current.id, null, 'turn-current:user');
    rollbackResponse.resolve({
      ...snapshot,
      turns: [current],
      historyNextCursor: 'fresh-cursor',
      snapshotSequence: 2
    });
    await rollback;
    olderResponse.resolve({ turns: [older], nextCursor: null });
    await loading;

    expect(workspace.turns.value.map((turn) => turn.id)).toEqual(['turn-current']);
    expect(workspace.historyNextCursor.value).toBe('fresh-cursor');
    expect(workspace.loadingOlderHistory.value).toBe(false);
    const rollbackCall = request.mock.calls.find(([path]) => path.endsWith('/rollback'));
    expect(rollbackCall?.[0]).toBe(
      '/api/nodes/node-1/hosted-conversations/conversation-1/rollback'
    );
    expect(JSON.parse(rollbackCall?.[1]?.body as string)).toEqual({
      turnId: 'turn-current',
      boundary: null,
      itemId: 'turn-current:user'
    });
  });

  it('does not replace text flushed while a rollback response is pending', async () => {
    const rollbackResponse = deferred<unknown>();
    let watchId = '';
    const workspace = service(async (path, init) => {
      if (path.endsWith('/watch')) {
        watchId = (JSON.parse(String(init?.body)) as { watchId: string }).watchId;
        return {
          accepted: true,
          watchId,
          nodeGeneration: 'generation-current',
          expiresAt: Date.now() + 45_000
        } as never;
      }
      if (path.endsWith('/rollback')) return rollbackResponse.promise as never;
      throw new Error('UNEXPECTED_REQUEST');
    });
    workspace.selectConversation('node-1', 'conversation-1');
    const initial = workspace.beginSelectedConversationWatch();
    await Promise.resolve();
    const identity = {
      workbenchConnectionId: 'connection-current',
      watchId,
      nodeGeneration: 'generation-current',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      expiresAt: Date.now() + 45_000
    };
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.snapshot',
      ...identity,
      revision: 1,
      snapshotSequence: 1,
      payload: snapshot
    });
    await initial;
    const emitRuntime = (sequence: number, kind: string, payload: unknown) =>
      workspace.handleWatchEvent({
        type: 'watch.hosted-conversation.event',
        ...identity,
        event: {
          sequence,
          category: 'hosted-conversation',
          payload: {
            conversationId: 'conversation-1',
            kind: 'runtime',
            runtimeEvent: {
              kind,
              executionId: 'run-1',
              turnId: 'turn-1',
              sequence,
              createdAt: sequence,
              payload
            }
          }
        }
      });
    emitRuntime(2, 'RUN', { status: 'RUNNING' });
    emitRuntime(3, 'DELTA', { itemId: 'assistant-1', text: 'new text' });
    const rollback = workspace.rollback('turn-1', null);
    await Promise.resolve();
    expect(workspace.turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'new text' });
    rollbackResponse.resolve({ ...snapshot, snapshotSequence: 2 });
    await rollback;
    expect(workspace.turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'new text' });
  });

  it('Merge by Stable Turn, Item, File ID and do not infer files from message text', async () => {
    let watchId = '';
    const workspace = service(async (path, init) => {
      if (!path.endsWith('/watch')) return { items: [], nextCursor: null } as never;
      watchId = (JSON.parse(String(init?.body)) as { watchId: string }).watchId;
      return {
        accepted: true,
        watchId,
        nodeGeneration: 'generation-current',
        expiresAt: Date.now() + 45_000
      } as never;
    });
    workspace.selectConversation('node-1', 'conversation-1');
    const initial = workspace.beginSelectedConversationWatch();
    await Promise.resolve();
    const identity = {
      workbenchConnectionId: 'connection-current',
      watchId,
      nodeGeneration: 'generation-current',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      expiresAt: Date.now() + 45_000
    };
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.snapshot',
      ...identity,
      revision: 1,
      snapshotSequence: 1,
      payload: snapshot
    });
    await initial;

    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 2,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'runtime',
          runtimeEvent: {
            kind: 'ITEM',
            executionId: 'run-1',
            turnId: 'turn-1',
            sequence: 1,
            createdAt: 2,
            payload: {
              item: {
                itemId: 'item-1',
                kind: 'assistant_message',
                status: 'IN_PROGRESS',
                payload: {
                  text: 'See /conversation/output/fake.txt',
                  format: 'markdown',
                  model: null
                }
              }
            }
          }
        }
      }
    });
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 3,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'runtime',
          runtimeEvent: {
            kind: 'ITEM',
            executionId: 'run-1',
            turnId: 'turn-1',
            sequence: 2,
            createdAt: 3,
            payload: {
              item: {
                itemId: 'item-1',
                kind: 'assistant_message',
                status: 'COMPLETED',
                payload: { text: 'Done', format: 'markdown', model: null }
              }
            }
          }
        }
      }
    });

    expect(workspace.snapshot.value?.turns).toHaveLength(1);
    expect(workspace.snapshot.value?.turns[0]?.items).toEqual([
      expect.objectContaining({
        id: 'item-1',
        status: 'COMPLETED',
        startedAt: 2,
        payload: expect.objectContaining({ text: 'Done' })
      })
    ]);
    expect(workspace.snapshot.value?.files).toEqual([]);

    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 4,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'runtime',
          runtimeEvent: {
            kind: 'ITEM',
            executionId: 'run-1',
            turnId: 'turn-1',
            sequence: 1,
            createdAt: 4,
            payload: {
              item: {
                itemId: 'item-1',
                kind: 'assistant_message',
                status: 'IN_PROGRESS',
                payload: { text: 'Stale', format: 'markdown', model: null }
              }
            }
          }
        }
      }
    });
    expect(workspace.snapshot.value?.turns[0]?.items[0]).toMatchObject({
      id: 'item-1',
      status: 'COMPLETED',
      payload: { text: 'Done' }
    });

    const file = {
      id: 'file-1',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'result.txt',
      displayName: 'result.txt',
      mimeType: 'text/plain',
      size: 6,
      source: 'AGENT',
      turnId: 'turn-1',
      itemId: 'item-1',
      createdAt: 4,
      updatedAt: 4
    } as const;
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 5,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'files',
          files: [file, { ...file, size: 7, updatedAt: 5 }],
          error: null
        }
      }
    });

    expect(workspace.snapshot.value?.files).toEqual([{ ...file, size: 7, updatedAt: 5 }]);
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 6,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'files',
          files: [{ ...file, size: 7, updatedAt: 5 }],
          error: {
            code: 'HOSTED_CONVERSATION_FILE_RECONCILE_FAILED',
            message: 'Hosted conversation file projection failed.'
          }
        }
      }
    });
    expect(workspace.snapshot.value?.error).toEqual({
      code: 'HOSTED_CONVERSATION_FILE_RECONCILE_FAILED',
      message: 'Hosted conversation file projection failed.'
    });

    const upgradeFailed = {
      ...conversation,
      activeVersionId: 'version-1',
      status: 'ACTIVE',
      updatedAt: 7,
      lastActivityAt: 7
    } as const;
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 7,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'upgrade',
          upgrade: {
            status: 'FAILED',
            previousVersionId: 'version-1',
            targetVersionId: 'version-2',
            activeVersionId: 'version-1',
            conversation: upgradeFailed,
            error: {
              code: 'HOSTED_CONVERSATION_UPGRADE_FAILED',
              message: 'The conversation template upgrade failed.'
            }
          }
        }
      }
    });
    expect(workspace.snapshot.value?.error?.code).toBe('HOSTED_CONVERSATION_UPGRADE_FAILED');
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 8,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'files',
          files: [{ ...file, size: 7, updatedAt: 5 }],
          error: null
        }
      }
    });
    expect(workspace.snapshot.value?.error).toBeNull();

    const upgraded = {
      ...upgradeFailed,
      activeVersionId: 'version-2',
      status: 'ACTIVE',
      updatedAt: 9,
      lastActivityAt: 9
    } as const;
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 9,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'upgrade',
          upgrade: {
            status: 'SUCCEEDED',
            previousVersionId: 'version-1',
            targetVersionId: 'version-2',
            activeVersionId: 'version-2',
            conversation: upgraded,
            error: null
          }
        }
      }
    });
    expect(workspace.snapshot.value?.error).toBeNull();

    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 10,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'runtime',
          runtimeEvent: {
            kind: 'RUN',
            executionId: 'run-1',
            turnId: 'turn-1',
            sequence: 10,
            createdAt: 7,
            payload: { status: 'SUCCEEDED' }
          }
        }
      }
    });
    expect(workspace.snapshot.value?.turns[0]).toMatchObject({
      status: 'SUCCEEDED',
      completedAt: 7
    });
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 9,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'runtime',
          runtimeEvent: {
            kind: 'RUN',
            executionId: 'run-1',
            turnId: 'turn-1',
            sequence: 9,
            createdAt: 8,
            payload: { status: 'RUNNING' }
          }
        }
      }
    });
    expect(workspace.snapshot.value?.turns[0]).toMatchObject({
      status: 'SUCCEEDED',
      completedAt: 7
    });
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.event',
      ...identity,
      event: {
        sequence: 12,
        category: 'hosted-conversation',
        payload: {
          conversationId: 'conversation-1',
          kind: 'runtime',
          runtimeEvent: {
            kind: 'DELTA',
            executionId: 'run-1',
            turnId: 'turn-1',
            sequence: 3,
            createdAt: 9,
            payload: { itemId: 'item-1', text: ' late' }
          }
        }
      }
    });

    expect(workspace.snapshot.value?.turns[0]).toMatchObject({
      status: 'SUCCEEDED',
      completedAt: 7
    });
    expect(workspace.snapshot.value?.turns[0]?.items[0]).toMatchObject({
      id: 'item-1',
      status: 'COMPLETED',
      payload: { text: 'Done' }
    });
  });

  it('Message responses must not override concurrent real-time snapshots or roll back the final state of the same run', async () => {
    const response = deferred<unknown>();
    let watchId = '';
    const workspace = service(async (path, init) => {
      if (path.endsWith('/watch')) {
        watchId = (JSON.parse(String(init?.body)) as { watchId: string }).watchId;
        return {
          accepted: true,
          watchId,
          nodeGeneration: 'generation-current',
          expiresAt: Date.now() + 45_000
        } as never;
      }
      return response.promise as never;
    });
    workspace.selectConversation('node-1', 'conversation-1');
    const initial = workspace.beginSelectedConversationWatch();
    await Promise.resolve();
    const identity = {
      workbenchConnectionId: 'connection-current',
      watchId,
      nodeGeneration: 'generation-current',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      expiresAt: Date.now() + 45_000
    };
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.snapshot',
      ...identity,
      revision: 1,
      snapshotSequence: 1,
      payload: snapshot
    });
    await initial;
    const operation = workspace.sendMessage({
      prompt: 'Continue.',
      attachmentIds: [],
      clientMessageId: 'message-race'
    });
    const terminalRun = {
      id: 'run-race',
      status: 'SUCCEEDED',
      startedAt: 2,
      completedAt: 3
    } as const;
    const preservedError = {
      code: 'HOSTED_CONVERSATION_FILE_RECONCILE_FAILED',
      message: 'Hosted conversation file projection failed.'
    } as const;
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.snapshot',
      ...identity,
      revision: 2,
      snapshotSequence: 2,
      payload: {
        ...snapshot,
        run: terminalRun,
        files: [
          {
            id: 'file-race',
            conversationId: 'conversation-1',
            category: 'OUTPUT',
            relativePath: 'race.txt',
            displayName: 'race.txt',
            mimeType: 'text/plain',
            size: 4,
            source: 'AGENT',
            createdAt: 3,
            updatedAt: 3
          }
        ],
        error: preservedError
      }
    });
    response.resolve({
      conversation: { ...conversation, updatedAt: 2, lastActivityAt: 2 },
      run: { id: 'run-race', status: 'RUNNING', startedAt: 2, completedAt: null }
    });

    await expect(operation).resolves.toEqual({
      id: 'run-race',
      status: 'RUNNING',
      startedAt: 2,
      completedAt: null
    });
    expect(workspace.snapshot.value).toMatchObject({
      run: terminalRun,
      files: [{ id: 'file-race' }],
      error: preservedError
    });
  });

  it('Immediately display user messages during message submission and converge in-place with authoritative user items and streaming terminal', async () => {
    const response = deferred<unknown>();
    let watchId = '';
    const workspace = service(async (path, init) => {
      if (path.endsWith('/watch')) {
        watchId = (JSON.parse(String(init?.body)) as { watchId: string }).watchId;
        return {
          accepted: true,
          watchId,
          nodeGeneration: 'generation-current',
          expiresAt: Date.now() + 45_000
        } as never;
      }
      if (path.endsWith('/messages')) return response.promise as never;
      throw new Error('UNEXPECTED_REQUEST');
    });
    workspace.selectConversation('node-1', 'conversation-1');
    const initial = workspace.beginSelectedConversationWatch();
    await Promise.resolve();
    const identity = {
      workbenchConnectionId: 'connection-current',
      watchId,
      nodeGeneration: 'generation-current',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      expiresAt: Date.now() + 45_000
    };
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.snapshot',
      ...identity,
      revision: 1,
      snapshotSequence: 1,
      payload: snapshot
    });
    await initial;

    const operation = workspace.sendMessage({
      prompt: 'Stream this answer.',
      attachmentIds: [],
      clientMessageId: 'message-stream'
    });

    expect(workspace.turns.value).toEqual([
      expect.objectContaining({
        runId: null,
        status: 'PREPARING',
        items: [
          expect.objectContaining({
            kind: 'user_message',
            payload: expect.objectContaining({
              clientMessageId: 'message-stream',
              text: 'Stream this answer.',
              delivery: 'PENDING'
            })
          })
        ]
      })
    ]);

    const runtimeEvent = (
      sourceSequence: number,
      runtime: {
        readonly kind: 'RUN' | 'ITEM' | 'DELTA';
        readonly sequence: number;
        readonly payload: unknown;
      }
    ) =>
      workspace.handleWatchEvent({
        type: 'watch.hosted-conversation.event',
        ...identity,
        event: {
          sequence: sourceSequence,
          category: 'hosted-conversation',
          payload: {
            conversationId: 'conversation-1',
            kind: 'runtime',
            runtimeEvent: {
              ...runtime,
              executionId: 'run-stream',
              turnId: 'turn-stream',
              createdAt: sourceSequence
            }
          }
        }
      });

    runtimeEvent(2, {
      kind: 'RUN',
      sequence: 1,
      payload: { status: 'RUNNING' }
    });
    runtimeEvent(3, {
      kind: 'ITEM',
      sequence: 1,
      payload: {
        item: {
          itemId: 'turn-stream:user',
          kind: 'user_message',
          status: 'COMPLETED',
          payload: {
            clientMessageId: 'message-stream',
            text: 'Stream this answer.',
            contexts: [],
            delivery: 'ACCEPTED'
          }
        }
      }
    });

    expect(workspace.turns.value).toHaveLength(1);
    expect(workspace.turns.value[0]).toMatchObject({
      id: 'turn-stream',
      runId: 'run-stream',
      items: [
        {
          id: 'turn-stream:user',
          kind: 'user_message',
          status: 'COMPLETED',
          payload: expect.objectContaining({
            clientMessageId: 'message-stream',
            delivery: 'ACCEPTED'
          })
        }
      ]
    });

    runtimeEvent(4, {
      kind: 'DELTA',
      sequence: 2,
      payload: { itemId: 'message:assistant-1', text: 'Partial ' }
    });
    runtimeEvent(5, {
      kind: 'DELTA',
      sequence: 3,
      payload: { itemId: 'message:assistant-1', text: 'answer' }
    });
    await vi.waitFor(() =>
      expect(workspace.turns.value[0]?.items[1]).toMatchObject({
        id: 'message:assistant-1',
        status: 'IN_PROGRESS',
        payload: { text: 'Partial answer' }
      })
    );
    expect(workspace.snapshot.value?.turns).toBe(workspace.turns.value);

    runtimeEvent(6, {
      kind: 'ITEM',
      sequence: 4,
      payload: {
        item: {
          itemId: 'message:assistant-1',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'Partial answer', format: 'markdown', model: null }
        }
      }
    });
    expect(workspace.turns.value[0]?.items[1]).toMatchObject({
      id: 'message:assistant-1',
      status: 'COMPLETED',
      payload: { text: 'Partial answer' }
    });

    response.resolve({
      conversation: { ...conversation, updatedAt: 2, lastActivityAt: 2 },
      run: {
        id: 'run-stream',
        status: 'RUNNING',
        startedAt: 2,
        completedAt: null
      }
    });
    await operation;

    expect(
      workspace.turns.value.flatMap((turn) =>
        turn.items.filter(
          (item) =>
            item.kind === 'user_message' &&
            (item.payload as { clientMessageId?: string }).clientMessageId === 'message-stream'
        )
      )
    ).toHaveLength(1);
    expect(
      (
        workspace.turns.value[0]?.items.find((item) => item.kind === 'assistant_message')
          ?.payload as { text?: string }
      ).text
    ).toBe('Partial answer');
  });

  it('Remove this optimistic user message when the message request fails', async () => {
    const workspace = service(async () => {
      throw new Error('NETWORK_FAILED');
    });
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);
    vi.spyOn(workspace.watchReady, 'value', 'get').mockReturnValue(true);

    await expect(
      workspace.sendMessage({
        prompt: 'Retry me.',
        attachmentIds: [],
        clientMessageId: 'message-failed'
      })
    ).rejects.toThrow('NETWORK_FAILED');

    expect(workspace.turns.value).toEqual([]);
  });

  it('Message requests reuse plain session commit transactions and are only being sent in the current Hosted Conversation presentation', async () => {
    const response = deferred<unknown>();
    const workspace = service(async () => response.promise as never);
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);
    vi.spyOn(workspace.watchReady, 'value', 'get').mockReturnValue(true);

    const operation = workspace.sendMessage({
      prompt: 'Continue.',
      attachmentIds: [],
      clientMessageId: 'message-submission'
    });

    expect(workspace.messageSubmitting.value).toBe(true);
    expect(workspace.messageSubmissionContext.value).toBe('node-1\u0000conversation-1');
    response.resolve({
      conversation: {
        ...conversation,
        title: 'Continue.',
        updatedAt: 2,
        lastActivityAt: 2
      },
      run: {
        id: 'run-submission',
        status: 'RUNNING',
        startedAt: 2,
        completedAt: null
      }
    });
    await operation;

    expect(workspace.messageSubmitting.value).toBe(false);
    expect(workspace.messageSubmissionContext.value).toBeUndefined();
  });
});
