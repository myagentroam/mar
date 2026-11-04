import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';
import { createComposerAttachmentDragTracker } from '../../src/service/composer-attachment-drag-tracker.js';

function file(name: string, size: number, type = 'text/plain'): File {
  return { name, size, type } as File;
}

describe('Web Composer Attachment State', () => {
  it('projects two simultaneous targets from one upload owner without reuploading on pane handoff', async () => {
    const a = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'a' };
    const b = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
    const uploads: Array<() => void> = [];
    const upload = vi.fn(() => new Promise<void>((resolve) => uploads.push(resolve)));
    const owner = createComposerAttachmentService({
      context: () => a,
      notice: vi.fn(),
      request: vi.fn().mockResolvedValue(undefined),
      csrfToken: ref('csrf'),
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn(),
      direct: { generation: () => 'generation', upload }
    });
    const main = owner.forTarget(() => a);
    const aside = owner.forTarget(() => b);
    main.add([new File(['a'], 'a.txt')]);
    aside.add([new File(['b'], 'b.txt')]);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(main.attachments.value.map((item) => item.file.name)).toEqual(['a.txt']);
    expect(aside.attachments.value.map((item) => item.file.name)).toEqual(['b.txt']);
    uploads.forEach((finish) => finish());
    await vi.waitFor(() => expect(aside.attachments.value[0]?.status).toBe('COMPLETED'));
    const moved = owner.forTarget(() => b);
    expect(moved.attachments.value[0]?.id).toBe(aside.attachments.value[0]?.id);
    expect(upload).toHaveBeenCalledTimes(2);
    main.clear();
    expect(aside.attachments.value).toHaveLength(1);
    owner.clearAll();
  });
  it('keeps a late upload with its original Session and transfers only the created draft target', async () => {
    const workspace = { kind: 'workspace' as const, nodeId: 'node-1', workspaceId: 'workspace-1' };
    const a = {
      kind: 'session' as const,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'a'
    };
    const b = {
      kind: 'session' as const,
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'b'
    };
    const target = ref<import('../../src/service/session-draft-service.js').DraftTarget>(a);
    let finish!: () => void;
    const upload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const state = createComposerAttachmentService({
      context: () => target.value,
      notice: vi.fn(),
      request: vi.fn().mockResolvedValue(undefined),
      csrfToken: ref('csrf'),
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn(),
      direct: { generation: () => 'generation', upload }
    });
    state.add([new File(['text'], 'a.txt')]);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    target.value = b;
    expect(state.attachments.value).toEqual([]);
    finish();
    target.value = a;
    await vi.waitFor(() => expect(state.attachments.value[0]?.status).toBe('COMPLETED'));
    target.value = workspace;
    state.add([new File(['other'], 'new.txt')]);
    const draft = state.attachments.value[0]!;
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    state.moveDraft(workspace, b);
    expect(state.attachments.value).toEqual([]);
    target.value = b;
    expect(state.attachments.value.map((attachment) => attachment.id)).toEqual([draft.id]);
    finish();
    await vi.waitFor(() => expect(state.attachments.value[0]?.status).toBe('COMPLETED'));
    target.value = a;
    expect(state.attachments.value.map((attachment) => attachment.file.name)).toEqual(['a.txt']);
    state.clearAll();
  });
  it.each(['remove', 'clear', 'clearAll'] as const)(
    '%s only changes the next draft while an overlapping submission still owns the attachment',
    (operation) => {
      const request = vi.fn(() => new Promise<never>(() => undefined));
      const state = createComposerAttachmentService({
        context: () => ({ kind: 'workspace', nodeId: 'node-1', workspaceId: 'workspace-1' }),
        notice: vi.fn(),
        request,
        csrfToken: ref('csrf'),
        renewCsrfToken: vi.fn(),
        onUnauthenticated: vi.fn()
      });
      state.add([file('sent.txt', 3)]);
      const sent = state.attachments.value[0]!;
      sent.status = 'COMPLETED';
      const first = state.retainForSubmission([sent]);
      const retry = state.retainForSubmission([sent]);
      first();
      first();
      if (operation === 'remove') state.remove(sent.id);
      else state[operation]();
      expect(state.attachments.value).toEqual([]);
      expect(request).toHaveBeenCalledTimes(1);
      retry();
      expect(request).toHaveBeenCalledTimes(1);
    }
  );

  it('allows cancelling an unsent attachment after its submission releases it', () => {
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const state = createComposerAttachmentService({
      context: () => ({ kind: 'workspace', nodeId: 'node-1', workspaceId: 'workspace-1' }),
      notice: vi.fn(),
      request,
      csrfToken: ref('csrf'),
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn()
    });
    state.add([file('sent.txt', 3)]);
    const sent = state.attachments.value[0]!;
    sent.status = 'COMPLETED';
    state.retainForSubmission([sent])();
    state.remove(sent.id);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('consumes only the submitted identities across workspace switches without cancelling owned files', () => {
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const workspaceId = ref('workspace-1');
    const state = createComposerAttachmentService({
      context: () => ({ kind: 'workspace', nodeId: 'node-1', workspaceId: workspaceId.value }),
      notice: vi.fn(),
      request,
      csrfToken: ref('csrf'),
      renewCsrfToken: vi.fn(),
      onUnauthenticated: vi.fn()
    });
    state.add([file('sent.txt', 3)]);
    const sent = state.attachments.value[0]!;
    sent.status = 'COMPLETED';
    state.add([file('next.txt', 3)]);
    const next = state.attachments.value[1]!;
    state.openPreview(sent);
    workspaceId.value = 'workspace-2';
    state.add([file('other.txt', 3)]);
    const other = state.attachments.value[0]!;
    state.consume([sent]);
    state.consume([sent]);
    expect(state.previewOpen.value).toBe(false);
    expect(state.attachments.value).toEqual([other]);
    workspaceId.value = 'workspace-1';
    expect(state.attachments.value).toEqual([next]);
    expect(request).toHaveBeenCalledTimes(3);
  });

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
      context: () => ({ kind: 'workspace', nodeId: 'node-1', workspaceId: 'workspace-1' }),
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
    expect(notice).toHaveBeenCalledWith(
      'Select an online workspace before adding attachments.',
      'warning'
    );
  });

  it('Hides attachments when switching Workspaces, restores them on return, and leaves the original upload running', () => {
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const workspaceId = ref('workspace-1');
    const state = createComposerAttachmentService({
      context: () => ({ kind: 'workspace', nodeId: 'node-1', workspaceId: workspaceId.value }),
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
