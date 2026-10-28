import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/util/api-error.js';
import {
  createHostedConversationWorkspaceService,
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

const snapshot = {
  nodeAppVersion: '0.9.55',
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
      sortOrder: 0,
      apiKeyConfigured: true
    }
  ],
  error: null,
  snapshotSequence: 1
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
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

describe('Web Hosted Conversation Workspace Service', () => {
  it('Sends only protocol-allowed fields for messages, configuration, metadata, stopping, and permanent deletion', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const updatedConversation = { ...conversation, modelId: 'model-2', updatedAt: 2 };
    const workspace = service(async (path, init) => {
      recordRequest(requests, path, init);
      if (path.endsWith('/messages'))
        return {
          conversation: updatedConversation,
          run: { id: 'run-2', status: 'RUNNING', startedAt: 2, completedAt: null }
        } as never;
      if (path.endsWith('/config')) return { conversation: updatedConversation } as never;
      if (init?.method === 'PATCH')
        return {
          conversation: {
            ...updatedConversation,
            title: 'Renamed conversation',
            pinnedAt: 2
          }
        } as never;
      if (path.endsWith('/interrupt')) return { interrupted: true } as never;
      if (init?.method === 'DELETE') return { deletedConversationId: 'conversation-1' } as never;
      return undefined as never;
    });
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);

    workspace.watchReady.value = true;
    await workspace.sendMessage({
      prompt: 'Continue.',
      attachmentIds: ['file-1'],
      clientMessageId: 'message-1',
      modelId: 'model-2'
    });
    await workspace.updateConfiguration({ modelId: 'model-2' });
    await workspace.updateMetadata({ title: 'Renamed conversation', pinned: true });
    expect(workspace.conversations.value[0]).toMatchObject({
      title: 'Renamed conversation',
      pinnedAt: 2
    });
    await expect(workspace.interrupt()).resolves.toBe(true);
    await expect(workspace.deleteConversation()).resolves.toEqual({
      deletedConversationId: 'conversation-1'
    });
    expect(workspace.selectedConversationId.value).toBeUndefined();
    expect(workspace.snapshot.value).toBeUndefined();
    expect(workspace.conversations.value).toEqual([]);

    expect(requests).toEqual([
      {
        path: '/api/nodes/node-1/hosted-conversations/conversation-1/messages',
        init: {
          method: 'POST',
          body: JSON.stringify({
            clientMessageId: 'message-1',
            prompt: 'Continue.',
            attachmentIds: ['file-1'],
            modelId: 'model-2'
          })
        }
      },
      {
        path: '/api/nodes/node-1/hosted-conversations/conversation-1/config',
        init: {
          method: 'PATCH',
          body: JSON.stringify({ modelId: 'model-2' })
        }
      },
      {
        path: '/api/nodes/node-1/hosted-conversations/conversation-1',
        init: {
          method: 'PATCH',
          body: JSON.stringify({ title: 'Renamed conversation', pinned: true })
        }
      },
      {
        path: '/api/nodes/node-1/hosted-conversations/conversation-1/interrupt',
        init: { method: 'POST', body: '{}' }
      },
      {
        path: '/api/nodes/node-1/hosted-conversations/conversation-1',
        init: { method: 'DELETE', body: '{}' }
      }
    ]);
  });

  it('Sends replacement intent without an app-version gate', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const workspace = service(async (path, init) => {
      recordRequest(requests, path, init);
      return {
        conversation,
        run: { id: 'run-replacement', status: 'RUNNING', startedAt: 2, completedAt: null }
      } as never;
    });
    workspace.selectConversation('node-1', 'conversation-1', {
      ...snapshot,
      nodeAppVersion: 'unknown'
    } as never);

    workspace.watchReady.value = true;
    await workspace.sendMessage({
      prompt: 'Replace the active Run.',
      attachmentIds: [],
      clientMessageId: 'replacement-message-1',
      deliveryIntent: 'REPLACE_CURRENT'
    });

    expect(requests).toEqual([
      {
        path: '/api/nodes/node-1/hosted-conversations/conversation-1/messages',
        init: {
          method: 'POST',
          body: JSON.stringify({
            clientMessageId: 'replacement-message-1',
            prompt: 'Replace the active Run.',
            attachmentIds: [],
            deliveryIntent: 'REPLACE_CURRENT'
          })
        }
      }
    ]);
  });

  it('Hosted rollback ignores an unknown app version and installs the authoritative snapshot', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const rolledBack = {
      ...snapshot,
      nodeAppVersion: 'unknown',
      turns: [],
      snapshotSequence: 2
    } as const;
    const workspace = service(async (path, init) => {
      recordRequest(requests, path, init);
      return rolledBack as never;
    });
    workspace.selectConversation('node-1', 'conversation-1', {
      ...snapshot,
      turns: [
        {
          id: 'turn-2',
          sessionId: 'session-1',
          runId: 'run-2',
          userItemId: 'turn-2:user',
          status: 'SUCCEEDED',
          model: 'model-1',
          effort: null,
          access: 'full-access',
          rewind: { before: 'turn-1', after: 'turn-2' },
          items: [],
          startedAt: 1,
          completedAt: 2
        }
      ]
    } as never);

    await expect(workspace.rollback('turn-2', 'turn-1')).resolves.toMatchObject(rolledBack);
    expect(requests).toEqual([
      {
        path: '/api/nodes/node-1/hosted-conversations/conversation-1/rollback',
        init: {
          method: 'POST',
          body: JSON.stringify({ turnId: 'turn-2', boundary: 'turn-1' })
        }
      }
    ]);
    expect(workspace.snapshot.value).toMatchObject(rolledBack);
    expect(workspace.turns.value).toEqual([]);
  });

  it('keeps hosted history unchanged when rollback fails or returns a different identity', async () => {
    const original = {
      ...snapshot,
      turns: [
        {
          id: 'turn-2',
          sessionId: 'session-1',
          runId: 'run-2',
          userItemId: 'turn-2:user',
          status: 'SUCCEEDED',
          model: 'model-1',
          effort: null,
          access: 'full-access',
          rewind: { before: 'turn-1', after: 'turn-2' },
          items: [],
          startedAt: 1,
          completedAt: 2
        }
      ]
    } as const;
    const failed = service(async () => {
      throw new Error('HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID');
    });
    failed.selectConversation('node-1', 'conversation-1', original as never);
    const normalizedOriginal = failed.snapshot.value;
    await expect(failed.rollback('turn-2', 'turn-1')).rejects.toThrow(
      'HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID'
    );
    expect(failed.snapshot.value).toBe(normalizedOriginal);

    const forged = service(
      async () =>
        ({
          ...snapshot,
          conversation: { ...conversation, sessionId: 'session-forged' }
        }) as never
    );
    forged.selectConversation('node-1', 'conversation-1', original as never);
    const normalizedForgedOriginal = forged.snapshot.value;
    await expect(forged.rollback('turn-2', 'turn-1')).rejects.toThrow(
      'HOSTED_CONVERSATION_RESPONSE_INVALID'
    );
    expect(forged.snapshot.value).toBe(normalizedForgedOriginal);
  });

  it('does not let a late rollback HTTP snapshot overwrite newer Watch state', async () => {
    const response = deferred<unknown>();
    const workspace = service(async () => response.promise as never);
    const original = {
      ...snapshot,
      turns: [
        {
          id: 'turn-2',
          sessionId: 'session-1',
          runId: 'run-2',
          userItemId: 'turn-2:user',
          status: 'SUCCEEDED',
          model: 'model-1',
          effort: null,
          access: 'full-access',
          rewind: { before: 'turn-1', after: 'turn-2' },
          items: [],
          startedAt: 1,
          completedAt: 2
        }
      ]
    } as const;
    workspace.selectConversation('node-1', 'conversation-1', original as never);
    const rollback = workspace.rollback('turn-2', 'turn-1');
    const newer = {
      ...snapshot,
      conversation: {
        ...conversation,
        title: 'Newer Watch title',
        updatedAt: conversation.updatedAt + 1
      },
      turns: [],
      snapshotSequence: 3
    } as const;
    workspace.selectConversation('node-1', 'conversation-1', newer as never);
    const newerSnapshot = workspace.snapshot.value;
    response.resolve({
      ...snapshot,
      turns: [],
      snapshotSequence: 2
    });

    await expect(rollback).resolves.toMatchObject({ snapshotSequence: 2 });
    expect(workspace.snapshot.value).toBe(newerSnapshot);
    expect(workspace.snapshot.value?.conversation.title).toBe('Newer Watch title');
  });

  it('installs late rollback history while preserving newer non-history state', async () => {
    const rollbackResponse = deferred<unknown>();
    const workspace = service(async (path) => {
      if (path.endsWith('/rollback')) return rollbackResponse.promise as never;
      if (path.endsWith('/hosted-conversations/conversation-1'))
        return {
          conversation: {
            ...conversation,
            title: 'Renamed while rollback was pending',
            updatedAt: 3,
            lastActivityAt: 3
          }
        } as never;
      return undefined as never;
    });
    const original = {
      ...snapshot,
      turns: [
        {
          id: 'turn-2',
          sessionId: 'session-1',
          runId: 'run-2',
          userItemId: 'turn-2:user',
          status: 'SUCCEEDED',
          model: 'model-1',
          effort: null,
          access: 'full-access',
          rewind: { before: 'turn-1', after: 'turn-2' },
          items: [],
          startedAt: 1,
          completedAt: 2
        }
      ]
    } as const;
    workspace.selectConversation('node-1', 'conversation-1', original as never);
    const rollback = workspace.rollback('turn-2', 'turn-1');

    await workspace.updateMetadata({ title: 'Renamed while rollback was pending' });
    rollbackResponse.resolve({
      ...snapshot,
      conversation: { ...conversation, lastActivityAt: 2 },
      turns: [],
      snapshotSequence: 2
    });

    await expect(rollback).resolves.toMatchObject({ turns: [] });
    expect(workspace.turns.value).toEqual([]);
    expect(workspace.snapshot.value?.conversation).toMatchObject({
      title: 'Renamed while rollback was pending',
      updatedAt: 3,
      lastActivityAt: 3
    });
  });

  it('Uploads in preflight, creation, sequential chunk, and completion order, and strictly parses file reads', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const uploadedFile = {
      id: 'file-uploaded',
      conversationId: 'conversation-1',
      category: 'UPLOAD',
      relativePath: 'note.txt',
      displayName: 'note.txt',
      mimeType: 'text/plain',
      size: 3,
      source: 'USER',
      createdAt: 2,
      updatedAt: 2
    } as const;
    const workspace = service(async (path, init) => {
      recordRequest(requests, path, init);
      if (path.endsWith('/uploads/preflight'))
        return { files: [{ name: 'note.txt', status: 'READY' }] } as never;
      if (path.endsWith('/uploads'))
        return {
          upload: {
            uploadId: 'upload-1',
            conversationId: 'conversation-1',
            name: 'note.txt',
            mimeType: 'text/plain',
            receivedBytes: 0,
            size: 3,
            status: 'UPLOADING'
          }
        } as never;
      if (path.endsWith('/chunks'))
        return {
          upload: {
            uploadId: 'upload-1',
            conversationId: 'conversation-1',
            name: 'note.txt',
            mimeType: 'text/plain',
            receivedBytes: 3,
            size: 3,
            status: 'UPLOADING'
          }
        } as never;
      if (path.endsWith('/complete'))
        return {
          upload: {
            uploadId: 'upload-1',
            conversationId: 'conversation-1',
            name: 'note.txt',
            mimeType: 'text/plain',
            receivedBytes: 3,
            size: 3,
            status: 'COMPLETED',
            file: uploadedFile
          }
        } as never;
      if (path.includes('/files/file-uploaded'))
        return {
          file: uploadedFile,
          encoding: 'base64',
          content: 'YWJj',
          offset: 0,
          nextOffset: null,
          eof: true
        } as never;
      return undefined as never;
    });
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);
    const file = {
      name: 'note.txt',
      size: 3,
      type: 'text/plain',
      arrayBuffer: async () => {
        throw new Error('FULL_FILE_READ_FORBIDDEN');
      },
      slice: () => ({
        arrayBuffer: async () => Uint8Array.from([97, 98, 99]).buffer
      })
    } as unknown as File;

    await expect(workspace.uploadFile(file, 'upload-request-1')).resolves.toMatchObject({
      status: 'COMPLETED',
      file: { id: 'file-uploaded' }
    });
    await expect(workspace.readFile('file-uploaded')).resolves.toMatchObject({
      content: 'YWJj',
      eof: true
    });

    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      offset: 0,
      dataBase64: 'YWJj'
    });
    expect(requests.map((entry) => entry.path)).toEqual([
      '/api/nodes/node-1/hosted-conversations/conversation-1/uploads/preflight',
      '/api/nodes/node-1/hosted-conversations/conversation-1/uploads',
      '/api/nodes/node-1/hosted-conversations/conversation-1/uploads/upload-1/chunks',
      '/api/nodes/node-1/hosted-conversations/conversation-1/uploads/upload-1/complete',
      '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-uploaded?offset=0&limit=524288'
    ]);
  });

  it('deletes only the stable target file ID from the current snapshot', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const deletedFile = {
      id: 'file-output',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'result.txt',
      displayName: 'result.txt',
      mimeType: 'text/plain',
      size: 6,
      source: 'AGENT',
      createdAt: 2,
      updatedAt: 2
    } as const;
    const remainingFile = {
      ...deletedFile,
      id: 'file-upload',
      category: 'UPLOAD',
      relativePath: 'input.txt',
      displayName: 'input.txt',
      source: 'USER'
    } as const;
    const workspace = service(async (path, init) => {
      recordRequest(requests, path, init);
      return {
        deletedFileId: deletedFile.id,
        files: [remainingFile]
      } as never;
    });
    workspace.selectConversation('node-1', 'conversation-1', {
      ...snapshot,
      files: [deletedFile, remainingFile]
    } as never);

    await expect(workspace.deleteFile(deletedFile.id)).resolves.toEqual({
      deletedFileId: deletedFile.id,
      files: [remainingFile]
    });
    expect(workspace.snapshot.value?.files).toEqual([remainingFile]);
    expect(requests).toEqual([
      {
        path: '/api/nodes/node-1/hosted-conversations/conversation-1/files/file-output',
        init: { method: 'DELETE', body: '{}' }
      }
    ]);
  });

  describe('file deletion response ordering', () => {
    const target = {
      id: 'file-target',
      conversationId: conversation.id,
      category: 'OUTPUT',
      relativePath: 'target.txt',
      displayName: 'target.txt',
      mimeType: 'text/plain',
      size: 6,
      source: 'AGENT',
      createdAt: 2,
      updatedAt: 2
    } as const;
    const existing = { ...target, id: 'file-existing', relativePath: 'existing.txt' };
    const added = { ...target, id: 'file-added', relativePath: 'added.txt' };
    const initial = { ...snapshot, files: [target, existing] };

    it('preserves newer files Watch additions and metadata when an older deletion response arrives', async () => {
      const response = deferred<unknown>();
      let watchId = '';
      const workspace = service(async (path, init) => {
        if (!path.endsWith('/watch')) return response.promise as never;
        watchId = (JSON.parse(String(init?.body)) as { watchId: string }).watchId;
        return {
          accepted: true,
          watchId,
          nodeGeneration: 'generation-current',
          expiresAt: Date.now() + 45_000
        } as never;
      });
      workspace.selectConversation('node-1', conversation.id);
      try {
        const watching = workspace.beginSelectedConversationWatch();
        await Promise.resolve();
        const identity = {
          workbenchConnectionId: 'connection-current',
          watchId,
          nodeGeneration: 'generation-current',
          nodeId: 'node-1',
          conversationId: conversation.id,
          expiresAt: Date.now() + 45_000
        };
        expect(
          workspace.handleWatchEvent({
            type: 'watch.hosted-conversation.snapshot',
            ...identity,
            revision: 1,
            snapshotSequence: 1,
            payload: initial
          })
        ).toBe(true);
        await watching;
        const deleting = workspace.deleteFile(target.id);
        const updated = { ...existing, size: 42, updatedAt: 3 };
        const error = { code: 'FILE_SCAN_PARTIAL', message: 'A file could not be scanned.' };
        expect(
          workspace.handleWatchEvent({
            type: 'watch.hosted-conversation.event',
            ...identity,
            event: {
              sequence: 2,
              category: 'hosted-conversation',
              payload: {
                conversationId: conversation.id,
                kind: 'files',
                files: [target, updated, added],
                error
              }
            }
          })
        ).toBe(true);
        expect(workspace.snapshot.value?.files).toEqual([target, updated, added]);
        const authoritative = workspace.snapshot.value;
        response.resolve({ deletedFileId: target.id, files: [existing] });
        await expect(deleting).resolves.toEqual({ deletedFileId: target.id, files: [existing] });
        expect(workspace.snapshot.value).toEqual({ ...authoritative, files: [updated, added] });
      } finally {
        workspace.stopSelectedConversationWatch();
      }
    });

    it.each(['request failure', 'wrong file ID', 'wrong conversation ID'] as const)(
      'keeps the current files unchanged after %s',
      async (failure) => {
        const error = new Error('Deletion failed');
        const workspace = service(async () => {
          if (failure === 'request failure') throw error;
          return {
            deletedFileId: failure === 'wrong file ID' ? 'another-file' : target.id,
            files:
              failure === 'wrong conversation ID'
                ? [{ ...existing, conversationId: 'another-conversation' }]
                : [existing]
          } as never;
        });
        workspace.selectConversation('node-1', conversation.id, initial as never);
        const before = workspace.snapshot.value;
        await expect(workspace.deleteFile(target.id)).rejects.toThrow(
          failure === 'request failure' ? error : 'HOSTED_CONVERSATION_RESPONSE_INVALID'
        );
        expect(workspace.snapshot.value).toBe(before);
      }
    );

    it('does not apply a late deletion response to another selected conversation', async () => {
      const response = deferred<unknown>();
      const workspace = service(async () => response.promise as never);
      workspace.selectConversation('node-1', conversation.id, initial as never);
      const deleting = workspace.deleteFile(target.id);
      workspace.selectConversation('node-2', 'conversation-2', {
        ...snapshot,
        conversation: { ...conversation, id: 'conversation-2', nodeId: 'node-2' },
        files: [{ ...target, conversationId: 'conversation-2' }]
      } as never);
      const selected = workspace.snapshot.value;
      response.resolve({ deletedFileId: target.id, files: [existing] });
      await expect(deleting).resolves.toMatchObject({ deletedFileId: target.id });
      expect(workspace.snapshot.value).toBe(selected);
      expect(workspace.selectedConversationId.value).toBe('conversation-2');
    });
  });

  it('restores the current Hosted Watch when permanent deletion fails so writes cannot continue without a live subscription', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    let currentWatchId = '';
    let watchGeneration = 0;
    const workspace = service(async (path, init) => {
      recordRequest(requests, path, init);
      if (path.endsWith('/watch') && init?.method === 'POST') {
        currentWatchId = (JSON.parse(String(init.body)) as { watchId: string }).watchId;
        watchGeneration += 1;
        return {
          accepted: true,
          watchId: currentWatchId,
          nodeGeneration: `generation-${watchGeneration}`,
          expiresAt: Date.now() + 45_000
        } as never;
      }
      if (path.endsWith('/watch') && init?.method === 'DELETE') return { unwatched: true } as never;
      if (init?.method === 'DELETE') throw new Error('NETWORK_RESPONSE_LOST');
      return undefined as never;
    });
    workspace.selectConversation('node-1', 'conversation-1');
    const initial = workspace.beginSelectedConversationWatch();
    await Promise.resolve();
    workspace.handleWatchEvent({
      type: 'watch.hosted-conversation.snapshot',
      workbenchConnectionId: 'connection-current',
      watchId: currentWatchId,
      nodeGeneration: 'generation-1',
      nodeId: 'node-1',
      conversationId: 'conversation-1',
      revision: 1,
      snapshotSequence: 1,
      expiresAt: Date.now() + 45_000,
      payload: snapshot
    });
    await initial;

    await expect(workspace.deleteConversation()).rejects.toThrow('NETWORK_RESPONSE_LOST');
    await Promise.resolve();

    expect(
      requests.filter((entry) => entry.path.endsWith('/watch') && entry.init?.method === 'POST')
    ).toHaveLength(2);
  });

  it('Attempts to cancel the temporary Node upload after a chunk upload fails', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const workspace = service(async (path, init) => {
      recordRequest(requests, path, init);
      if (path.endsWith('/uploads/preflight'))
        return { files: [{ name: 'broken.txt', status: 'READY' }] } as never;
      if (path.endsWith('/uploads'))
        return {
          upload: {
            uploadId: 'upload-broken',
            conversationId: 'conversation-1',
            name: 'broken.txt',
            mimeType: 'text/plain',
            receivedBytes: 0,
            size: 3,
            status: 'UPLOADING'
          }
        } as never;
      if (path.endsWith('/chunks')) throw new Error('NETWORK_FAILED');
      if (path.endsWith('/cancel'))
        return {
          upload: {
            uploadId: 'upload-broken',
            conversationId: 'conversation-1',
            name: 'broken.txt',
            mimeType: 'text/plain',
            receivedBytes: 0,
            size: 3,
            status: 'CANCELLED'
          }
        } as never;
      return undefined as never;
    });
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);
    const file = {
      name: 'broken.txt',
      size: 3,
      type: 'text/plain',
      slice: () => ({
        arrayBuffer: async () => Uint8Array.from([97, 98, 99]).buffer
      })
    } as unknown as File;

    await expect(workspace.uploadFile(file, 'upload-request-broken')).rejects.toThrow(
      'NETWORK_FAILED'
    );
    expect(requests.at(-1)).toEqual({
      path: '/api/nodes/node-1/hosted-conversations/conversation-1/uploads/upload-broken/cancel',
      init: { method: 'POST', body: '{}' }
    });
  });

  it('Stops later chunks when canceled during file reading and cleans up the temporary Node upload', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const content = deferred<ArrayBuffer>();
    const reading = deferred<void>();
    const workspace = service(async (path, init) => {
      recordRequest(requests, path, init);
      if (path.endsWith('/uploads/preflight'))
        return { files: [{ name: 'cancelled.txt', status: 'READY' }] } as never;
      if (path.endsWith('/uploads'))
        return {
          upload: {
            uploadId: 'upload-cancelled',
            conversationId: 'conversation-1',
            name: 'cancelled.txt',
            mimeType: 'text/plain',
            receivedBytes: 0,
            size: 3,
            status: 'UPLOADING'
          }
        } as never;
      if (path.endsWith('/cancel'))
        return {
          upload: {
            uploadId: 'upload-cancelled',
            conversationId: 'conversation-1',
            name: 'cancelled.txt',
            mimeType: 'text/plain',
            receivedBytes: 0,
            size: 3,
            status: 'CANCELLED'
          }
        } as never;
      throw new Error('UNEXPECTED_UPLOAD_REQUEST');
    });
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);
    const file = {
      name: 'cancelled.txt',
      size: 3,
      type: 'text/plain',
      slice: () => ({
        arrayBuffer: async () => {
          reading.resolve();
          return content.promise;
        }
      })
    } as unknown as File;
    const controller = new AbortController();
    const operation = workspace.uploadFile(
      file,
      'upload-request-cancelled',
      undefined,
      controller.signal
    );
    await reading.promise;
    controller.abort();
    content.resolve(Uint8Array.from([97, 98, 99]).buffer);

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests.at(-1)).toEqual({
      path: '/api/nodes/node-1/hosted-conversations/conversation-1/uploads/upload-cancelled/cancel',
      init: { method: 'POST', body: '{}' }
    });
    expect(requests.some((entry) => entry.path.endsWith('/chunks'))).toBe(false);
  });

  it('Requires file chunk responses to match the request offset and projected size to prevent download loops or misaligned assembly', async () => {
    const workspace = service(
      async () =>
        ({
          file: {
            id: 'file-1',
            conversationId: 'conversation-1',
            category: 'OUTPUT',
            relativePath: 'result.txt',
            displayName: 'result.txt',
            mimeType: 'text/plain',
            size: 3,
            source: 'AGENT',
            createdAt: 2,
            updatedAt: 2
          },
          encoding: 'base64',
          content: 'YQ==',
          offset: 0,
          nextOffset: 1,
          eof: false
        }) as never
    );
    workspace.selectConversation('node-1', 'conversation-1', snapshot as never);

    await expect(workspace.readFile('file-1', 1, 1)).rejects.toThrow(
      'HOSTED_CONVERSATION_RESPONSE_INVALID'
    );
  });
});

function recordRequest(
  requests: Array<{ path: string; init?: RequestInit }>,
  path: string,
  init?: RequestInit
): void {
  requests.push(init === undefined ? { path } : { path, init });
}

describe('Hosted template changes', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
  const target = {
    ...template,
    id: 'template-2',
    name: 'Second template',
    currentVersionId: 'version-2'
  };
  // Version is display metadata; admission and live state determine availability.
  const initial = { ...snapshot, nodeAppVersion: 'unknown' };
  const changed = {
    ...initial,
    conversation: {
      ...conversation,
      templateId: target.id,
      templateName: target.name,
      activeVersionId: 'version-2',
      title: 'Latest Watch title',
      updatedAt: 3
    },
    template: target,
    snapshotSequence: 2
  };

  function harness(
    options: { pending?: Promise<unknown>; failure?: Error; commit?: boolean } = {}
  ) {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const watches: Array<Record<string, unknown>> = [];
    let committed = false;
    const result = {
      conversation: { ...changed.conversation, title: 'Older HTTP title' },
      template: target,
      models: initial.models
    };
    const workspace = service(async (path, init) => {
      recordRequest(requests, path, init);
      if (path === '/api/conversation-templates')
        return {
          templates: [template, target, { ...target, id: 'foreign-template', nodeId: 'other-node' }]
        } as never;
      if (path.endsWith('/template')) {
        committed = options.commit !== false;
        await options.pending;
        if (options.failure) throw options.failure;
        return result as never;
      }
      if (path.endsWith('/watch') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body['mode'] === 'initial') {
          const frame = {
            type: 'watch.hosted-conversation.snapshot',
            workbenchConnectionId: 'connection-current',
            watchId: body['watchId'],
            nodeGeneration: 'generation-current',
            nodeId: 'node-1',
            conversationId: 'conversation-1',
            revision: 1,
            snapshotSequence: committed ? 2 : 1,
            expiresAt: Date.now() + 60_000,
            payload: committed ? changed : initial
          };
          watches.push(frame);
          queueMicrotask(() => workspace.handleWatchEvent(frame));
          return {
            accepted: true,
            watchId: body['watchId'],
            nodeGeneration: 'generation-current',
            expiresAt: Date.now() + 60_000
          } as never;
        }
      }
      return undefined as never;
    });
    workspace.selectConversation('node-1', 'conversation-1', initial as never);
    cleanups.push(() => workspace.stopSelectedConversationWatch());
    return { workspace, requests, watches };
  }

  it('filters options to the selected Node without changing the selected model', async () => {
    const h = harness();
    expect((await h.workspace.listTemplateOptions()).map((item) => item.id)).toEqual([
      'template-1',
      'template-2'
    ]);
    expect(h.workspace.snapshot.value?.conversation.modelId).toBe(conversation.modelId);
    expect(h.requests.map((item) => item.path)).toEqual(['/api/conversation-templates']);
  });

  it('submits only the source and target, then restores one Watch instead of installing the HTTP snapshot', async () => {
    const h = harness();
    await h.workspace.beginSelectedConversationWatch();
    await h.workspace.switchTemplate(target.id, template.id);
    expect(
      h.requests
        .filter((item) => item.path.endsWith('/template'))
        .map((item) => JSON.parse(String(item.init?.body)))
    ).toEqual([{ expectedTemplateId: template.id, templateId: target.id }]);
    expect(h.watches).toHaveLength(2);
    expect(h.workspace.watchReady.value).toBe(true);
    expect(h.workspace.snapshot.value?.conversation).toMatchObject(changed.conversation);
    expect(h.workspace.templateChanging.value).toBe(false);
  });

  it('coalesces the invalidation signal and the late successful HTTP response', async () => {
    const pending = deferred<unknown>();
    const h = harness({ pending: pending.promise });
    await h.workspace.beginSelectedConversationWatch();
    const sending = h.workspace.switchTemplate(target.id, template.id);
    expect(h.workspace.templateChanging.value).toBe(true);
    await expect(h.workspace.updateConfiguration({ modelId: 'model-1' })).rejects.toThrow(
      'HOSTED_CONVERSATION_STATE_INVALID'
    );
    const old = h.watches[0]!;
    h.workspace.handleWatchEvent({
      ...old,
      type: 'watch.hosted-conversation.event',
      event: {
        sequence: 2,
        category: 'hosted-conversation',
        payload: { kind: 'template-changed', conversationId: conversation.id }
      }
    });
    await Promise.resolve();
    await Promise.resolve();
    pending.resolve(undefined);
    await sending;
    expect(h.watches).toHaveLength(2);
    expect(h.workspace.snapshot.value?.conversation.title).toBe('Latest Watch title');
  });

  it('does not select the old conversation again when its write completes after navigation', async () => {
    const pending = deferred<unknown>();
    const h = harness({ pending: pending.promise });
    await h.workspace.beginSelectedConversationWatch();
    const sending = h.workspace.switchTemplate(target.id, template.id);
    h.workspace.selectConversation('node-1', 'conversation-other', {
      ...initial,
      conversation: { ...conversation, id: 'conversation-other', sessionId: 'session-other' }
    } as never);
    pending.resolve(undefined);
    await sending;
    expect(h.workspace.selectedConversationId.value).toBe('conversation-other');
    expect(h.workspace.snapshot.value?.conversation.templateId).toBe(template.id);
    expect(h.watches).toHaveLength(1);
  });

  it.each([
    'quota',
    'transport',
    'NODE_RESPONSE_INVALID',
    'INTERNAL_ERROR',
    'NODE_SEND_FAILED',
    'NODE_CONTROL_CLOSED'
  ])('does not retry a failed write; reconciles only an uncertain result: %s', async (kind) => {
    const uncertain = kind !== 'quota';
    const failure =
      kind === 'transport'
        ? new TypeError('Connection lost')
        : new ApiError(
            kind === 'quota' ? 'HOSTED_CONVERSATION_QUOTA_EXCEEDED' : kind,
            'Request failed.'
          );
    const h = harness({ failure, commit: uncertain });
    await h.workspace.beginSelectedConversationWatch();
    await expect(h.workspace.switchTemplate(target.id, template.id)).rejects.toBe(failure);
    expect(h.requests.filter((item) => item.path.endsWith('/template'))).toHaveLength(1);
    expect(h.watches).toHaveLength(uncertain ? 2 : 1);
    expect(h.workspace.snapshot.value?.conversation.templateId).toBe(
      uncertain ? target.id : template.id
    );
    expect(h.workspace.templateChanging.value).toBe(false);
  });
});
