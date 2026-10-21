import { createHash, randomUUID } from 'node:crypto';
import * as workspaceFiles from '../../src/workspace.js';
import * as uploadFiles from 'node:fs/promises';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeAgentSession, NodeWorkspace } from '../../src/database.js';
import { RunAttachmentService } from '../../src/service/run-attachment-service.js';
import { SessionContextService } from '../../src/service/session-context-service.js';
import { WorkspaceDomainState } from '../../src/service/workspace-domain-state.js';
import { WorkspaceUploadService } from '../../src/service/workspace-upload-service.js';
import { WorkspaceFileService } from '../../src/service/workspace-file-service.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>())
}));

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node process cache cleanup', () => {
  it('reports cleanup failures without forgetting its cancelled upload or keeping its handle open', async () => {
    const root = await temporaryDirectory();
    const state = new WorkspaceDomainState();
    const service = new WorkspaceUploadService(
      state,
      () => undefined,
      () => root
    );
    const workspace = { id: 'workspace-cleanup-error', path: root } as NodeWorkspace;
    const upload = await service.createDirect(workspace, {
      path: 'file.bin',
      size: 0,
      overwrite: false,
      sha256: createHash('sha256').digest('hex')
    });
    const record = state.uploads.get(upload.uploadId)!;
    const close = vi.spyOn(record.handle, 'close');
    const remove = vi.spyOn(uploadFiles, 'rm').mockRejectedValueOnce(new Error('cleanup denied'));
    try {
      await expect(service.cancel(upload.uploadId)).rejects.toThrow('cleanup denied');
      expect(close).toHaveBeenCalledOnce();
      expect(state.uploads.get(upload.uploadId)).toBe(record);
      expect(() => service.status(upload.uploadId)).toThrow('UPLOAD_NOT_FOUND');
    } finally {
      remove.mockRestore();
      await service.cancel(upload.uploadId);
      await service.shutdown();
    }
  });

  it('validates the final target and staging size before publishing an upload', async () => {
    const root = await temporaryDirectory();
    const state = new WorkspaceDomainState();
    const service = new WorkspaceUploadService(
      state,
      () => undefined,
      () => root
    );
    const workspace = { id: 'workspace-validation', path: root } as NodeWorkspace;
    const payload = Buffer.from('new');
    const input = {
      path: 'file.bin',
      size: 3,
      overwrite: true,
      sha256: createHash('sha256').update(payload).digest('hex')
    };
    const target = join(root, 'file.bin');
    await writeFile(target, 'old');
    try {
      const upload = await service.createDirect(workspace, input);
      await service.writeDirect(upload.uploadId, payload);
      const record = state.uploads.get(upload.uploadId)!;
      await writeFile(record.temporaryPath, 'changed size');
      await expect(service.complete(upload.uploadId)).rejects.toThrow('UPLOAD_STAGING_INVALID');
      expect(await readFile(target, 'utf8')).toBe('old');
      await service.cancel(upload.uploadId);

      const next = await service.createDirect(workspace, input);
      await service.writeDirect(next.uploadId, payload);
      const preflight = vi.spyOn(workspaceFiles, 'preflightWorkspaceUpload').mockResolvedValue({
        path: 'different.bin',
        absolutePath: join(root, 'different.bin'),
        status: 'READY'
      });
      await expect(service.completeDirect(next.uploadId, 3)).rejects.toThrow(
        'UPLOAD_TARGET_INVALID'
      );
      preflight.mockRestore();
      expect(await readFile(target, 'utf8')).toBe('old');
    } finally {
      vi.restoreAllMocks();
      await service.shutdown();
    }
  });

  it.each(['complete', 'cancel'])(
    'handles attachment %s and relay retry without reading OS file identity',
    async (operation) => {
      const root = await temporaryDirectory();
      const state = new WorkspaceDomainState();
      const service = new WorkspaceUploadService(
        state,
        () => undefined,
        () => root
      );
      const workspace = { id: 'workspace-attachment-upload', path: root } as NodeWorkspace;
      const id = randomUUID();
      const payload = Buffer.from('attachment bytes');
      const originalLstat = uploadFiles.lstat;
      const metadata = vi.spyOn(uploadFiles, 'lstat').mockImplementation(async (...args) => {
        const value = await originalLstat(...args);
        const rejectIdentityRead = () => {
          throw new Error('OS file identity must not be read');
        };
        Object.defineProperties(value, {
          dev: { get: rejectIdentityRead },
          ino: { get: rejectIdentityRead }
        });
        return value;
      });
      const input = {
        name: 'file.txt',
        size: payload.length,
        overwrite: false,
        composerAttachmentId: id,
        mime: 'text/plain'
      };
      try {
        const upload = await service.createDirect(workspace, {
          path: input.name,
          size: input.size,
          overwrite: false,
          sha256: createHash('sha256').update(payload).digest('hex'),
          composerAttachment: { id, mime: input.mime }
        });
        await service.writeDirect(upload.uploadId, payload);
        if (operation === 'complete') {
          await service.completeDirect(upload.uploadId, payload.length);
          expect(await readFile(join(root, id, input.name))).toEqual(payload);
          await service.cancel(id);
        } else {
          await service.cancel(upload.uploadId);
        }
        expect(state.uploads.size).toBe(0);
        expect(state.composerAttachments.size).toBe(0);
        await expect(access(join(root, id))).rejects.toThrow();

        const retry = await service.create(workspace, input);
        await service.write({
          uploadId: retry.uploadId,
          offset: 0,
          dataBase64: payload.toString('base64')
        });
        await service.complete(retry.uploadId);
        expect(await readFile(join(root, id, input.name))).toEqual(payload);
      } finally {
        metadata.mockRestore();
        await service.shutdown();
      }
    }
  );

  it('does not replace a newly existing target when overwrite is not authorized', async () => {
    const root = await temporaryDirectory();
    const service = new WorkspaceUploadService(
      new WorkspaceDomainState(),
      () => undefined,
      () => root
    );
    const workspace = { id: 'workspace-no-replace', path: root } as NodeWorkspace;
    try {
      const upload = await service.createDirect(workspace, {
        path: 'file.bin',
        size: 0,
        overwrite: false,
        sha256: createHash('sha256').digest('hex')
      });
      await writeFile(join(root, 'file.bin'), 'existing');
      const preflight = vi.spyOn(workspaceFiles, 'preflightWorkspaceUpload').mockResolvedValue({
        path: 'file.bin',
        absolutePath: join(root, 'file.bin'),
        status: 'READY'
      });
      await expect(service.completeDirect(upload.uploadId, 0)).rejects.toThrow(
        'UPLOAD_TARGET_EXISTS'
      );
      preflight.mockRestore();
      expect(await readFile(join(root, 'file.bin'), 'utf8')).toBe('existing');
    } finally {
      vi.restoreAllMocks();
      await service.shutdown();
    }
  });

  it('leaves the target unchanged when completion authorization has been cancelled', async () => {
    const root = await temporaryDirectory();
    const service = new WorkspaceUploadService(
      new WorkspaceDomainState(),
      () => undefined,
      () => root
    );
    const workspace = { id: 'workspace-aborted', path: root } as NodeWorkspace;
    await writeFile(join(root, 'file.bin'), 'old');
    try {
      const upload = await service.createDirect(workspace, {
        path: 'file.bin',
        size: 0,
        overwrite: true,
        sha256: createHash('sha256').digest('hex')
      });
      await expect(service.completeDirect(upload.uploadId, 0, AbortSignal.abort())).rejects.toThrow(
        'UPLOAD_CANCELLED'
      );
      expect(await readFile(join(root, 'file.bin'), 'utf8')).toBe('old');
    } finally {
      await service.shutdown();
    }
  });

  it('rejects overlapping direct chunks instead of advancing the same offset twice', async () => {
    const root = await temporaryDirectory();
    const service = new WorkspaceUploadService(
      new WorkspaceDomainState(),
      () => undefined,
      () => join(root, 'temp-files')
    );
    const workspace = { id: 'workspace-overlap', path: root } as NodeWorkspace;
    try {
      const upload = await service.createDirect(workspace, {
        path: 'file.bin',
        size: 3,
        overwrite: false,
        sha256: createHash('sha256').update('new').digest('hex')
      });
      const first = service.writeDirect(upload.uploadId, Buffer.from('n'));
      await expect(service.writeDirect(upload.uploadId, Buffer.from('n'))).rejects.toThrow(
        'UPLOAD_OFFSET_INVALID'
      );
      await first;
      expect(service.status(upload.uploadId).receivedBytes).toBe(1);
      await service.writeDirect(upload.uploadId, Buffer.from('ew'));
      await service.completeDirect(upload.uploadId, 3);
      expect(await readFile(join(root, 'file.bin'), 'utf8')).toBe('new');
    } finally {
      await service.shutdown();
    }
  });

  it.each(['cancel', 'expiry', 'shutdown'])(
    'cleans direct-upload staging on %s without replacing its target',
    async (reason) => {
      vi.useFakeTimers();
      const root = await temporaryDirectory();
      const state = new WorkspaceDomainState();
      const service = new WorkspaceUploadService(
        state,
        () => undefined,
        () => join(root, 'temp-files')
      );
      const workspace = { id: 'workspace-cleanup', path: root } as NodeWorkspace;
      const target = join(root, 'target.bin');
      await writeFile(target, 'old target');
      try {
        const upload = await service.createDirect(workspace, {
          path: 'target.bin',
          size: 3,
          overwrite: true,
          sha256: createHash('sha256').update('new').digest('hex')
        });
        await service.writeDirect(upload.uploadId, Buffer.from('n'));
        const temporary = state.uploads.get(upload.uploadId)!.temporaryPath;
        if (reason === 'cancel') await service.cancel(upload.uploadId);
        else if (reason === 'shutdown') await service.shutdown();
        else await vi.advanceTimersByTimeAsync(60 * 60_000);
        vi.useRealTimers();
        await vi.waitFor(() => expect(state.uploads.size).toBe(0));
        await vi.waitFor(async () => {
          await expect(access(temporary)).rejects.toThrow();
        });
        expect(await readFile(target, 'utf8')).toBe('old target');
      } finally {
        await service.shutdown();
      }
    }
  );

  it('rechecks path and overwrite authorization before resuming staging', async () => {
    const root = await temporaryDirectory();
    const state = new WorkspaceDomainState();
    const service = new WorkspaceUploadService(
      state,
      () => undefined,
      () => join(root, 'temp-files')
    );
    const workspace = { id: 'workspace-path', path: root } as NodeWorkspace;
    const target = join(root, 'target.bin');
    const input = {
      path: 'target.bin',
      size: 3,
      overwrite: false,
      sha256: createHash('sha256').update('new').digest('hex')
    };
    try {
      const upload = await service.createDirect(workspace, input);
      await expect(service.createDirect(workspace, { ...input, overwrite: true })).rejects.toThrow(
        'UPLOAD_TARGET_BUSY'
      );
      await writeFile(target, 'arrived later');
      await expect(service.createDirect(workspace, input)).rejects.toThrow('UPLOAD_TARGET_INVALID');
      await rm(target);
      const outside = join(root, 'other.bin');
      await writeFile(outside, 'other target');
      await symlink(outside, target);
      await expect(service.createDirect(workspace, input)).rejects.toThrow();
      expect(service.status(upload.uploadId).receivedBytes).toBe(0);
      expect(await readFile(outside, 'utf8')).toBe('other target');
    } finally {
      await service.shutdown();
    }
  });

  it('resumes a matching direct upload at its Node offset and rejects mixed content without replacing the target', async () => {
    const root = await temporaryDirectory();
    const workspace = { id: 'workspace-1', path: root } as NodeWorkspace;
    const target = join(root, 'file.bin');
    await writeFile(target, 'original');
    const state = new WorkspaceDomainState();
    const service = new WorkspaceUploadService(
      state,
      () => undefined,
      () => join(root, 'node-data', 'temp-files')
    );
    const payload = Buffer.from('correct');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const input = { path: 'file.bin', size: payload.length, sha256, overwrite: true };
    try {
      const first = await service.createDirect(workspace, input);
      await service.writeDirect(first.uploadId, payload.subarray(0, 3));
      await expect(
        service.createDirect(workspace, { ...input, sha256: 'f'.repeat(64) })
      ).rejects.toThrow('UPLOAD_TARGET_BUSY');
      const resumed = await service.createDirect(workspace, input);
      expect(resumed.uploadId).toBe(first.uploadId);
      expect(resumed.receivedBytes).toBe(3);
      for (const offset of [0, payload.length + 1]) {
        await expect(
          service.write({ uploadId: resumed.uploadId, offset, dataBase64: 'eA==' })
        ).rejects.toThrow('UPLOAD_OFFSET_INVALID');
      }
      await service.writeDirect(resumed.uploadId, payload.subarray(3));
      await service.completeDirect(resumed.uploadId, payload.length);
      expect(await readFile(target, 'utf8')).toBe('correct');

      const staged = await service.createDirect(workspace, input);
      await service.writeDirect(staged.uploadId, payload);
      const stagedFile = state.uploads.get(staged.uploadId)!;
      await writeFile(stagedFile.temporaryPath, 'changed');
      await expect(service.completeDirect(staged.uploadId, payload.length)).rejects.toThrow(
        'DIRECT_INTEGRITY_FAILED'
      );
      expect(await readFile(target, 'utf8')).toBe('correct');

      const rejected = await service.createDirect(workspace, input);
      await service.writeDirect(rejected.uploadId, payload.subarray(0, 3));
      await service.writeDirect(rejected.uploadId, Buffer.from('changed').subarray(3));
      await expect(service.completeDirect(rejected.uploadId, payload.length)).rejects.toThrow(
        'DIRECT_INTEGRITY_FAILED'
      );
      expect(await readFile(target, 'utf8')).toBe('correct');
    } finally {
      await service.shutdown();
    }
  });

  it('deletes context snapshots automatically after their TTL', async () => {
    vi.useFakeTimers();
    const session = {
      id: 'session-1',
      externalSessionId: 'native-1',
      model: 'model-1'
    } as NodeAgentSession;
    const service = new SessionContextService({
      runners: {
        product: () => ({
          readContextUsage: async () => ({ model: 'model-1', usedTokens: 10, maxTokens: 100 })
        })
      } as never,
      session: () => session,
      stopped: () => false,
      publish: () => undefined
    });

    await service.read(session);
    expect(snapshotCount(service)).toBe(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(snapshotCount(service)).toBe(0);
    service.dispose();
  });

  it('deletes native history image source registrations automatically after their TTL', async () => {
    vi.useFakeTimers();
    const root = await temporaryDirectory();
    const service = new RunAttachmentService(() => [root]);
    const session = { id: 'session-1' } as NodeAgentSession;

    service.registerNative(session, [
      { name: 'image.png', mime: 'image/png', localPath: join(root, 'image.png') }
    ]);
    expect(service.state.nativeHistoryImages.size).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(service.state.nativeHistoryImages.size).toBe(0);
    service.dispose();
  });

  it('registers Hosted images from an explicit native root and reads them through the controlled reference', async () => {
    const root = await temporaryDirectory();
    const imagePath = join(root, 'image.png');
    await writeFile(imagePath, Buffer.from('hosted-native-image'));
    const service = new RunAttachmentService(() => []);
    service.cache('active-run', [
      {
        name: 'image.png',
        mime: 'image/png',
        dataBase64: Buffer.from('hosted-native-image').toString('base64')
      }
    ]);
    const cached = service.state.runImages.get('active-run');
    if (cached === undefined) throw new Error('Active image cache is missing');
    cached.localPaths = [imagePath];

    const registered = service.registerNativeImages(
      'native-history:hosted:conversation-1',
      [root],
      [{ name: 'image.png', mime: 'image/png', localPath: imagePath }],
      { reuseCachedRunImages: false }
    );
    expect(registered).toEqual([
      {
        name: 'image.png',
        mime: 'image/png',
        runId: 'native-history:hosted:conversation-1',
        imageRef: expect.stringMatching(/^file:/u)
      }
    ]);
    await expect(
      service.readNative('native-history:hosted:conversation-1', registered[0]!.imageRef as string)
    ).resolves.toMatchObject({
      name: 'image.png',
      mime: 'image/png',
      dataBase64: Buffer.from('hosted-native-image').toString('base64')
    });
    expect(
      service.registerNativeImages(
        'native-history:hosted:escaped',
        [root],
        [{ name: 'outside.png', mime: 'image/png', localPath: join(root, '..', 'outside.png') }]
      )
    ).toEqual([{ name: 'outside.png', mime: 'image/png' }]);
    service.dispose();
  });

  it('loads pixels only when a native history image is previewed', async () => {
    const service = new RunAttachmentService(() => []);
    const dataBase64 = Buffer.from('lazy-image').toString('base64');
    const read = vi.fn(async () => ({
      name: 'lazy.png',
      mime: 'image/png',
      dataBase64
    }));

    expect(
      service.registerNativeImages(
        'native-history:lazy',
        [],
        [
          {
            name: 'lazy.png',
            mime: 'image/png',
            byteSize: 10,
            sourceId: 'turn-1:image-0',
            read
          }
        ]
      )
    ).toEqual([
      {
        name: 'lazy.png',
        mime: 'image/png',
        byteSize: 10,
        runId: 'native-history:lazy',
        imageRef: 'reader:turn-1%3Aimage-0'
      }
    ]);
    expect(read).not.toHaveBeenCalled();

    await expect(
      service.readNative('native-history:lazy', 'reader:turn-1%3Aimage-0')
    ).resolves.toEqual({
      name: 'lazy.png',
      mime: 'image/png',
      dataBase64
    });
    expect(read).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it.each(['native-history:session-1', 'native-history:hosted:conversation-1'])(
    'keeps exact file identity across order changes, TTL and restart in %s',
    async (runId) => {
      vi.useFakeTimers();
      const root = await temporaryDirectory();
      const old = { name: 'same.png', mime: 'image/png', localPath: join(root, 'old.png') };
      const fresh = { ...old, localPath: join(root, 'fresh.png') };
      await writeFile(old.localPath, 'old-pixels');
      await writeFile(fresh.localPath, 'fresh-pixels');
      const service = new RunAttachmentService(() => []);
      const register = (images: (typeof old)[]) =>
        service.registerNativeImages(runId, [root], images);
      const [oldAttachment, freshAttachment] = register([old, fresh]);
      const oldRef = oldAttachment!.imageRef as string;
      const freshRef = freshAttachment!.imageRef as string;
      expect(oldRef).not.toBe(freshRef);
      expect(JSON.stringify([oldAttachment, freshAttachment])).not.toContain(root);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(await service.readNative(runId, oldRef)).toBeUndefined();
      expect(register([fresh])[0]).toEqual(freshAttachment);
      expect(await service.readNative(runId, oldRef)).toBeUndefined();
      expect(register([old, fresh])).toEqual([oldAttachment, freshAttachment]);
      expect(await service.readNative(runId, freshRef)).toMatchObject({
        dataBase64: Buffer.from('fresh-pixels').toString('base64')
      });
      service.dispose();

      const restarted = new RunAttachmentService(() => []);
      expect(restarted.registerNativeImages(runId, [root], [fresh, old])).toEqual([
        freshAttachment,
        oldAttachment
      ]);
      expect(await restarted.readNative(runId, oldRef)).toMatchObject({
        dataBase64: Buffer.from('old-pixels').toString('base64')
      });
      expect(await restarted.readNative(runId, '0')).toBeUndefined();
      expect(await restarted.readNative('native-history:other', oldRef)).toBeUndefined();
      expect(await restarted.readNative(runId, old.localPath)).toBeUndefined();
      await writeFile(fresh.localPath, 'updated-pixels');
      expect(await restarted.readNative(runId, freshRef)).toMatchObject({
        dataBase64: Buffer.from('updated-pixels').toString('base64')
      });
      await rm(fresh.localPath);
      expect(await restarted.readNative(runId, freshRef)).toBeUndefined();
      restarted.dispose();
    }
  );

  it('keeps lazy reader identity after reverse re-registration and rejects invalid pixels', async () => {
    const service = new RunAttachmentService(() => []);
    const first = {
      name: 'same.png',
      mime: 'image/png',
      sourceId: 'entry:1:0',
      read: async () => ({
        name: 'same.png',
        mime: 'image/png',
        dataBase64: Buffer.from('first').toString('base64')
      })
    };
    const second = {
      ...first,
      sourceId: 'entry:2:0',
      read: async () => ({
        name: 'same.png',
        mime: 'image/png',
        dataBase64: Buffer.from('second').toString('base64')
      })
    };
    const runId = 'native-history:lazy';
    const original = service.registerNativeImages(runId, [], [first, second]);
    service.state.nativeHistoryImages.delete(runId);
    expect(service.registerNativeImages(runId, [], [second, first])).toEqual(
      [...original].reverse()
    );
    expect(await service.readNative(runId, original[0]!.imageRef as string)).toMatchObject({
      dataBase64: Buffer.from('first').toString('base64')
    });
    service.registerNativeImages(
      runId,
      [],
      [
        {
          ...first,
          read: async () => ({ name: 'wrong.png', mime: 'image/png', dataBase64: 'invalid' })
        }
      ]
    );
    expect(await service.readNative(runId, original[0]!.imageRef as string)).toBeUndefined();
    service.dispose();
  });

  it('rejects file source collisions, symlink escapes and oversized files', async () => {
    const root = await temporaryDirectory();
    const outside = join(await temporaryDirectory(), 'outside.png');
    await writeFile(outside, 'outside');
    const path = join(root, 'image.png');
    await symlink(outside, path);
    const service = new RunAttachmentService(() => []);
    const runId = 'native-history:secure';
    const image = {
      name: 'image.png',
      mime: 'image/png',
      sourceId: 'session:image.png',
      localPath: path
    };
    const [attachment] = service.registerNativeImages(runId, [root], [image]);
    expect(await service.readNative(runId, attachment!.imageRef as string)).toBeUndefined();
    expect(
      service.registerNativeImages(
        runId,
        [root],
        [{ ...image, localPath: join(root, 'other.png') }]
      )
    ).toEqual([{ name: image.name, mime: image.mime }]);
    await rm(path);
    await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(await service.readNative(runId, attachment!.imageRef as string)).toBeUndefined();
    service.dispose();
  });

  it('degrades invalid native source identities without breaking the history projection', async () => {
    const root = await temporaryDirectory();
    const service = new RunAttachmentService(() => []);
    const image = { name: 'image.png', mime: 'image/png', localPath: join(root, 'image.png') };
    const runId = 'native-history:invalid-source';
    try {
      for (const sourceId of ['', 'x'.repeat(2048), String.fromCharCode(0xd800)]) {
        expect(service.registerNativeImages(runId, [root], [{ ...image, sourceId }])).toEqual([
          { name: image.name, mime: image.mime }
        ]);
        expect(
          service.registerNativeImages(
            runId,
            [],
            [{ ...image, sourceId, read: async () => undefined }]
          )
        ).toEqual([{ name: image.name, mime: image.mime }]);
      }
      expect(service.state.nativeHistoryImages.size).toBe(0);
    } finally {
      service.dispose();
    }
  });

  it('matches Codex temporary image paths only against existing Run image caches', async () => {
    vi.useFakeTimers();
    const service = new RunAttachmentService(() => []);
    const session = { id: 'session-codex-image' } as NodeAgentSession;
    const image = {
      name: 'image.png',
      mime: 'image/png' as const,
      dataBase64: Buffer.from('image').toString('base64')
    };
    service.cache('run-codex-image', [image]);
    const [input] = await service.materializeCodex('run-codex-image', [image]);

    expect(
      service.registerNative(session, [
        { name: 'Image #1', mime: 'image/png', localPath: input!.path }
      ])
    ).toEqual([
      expect.objectContaining({
        name: 'image.png',
        mime: 'image/png',
        runId: 'run-codex-image',
        imageIndex: 0
      })
    ]);
    expect(
      service.registerNative(session, [
        {
          name: 'Image #1',
          mime: 'image/png',
          localPath: join(tmpdir(), 'myagentroam-attachment-missing', '1.png')
        }
      ])
    ).toEqual([]);
    service.expire('run-codex-image');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(
      service.registerNative(session, [
        { name: 'Image #1', mime: 'image/png', localPath: input!.path }
      ])
    ).toEqual([]);
    service.dispose();
  });

  it('previews private attachment resources before and after Session adoption without Workspace files or cross-Workspace access', async () => {
    const root = await temporaryDirectory();
    const workspace = { id: 'workspace-1', path: join(root, 'workspace') } as NodeWorkspace;
    await mkdir(workspace.path);
    const state = new WorkspaceDomainState();
    const tempRoot = () => join(root, 'node-data', 'temp-files');
    const uploads = new WorkspaceUploadService(state, () => undefined, tempRoot);
    const attachments = new RunAttachmentService(
      () => [],
      () => false,
      tempRoot
    );
    const files = new WorkspaceFileService(
      state,
      () => undefined,
      {},
      (id, path) => uploads.fileResource(id, path) ?? attachments.fileResource(id, path)
    );
    try {
      const uploaded = await uploadAttachment(uploads, workspace, 'original image');
      const resource = uploaded.resourcePath;
      expect(uploaded.path).toBe(join(tempRoot(), uploaded.id, 'image.png'));
      await expect(access(join(workspace.path, '.mar'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await files.read(workspace, { path: resource })).toMatchObject({
        path: resource,
        content: 'original image'
      });
      await expect(files.read({ ...workspace, id: 'other' }, { path: resource })).rejects.toThrow(
        'FILE_NOT_FOUND'
      );
      await expect(files.read(workspace, { path: resource + '/secret' })).rejects.toThrow(
        'FILE_PATH_ESCAPE'
      );
      await expect(
        files.write(workspace, {
          path: resource,
          content: 'overwrite',
          expectedRevision: 'revision'
        })
      ).rejects.toThrow('FILE_PATH_ESCAPE');
      await expect(files.mutate(workspace, { action: 'DELETE', path: resource })).rejects.toThrow(
        'FILE_PATH_ESCAPE'
      );
      if (process.platform !== 'win32') {
        const outside = join(root, 'private.txt');
        await writeFile(outside, 'not an attachment');
        await rm(uploaded.path);
        await symlink(outside, uploaded.path);
        await expect(files.read(workspace, { path: resource })).rejects.toThrow('FILE_PATH_ESCAPE');
        await rm(uploaded.path);
        await writeFile(uploaded.path, 'original image');
      }
      const reservation = await uploads.reserve(workspace.id, [uploaded.id]);
      reservation.commit((directories) =>
        attachments.adoptSessionFiles(
          'session',
          'input',
          directories,
          workspace.id,
          reservation.attachments.map((file) => file.path)
        )
      );
      attachments.move('input', 'execution');
      attachments.migrateSession('session', 'native');
      await uploads.shutdown();
      await expect(
        uploads.create(
          { ...workspace, id: 'other' },
          {
            name: 'image.png',
            size: 3,
            overwrite: true,
            composerAttachmentId: uploaded.id,
            mime: 'image/png'
          }
        )
      ).rejects.toThrow('COMPOSER_ATTACHMENT_INVALID');
      expect(
        await files.readContent(
          workspace,
          { path: resource, offset: 2, limit: 4 },
          join(root, 'other-worktree')
        )
      ).toMatchObject({
        path: resource,
        contentBase64: Buffer.from('igin').toString('base64'),
        offset: 2
      });
      await expect(
        files.readContent({ ...workspace, id: 'other' }, { path: resource })
      ).rejects.toThrow('FILE_NOT_FOUND');
      await expect(
        files.readContent(workspace, { path: resource, previewDirectory: '.' })
      ).rejects.toThrow('FILE_PATH_ESCAPE');
      await attachments.releaseSession('native');
      await expect(files.read(workspace, { path: resource })).rejects.toThrow('FILE_NOT_FOUND');
    } finally {
      await uploads.shutdown();
      attachments.dispose();
    }
  });

  it('deletes completed but unconsumed Composer attachments after their TTL', async () => {
    vi.useFakeTimers();
    const root = await temporaryDirectory();
    const state = new WorkspaceDomainState();
    const service = new WorkspaceUploadService(
      state,
      () => undefined,
      () => join(root, 'node-data', 'temp-files')
    );
    const workspace = { id: 'workspace-1', path: root } as NodeWorkspace;
    const attachmentId = 'b64ed8b0-89c7-44ad-b890-d332c91b43e7';
    const created = await service.create(workspace, {
      name: 'empty.txt',
      size: 0,
      overwrite: false,
      composerAttachmentId: attachmentId,
      mime: 'text/plain'
    });

    await service.complete(created.uploadId);
    expect(state.composerAttachments.size).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await vi.waitFor(() => expect(state.composerAttachments.size).toBe(0));
    await service.shutdown();
  });

  it('adopts same-name uploads in place and retains every directory through Session and execution migration', async () => {
    vi.useFakeTimers();
    const root = await temporaryDirectory();
    const state = new WorkspaceDomainState();
    const uploads = new WorkspaceUploadService(
      state,
      () => undefined,
      () => join(root, 'node-data', 'temp-files')
    );
    const attachments = new RunAttachmentService(() => []);
    const workspace = { id: 'workspace-1', path: root } as NodeWorkspace;
    try {
      const first = await uploadAttachment(uploads, workspace, 'first');
      const second = await uploadAttachment(uploads, workspace, 'second');
      const reservation = await uploads.reserve(workspace.id, [first.id, second.id]);
      expect(reservation.attachments.map((file) => file.path)).toEqual([first.path, second.path]);
      reservation.commit((directories) =>
        attachments.adoptSessionFiles(
          'bootstrap',
          'input',
          directories,
          workspace.id,
          reservation.attachments.map((file) => file.path)
        )
      );
      reservation.release();
      expect(state.composerAttachments.size).toBe(0);
      await expect(uploads.reserve(workspace.id, [first.id])).rejects.toThrow(
        'COMPOSER_ATTACHMENT_UNAVAILABLE'
      );
      await expect(uploads.cancel(first.id)).rejects.toThrow('UPLOAD_NOT_FOUND');
      attachments.move('input', 'execution');
      attachments.migrateSession('bootstrap', 'native');
      attachments.cleanup('execution');
      await uploads.shutdown();
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(await readFile(first.path, 'utf8')).toBe('first');
      expect(await readFile(second.path, 'utf8')).toBe('second');
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () => {
        await expect(access(first.path)).rejects.toThrow();
        await expect(access(second.path)).rejects.toThrow();
      });
    } finally {
      await uploads.shutdown();
      attachments.dispose();
    }
  });

  it('reserves an entire upload batch exclusively and restores the original expiry after failed preparation', async () => {
    vi.useFakeTimers();
    const root = await temporaryDirectory();
    const state = new WorkspaceDomainState();
    const uploads = new WorkspaceUploadService(
      state,
      () => undefined,
      () => join(root, 'node-data', 'temp-files')
    );
    const workspace = { id: 'workspace-1', path: root } as NodeWorkspace;
    try {
      const file = await uploadAttachment(uploads, workspace, 'first');
      await expect(uploads.reserve('other-workspace', [file.id])).rejects.toThrow(
        'COMPOSER_ATTACHMENT_UNAVAILABLE'
      );
      await expect(uploads.reserve(workspace.id, [file.id, randomUUID()])).rejects.toThrow(
        'COMPOSER_ATTACHMENT_UNAVAILABLE'
      );
      await expect(uploads.reserve(workspace.id, [file.id, file.id])).rejects.toThrow(
        'COMPOSER_ATTACHMENT_UNAVAILABLE'
      );
      await vi.advanceTimersByTimeAsync(58 * 60_000);
      const reserving = uploads.reserve(workspace.id, [file.id]);
      await expect(uploads.reserve(workspace.id, [file.id])).rejects.toThrow(
        'COMPOSER_ATTACHMENT_UNAVAILABLE'
      );
      await expect(uploads.cancel(file.id)).rejects.toThrow('COMPOSER_ATTACHMENT_UNAVAILABLE');
      const reservation = await reserving;
      await vi.advanceTimersByTimeAsync(60_000);
      reservation.release();
      reservation.release();
      const retry = await uploads.reserve(workspace.id, [file.id]);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(await readFile(file.path, 'utf8')).toBe('first');
      retry.release();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(async () => {
        expect(state.composerAttachments.size).toBe(0);
        await expect(access(file.path)).rejects.toThrow();
      });
    } finally {
      await uploads.shutdown();
    }
  });

  it('releases the whole reservation after file validation or ownership transfer fails', async () => {
    const root = await temporaryDirectory();
    const state = new WorkspaceDomainState();
    const uploads = new WorkspaceUploadService(
      state,
      () => undefined,
      () => join(root, 'node-data', 'temp-files')
    );
    const attachments = new RunAttachmentService(() => []);
    const workspace = { id: 'workspace-1', path: root } as NodeWorkspace;
    try {
      const first = await uploadAttachment(uploads, workspace, 'first');
      const second = await uploadAttachment(uploads, workspace, 'second');
      await writeFile(second.path, 'changed-size');
      await expect(uploads.reserve(workspace.id, [first.id, second.id])).rejects.toThrow(
        'COMPOSER_ATTACHMENT_UNAVAILABLE'
      );
      await writeFile(second.path, 'second');
      const reservation = await uploads.reserve(workspace.id, [first.id, second.id]);
      attachments.dispose();
      expect(() =>
        reservation.commit((directories) =>
          attachments.adoptSessionFiles(
            'session',
            'input',
            directories,
            workspace.id,
            reservation.attachments.map((file) => file.path)
          )
        )
      ).toThrow('NODE_STOPPED');
      reservation.release();
      const retry = await uploads.reserve(workspace.id, [first.id, second.id]);
      expect(retry.attachments.map((file) => file.attachment.dataBase64)).toEqual([
        Buffer.from('first').toString('base64'),
        Buffer.from('second').toString('base64')
      ]);
      retry.release();
      await uploads.cancel(first.id);
      await expect(access(first.path)).rejects.toThrow();
      expect(await readFile(second.path, 'utf8')).toBe('second');
    } finally {
      await uploads.shutdown();
      attachments.dispose();
    }
  });

  it('prevents a stopped upload reservation from transferring or resurrecting files', async () => {
    const root = await temporaryDirectory();
    const state = new WorkspaceDomainState();
    const uploads = new WorkspaceUploadService(
      state,
      () => undefined,
      () => join(root, 'node-data', 'temp-files')
    );
    const workspace = { id: 'workspace-1', path: root } as NodeWorkspace;
    const file = await uploadAttachment(uploads, workspace, 'first');
    const reservation = await uploads.reserve(workspace.id, [file.id]);
    await uploads.shutdown();
    const retain = vi.fn();
    expect(() => reservation.commit(retain)).toThrow('COMPOSER_ATTACHMENT_UNAVAILABLE');
    expect(retain).not.toHaveBeenCalled();
    reservation.release();
    expect(state.composerAttachments.size).toBe(0);
    await expect(access(file.path)).rejects.toThrow();
  });
});

function snapshotCount(service: SessionContextService): number {
  return (service as unknown as { readonly snapshots: ReadonlyMap<string, unknown> }).snapshots
    .size;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mar-node-cache-expiration-'));
  directories.push(path);
  return path;
}

async function uploadAttachment(
  uploads: WorkspaceUploadService,
  workspace: NodeWorkspace,
  content: string
) {
  const id = randomUUID();
  const upload = await uploads.create(workspace, {
    name: 'image.png',
    mime: 'image/png',
    size: Buffer.byteLength(content),
    overwrite: false,
    composerAttachmentId: id
  });
  await uploads.write({
    uploadId: upload.uploadId,
    offset: 0,
    dataBase64: Buffer.from(content).toString('base64')
  });
  const completed = await uploads.complete(upload.uploadId);
  return {
    id,
    resourcePath: completed.path,
    path: uploads.fileResource(workspace.id, completed.path)!
  };
}
