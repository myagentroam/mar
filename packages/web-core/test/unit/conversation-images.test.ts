import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationImageService } from '../../src/service/ConversationImageService';
import { conversationItemSchema } from '../../../protocol/src/index';
import { computed, ref, type Ref } from 'vue';
import type { ComposerAttachmentFile } from '@myagentroam/protocol';
import { ApiError } from '../../src/util/api-error.js';

function fileOptions(
  target: Ref<{ nodeId: string; workspaceId: string }>,
  request: (path: string, init?: RequestInit) => Promise<unknown>,
  onError: (error: unknown, path: string) => void
) {
  return {
    target: computed(() => JSON.stringify(target.value)),
    revalidate: (file: ComposerAttachmentFile) => request(file.path, { cache: 'no-store' }),
    sourceUrl: (file: ComposerAttachmentFile, revision: number) => {
      const parameters = new URLSearchParams({
        nodeId: target.value.nodeId,
        path: file.path,
        preview: String(revision)
      });
      return `/api/workspaces/${target.value.workspaceId}/files/content?${parameters}`;
    },
    onError
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Web Conversation Image State', () => {
  it('uses a fresh image URL on reopening and ignores a failed previous image', async () => {
    const target = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const request = vi.fn(async () => ({}));
    const onError = vi.fn();
    const state = createConversationImageService(ref('node-1'), {
      fileAttachments: fileOptions(target, request, onError)
    });
    const file = {
      name: 'photo.png',
      mime: 'image/png',
      path: '.mar/temp-files/session/photo.png'
    };
    try {
      await state.openFileAttachment(file);
      const previousUrl = state.preview.value!.url;
      state.previewOpen.value = false;
      await state.openFileAttachment(file);
      const currentUrl = state.preview.value!.url;
      expect(currentUrl).not.toBe(previousUrl);
      await state.previewFailed(previousUrl);
      expect(request).toHaveBeenCalledTimes(2);
      expect(state.previewOpen.value).toBe(true);
      expect(state.preview.value?.url).toBe(currentUrl);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      state.dispose();
    }
  });
  it('uses the configured authority and ignores late reads after disposal', async () => {
    const target = ref('node-1:workspace-1');
    const onError = vi.fn();
    let finish!: () => void;
    const revalidate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const state = createConversationImageService(ref('node-1'), {
      fileAttachments: {
        target,
        revalidate,
        sourceUrl: () => '/api/workspaces/workspace-1/files/content?nodeId=node-1&path=photo.png',
        onError
      }
    });
    const file = {
      name: 'photo.png',
      mime: 'image/png',
      path: '.mar/temp-files/session/photo.png'
    };
    const first = state.openFileAttachment(file);
    finish();
    await first;
    expect(state.preview.value?.url).toContain('/workspaces/workspace-1/');
    const second = state.openFileAttachment(file);
    state.dispose();
    finish();
    await second;
    expect(state.previewOpen.value).toBe(false);
    expect(state.preview.value).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports decode failures normally and ignores errors from replaced previews', async () => {
    const target = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({}));
    const onError = vi.fn();
    const state = createConversationImageService(ref('node-1'), {
      fileAttachments: fileOptions(target, request, onError)
    });
    try {
      const file = {
        name: 'photo.png',
        mime: 'image/png',
        path: '.mar/temp-files/session/photo.png'
      };
      await state.openFileAttachment(file);
      const url = state.preview.value!.url;
      await state.previewFailed(url);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'IMAGE_PREVIEW_FAILED' }),
        file.path
      );
      await state.openFileAttachment(file);
      state.open({ name: 'generated.png', previewUrl: '/api/agent-runs/run-1/images/0' });
      await state.previewFailed(url);
      expect(state.preview.value?.name).toBe('generated.png');
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      state.dispose();
    }
  });
  it('revalidates each Workspace attachment click and uses the shared URL-backed dialog', async () => {
    const target = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({}));
    const onError = vi.fn();
    const state = createConversationImageService(ref('node-1'), {
      fileAttachments: fileOptions(target, request, onError)
    });
    const file = {
      name: '原图 with spaces.png',
      mime: 'image/png',
      path: '.mar/temp-files/session/原图 with spaces.png'
    };
    try {
      await state.openFileAttachment(file);
      expect(state.previewOpen.value).toBe(true);
      expect(state.preview.value?.name).toBe(file.name);
      const url = new URL(state.preview.value!.url, 'http://localhost');
      expect(url.pathname).toBe('/api/workspaces/workspace-1/files/content');
      expect(url.searchParams.get('path')).toBe(file.path);
      expect(url.searchParams.get('nodeId')).toBe('node-1');
      expect(state.preview.value!.url).not.toMatch(/^blob:|^data:/u);
      request.mockRejectedValueOnce(new ApiError('FILE_NOT_FOUND', 'File not found.'));
      await state.openFileAttachment(file);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[0]?.[1]).toEqual({ cache: 'no-store' });
      expect(state.previewOpen.value).toBe(false);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'FILE_NOT_FOUND' }),
        file.path
      );
    } finally {
      state.dispose();
    }
  });

  it('does not let a late attachment read reopen a dialog after a Workspace switch', async () => {
    const target = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    let resolve!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const state = createConversationImageService(ref('node-1'), {
      fileAttachments: fileOptions(target, request, vi.fn())
    });
    try {
      const pending = state.openFileAttachment({
        name: 'photo.png',
        mime: 'image/png',
        path: '.mar/temp-files/session/photo.png'
      });
      target.value = { nodeId: 'node-2', workspaceId: 'workspace-2' };
      target.value = { nodeId: 'node-1', workspaceId: 'workspace-1' };
      resolve({});
      await pending;
      expect(state.previewOpen.value).toBe(false);
      expect(state.preview.value).toBeUndefined();
    } finally {
      state.dispose();
    }
  });

  it('reports a source removed during image loading without keeping a broken preview', async () => {
    const target = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({}));
    const onError = vi.fn();
    const state = createConversationImageService(ref('node-1'), {
      fileAttachments: fileOptions(target, request, onError)
    });
    const file = {
      name: 'photo.png',
      mime: 'image/png',
      path: '.mar/temp-files/session/photo.png'
    };
    try {
      await state.openFileAttachment(file);
      const url = state.preview.value!.url;
      request.mockRejectedValueOnce(new ApiError('FILE_NOT_FOUND', 'File not found.'));
      await state.previewFailed(url);
      expect(state.previewOpen.value).toBe(false);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'FILE_NOT_FOUND' }),
        file.path
      );
      await state.previewFailed(url);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      state.dispose();
    }
  });
  it('Preserves official user image references through protocol parsing into Web previews', () => {
    const item = conversationItemSchema.parse({
      id: 'user',
      sessionId: 'session',
      turnId: 'turn',
      runId: null,
      parentItemId: null,
      sourceSequence: 1,
      revision: 0,
      kind: 'user_message',
      status: 'COMPLETED',
      startedAt: 1,
      completedAt: 2,
      payload: {
        clientMessageId: null,
        text: '',
        contexts: [],
        delivery: 'ACCEPTED',
        attachments: [
          {
            name: 'image.png',
            mime: 'image/png',
            runId: 'native-history:session',
            imageRef: 'reader:session%3A1%3A0'
          },
          { name: 'unavailable', mime: 'image/unknown' }
        ]
      }
    });
    const state = createConversationImageService({ value: 'node-1' } as never);
    expect(state.attachments(item.runId, item.payload)).toEqual([
      {
        name: 'image.png',
        previewUrl:
          '/api/agent-runs/native-history%3Asession/images/reader%3Asession%253A1%253A0?nodeId=node-1'
      },
      { name: 'unavailable', previewUrl: undefined }
    ]);
  });

  it('Uses same-origin authenticated image URLs directly without creating extra Blob URLs', () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
    const state = createConversationImageService({ value: 'node-1' } as never);
    expect(
      state.attachments('run-1', {
        attachments: [{ name: 'image.png', mime: 'image/png', imageIndex: 0 }]
      })
    ).toEqual([
      {
        name: 'image.png',
        previewUrl: '/api/agent-runs/run-1/images/0?nodeId=node-1'
      }
    ]);
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('Falls back to a placeholder after image loading fails and allows reloading after the corresponding Turn is evicted', () => {
    const state = createConversationImageService({ value: 'node-1' } as never);
    const retainedSource = '/api/agent-runs/run-1/images/0?nodeId=node-1';
    state.markUnavailable(retainedSource);

    expect(
      state.attachments('run-1', {
        attachments: [{ name: 'image.png', mime: 'image/png', imageIndex: 0 }]
      })[0]?.previewUrl
    ).toBeUndefined();

    state.retain([
      {
        id: 'turn-1',
        sessionId: 'session-1',
        runId: 'run-1',
        status: 'COMPLETED',
        items: [
          {
            id: 'user-1',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: {
              attachments: [{ name: 'image.png', mime: 'image/png', imageIndex: 0 }]
            }
          }
        ]
      }
    ]);
    expect(state.unavailable.value).toEqual({ [retainedSource]: true });

    state.retain([]);

    expect(state.unavailable.value).toEqual({});
  });

  it('Lets Hosted Conversation inject a dedicated image source while preserving the shared placeholder behavior', () => {
    const conversationId = { value: 'conversation-1' };
    const supported = createConversationImageService({ value: 'node-1' } as never, {
      sourceUrl: ({ nodeId, runId, imageSelector }) =>
        `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/${encodeURIComponent(conversationId.value)}/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageSelector)}`
    });
    expect(
      supported.attachments(null, {
        attachments: [
          {
            name: 'generated.png',
            mime: 'image/png',
            runId: 'native-history:hosted:conversation-1',
            imageRef: 'file:session%3Agenerated.png'
          }
        ]
      })
    ).toEqual([
      {
        name: 'generated.png',
        previewUrl:
          '/api/nodes/node-1/hosted-conversations/conversation-1/runs/native-history%3Ahosted%3Aconversation-1/images/file%3Asession%253Agenerated.png'
      }
    ]);

    const unsupported = createConversationImageService({ value: 'node-1' } as never, {
      sourceUrl: () => undefined
    });
    expect(
      unsupported.attachments(null, {
        attachments: [
          {
            name: 'generated.png',
            mime: 'image/png',
            runId: 'native-history:hosted:conversation-1',
            imageRef: 'file:session%3Agenerated.png'
          }
        ]
      })[0]?.previewUrl
    ).toBeUndefined();
  });

  it('never guesses native indexes or falls back from a missing stable source', () => {
    const state = createConversationImageService({ value: 'node-1' } as never);
    expect(
      state.attachments('run-1', {
        attachments: [
          { name: 'old.png', mime: 'image/png', runId: 'native-history:session', imageIndex: 0 }
        ]
      })[0]?.previewUrl
    ).toBeUndefined();
    const payload = {
      attachments: [
        {
          name: 'fresh.png',
          mime: 'image/png',
          runId: 'native-history:session',
          imageRef: 'file:fresh.png'
        }
      ]
    };
    const url = state.attachments(null, payload)[0]!.previewUrl!;
    state.markUnavailable(url);
    state.retain([
      {
        id: 'turn',
        sessionId: 'session',
        runId: null,
        status: 'COMPLETED',
        items: [{ id: 'image', kind: 'tool_call', status: 'COMPLETED', payload }]
      }
    ]);
    expect(state.unavailable.value[url]).toBe(true);
    expect(state.attachments('run-1', payload)[0]?.previewUrl).toBeUndefined();
  });
});
