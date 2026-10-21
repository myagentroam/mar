import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostedConversationRuntime } from '../../src/service/hosted-conversation-node-service.js';
import { HostedConversationNodeService } from '../../src/service/hosted-conversation-node-service.js';
import { HostedConversationStore } from '../../src/service/hosted-conversation-store.js';
import { NodeDatabase } from '../../src/database.js';
import type {
  ConversationTemplateDraft,
  MarAgentRuntimeModelConfiguration
} from '../../../packages/protocol/src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => {
      await makeWritable(path).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    })
  );
});

describe('Node hosted conversation files', () => {
  it('closes write admission and waits for an accepted file delete on repeated disposal', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const remove = vi.spyOn(fixture.store, 'deleteFile').mockImplementation(async () => {
      await gate;
      return [];
    });
    const operations = fixture.service.operations();
    const write = operations['conversation.hosted.file.delete']!({
      conversationId,
      fileId: 'file',
      __requestUserId: 7
    });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    const closing = fixture.service.dispose();
    expect(fixture.service.dispose()).toBe(closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    try {
      await expect(
        operations['conversation.hosted.files.upload.create']!({
          conversationId,
          clientRequestId: 'late-create',
          name: 'late.txt',
          size: 1,
          mimeType: 'text/plain',
          __requestUserId: 7
        })
      ).rejects.toThrow('CONVERSATION_HOSTING_UNAVAILABLE');
      expect(closed).toBe(false);
    } finally {
      finish();
      await Promise.all([write, closing]);
    }
    expect(closed).toBe(true);
  });

  it('accounts for an upload creation before its first asynchronous preparation completes', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const request = Promise.resolve(
      fixture.service.operations()['conversation.hosted.files.upload.create']!({
        conversationId,
        clientRequestId: 'pending-create',
        name: 'pending.txt',
        size: 1,
        mimeType: 'text/plain',
        __requestUserId: 7
      })
    );
    try {
      expect(fixture.service.isConversationInUse(conversationId)).toBe(true);
      expect(fixture.service.beginConversationCleanup(conversationId)).toBeUndefined();
      await request;
    } finally {
      await request.catch(() => undefined);
      await fixture.service.dispose();
    }
  });

  it('waits for all accepted file writes even when one fails, before deleting a conversation', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    fixture.runtime.releaseSession.mockResolvedValue(undefined);
    let fail!: (error: Error) => void;
    let finish!: () => void;
    const first = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const second = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const removeFile = vi
      .spyOn(fixture.store, 'deleteFile')
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => {
        await second;
        return [];
      });
    const permanent = vi.spyOn(fixture.store, 'permanentDeleteConversation');
    const operations = fixture.service.operations();
    const a = Promise.resolve(
      operations['conversation.hosted.file.delete']!({
        conversationId,
        fileId: 'file-a',
        __requestUserId: 7
      })
    ).catch(() => undefined);
    const b = Promise.resolve(
      operations['conversation.hosted.file.delete']!({
        conversationId,
        fileId: 'file-b',
        __requestUserId: 7
      })
    );
    await vi.waitFor(() => expect(removeFile).toHaveBeenCalledTimes(2));
    const deletion = Promise.resolve(
      operations['conversation.hosted.delete']!({
        conversationId,
        __requestUserId: 7
      })
    );
    try {
      fail(new Error('WRITE_FAILED'));
      await a;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(permanent).not.toHaveBeenCalled();
      finish();
      await Promise.all([b, deletion]);
      expect(permanent).toHaveBeenCalledOnce();
    } finally {
      finish();
      await Promise.allSettled([a, b, deletion]);
      await fixture.service.dispose();
    }
  });

  it('rejects overlapping upload mutations and preserves a completion accepted before disposal', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const operations = fixture.service.operations();
    const created = (await operations['conversation.hosted.files.upload.create']!({
      conversationId,
      clientRequestId: 'overlap',
      name: 'overlap.txt',
      size: 3,
      mimeType: 'text/plain',
      __requestUserId: 7
    })) as { upload: { uploadId: string } };
    const input = { conversationId, uploadId: created.upload.uploadId, __requestUserId: 7 };
    const chunk = Promise.resolve(
      operations['conversation.hosted.files.upload.chunk']!({
        ...input,
        offset: 0,
        dataBase64: Buffer.from('abc').toString('base64')
      })
    );
    await expect(operations['conversation.hosted.files.upload.cancel']!(input)).rejects.toThrow(
      'HOSTED_CONVERSATION_FILE_CONFLICT'
    );
    await expect(operations['conversation.hosted.files.upload.complete']!(input)).rejects.toThrow(
      'HOSTED_CONVERSATION_FILE_CONFLICT'
    );
    await chunk;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const registerFile = fixture.store.registerFile.bind(fixture.store);
    const registration = vi
      .spyOn(fixture.store, 'registerFile')
      .mockImplementation(async (...args) => {
        await gate;
        return registerFile(...args);
      });
    const complete = Promise.resolve(
      operations['conversation.hosted.files.upload.complete']!(input)
    );
    await vi.waitFor(() => expect(registration).toHaveBeenCalledOnce());
    const closing = fixture.service.dispose();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    try {
      expect(closed).toBe(false);
    } finally {
      finish();
      await Promise.all([complete, closing]);
    }
    const [file] = fixture.store.listFiles(7, conversationId);
    expect(file?.relativePath).toBe('overlap.txt');
    expect(await readFile(fixture.store.filePath(7, file!), 'utf8')).toBe('abc');
    const paths = fixture.store.pathsForConversation(7, conversationId);
    expect(await readdir(paths.uploadsDirectory)).toEqual(['overlap.txt']);
  });

  it('reopens write admission after a failed permanent deletion and allows a later retry', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    fixture.runtime.releaseSession.mockResolvedValue(undefined);
    vi.spyOn(fixture.store, 'permanentDeleteConversation').mockRejectedValueOnce(
      new Error('DELETE_FAILED')
    );
    const operations = fixture.service.operations();
    const input = { conversationId, __requestUserId: 7 };
    await expect(operations['conversation.hosted.delete']!(input)).rejects.toThrow('DELETE_FAILED');
    await expect(
      operations['conversation.hosted.files.upload.create']!({
        ...input,
        clientRequestId: 'after-failure',
        name: 'retry.txt',
        size: 1,
        mimeType: 'text/plain'
      })
    ).resolves.toMatchObject({ upload: { status: 'UPLOADING' } });
    await expect(operations['conversation.hosted.delete']!(input)).resolves.toEqual({
      deletedConversationId: conversationId
    });
    await fixture.service.dispose();
  });

  it('uploads strict contiguous chunks, projects a stable attachment and reads bounded content', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    await fixture.store.advanceLastActivity(conversationId, 6_000);
    fixture.setNow(1_000);
    const operations = fixture.service.operations();

    await expect(
      operations['conversation.hosted.files.upload.preflight']!({
        conversationId,
        files: [{ name: 'input.txt', size: 6, mimeType: 'text/plain' }],
        __requestUserId: 7
      })
    ).resolves.toEqual({ files: [{ name: 'input.txt', status: 'READY' }] });
    const created = (await operations['conversation.hosted.files.upload.create']!({
      conversationId,
      clientRequestId: 'upload-request-1',
      name: 'input.txt',
      size: 6,
      mimeType: 'text/plain',
      __requestUserId: 7
    })) as { upload: { uploadId: string } };
    const uploadId = created.upload.uploadId;
    await expect(
      operations['conversation.hosted.files.upload.chunk']!({
        conversationId,
        uploadId,
        offset: 1,
        dataBase64: Buffer.from('bad').toString('base64'),
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_UPLOAD_OFFSET_INVALID');
    await operations['conversation.hosted.files.upload.chunk']!({
      conversationId,
      uploadId,
      offset: 0,
      dataBase64: Buffer.from('abc').toString('base64'),
      __requestUserId: 7
    });
    await operations['conversation.hosted.files.upload.chunk']!({
      conversationId,
      uploadId,
      offset: 3,
      dataBase64: Buffer.from('def').toString('base64'),
      __requestUserId: 7
    });
    const completed = (await operations['conversation.hosted.files.upload.complete']!({
      conversationId,
      uploadId,
      __requestUserId: 7
    })) as { upload: { file: { id: string; relativePath: string } } };
    expect(completed.upload.file).toMatchObject({ relativePath: 'input.txt', source: 'USER' });
    expect(
      fixture.database.raw
        .prepare('SELECT updated_at,last_activity_at FROM hosted_conversations WHERE id=?')
        .get(conversationId)
    ).toEqual({ updated_at: 6_000, last_activity_at: 6_000 });
    const files = await operations['conversation.hosted.files.list']!({
      conversationId,
      __requestUserId: 7
    });
    expect(files).toEqual({ files: [completed.upload.file] });
    fixture.database.raw
      .prepare('DELETE FROM conversation_files WHERE conversation_id=?')
      .run(conversationId);
    await fixture.store.rebuildConversationIndex();
    expect(fixture.store.listFiles(7, conversationId)).toEqual([
      expect.objectContaining({
        id: completed.upload.file.id,
        category: 'UPLOAD',
        relativePath: 'input.txt',
        size: 6,
        source: 'USER'
      })
    ]);
    await expect(
      operations['conversation.hosted.file.read']!({
        conversationId,
        fileId: completed.upload.file.id,
        offset: 1,
        limit: 3,
        __requestUserId: 7
      })
    ).resolves.toMatchObject({
      content: Buffer.from('bcd').toString('base64'),
      offset: 1,
      nextOffset: 4,
      eof: false
    });

    await operations['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-with-file',
      prompt: 'Read the attachment.',
      attachmentIds: [completed.upload.file.id],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    expect(fixture.runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: 'Read the attachment.',
        prompt: expect.stringContaining('/workspace/inbox/input.txt'),
        attachmentIds: [completed.upload.file.id]
      })
    );
  });

  it('allocates stable suffixes for repeated upload names without overwriting attachments', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const operations = fixture.service.operations();
    const create = async (clientRequestId: string, name = 'image.png') =>
      (await operations['conversation.hosted.files.upload.create']!({
        conversationId,
        clientRequestId,
        name,
        size: 1,
        mimeType: 'image/png',
        __requestUserId: 7
      })) as {
        readonly upload: {
          readonly uploadId: string;
          readonly name: string;
        };
      };
    const complete = async (uploadId: string) => {
      await operations['conversation.hosted.files.upload.chunk']!({
        conversationId,
        uploadId,
        offset: 0,
        dataBase64: Buffer.from('x').toString('base64'),
        __requestUserId: 7
      });
      return (await operations['conversation.hosted.files.upload.complete']!({
        conversationId,
        uploadId,
        __requestUserId: 7
      })) as {
        readonly upload: {
          readonly file: { readonly id: string; readonly relativePath: string };
        };
      };
    };

    const initial = await create('image-initial');
    expect(initial.upload.name).toBe('image.png');
    await complete(initial.upload.uploadId);
    await expect(
      operations['conversation.hosted.files.upload.preflight']!({
        conversationId,
        files: [
          { name: 'image.png', size: 1, mimeType: 'image/png' },
          { name: 'image.png', size: 1, mimeType: 'image/png' }
        ],
        __requestUserId: 7
      })
    ).resolves.toEqual({
      files: [
        { name: 'image.png', status: 'READY' },
        { name: 'image.png', status: 'READY' }
      ]
    });
    await expect(
      operations['conversation.hosted.files.upload.preflight']!({
        conversationId,
        files: [{ name: 'x'.repeat(256), size: 1, mimeType: 'text/plain' }],
        __requestUserId: 7
      })
    ).resolves.toEqual({
      files: [{ name: 'x'.repeat(256), status: 'INVALID_NAME' }]
    });
    const [concurrentRetry, concurrentDuplicate] = await Promise.all([
      create('duplicate-client-request', 'retry.png'),
      create('duplicate-client-request', 'retry.png')
    ]);
    expect(concurrentDuplicate).toEqual(concurrentRetry);

    const [firstDuplicate, secondDuplicate] = await Promise.all([
      create('image-duplicate-1'),
      create('image-duplicate-2')
    ]);
    expect([firstDuplicate.upload.name, secondDuplicate.upload.name].sort()).toEqual([
      'image (1).png',
      'image (2).png'
    ]);
    await expect(create('image-duplicate-1')).resolves.toEqual(firstDuplicate);
    const suffixCollision = await create('image-suffix-collision', 'image (1).png');
    expect(suffixCollision.upload.name).toBe('image (3).png');

    const suffixed = [firstDuplicate, secondDuplicate].find(
      (created) => created.upload.name === 'image (1).png'
    );
    expect(suffixed).toBeDefined();
    const completed = await complete(suffixed!.upload.uploadId);
    await operations['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-with-renamed-file',
      prompt: 'Read the renamed attachment.',
      attachmentIds: [completed.upload.file.id],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    expect(fixture.runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('/workspace/inbox/image (1).png')
      })
    );
  });

  it('reads the current regular file when its size changes after projection', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversationId);
    const target = join(paths.outputDirectory, 'changing.txt');
    await writeFile(target, 'old');
    const [projected] = await fixture.store.reconcileFiles(7, conversationId);
    expect(projected).toBeDefined();

    await writeFile(target, 'current content');
    await utimes(
      target,
      new Date(projected!.updatedAt + 10_000),
      new Date(projected!.updatedAt + 10_000)
    );
    const first = (await fixture.service.operations()['conversation.hosted.file.read']!({
      conversationId,
      fileId: projected!.id,
      offset: 0,
      limit: 7,
      __requestUserId: 7
    })) as {
      readonly file: { readonly size: number; readonly updatedAt: number };
      readonly content: string;
      readonly nextOffset: number | null;
      readonly eof: boolean;
    };

    expect(first.file).toMatchObject({
      ...projected,
      size: Buffer.byteLength('current content'),
      updatedAt: expect.any(Number)
    });
    expect(first.file.updatedAt).toBeGreaterThan(projected!.updatedAt);
    expect(Buffer.from(first.content, 'base64').toString('utf8')).toBe('current');
    expect(first.nextOffset).toBe(7);
    expect(first.eof).toBe(false);

    await writeFile(target, 'newer');
    await utimes(
      target,
      new Date(first.file.updatedAt + 10_000),
      new Date(first.file.updatedAt + 10_000)
    );
    const second = (await fixture.service.operations()['conversation.hosted.file.read']!({
      conversationId,
      fileId: projected!.id,
      offset: 0,
      limit: 5,
      __requestUserId: 7
    })) as {
      readonly file: { readonly size: number; readonly updatedAt: number };
      readonly content: string;
      readonly eof: boolean;
    };
    expect(second.file).toMatchObject({
      ...projected,
      size: Buffer.byteLength('newer'),
      updatedAt: expect.any(Number)
    });
    expect(second.file.updatedAt).toBeGreaterThan(first.file.updatedAt);
    expect(second.file).not.toEqual(first.file);
    expect(Buffer.from(second.content, 'base64').toString('utf8')).toBe('newer');
    expect(second.eof).toBe(true);
  });

  it('changes the read projection when same-size content is overwritten with preserved mtime', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversationId);
    const target = join(paths.outputDirectory, 'same-size.txt');
    await writeFile(target, 'before');
    const [projected] = await fixture.store.reconcileFiles(7, conversationId);
    expect(projected).toBeDefined();

    const first = (await fixture.service.operations()['conversation.hosted.file.read']!({
      conversationId,
      fileId: projected!.id,
      __requestUserId: 7
    })) as {
      readonly file: { readonly size: number; readonly updatedAt: number };
      readonly content: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(target, 'after!');
    await utimes(target, new Date(projected!.updatedAt), new Date(projected!.updatedAt));

    const second = (await fixture.service.operations()['conversation.hosted.file.read']!({
      conversationId,
      fileId: projected!.id,
      __requestUserId: 7
    })) as {
      readonly file: { readonly size: number; readonly updatedAt: number };
      readonly content: string;
    };

    expect(Buffer.from(first.content, 'base64').toString('utf8')).toBe('before');
    expect(Buffer.from(second.content, 'base64').toString('utf8')).toBe('after!');
    expect(second.file.size).toBe(first.file.size);
    expect(second.file.updatedAt).toBeGreaterThan(first.file.updatedAt);
  });

  it('deletes owned upload and output files by stable ID and returns the authoritative projection', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const otherConversationId = await createConversation(fixture, 'create-files-other');
    const operations = fixture.service.operations();
    const created = (await operations['conversation.hosted.files.upload.create']!({
      conversationId,
      clientRequestId: 'delete-upload',
      name: 'delete-me.txt',
      size: 6,
      mimeType: 'text/plain',
      __requestUserId: 7
    })) as { upload: { uploadId: string } };
    await operations['conversation.hosted.files.upload.chunk']!({
      conversationId,
      uploadId: created.upload.uploadId,
      offset: 0,
      dataBase64: Buffer.from('upload').toString('base64'),
      __requestUserId: 7
    });
    await operations['conversation.hosted.files.upload.complete']!({
      conversationId,
      uploadId: created.upload.uploadId,
      __requestUserId: 7
    });
    const paths = fixture.store.pathsForConversation(7, conversationId);
    await writeFile(join(paths.outputDirectory, 'result.txt'), 'output');
    await fixture.store.reconcileFiles(7, conversationId);
    const projected = fixture.store.listFiles(7, conversationId);
    const upload = projected.find((file) => file.category === 'UPLOAD');
    const output = projected.find((file) => file.category === 'OUTPUT');
    expect(upload).toBeDefined();
    expect(output).toBeDefined();

    await expect(
      operations['conversation.hosted.file.delete']!({
        conversationId,
        fileId: upload!.id,
        __requestUserId: 8
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    await expect(
      operations['conversation.hosted.file.delete']!({
        conversationId: otherConversationId,
        fileId: upload!.id,
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_FILE_NOT_FOUND');

    const before = fixture.database.raw
      .prepare('SELECT last_activity_at FROM hosted_conversations WHERE id=?')
      .get(conversationId) as { last_activity_at: number };
    const deletedAt = before.last_activity_at + 1_000;
    fixture.setNow(deletedAt);
    await expect(
      operations['conversation.hosted.file.delete']!({
        conversationId,
        fileId: output!.id,
        __requestUserId: 7
      })
    ).resolves.toEqual({
      deletedFileId: output!.id,
      files: [upload]
    });
    await expect(lstat(join(paths.outputDirectory, 'result.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    });

    await expect(
      operations['conversation.hosted.file.delete']!({
        conversationId,
        fileId: upload!.id,
        __requestUserId: 7
      })
    ).resolves.toEqual({
      deletedFileId: upload!.id,
      files: []
    });
    await expect(lstat(join(paths.uploadsDirectory, 'delete-me.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(fixture.store.listFiles(7, conversationId)).toEqual([]);
    expect(
      fixture.database.raw
        .prepare('SELECT used_bytes,last_activity_at FROM hosted_conversations WHERE id=?')
        .get(conversationId)
    ).toEqual({ used_bytes: 0, last_activity_at: deletedAt });
  });

  it('does not gate deletion on an active Run and rejects a late delete after the file changes', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversationId);
    await writeFile(join(paths.outputDirectory, 'busy.txt'), 'busy');
    const [file] = await fixture.store.reconcileFiles(7, conversationId);
    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'busy-file-run',
      prompt: 'Use the output.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });

    await writeFile(join(paths.outputDirectory, 'busy.txt'), 'late');
    await utimes(
      join(paths.outputDirectory, 'busy.txt'),
      new Date(file!.updatedAt + 10_000),
      new Date(file!.updatedAt + 10_000)
    );
    await expect(
      fixture.service.operations()['conversation.hosted.file.delete']!({
        conversationId,
        fileId: file!.id,
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_FILE_CONFLICT');
    await fixture.store.reconcileFiles(7, conversationId);
    const [current] = fixture.store.listFiles(7, conversationId);
    await expect(
      fixture.service.operations()['conversation.hosted.file.delete']!({
        conversationId,
        fileId: current!.id,
        __requestUserId: 7
      })
    ).resolves.toMatchObject({ deletedFileId: current!.id, files: [] });
    fixture.pending.complete({ status: 'SUCCEEDED', completedAt: 3_000 });
    await vi.waitFor(() => expect(fixture.service.isConversationInUse(conversationId)).toBe(false));
  });

  it('allows deletes for different files to proceed independently', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversationId);
    await writeFile(join(paths.outputDirectory, 'first.txt'), 'first');
    await writeFile(join(paths.outputDirectory, 'second.txt'), 'second');
    const files = await fixture.store.reconcileFiles(7, conversationId);
    const first = files.find((file) => file.relativePath === 'first.txt');
    const second = files.find((file) => file.relativePath === 'second.txt');
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const originalDelete = fixture.store.deleteFile.bind(fixture.store);
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      vi.spyOn(fixture.store, 'deleteFile').mockImplementation(
        async (userId, currentConversationId, fileId, deletedAt) => {
          if (fileId === first!.id) {
            resolve();
            await new Promise<void>((release) => {
              releaseFirst = release;
            });
          }
          return originalDelete(userId, currentConversationId, fileId, deletedAt);
        }
      );
    });
    const operations = fixture.service.operations();
    const firstDelete = operations['conversation.hosted.file.delete']!({
      conversationId,
      fileId: first!.id,
      __requestUserId: 7
    });
    await firstStarted;

    await expect(
      operations['conversation.hosted.file.delete']!({
        conversationId,
        fileId: second!.id,
        __requestUserId: 7
      })
    ).resolves.toMatchObject({ deletedFileId: second!.id });
    releaseFirst();
    await expect(firstDelete).resolves.toMatchObject({ deletedFileId: first!.id, files: [] });
  });

  it('enforces upload and environment quota without deleting existing files', async () => {
    const fixture = await fileFixture({ maxStorageBytes: 8, maxUploadBytes: 4 });
    const conversationId = await createConversation(fixture);
    const operations = fixture.service.operations();
    await expect(
      operations['conversation.hosted.files.upload.create']!({
        conversationId,
        clientRequestId: 'too-large',
        name: 'large.bin',
        size: 5,
        mimeType: 'application/octet-stream',
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_QUOTA_EXCEEDED');

    const created = (await operations['conversation.hosted.files.upload.create']!({
      conversationId,
      clientRequestId: 'fits',
      name: 'small.bin',
      size: 4,
      mimeType: 'application/octet-stream',
      __requestUserId: 7
    })) as { upload: { uploadId: string } };
    await operations['conversation.hosted.files.upload.chunk']!({
      conversationId,
      uploadId: created.upload.uploadId,
      offset: 0,
      dataBase64: Buffer.from('1234').toString('base64'),
      __requestUserId: 7
    });
    await operations['conversation.hosted.files.upload.complete']!({
      conversationId,
      uploadId: created.upload.uploadId,
      __requestUserId: 7
    });
    await expect(
      operations['conversation.hosted.files.upload.create']!({
        conversationId,
        clientRequestId: 'over-total',
        name: 'other.bin',
        size: 5,
        mimeType: 'application/octet-stream',
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_QUOTA_EXCEEDED');
    const paths = fixture.store.pathsForConversation(7, conversationId);
    await expect(readFile(join(paths.uploadsDirectory, 'small.bin'), 'utf8')).resolves.toBe('1234');
  });

  it('rejects symlink targets and cross-user file access', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversationId);
    const outside = join(fixture.directory, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(paths.uploadsDirectory, 'escape.txt'));

    await expect(
      fixture.service.operations()['conversation.hosted.files.upload.create']!({
        conversationId,
        clientRequestId: 'escape',
        name: 'escape.txt',
        size: 1,
        mimeType: 'text/plain',
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_FILE_INVALID');
    await expect(
      fixture.service.operations()['conversation.hosted.files.list']!({
        conversationId,
        __requestUserId: 8
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_NOT_AUTHORIZED');

    const hardlinkSource = join(fixture.directory, 'hardlink-source.txt');
    await writeFile(hardlinkSource, 'shared inode');
    const projectedPath = join(paths.outputDirectory, 'projected.txt');
    await rm(join(paths.uploadsDirectory, 'escape.txt'));
    await writeFile(projectedPath, 'projected');
    const [projected] = await fixture.store.reconcileFiles(7, conversationId);
    await rm(projectedPath);
    await symlink(outside, projectedPath);
    await expect(
      fixture.service.operations()['conversation.hosted.file.read']!({
        conversationId,
        fileId: projected!.id,
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_FILE_INVALID');
    await rm(projectedPath);
    await link(hardlinkSource, projectedPath);
    await expect(
      fixture.service.operations()['conversation.hosted.file.read']!({
        conversationId,
        fileId: projected!.id,
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_FILE_INVALID');

    await link(hardlinkSource, join(paths.outputDirectory, 'hardlink.txt'));
    await expect(fixture.store.reconcileFiles(7, conversationId)).rejects.toThrow(
      'HOSTED_CONVERSATION_FILE_INVALID'
    );
  });

  it('enforces the total storage quota for generated output', async () => {
    const fixture = await fileFixture({
      maxStorageBytes: 4,
      maxUploadBytes: 4
    });
    const conversationId = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversationId);
    await writeFile(join(paths.outputDirectory, 'too-large.txt'), '12345');

    await expect(fixture.store.reconcileFiles(7, conversationId)).rejects.toThrow(
      'HOSTED_CONVERSATION_QUOTA_EXCEEDED'
    );
    expect(fixture.store.listFiles(7, conversationId)).toEqual([]);
  });

  it('projects generated files and rebuilds active conversations without stale Run or upload state', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversationId);

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'message-restart',
      prompt: 'Create files.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    await mkdir(join(paths.outputDirectory, 'nested'), { recursive: true });
    await mkdir(join(paths.outputDirectory, 'tmp'), { recursive: true });
    await writeFile(join(paths.outputDirectory, 'notes.md'), 'notes');
    await writeFile(join(paths.outputDirectory, 'nested', 'data.json'), '{}');
    await writeFile(join(paths.outputDirectory, 'report.txt'), 'report');
    await writeFile(join(paths.outputDirectory, 'tmp', 'progress.txt'), 'persistent progress');
    fixture.pending.complete({ status: 'SUCCEEDED', completedAt: 3_000 });

    await vi.waitFor(async () => {
      const projected = (await fixture.service.operations()['conversation.hosted.files.list']!({
        conversationId,
        __requestUserId: 7
      })) as { files: Array<{ id: string; category: string; relativePath: string }> };
      expect(projected.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: 'OUTPUT', relativePath: 'notes.md' }),
          expect.objectContaining({ category: 'OUTPUT', relativePath: 'nested/data.json' }),
          expect.objectContaining({ category: 'OUTPUT', relativePath: 'report.txt' }),
          expect.objectContaining({ category: 'OUTPUT', relativePath: 'tmp/progress.txt' })
        ])
      );
    });
    const beforeRestart = fixture.store.listFiles(7, conversationId);
    const stableIds = new Map(
      beforeRestart.map((file) => [`${file.category}:${file.relativePath}`, file.id])
    );
    await writeFile(join(paths.uploadsDirectory, '.abandoned-upload.upload'), 'partial');
    await mkdir(join(paths.temporaryRootDirectory, 'run-abandoned'), { recursive: true });
    await writeFile(join(paths.temporaryRootDirectory, 'run-abandoned', 'partial.txt'), 'partial');

    const restarted = new HostedConversationStore({
      dataDirectory: join(fixture.directory, 'data'),
      rootDirectory: join(fixture.directory, 'data', 'hosted'),
      nodeId: 'node-1',
      database: fixture.database
    });
    await restarted.initialize();
    await restarted.rebuildConversationIndex();

    expect(restarted.requireConversation(7, conversationId).status).toBe('ACTIVE');
    expect(restarted.findMessage(7, conversationId, 'message-restart')).toMatchObject({
      status: 'SUCCEEDED'
    });
    const afterRestart = restarted.listFiles(7, conversationId);
    expect(afterRestart).toHaveLength(4);
    for (const file of afterRestart)
      expect(file.id).toBe(stableIds.get(`${file.category}:${file.relativePath}`));
    await expect(
      lstat(join(paths.uploadsDirectory, '.abandoned-upload.upload'))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(lstat(join(paths.temporaryRootDirectory, 'run-abandoned'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(readFile(join(paths.outputDirectory, 'report.txt'), 'utf8')).resolves.toBe(
      'report'
    );
    await expect(
      readFile(join(paths.outputDirectory, 'tmp', 'progress.txt'), 'utf8')
    ).resolves.toBe('persistent progress');
  });

  it('waits for terminal file reconciliation before permanently deleting an active conversation', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'delete-running',
      prompt: 'Finish before deletion.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    let releaseReconciliation!: () => void;
    const reconciliationGate = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const reconcile = vi.spyOn(fixture.store, 'reconcileFiles').mockImplementation(async () => {
      await reconciliationGate;
      return [];
    });
    const permanentDelete = vi.spyOn(fixture.store, 'permanentDeleteConversation');
    const deletion = fixture.service.operations()['conversation.hosted.delete']!({
      conversationId,
      __requestUserId: 7
    });
    fixture.pending.complete({ status: 'INTERRUPTED', completedAt: 3_000 });

    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    expect(permanentDelete).not.toHaveBeenCalled();
    releaseReconciliation();
    await expect(deletion).resolves.toMatchObject({
      deletedConversationId: conversationId
    });
    expect(permanentDelete).toHaveBeenCalledWith(conversationId);
  });

  it('waits for a pending message start and cancels its Run before permanent deletion', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    let reportRunStart!: () => void;
    let releaseRunStart!: () => void;
    const runStartEntered = new Promise<void>((resolve) => {
      reportRunStart = resolve;
    });
    const runStartReleased = new Promise<void>((resolve) => {
      releaseRunStart = resolve;
    });
    fixture.runtime.startRun.mockImplementationOnce(async () => {
      reportRunStart();
      await runStartReleased;
      return fixture.pending.handle;
    });

    const message = fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'delete-pending-start',
      prompt: 'Start before deletion.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    await runStartEntered;
    const deletion = fixture.service.operations()['conversation.hosted.delete']!({
      conversationId,
      __requestUserId: 7
    });
    releaseRunStart();
    await expect(message).resolves.toMatchObject({
      run: { id: 'run-1', status: 'RUNNING' }
    });

    await vi.waitFor(() => expect(fixture.pending.handle.cancel).toHaveBeenCalledOnce());
    fixture.pending.complete({ status: 'INTERRUPTED', completedAt: 3_000 });
    await expect(deletion).resolves.toEqual({ deletedConversationId: conversationId });
  });

  it('excludes conversations from maintenance cleanup while user deletion releases runtime state', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    fixture.pending.complete({ status: 'SUCCEEDED', completedAt: 2_500 });
    let enterRelease!: () => void;
    let releaseRuntime!: () => void;
    const releaseEntered = new Promise<void>((resolve) => {
      enterRelease = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    fixture.runtime.releaseSession.mockImplementation(async () => {
      enterRelease();
      await releaseGate;
    });
    const deletion = fixture.service.operations()['conversation.hosted.delete']!({
      conversationId,
      __requestUserId: 7
    });
    await releaseEntered;
    const cleanupDuringDelete = fixture.service.beginConversationCleanup(conversationId);
    cleanupDuringDelete?.();
    releaseRuntime();
    await deletion;
    expect(cleanupDuringDelete).toBeUndefined();
  });

  it('permanently deletes the entire environment and exposes no restore operation', async () => {
    const fixture = await fileFixture();
    const conversationId = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversationId);
    await writeFile(join(paths.outputDirectory, 'keep.txt'), 'keep');

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId,
      clientMessageId: 'tmp-run',
      prompt: 'Run.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: model,
      __marAgentModels: [model]
    });
    const runInput = fixture.runtime.startRun.mock.calls[0]![0];
    await writeFile(join(runInput.temporaryDirectory, 'temporary.txt'), 'temporary');
    fixture.pending.complete({ status: 'FAILED', completedAt: 3_000 });
    let releaseDisable: (() => void) | undefined;
    await vi.waitFor(async () => {
      await expect(
        readFile(join(runInput.temporaryDirectory, 'temporary.txt'), 'utf8')
      ).resolves.toBe('temporary');
      releaseDisable = fixture.service.prepareForDisable();
      expect(releaseDisable).toBeTypeOf('function');
    });
    releaseDisable!();

    const deleted = await fixture.service.operations()['conversation.hosted.delete']!({
      conversationId,
      __requestUserId: 7
    });
    expect(deleted).toEqual({ deletedConversationId: conversationId });
    await expect(lstat(paths.conversationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(runInput.temporaryDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      fixture.database.raw
        .prepare('SELECT id FROM hosted_conversations WHERE id=?')
        .get(conversationId)
    ).toBeUndefined();
    expect(fixture.service.operations()).not.toHaveProperty('conversation.hosted.restore');
    expect(() =>
      fixture.service.operations()['conversation.hosted.message']!({
        conversationId,
        clientMessageId: 'blocked',
        prompt: 'Blocked.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: model,
        __marAgentModels: [model]
      })
    ).toThrow('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    await expect(readFile(join(paths.outputDirectory, 'keep.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });
});

const model: MarAgentRuntimeModelConfiguration = {
  id: 'model-1',
  name: 'Model',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test/v1',
  apiKey: 'secret',
  modelId: 'model',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

async function fileFixture(
  quota: { maxStorageBytes: number; maxUploadBytes: number } = {
    maxStorageBytes: 1_000_000,
    maxUploadBytes: 100_000
  }
) {
  const directory = await temporaryDirectory();
  const dataDirectory = join(directory, 'data');
  const temporaryRootDirectory = join(directory, 'host-tmp');
  const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
  const store = new HostedConversationStore({
    dataDirectory,
    rootDirectory: join(dataDirectory, 'hosted'),
    temporaryRootDirectory,
    nodeId: 'node-1',
    database
  });
  await store.initialize();
  const pending = deferredRun();
  const runtime = {
    createSession: vi.fn<HostedConversationRuntime['createSession']>(async () => ({
      sessionId: 'session-1'
    })),
    history: vi.fn<HostedConversationRuntime['history']>(async () => ({
      turns: [],
      nextCursor: null
    })),
    rollback: vi.fn<HostedConversationRuntime['rollback']>(async () => ({
      lastActivityAt: 2_000
    })),
    startRun: vi.fn<HostedConversationRuntime['startRun']>(async () => pending.handle),
    releaseSession: vi.fn<HostedConversationRuntime['releaseSession']>(async () => {
      await pending.handle.completion;
    })
  } satisfies HostedConversationRuntime;
  let id = 0;
  let currentNow: number | undefined;
  const service = new HostedConversationNodeService({
    database,
    store,
    runtime,
    nodeId: () => 'node-1',
    now: () => currentNow ?? 2_000 + id,
    id: () => `id-${++id}`,
    processExecutorFactory: vi.fn(() => ({ spawn: vi.fn() }) as never),
    readImage: vi.fn(async () => undefined)
  });
  const templateDraft: ConversationTemplateDraft = {
    templateId: 'template-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    revision: 1,
    name: 'Files',
    description: 'Files template',
    allowedModels: [{ modelId: 'model', name: 'Model' }],
    defaultModelId: 'model',
    mcpIds: [],
    networkMode: 'NONE',
    quotas: {
      maxStorageBytes: quota.maxStorageBytes,
      maxUploadBytes: quota.maxUploadBytes
    },
    updatedAt: 1_000
  };
  const storageKey = 'template_version_files';
  const templateDirectory = store.templateVersionDirectory(storageKey);
  await import('node:fs/promises').then(({ mkdir }) =>
    Promise.all(
      ['content', 'content/inbox', 'content/output'].map((relativePath) =>
        mkdir(join(templateDirectory, relativePath), { recursive: true })
      )
    )
  );
  const directories: string[] = [];
  const entries: Record<string, unknown>[] = [];
  const contentHash = createHash('sha256').update('').digest('hex');
  const manifest = {
    schemaVersion: 2,
    sourceWorkspacePath: '/projects/files-template',
    templateId: 'template-1',
    versionId: 'version-1',
    versionNumber: 1,
    draftRevision: 1,
    hostPolicyVersion: 1,
    publishedByUserId: 1,
    publishedAt: 1_000,
    draft: templateDraft,
    mcpServers: [],
    mcpConfigHash: EMPTY_MCP_CONFIG_HASH,
    directories,
    entries,
    contentHash
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
  await writeFile(join(templateDirectory, 'manifest.json'), manifestJson);
  await sealTemplateFixture(templateDirectory);
  database.raw
    .prepare(
      `INSERT INTO conversation_template_versions
       (id,template_id,version_number,draft_revision,status,storage_key,manifest,content_hash,
        mcp_config_hash,manifest_hash,file_count,total_bytes,host_policy_version,published_by_user_id,
        published_at,reference_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
    )
    .run(
      'version-1',
      'template-1',
      1,
      1,
      'AVAILABLE',
      storageKey,
      manifestJson,
      contentHash,
      EMPTY_MCP_CONFIG_HASH,
      manifestHash,
      0,
      0,
      1,
      1,
      1_000
    );
  return {
    directory,
    database,
    store,
    runtime,
    pending,
    service,
    setNow(value: number) {
      currentNow = value;
    }
  };
}

const EMPTY_MCP_CONFIG_HASH = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

async function createConversation(
  fixture: Awaited<ReturnType<typeof fileFixture>>,
  clientRequestId = 'create-files'
): Promise<string> {
  const result = (await fixture.service.operations()['conversation.hosted.create']!({
    templateId: 'template-1',
    clientRequestId,
    __requestUserId: 7,
    __template: {
      id: 'template-1',
      nodeId: 'node-1',
      name: 'Files',
      description: 'Files template',
      status: 'ACTIVE',
      currentVersionId: 'version-1',
      available: true,
      createdAt: 1_000,
      updatedAt: 1_000
    },
    __marAgentModels: [model]
  })) as { conversation: { id: string } };
  return result.conversation.id;
}

function deferredRun() {
  let complete!: (value: {
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
    completedAt: number;
  }) => void;
  const completion = new Promise<{
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
    completedAt: number;
  }>((resolve) => (complete = resolve));
  return {
    complete,
    handle: {
      run: { id: 'run-1', status: 'RUNNING' as const, startedAt: 2_000, completedAt: null },
      completion,
      cancel: vi.fn(() => true)
    }
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mar-node-hosted-files-'));
  directories.push(path);
  return path;
}

async function sealTemplateFixture(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) await sealTemplateFixture(join(path, entry));
    await chmod(path, 0o555);
    return;
  }
  await chmod(path, 0o444);
}

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
    return;
  }
  await chmod(path, 0o600);
}
