import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';
import * as imageCompatibility from '../../src/util/composer-image-compatibility.js';

function fixture() {
  const request = vi.fn(async () => undefined);
  const sendBody = vi.fn<Parameters<typeof createComposerAttachmentService>[0]['sendBody']>(
    async () => undefined
  );
  const service = createComposerAttachmentService({
    context: () => ({ kind: 'workspace', nodeId: 'node-1', workspaceId: 'workspace-1' }),
    notice: vi.fn(),
    request: request as never,
    sendBody
  });
  return { service, request, sendBody };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Public Composer Attachment Upload', () => {
  it('uploads converted PNG metadata and retains the converted file for submission', async () => {
    const png = new File(['png!'], 'scope.png', { type: 'image/png' });
    vi.spyOn(imageCompatibility, 'normalizeComposerImage').mockResolvedValue(png);
    const f = fixture();
    f.service.add([new File(['bmp'], 'scope.bmp', { type: 'image/bmp' })]);
    await vi.waitFor(() => expect(f.service.attachments.value[0]?.status).toBe('COMPLETED'));
    expect(f.sendBody.mock.calls[0]?.[0].descriptor).toMatchObject({
      fileName: 'scope.png',
      size: 4,
      composerAttachment: { mime: 'image/png' }
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.service.attachments.value[0]?.file).toBe(png);
  });

  it('does not upload a removed BMP after conversion finishes', async () => {
    let finish!: (file: File) => void;
    vi.spyOn(imageCompatibility, 'normalizeComposerImage').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const f = fixture();
    f.service.add([new File(['bmp'], 'scope.bmp', { type: 'image/bmp' })]);
    await f.service.remove(f.service.attachments.value[0]!.id);
    finish(new File(['png'], 'scope.png', { type: 'image/png' }));
    await Promise.resolve();
    expect(f.sendBody).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it('blocks upload when converted PNG would exceed the message total', async () => {
    vi.stubGlobal('window', { setTimeout: vi.fn() });
    vi.spyOn(imageCompatibility, 'normalizeComposerImage').mockResolvedValue(
      new File([new Uint8Array(5 * 1024 * 1024)], 'scope.png', { type: 'image/png' })
    );
    const f = fixture();
    const sibling = new File([new Uint8Array(3 * 1024 * 1024)], 'a.txt');
    f.service.add([sibling, sibling, new File(['bmp'], 'scope.bmp', { type: 'image/bmp' })]);
    await vi.waitFor(() => expect(f.service.attachments.value[2]?.status).toBe('FAILED'));
    await vi.waitFor(() => expect(f.sendBody).toHaveBeenCalledTimes(2));
    expect(f.request).not.toHaveBeenCalled();
    expect(f.service.attachments.value[2]?.error).toContain('BMP');
  });

  it('includes the shared full-file checksum in the Composer upload stream', async () => {
    const sendBody = vi.fn(async () => undefined);
    const request = vi.fn();
    const service = createComposerAttachmentService({
      context: () => ({ kind: 'workspace', nodeId: 'node-1', workspaceId: 'workspace-1' }),
      notice: vi.fn(),
      request,

      sendBody
    });
    service.add([new File(['text'], 'note.txt')]);
    await vi.waitFor(() => expect(service.attachments.value[0]?.status).toBe('COMPLETED'));
    expect(sendBody).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: expect.objectContaining({
          sha256: createHash('sha256').update('text').digest('hex'),
          composerAttachment: expect.objectContaining({ id: service.attachments.value[0]!.id })
        })
      })
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('does not open an upload stream after removal while hashing', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32));
    let finishHash!: (value: ArrayBuffer) => void;
    const file = new File(['text'], 'note.txt');
    vi.spyOn(file, 'arrayBuffer').mockImplementation(
      () => new Promise((resolve) => (finishHash = resolve))
    );
    const sendBody = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({}));
    const service = createComposerAttachmentService({
      context: () => ({ kind: 'workspace', nodeId: 'node-1', workspaceId: 'workspace-1' }),
      notice: vi.fn(),
      request: request as never,

      sendBody
    });
    service.add([file]);
    service.remove(service.attachments.value[0]!.id);
    finishHash(new TextEncoder().encode('text').buffer);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendBody).not.toHaveBeenCalled();
  });

  it('deletes a completed streaming upload by attachment identity', async () => {
    const f = fixture();
    f.service.add([new File(['text'], 'note.txt')]);
    await vi.waitFor(() => expect(f.service.attachments.value[0]?.status).toBe('COMPLETED'));
    expect(f.request).not.toHaveBeenCalled();
    const id = f.service.attachments.value[0]!.id;
    f.service.remove(id);
    expect(f.service.attachments.value).toEqual([]);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      `/api/workspaces/workspace-1/uploads/${id}/cancel`,
      expect.objectContaining({ body: JSON.stringify({ nodeId: 'node-1' }) })
    );
  });

  it('aborts an in-flight upload and cleans up a late successful completion by attachment ID', async () => {
    const f = fixture();
    const complete = Promise.withResolvers<void>();
    f.sendBody.mockReturnValueOnce(complete.promise);
    f.service.add([new File(['text'], 'note.txt')]);
    await vi.waitFor(() => expect(f.sendBody).toHaveBeenCalledOnce());
    const id = f.service.attachments.value[0]!.id;
    f.service.remove(id);
    expect(f.sendBody.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
    complete.resolve();
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        `/api/workspaces/workspace-1/uploads/${id}/cancel`,
        expect.anything()
      )
    );
    expect(f.service.attachments.value).toEqual([]);
  });

  it('does not retry or fall back on an authentication failure and removes the failed attachment', async () => {
    vi.stubGlobal('window', { setTimeout: vi.fn() });
    const f = fixture();
    f.sendBody.mockRejectedValueOnce(new Error('UNAUTHENTICATED'));
    f.service.add([new File(['text'], 'note.txt')]);
    await vi.waitFor(() => expect(f.service.attachments.value[0]?.status).toBe('FAILED'));
    expect(f.sendBody).toHaveBeenCalledOnce();
    expect(f.request).not.toHaveBeenCalled();
    expect(window.setTimeout).toHaveBeenCalledOnce();
    const [cleanup, delay] = vi.mocked(window.setTimeout).mock.calls[0]!;
    expect(delay).toBe(1000);
    (cleanup as () => void)();
    expect(f.service.attachments.value).toEqual([]);
  });
});
