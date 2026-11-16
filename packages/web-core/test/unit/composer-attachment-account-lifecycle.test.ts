import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';

vi.mock('../../src/util/workspace-file-checksum.js', () => ({
  workspaceFileSha256: vi.fn(async () => 'file-checksum')
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(
  request = vi.fn(async () => ({ upload: { uploadId: 'upload', receivedBytes: 0, size: 0 } }))
) {
  const context = { kind: 'workspace' as const, nodeId: 'node', workspaceId: 'workspace' };
  const renewCsrfToken = vi.fn(async () => 'new-csrf');
  const onUnauthenticated = vi.fn();
  const notice = vi.fn();
  const service = createComposerAttachmentService({
    context: () => context,
    request: request as Parameters<typeof createComposerAttachmentService>[0]['request'],
    csrfToken: ref('csrf'),
    renewCsrfToken,
    onUnauthenticated,
    notice
  });
  return { service, request, renewCsrfToken, onUnauthenticated, notice };
}

describe('Composer account lifetime', () => {
  it('aborts relay transport, releases previews and ignores late authorization errors on account end', async () => {
    const requests: FakeChunk[] = [];
    class FakeChunk {
      upload = {};
      status = 403;
      responseText = JSON.stringify({ code: 'CSRF_INVALID' });
      onload?: () => void;
      onabort?: () => void;
      open() {}
      setRequestHeader() {}
      send() {
        requests.push(this);
      }
      abort = vi.fn(() => this.onabort?.());
    }
    vi.stubGlobal('XMLHttpRequest', FakeChunk);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:old-account');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const f = fixture();
    f.service.add([new File(['image'], 'old.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    f.service.openPreview(f.service.attachments.value[0]!);
    f.service.dragging.value = true;
    f.service.clearAll();
    expect(requests[0]!.abort).toHaveBeenCalledOnce();
    expect(revoked).toHaveBeenCalledWith('blob:old-account');
    expect(f.service.previewOpen.value).toBe(false);
    expect(f.service.preview.value).toBeUndefined();
    expect(f.service.dragging.value).toBe(false);
    requests[0]!.onload?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.service.attachments.value).toEqual([]);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.renewCsrfToken).not.toHaveBeenCalled();
    expect(f.onUnauthenticated).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
  });

  it('does not cancel a late old-account create under the new account and remains reusable', async () => {
    let release!: (value: {
      upload: { uploadId: string; receivedBytes: number; size: number };
    }) => void;
    const oldCreate = new Promise<{
      upload: { uploadId: string; receivedBytes: number; size: number };
    }>((resolve) => {
      release = resolve;
    });
    const request = vi
      .fn(async () => ({ upload: { uploadId: 'new-upload', receivedBytes: 1, size: 1 } }))
      .mockImplementationOnce(() => oldCreate);
    const f = fixture(request);
    f.service.add([new File(['x'], 'old.txt')]);
    expect(request).toHaveBeenCalledOnce();
    f.service.clearAll();
    f.service.add([new File(['x'], 'new.txt')]);
    await vi.waitFor(() => expect(f.service.attachments.value[0]?.status).toBe('COMPLETED'));
    release({ upload: { uploadId: 'old-upload', receivedBytes: 0, size: 0 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.service.attachments.value.map((item) => item.file.name)).toEqual(['new.txt']);
    expect(request).toHaveBeenCalledTimes(3);
    expect(f.onUnauthenticated).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
    f.service.clearAll();
  });
});
