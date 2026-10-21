import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createComposerAttachmentService } from '../../src/service/ComposerAttachmentService.js';
import { createComposerAttachmentDragTracker } from '../../src/service/ComposerAttachmentDragTracker.js';

function file(name: string, size: number, type = 'text/plain'): File {
  return { name, size, type } as File;
}

describe('Web Composer Attachment State', () => {
  it('Keeps the attachment highlighted when dragging into a Composer sub-area and clears the highlight after the drop completes', () => {
    let dragging = false;
    const state = createComposerAttachmentDragTracker((value) => (dragging = value));

    state.enter();
    state.enter();
    state.leave();
    expect(dragging).toBe(true);

    state.reset();
    expect(dragging).toBe(false);
    state.leave();
    expect(dragging).toBe(false);
  });

  it('Creates attachments and starts uploads in a valid Workspace', () => {
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const state = createComposerAttachmentService({
      context: () => ({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      notice: vi.fn(),
      request,
      csrfToken: { value: 'csrf' } as never,
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn()
    });

    state.add([file('note.txt', 128)]);
    expect(state.attachments.value).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      '/api/workspaces/workspace-1/uploads',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('Rejects attachments without a Workspace and does not start an upload', () => {
    const notice = vi.fn();
    const request = vi.fn();
    const state = createComposerAttachmentService({
      context: () => undefined,
      notice,
      request,
      csrfToken: { value: 'csrf' } as never,
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn()
    });

    state.add([file('note.txt', 128)]);
    expect(state.attachments.value).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('Select an online workspace before adding attachments.');
  });

  it('Hides attachments when switching Workspaces, restores them on return, and leaves the original upload running', () => {
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const workspaceId = ref('workspace-1');
    const state = createComposerAttachmentService({
      context: () => ({ nodeId: 'node-1', workspaceId: workspaceId.value }),
      notice: vi.fn(),
      request,
      csrfToken: { value: 'csrf' } as never,
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn()
    });

    state.add([file('attachment.txt', 128)]);
    workspaceId.value = 'workspace-2';
    expect(state.attachments.value).toHaveLength(0);
    workspaceId.value = 'workspace-1';
    expect(state.attachments.value).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
