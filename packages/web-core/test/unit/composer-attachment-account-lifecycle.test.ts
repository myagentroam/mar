import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';

vi.mock('../../src/util/workspace-file-checksum.js', () => ({
  workspaceFileSha256: vi.fn(async () => 'file-checksum')
}));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const sendBody = vi.fn<Parameters<typeof createComposerAttachmentService>[0]['sendBody']>(
    async () => undefined
  );
  const request = vi.fn();
  const notice = vi.fn();
  const service = createComposerAttachmentService({
    context: () => ({ kind: 'workspace', nodeId: 'node', workspaceId: 'workspace' }),
    request,
    sendBody,
    notice
  });
  return { service, request, sendBody, notice };
}

describe('Composer account lifetime', () => {
  it('aborts the upload stream, releases the preview and ignores a late authorization failure', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:old-account');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const f = fixture();
    const old = Promise.withResolvers<void>();
    f.sendBody.mockReturnValueOnce(old.promise);
    f.service.add([new File(['image'], 'old.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(f.sendBody).toHaveBeenCalledOnce());
    f.service.openPreview(f.service.attachments.value[0]!);
    f.service.dragging.value = true;
    f.service.clearAll();
    expect(f.sendBody.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(revoked).toHaveBeenCalledWith('blob:old-account');
    expect(f.service.previewOpen.value).toBe(false);
    expect(f.service.preview.value).toBeUndefined();
    expect(f.service.dragging.value).toBe(false);
    old.reject(new Error('UNAUTHENTICATED'));
    await Promise.resolve();
    expect(f.service.attachments.value).toEqual([]);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
  });

  it('does not cancel an old account attachment under the new account after a late completion', async () => {
    const f = fixture();
    const old = Promise.withResolvers<void>();
    f.sendBody.mockReturnValueOnce(old.promise);
    f.service.add([new File(['x'], 'old.txt')]);
    await vi.waitFor(() => expect(f.sendBody).toHaveBeenCalledOnce());
    f.service.clearAll();
    f.service.add([new File(['x'], 'new.txt')]);
    await vi.waitFor(() => expect(f.service.attachments.value[0]?.status).toBe('COMPLETED'));
    old.resolve();
    await Promise.resolve();
    expect(f.service.attachments.value.map((item) => item.file.name)).toEqual(['new.txt']);
    expect(f.sendBody).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
    f.service.clearAll();
  });
});
