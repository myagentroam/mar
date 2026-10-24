import { ref } from 'vue';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';

class FakeXHR {
  static replies: Array<{ status: number; body: object }> = [];
  static sent: FakeXHR[] = [];
  withCredentials = false;
  headers: Record<string, string> = {};
  url = '';
  status = 0;
  responseText = '';
  upload = { onprogress: undefined as unknown };
  onload?: () => void;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send() {
    FakeXHR.sent.push(this);
    const response = FakeXHR.replies.shift();
    if (response === undefined) throw new Error('Unexpected upload attempt');
    this.status = response.status;
    this.responseText = JSON.stringify(response.body);
    queueMicrotask(() => this.onload?.());
  }
}

function fixture() {
  FakeXHR.sent = [];
  FakeXHR.replies = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  const csrfToken = ref('old-csrf');
  const request = vi.fn(async (path: string) =>
    path.endsWith('/uploads')
      ? { upload: { uploadId: 'upload-1', receivedBytes: 0, size: 4 } }
      : undefined
  );
  const renewCsrfToken = vi.fn(async () => {
    csrfToken.value = 'new-csrf';
    return csrfToken.value;
  });
  const onUnauthenticated = vi.fn();
  const service = createComposerAttachmentService({
    context: () => ({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
    notice: vi.fn(),
    request: request as never,
    csrfToken,
    renewCsrfToken,
    onUnauthenticated
  });
  return { service, request, renewCsrfToken, onUnauthenticated };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Public Composer Attachment Upload', () => {
  it('includes the shared full-file checksum on the existing Composer direct path', async () => {
    const directUpload = vi.fn(async () => undefined);
    const request = vi.fn();
    const service = createComposerAttachmentService({
      context: () => ({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      notice: vi.fn(),
      request,
      csrfToken: ref('token'),
      renewCsrfToken: async () => 'token',
      onUnauthenticated: vi.fn(),
      direct: { generation: () => 'generation-1', upload: directUpload }
    });
    service.add([new File(['text'], 'note.txt')]);
    await vi.waitFor(() => expect(service.attachments.value[0]?.status).toBe('COMPLETED'));
    expect(directUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: expect.objectContaining({
          sha256: createHash('sha256').update('text').digest('hex'),
          composerAttachment: expect.objectContaining({ id: service.attachments.value[0]!.id })
        })
      })
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('does not start direct transfer after removal while hashing', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32));
    let finishHash!: (value: ArrayBuffer) => void;
    const file = new File(['text'], 'note.txt');
    vi.spyOn(file, 'arrayBuffer').mockImplementation(
      () => new Promise((resolve) => (finishHash = resolve))
    );
    const directUpload = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({}));
    const service = createComposerAttachmentService({
      context: () => ({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      notice: vi.fn(),
      request: request as never,
      csrfToken: ref('token'),
      renewCsrfToken: async () => 'token',
      onUnauthenticated: vi.fn(),
      direct: { generation: () => 'generation-1', upload: directUpload }
    });
    service.add([file]);
    service.remove(service.attachments.value[0]!.id);
    finishHash(new TextEncoder().encode('text').buffer);
    await new Promise((resolve) => setImmediate(resolve));
    expect(directUpload).not.toHaveBeenCalled();
  });

  it('Renews CSRF only once, retries with the same offset, completes the upload, and deletes by attachment identity', async () => {
    const f = fixture();
    FakeXHR.replies = [
      { status: 403, body: { error: { code: 'CSRF_INVALID' } } },
      { status: 200, body: { upload: { receivedBytes: 4 } } }
    ];
    f.service.add([new File(['text'], 'note.txt', { type: 'text/plain' })]);
    await vi.waitFor(() => expect(f.service.attachments.value[0]?.status).toBe('COMPLETED'));
    expect(f.renewCsrfToken).toHaveBeenCalledOnce();
    expect(FakeXHR.sent.map((xhr) => xhr.headers['x-csrf-token'])).toEqual([
      'old-csrf',
      'new-csrf'
    ]);
    expect(FakeXHR.sent.every((xhr) => xhr.withCredentials && xhr.url.endsWith('offset=0'))).toBe(
      true
    );
    expect(f.request).toHaveBeenCalledWith(
      '/api/workspaces/workspace-1/uploads/upload-1/complete',
      expect.objectContaining({ method: 'POST' })
    );
    const id = f.service.attachments.value[0]!.id;
    f.service.remove(id);
    expect(f.service.attachments.value).toEqual([]);
    expect(f.request).toHaveBeenCalledWith(
      `/api/workspaces/workspace-1/uploads/${id}/cancel`,
      expect.objectContaining({ body: JSON.stringify({ nodeId: 'node-1' }) })
    );
  });

  it('Deletes an attachment before package creation, immediately cancels a late upload, and sends no chunks', async () => {
    const f = fixture();
    let finish!: (value: {
      upload: { uploadId: string; receivedBytes: number; size: number };
    }) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    f.service.add([new File(['text'], 'note.txt', { type: 'text/plain' })]);
    f.service.remove(f.service.attachments.value[0]!.id);
    finish({ upload: { uploadId: 'late-upload', receivedBytes: 0, size: 4 } });
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith(
        '/api/workspaces/workspace-1/uploads/late-upload/cancel',
        expect.anything()
      )
    );
    expect(FakeXHR.sent).toEqual([]);
    expect(f.service.attachments.value).toEqual([]);
  });

  it('Notifies the authentication entry point on session expiration, does not retry chunks, and removes failed attachments after a delay', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout });
    const f = fixture();
    FakeXHR.replies = [{ status: 401, body: { error: { code: 'UNAUTHENTICATED' } } }];
    f.service.add([new File(['text'], 'note.txt', { type: 'text/plain' })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onUnauthenticated).toHaveBeenCalledOnce();
    expect(FakeXHR.sent).toHaveLength(1);
    expect(f.renewCsrfToken).not.toHaveBeenCalled();
    expect(f.service.attachments.value[0]?.status).toBe('FAILED');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.service.attachments.value).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
