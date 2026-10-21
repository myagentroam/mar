import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeComposerTag } from '@myagentroam/protocol';
import { registerSessionShareResourceRoutes } from '../../src/session-share-resource-routes.js';
import type { SessionShares } from '../../src/session-shares.js';
import { sendError } from '../../src/http-errors.js';

interface QueueItem {
  queueItemId: string;
  workspaceId: string;
  sessionId: string;
  content: string;
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const app = Fastify();
  apps.push(app);
  let active = true;
  let fileBytes: Buffer = Buffer.from('resource');
  let queueItems: QueueItem[] = [];
  const executedContent: string[] = [];
  const runs: Record<string, { sessionId: string; workspaceId: string }> = {
    'run-current': { sessionId: 'session-current', workspaceId: 'workspace-fixed' },
    'run-other-session': { sessionId: 'session-other', workspaceId: 'workspace-fixed' },
    'run-other-workspace': { sessionId: 'session-current', workspaceId: 'workspace-other' }
  };
  const context = {
    nodeId: 'node-fixed',
    workspaceId: 'workspace-fixed',
    sessionId: 'session-current',
    user: { userId: 7, username: 'Owner', sessionHash: 'share-session', channel: true }
  };
  const resolved = { context, record: {} as never, sharerName: 'Owner' } as Awaited<
    ReturnType<SessionShares['resolve']>
  >;
  const resolve = vi.fn(async (_request: FastifyRequest<{ Params: { shareId: string } }>) => {
    if (!active) throw new Error('SESSION_SHARE_NOT_FOUND');
    return resolved;
  });
  const requestNode = vi.fn(async (...args: unknown[]): Promise<unknown> => {
    const operation = args[1];
    const data = args[2] as Record<string, unknown>;
    if (operation === 'workspace.queue.get')
      return { queue: { version: 4, paused: false, items: queueItems } };
    if (operation === 'workspace.queue.message.update') {
      const item = queueItems.find((value) => value.queueItemId === data.queueItemId);
      if (item !== undefined) item.content = String(data.content);
    }
    if (operation === 'workspace.queue.message.execute') {
      const item = queueItems.find((value) => value.queueItemId === data.queueItemId);
      if (item !== undefined) executedContent.push(item.content);
    }
    if (operation === 'workspace.file.content.read') {
      const offset = data.offset as number;
      const limit = data.limit as number;
      return {
        file: {
          size: fileBytes.length,
          offset,
          contentBase64: fileBytes.subarray(offset, offset + limit).toString('base64')
        }
      };
    }
    if (operation === 'run.get') return { run: runs[String(data.runId)] };
    if (operation === 'run.image.read')
      return { image: { mime: 'image/png', dataBase64: Buffer.from('png').toString('base64') } };
    if (operation === 'node.skills.inspect')
      return { skills: [{ name: 'shared-skill' }, { name: 'node-only' }] };
    if (operation === 'workspace.skills.inspect')
      return { skills: [{ name: 'shared-skill' }, { name: 'workspace-only' }] };
    return { accepted: true };
  });

  app.register(
    async (scope) => {
      scope.setErrorHandler((error, _request, reply) => {
        const code = error instanceof Error ? error.message : 'NODE_RESPONSE_INVALID';
        return sendError(reply, code === 'QUEUE_VERSION_CONFLICT' ? 409 : 404, code);
      });
      registerSessionShareResourceRoutes({
        app: scope,
        nodeControl: { requestNode } as never,
        resolve
      });
    },
    { prefix: '/api/session-shares/:shareId' }
  );
  await app.ready();
  return {
    app,
    requestNode,
    resolve,
    context,
    setActive: (value: boolean) => {
      active = value;
    },
    setFileBytes: (value: Buffer) => {
      fileBytes = value;
    },
    setQueueItems: (value: QueueItem[]) => {
      queueItems = value;
    },
    executedContent
  };
}

describe('Session-share resource routes', () => {
  it('uses the fixed share target for file reads and exposes effective skills through the existing inspect operations', async () => {
    const f = await fixture();
    const file = await f.app.inject({
      url: '/api/session-shares/share-one/files/read?path=notes.txt&offset=0&limit=10&nodeId=attacker&workspaceId=other&sessionId=other'
    });
    expect(file.statusCode).toBe(200);
    expect(f.requestNode).toHaveBeenCalledWith(
      'node-fixed',
      'workspace.file.read',
      {
        path: 'notes.txt',
        offset: 0,
        limit: 10,
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current'
      },
      {
        userId: 7,
        username: 'Owner',
        sessionHash: 'share-session',
        channel: true,
        workspaceId: 'workspace-fixed'
      }
    );

    const skills = await f.app.inject({ url: '/api/session-shares/share-one/effective-skills' });
    expect(skills.statusCode).toBe(200);
    expect(skills.json().skills).toEqual([
      { name: 'node-only', source: 'NODE_HOME' },
      { name: 'shared-skill', source: 'WORKSPACE' },
      { name: 'workspace-only', source: 'WORKSPACE' }
    ]);
    expect(f.requestNode).toHaveBeenCalledWith(
      'node-fixed',
      'node.skills.inspect',
      {
        includeClaudeCompatibility: true,
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current'
      },
      expect.objectContaining({
        userId: 7,
        sessionHash: 'share-session',
        workspaceId: 'workspace-fixed'
      })
    );
    expect(f.requestNode).toHaveBeenCalledWith(
      'node-fixed',
      'workspace.skills.inspect',
      { workspaceId: 'workspace-fixed', sessionId: 'session-current' },
      expect.objectContaining({
        userId: 7,
        sessionHash: 'share-session',
        workspaceId: 'workspace-fixed'
      })
    );
  });

  it('filters Workspace queue results to the fixed Session', async () => {
    const f = await fixture();
    f.setQueueItems([
      {
        queueItemId: 'own-item',
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current',
        content: 'mine'
      },
      {
        queueItemId: 'other-item',
        workspaceId: 'workspace-fixed',
        sessionId: 'session-other',
        content: 'other session'
      },
      {
        queueItemId: 'other-workspace-item',
        workspaceId: 'workspace-other',
        sessionId: 'session-current',
        content: 'other workspace'
      }
    ]);
    const response = await f.app.inject({ url: '/api/session-shares/share-one/queue' });
    expect(response.statusCode).toBe(200);
    expect(response.json().queue.items).toEqual([
      {
        queueItemId: 'own-item',
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current',
        content: 'mine'
      }
    ]);
  });

  it('rejects editing, deleting, or executing a queue item from another Session', async () => {
    const f = await fixture();
    f.setQueueItems([
      {
        queueItemId: 'other-item',
        workspaceId: 'workspace-fixed',
        sessionId: 'session-other',
        content: 'private'
      }
    ]);
    const attempts = [
      {
        method: 'PATCH',
        url: '/api/session-shares/share-one/queue/other-item',
        payload: { content: 'edited' }
      },
      { method: 'DELETE', url: '/api/session-shares/share-one/queue/other-item' },
      { method: 'POST', url: '/api/session-shares/share-one/queue/other-item/execute' }
    ] as const;
    for (const attempt of attempts) {
      const response = await f.app.inject(attempt);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('QUEUE_ITEM_INVALID');
    }
    expect(f.requestNode.mock.calls.map((call) => call[1])).toEqual([
      'workspace.queue.get',
      'workspace.queue.get',
      'workspace.queue.get'
    ]);
  });

  it('refuses cross-Session queue reorder IDs and preserves Channel tags through edit and execute', async () => {
    const f = await fixture();
    const channelTag = serializeComposerTag('mar_channel', {
      source: 'WEB_SHARE',
      channelId: 'share-one',
      senderId: 'visitor-one',
      name: 'Guest'
    });
    const item: QueueItem = {
      queueItemId: 'own-item',
      workspaceId: 'workspace-fixed',
      sessionId: 'session-current',
      content: channelTag + '\nOriginal text'
    };
    f.setQueueItems([
      item,
      {
        queueItemId: 'other-item',
        workspaceId: 'workspace-fixed',
        sessionId: 'session-other',
        content: 'other'
      }
    ]);

    const crossSession = await f.app.inject({
      method: 'PUT',
      url: '/api/session-shares/share-one/queue',
      payload: { expectedVersion: 4, queueItemIds: ['own-item', 'other-item'] }
    });
    expect(crossSession.statusCode).toBe(409);
    expect(crossSession.json().error.code).toBe('QUEUE_VERSION_CONFLICT');
    expect(f.requestNode.mock.calls.map((call) => call[1])).toEqual(['workspace.queue.get']);

    const reordered = await f.app.inject({
      method: 'PUT',
      url: '/api/session-shares/share-one/queue',
      payload: { expectedVersion: 4, queueItemIds: ['own-item'] }
    });
    expect(reordered.statusCode).toBe(200);
    expect(f.requestNode).toHaveBeenLastCalledWith(
      'node-fixed',
      'workspace.queue.reorder',
      {
        expectedVersion: 4,
        queueItemIds: ['own-item'],
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current'
      },
      expect.objectContaining({
        userId: 7,
        sessionHash: 'share-session',
        workspaceId: 'workspace-fixed'
      })
    );

    const editedContent = channelTag + '\nEdited text';
    const edited = await f.app.inject({
      method: 'PATCH',
      url: '/api/session-shares/share-one/queue/own-item',
      payload: { content: editedContent }
    });
    expect(edited.statusCode).toBe(200);
    expect(f.requestNode).toHaveBeenLastCalledWith(
      'node-fixed',
      'workspace.queue.message.update',
      {
        queueItemId: 'own-item',
        content: editedContent,
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current'
      },
      expect.objectContaining({
        userId: 7,
        sessionHash: 'share-session',
        workspaceId: 'workspace-fixed'
      })
    );
    const executed = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/queue/own-item/execute'
    });
    expect(executed.statusCode).toBe(200);
    expect(f.executedContent).toEqual([editedContent]);
  });

  it('implements the attachment upload request protocol and keeps its target fixed', async () => {
    const f = await fixture();
    const uploadId = '00000000-0000-4000-8000-000000000011';
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/uploads',
      payload: {
        name: 'notes.txt',
        size: 3,
        mime: 'text/plain',
        overwrite: false,
        composerAttachmentId: '00000000-0000-4000-8000-000000000012'
      }
    });
    expect(created.statusCode).toBe(200);
    expect(f.requestNode).toHaveBeenLastCalledWith(
      'node-fixed',
      'workspace.files.upload.create',
      {
        name: 'notes.txt',
        size: 3,
        mime: 'text/plain',
        overwrite: false,
        composerAttachmentId: '00000000-0000-4000-8000-000000000012',
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current'
      },
      expect.objectContaining({
        userId: 7,
        sessionHash: 'share-session',
        workspaceId: 'workspace-fixed'
      })
    );

    const chunk = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/uploads/' + uploadId + '/chunks?offset=0',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('abc')
    });
    expect(chunk.statusCode).toBe(200);
    expect(f.requestNode).toHaveBeenLastCalledWith(
      'node-fixed',
      'workspace.files.upload.chunk',
      {
        uploadId,
        offset: 0,
        dataBase64: 'YWJj',
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current'
      },
      expect.objectContaining({
        userId: 7,
        sessionHash: 'share-session',
        workspaceId: 'workspace-fixed'
      })
    );
    for (const action of ['complete', 'cancel']) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/session-shares/share-one/uploads/' + uploadId + '/' + action
      });
      expect(response.statusCode).toBe(200);
      expect(f.requestNode).toHaveBeenLastCalledWith(
        'node-fixed',
        'workspace.files.upload.' + action,
        { uploadId, workspaceId: 'workspace-fixed', sessionId: 'session-current' },
        expect.objectContaining({
          userId: 7,
          sessionHash: 'share-session',
          workspaceId: 'workspace-fixed'
        })
      );
    }

    f.requestNode.mockClear();
    const invalid = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/uploads',
      payload: {
        name: 'notes.txt',
        size: 3,
        mime: 'text/plain',
        overwrite: true,
        composerAttachmentId: '00000000-0000-4000-8000-000000000012'
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(f.requestNode).not.toHaveBeenCalled();
  });

  it('revalidates share admission for each chunk of a read-only Range response', async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(512 * 1024 + 4, 0x61);
    f.setFileBytes(bytes);
    const response = await f.app.inject({
      url: '/api/session-shares/share-one/files/content?path=large.bin',
      headers: { range: 'bytes=0-524288' }
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 0-524288/524292');
    expect(response.rawPayload).toEqual(bytes.subarray(0, 524289));
    expect(f.resolve).toHaveBeenCalledTimes(4);
    expect(
      f.requestNode.mock.calls.filter((call) => call[1] === 'workspace.file.content.read')
    ).toHaveLength(3);
  });

  it('owns Run user-input, approval, interrupt, and image actions to the fixed Session', async () => {
    const f = await fixture();
    const userInput = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/runs/run-other-session/user-input/request-one',
      payload: { answers: { answer: 'no' } }
    });
    expect(userInput.statusCode).toBe(404);
    expect(userInput.json().error.code).toBe('RUN_NOT_FOUND');
    const interrupt = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/runs/run-other-workspace/interrupt'
    });
    expect(interrupt.statusCode).toBe(404);
    expect(interrupt.json().error.code).toBe('RUN_NOT_FOUND');
    const image = await f.app.inject({
      url: '/api/session-shares/share-one/runs/run-other-session/images/0'
    });
    expect(image.statusCode).toBe(404);
    expect(image.json().error.code).toBe('RUN_NOT_FOUND');
    const approval = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/runs/run-other-session/approvals/approval-one/decision',
      payload: { nodeId: 'attacker-node', decision: 'APPROVED' }
    });
    expect(approval.statusCode).toBe(404);
    expect(approval.json().error.code).toBe('RUN_NOT_FOUND');
    expect(f.requestNode.mock.calls.map((call) => call[1])).toEqual([
      'run.get',
      'run.get',
      'run.get',
      'run.get'
    ]);

    f.requestNode.mockClear();
    const ownInput = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/runs/run-current/user-input/request-one',
      payload: { answers: { answer: 'yes' } }
    });
    expect(ownInput.statusCode).toBe(200);
    expect(f.requestNode).toHaveBeenLastCalledWith(
      'node-fixed',
      'run.user-input.respond',
      {
        runId: 'run-current',
        requestId: 'request-one',
        answers: { answer: 'yes' },
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current'
      },
      expect.objectContaining({
        userId: 7,
        sessionHash: 'share-session',
        workspaceId: 'workspace-fixed'
      })
    );

    const ownApproval = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/runs/run-current/approvals/approval-one/decision',
      payload: { nodeId: 'attacker-node', decision: 'REJECTED' }
    });
    expect(ownApproval.statusCode).toBe(200);
    expect(f.requestNode).toHaveBeenLastCalledWith(
      'node-fixed',
      'run.approval.decide',
      {
        runId: 'run-current',
        approvalId: 'approval-one',
        decision: 'REJECTED',
        workspaceId: 'workspace-fixed',
        sessionId: 'session-current'
      },
      expect.objectContaining({
        userId: 7,
        sessionHash: 'share-session',
        workspaceId: 'workspace-fixed'
      })
    );
    f.requestNode.mockClear();
    const invalidApproval = await f.app.inject({
      method: 'POST',
      url: '/api/session-shares/share-one/runs/run-current/approvals/approval-one/decision',
      payload: { decision: 'MAYBE' }
    });
    expect(invalidApproval.statusCode).toBe(400);
    expect(invalidApproval.json().error.code).toBe('APPROVAL_DECISION_INVALID');
    expect(f.requestNode).not.toHaveBeenCalled();

    const ownImage = await f.app.inject({
      url: '/api/session-shares/share-one/runs/run-current/images/0'
    });
    expect(ownImage.statusCode).toBe(200);
    expect(ownImage.rawPayload).toEqual(Buffer.from('png'));
    expect(f.requestNode).toHaveBeenLastCalledWith(
      'node-fixed',
      'run.image.read',
      { runId: 'run-current', imageIndex: 0 },
      { userId: 7, sessionHash: 'share-session', workspaceId: 'workspace-fixed' }
    );

    f.requestNode.mockClear();
    const wrongNative = await f.app.inject({
      url: '/api/session-shares/share-one/runs/native-history:session-other/images/reference'
    });
    expect(wrongNative.statusCode).toBe(400);
    expect(wrongNative.json().error.code).toBe('RUN_IMAGE_INVALID');
    expect(f.requestNode).not.toHaveBeenCalled();
    const native = await f.app.inject({
      url: '/api/session-shares/share-one/runs/native-history:session-current/images/file:reference'
    });
    expect(native.statusCode).toBe(200);
    expect(f.requestNode).toHaveBeenCalledWith(
      'node-fixed',
      'run.image.read',
      { runId: 'native-history:session-current', imageRef: 'file:reference' },
      { userId: 7, sessionHash: 'share-session', workspaceId: 'workspace-fixed' }
    );
  });

  it('rejects new file reads after share authorization is revoked', async () => {
    const f = await fixture();
    f.setActive(false);
    const response = await f.app.inject({
      url: '/api/session-shares/share-one/files/read?path=notes.txt&offset=0&limit=10'
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('SESSION_SHARE_NOT_FOUND');
    expect(f.requestNode).not.toHaveBeenCalled();
  });
});
