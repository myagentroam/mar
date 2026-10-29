import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workbenchNodeOperationSchema } from '../../packages/protocol/src/index.js';
import {
  cleanupHostedConversationRuntimeFixtures,
  createConversation,
  createRequest,
  deferredRun,
  draft,
  modelOne,
  modelOneAlternative,
  modelTwo,
  runtimeFixture,
  seedVersion
} from './support/hosted-conversation-runtime-fixture.js';

afterEach(cleanupHostedConversationRuntimeFixtures);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function fixture() {
  const f = await runtimeFixture();
  const conversation = await createConversation(f);
  const target = {
    ...draft,
    templateId: 'template-2',
    name: 'Office',
    description: 'Office template',
    allowedModels: [{ modelId: 'model-two', name: 'Model Two' }],
    defaultModelId: 'model-two'
  };
  await seedVersion(f, 'office-v1', 1, target);
  const request = {
    conversationId: conversation.id,
    templateId: target.templateId,
    expectedTemplateId: draft.templateId,
    __requestUserId: 7,
    __marAgentModels: [modelOne, modelTwo],
    __template: {
      ...createRequest().__template,
      id: target.templateId,
      name: target.name,
      description: target.description,
      currentVersionId: 'office-v1'
    }
  };
  return {
    ...f,
    conversation,
    target,
    request,
    switchTemplate: f.service.operations()['conversation.hosted.template.switch']!
  };
}

describe('Node hosted conversation template switch', () => {
  it('rejects a delayed rollback authorized for the former template before reading or changing history', async () => {
    const f = await fixture();
    try {
      await f.switchTemplate(f.request);
      f.runtime.history.mockClear();
      await expect(async () =>
        f.service.operations()['conversation.hosted.rollback']!({
          conversationId: f.conversation.id,
          turnId: 'turn-1',
          itemId: 'item-1',
          boundary: 'turn-0',
          __requestUserId: 7,
          __sourceTemplateId: 'template-1',
          __marAgentModels: [modelOne]
        })
      ).rejects.toThrow('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');
      expect(f.runtime.history).not.toHaveBeenCalled();
      expect(f.runtime.rollback).not.toHaveBeenCalled();
      expect(f.store.requireConversation(7, f.conversation.id).templateId).toBe('template-2');
    } finally {
      await f.service.dispose();
    }
  });

  it('restores the original binding on a failed commit and rebuilds references after a successful switch', async () => {
    const f = await fixture();
    const before = f.store.requireConversation(7, f.conversation.id);
    const referenceCounts = () =>
      f.database.raw
        .prepare('SELECT id,reference_count FROM conversation_template_versions ORDER BY id')
        .all();
    const originalReferences = referenceCounts();
    f.database.raw.exec(`CREATE TRIGGER reject_target_reference
      BEFORE UPDATE OF reference_count ON conversation_template_versions
      WHEN NEW.id='office-v1' AND NEW.reference_count > OLD.reference_count
      BEGIN SELECT RAISE(ABORT, 'TEST_TEMPLATE_SWITCH'); END`);
    try {
      await expect(f.switchTemplate(f.request)).rejects.toThrow('TEST_TEMPLATE_SWITCH');
      expect(f.store.requireConversation(7, f.conversation.id)).toEqual(before);
      const manifest = f.store.pathsForConversation(7, f.conversation.id).manifestPath;
      expect(JSON.parse(await readFile(manifest, 'utf8'))).toEqual(before);
      expect(referenceCounts()).toEqual(originalReferences);
      f.database.raw.exec('DROP TRIGGER reject_target_reference');
      await f.switchTemplate(f.request);
      await f.store.rebuildConversationIndex();
      expect(f.store.requireConversation(7, f.conversation.id)).toMatchObject({
        sessionId: before.sessionId,
        templateId: 'template-2',
        activeVersionId: 'office-v1'
      });
      expect(referenceCounts()).toEqual(
        [
          { id: 'office-v1', reference_count: 1 },
          { id: before.activeVersionId, reference_count: 0 }
        ].sort((left, right) => left.id.localeCompare(right.id))
      );
    } finally {
      await f.service.dispose();
    }
  });

  it('uses the new template instructions, network policy and MCP on the original Session', async () => {
    const f = await fixture();
    await seedVersion(
      f,
      'office-environment',
      2,
      {
        ...f.target,
        networkMode: 'UNRESTRICTED',
        mcpIds: ['public-mcp']
      },
      'AVAILABLE',
      [
        {
          id: 'public-mcp',
          serverName: 'public-tools',
          displayName: 'Public tools',
          version: '1.0.0',
          origin: 'NODE',
          transport: 'HTTP',
          runtime: { transport: 'HTTP', url: 'https://mcp.example.test/tools' },
          configuration: {}
        }
      ]
    );
    try {
      await f.switchTemplate({
        ...f.request,
        __template: { ...f.request.__template, currentVersionId: 'office-environment' }
      });
      await f.service.operations()['conversation.hosted.message']!({
        conversationId: f.conversation.id,
        clientMessageId: 'environment-after-switch',
        prompt: 'Continue.',
        attachmentIds: [],
        __requestUserId: 7,
        __sourceTemplateId: 'template-2',
        __marAgentModels: [modelOne, modelTwo]
      });
      const run = f.runtime.startRun.mock.calls[0]![0];
      expect(run.sessionId).toBe(f.conversation.sessionId);
      expect(await readFile(join(run.workspaceDirectory, 'instructions.md'), 'utf8')).toBe(
        'version-2'
      );
      expect(run.systemInstruction).toContain('published remote HTTP MCP may access networks');
      expect(run.webAccess).toBe(true);
      expect(run.mcpServers).toEqual([
        expect.objectContaining({
          name: 'public-tools',
          transport: 'HTTP',
          url: 'https://mcp.example.test/tools',
          authorizationIdentity: 'user:7'
        })
      ]);
    } finally {
      for (const pending of f.pendingRuns) {
        pending.handle.cancel.mockImplementation(() => {
          pending.complete({ status: 'INTERRUPTED', completedAt: 3_000 });
          return true;
        });
      }
      await f.service.dispose();
    }
  });

  it('occupies the conversation before awaiting the template commit and rejects competing writes', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const commit = f.store.updateConversation.bind(f.store);
    vi.spyOn(f.store, 'updateConversation').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return commit(...args);
    });
    const switching = f.switchTemplate(f.request);
    try {
      await entered.promise;
      expect(() => f.switchTemplate(f.request)).toThrow('HOSTED_CONVERSATION_STATE_INVALID');
      await expect(
        f.service.operations()['conversation.hosted.message']!({
          conversationId: f.conversation.id,
          clientMessageId: 'during-switch',
          prompt: 'Wait.',
          attachmentIds: [],
          __requestUserId: 7,
          __sourceTemplateId: 'template-1',
          __marAgentModels: [modelOne]
        })
      ).rejects.toThrow('HOSTED_CONVERSATION_STATE_INVALID');
      expect(() =>
        f.service.operations()['conversation.hosted.config.update']!({
          conversationId: f.conversation.id,
          modelId: 'model-1',
          __requestUserId: 7,
          __sourceTemplateId: 'template-1',
          __marAgentModels: [modelOne]
        })
      ).toThrow('HOSTED_CONVERSATION_STATE_INVALID');
      expect(f.runtime.startRun).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await switching;
      await f.service.dispose();
    }
  });

  it('rejects a late old-template model refresh without overwriting the new binding', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const refresh = f.store.updateConversation.bind(f.store);
    vi.spyOn(f.store, 'updateConversation').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return refresh(...args);
    });
    const reading = Promise.resolve(
      f.service.operations()['conversation.hosted.get']!({
        conversationId: f.conversation.id,
        __requestUserId: 7,
        __sourceTemplateId: 'template-1',
        __marAgentModels: [modelOneAlternative]
      })
    );
    const rejected = expect(reading).rejects.toThrow('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');
    try {
      await entered.promise;
      await f.switchTemplate(f.request);
      release.resolve();
      await rejected;
      expect(f.store.requireConversation(7, f.conversation.id)).toMatchObject({
        templateId: 'template-2',
        activeVersionId: 'office-v1',
        modelId: 'model-2'
      });
    } finally {
      release.resolve();
      await reading.catch(() => undefined);
      await f.service.dispose();
    }
  });

  it('registers the switch as a fixed Workbench Node operation', () => {
    expect(workbenchNodeOperationSchema.parse('conversation.hosted.template.switch')).toBe(
      'conversation.hosted.template.switch'
    );
  });

  it('preserves the Session and files, switches the next Run environment and never returns credentials', async () => {
    const f = await fixture();
    try {
      const paths = f.store.pathsForConversation(7, f.conversation.id);
      await writeFile(join(paths.uploadsDirectory, 'input.txt'), 'input');
      await writeFile(join(paths.outputDirectory, 'result.txt'), 'result');
      await f.store.reconcileFiles(7, f.conversation.id);
      const files = f.store.listFiles(7, f.conversation.id);
      const result = await f.switchTemplate(f.request);
      expect(result).toMatchObject({
        conversation: {
          id: f.conversation.id,
          sessionId: f.conversation.sessionId,
          templateId: 'template-2',
          activeVersionId: 'office-v1',
          modelId: 'model-2'
        },
        template: { id: 'template-2', name: 'Office', currentVersionId: 'office-v1' },
        models: [{ id: 'model-2' }]
      });
      expect(JSON.stringify(result)).not.toContain('secret-');
      expect(f.runtime.createSession).toHaveBeenCalledOnce();
      expect(f.runtime.startRun).not.toHaveBeenCalled();
      expect(f.store.requireConversation(7, f.conversation.id).clientRequestId).toBe(
        'create-request-1'
      );
      expect(await readFile(join(paths.uploadsDirectory, 'input.txt'), 'utf8')).toBe('input');
      expect(await readFile(join(paths.outputDirectory, 'result.txt'), 'utf8')).toBe('result');
      expect(f.store.listFiles(7, f.conversation.id)).toEqual(files);
      await f.service.operations()['conversation.hosted.message']!({
        conversationId: f.conversation.id,
        clientMessageId: 'after-switch',
        prompt: 'Continue.',
        attachmentIds: [],
        __requestUserId: 7,
        __sourceTemplateId: 'template-2',
        __marAgentModels: [modelOne, modelTwo]
      });
      expect(f.runtime.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: f.conversation.sessionId,
          modelId: 'model-2',
          pathMounts: expect.arrayContaining([
            expect.objectContaining({
              logicalPath: '/workspace',
              physicalPath: expect.stringContaining('office_v1')
            })
          ])
        })
      );
    } finally {
      for (const pending of f.pendingRuns) {
        pending.handle.cancel.mockImplementation(() => {
          pending.complete({ status: 'INTERRUPTED', completedAt: 3_000 });
          return true;
        });
      }
      await f.service.dispose();
    }
  });

  it('keeps the current model when the target permits it', async () => {
    const f = await fixture();
    await seedVersion(f, 'office-v2', 2, {
      ...f.target,
      allowedModels: draft.allowedModels,
      defaultModelId: draft.defaultModelId
    });
    const result = await f.switchTemplate({
      ...f.request,
      __template: { ...f.request.__template, currentVersionId: 'office-v2' }
    });
    expect(result).toMatchObject({
      conversation: { modelId: 'model-1', activeVersionId: 'office-v2' }
    });
    await f.service.dispose();
  });

  it('does not upgrade or mutate an already selected template even if a newer version was published', async () => {
    const f = await fixture();
    await f.switchTemplate(f.request);
    const before = f.store.requireConversation(7, f.conversation.id);
    await seedVersion(f, 'office-v2', 2, f.target);
    f.setNow(9_000);
    const result = await f.switchTemplate({
      ...f.request,
      __template: { ...f.request.__template, currentVersionId: 'office-v2' }
    });
    expect(f.store.requireConversation(7, f.conversation.id)).toEqual(before);
    expect(result).toMatchObject({
      conversation: { activeVersionId: 'office-v1' },
      template: { currentVersionId: 'office-v1' }
    });
    await f.service.dispose();
  });

  it('rejects a stale expected template without changing the current binding', async () => {
    const f = await fixture();
    const before = f.store.requireConversation(7, f.conversation.id);

    await expect(
      f.switchTemplate({ ...f.request, expectedTemplateId: 'template-stale' })
    ).rejects.toThrow('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');

    expect(f.store.requireConversation(7, f.conversation.id)).toEqual(before);
    expect(f.workbenchEvents).toHaveLength(0);
    await f.service.dispose();
  });

  it('does not switch while a Run is active', async () => {
    const f = await fixture();
    const pending = deferredRun('run-template-switch-blocked');
    f.runtime.startRun.mockImplementationOnce(async () => {
      f.pendingRuns.push(pending);
      return pending.handle;
    });

    try {
      await f.service.operations()['conversation.hosted.message']!({
        conversationId: f.conversation.id,
        clientMessageId: 'message-before-template-switch',
        prompt: 'Keep this Run on the current template.',
        attachmentIds: [],
        __requestUserId: 7,
        __sourceTemplateId: 'template-1',
        __marAgentModel: modelOne,
        __marAgentModels: [modelOne]
      });
      const before = f.store.requireConversation(7, f.conversation.id);

      expect(() => f.switchTemplate(f.request)).toThrow('HOSTED_CONVERSATION_RUN_ACTIVE');

      expect(f.store.requireConversation(7, f.conversation.id)).toEqual(before);
      expect(f.runtime.startRun).toHaveBeenCalledOnce();
    } finally {
      pending.complete({ status: 'SUCCEEDED', completedAt: 6_000 });
      await f.service.dispose();
    }
  });

  it('invalidates the ready old Watch after commit and removes its lease', async () => {
    const f = await fixture();
    const watch = f.service.operations()['conversation.hosted.watch']!;
    const watchRequest = {
      conversationId: f.conversation.id,
      workbenchConnectionId: 'connection-1',
      watchId: 'watch-0001',
      __requestUserId: 7,
      __workspaceWatchSessionHash: 'session-hash',
      __sourceTemplateId: 'template-1',
      __marAgentModels: [modelOne]
    };

    try {
      await watch({ ...watchRequest, mode: 'initial' });
      await vi.waitFor(() => {
        expect(f.watchFrames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'watch.hosted-conversation.snapshot',
              watchId: 'watch-0001'
            })
          ])
        );
      });
      const frameCount = f.watchFrames.length;

      await f.switchTemplate(f.request);

      expect(f.watchFrames.slice(frameCount)).toEqual([
        expect.objectContaining({
          type: 'watch.hosted-conversation.event',
          watchId: 'watch-0001',
          templateId: 'template-1',
          event: expect.objectContaining({
            category: 'hosted-conversation',
            payload: { conversationId: f.conversation.id, kind: 'template-changed' }
          })
        })
      ]);
      await expect(watch({ ...watchRequest, mode: 'renew' })).rejects.toThrow(
        'HOSTED_CONVERSATION_TEMPLATE_CONFLICT'
      );
      await expect(
        watch({
          conversationId: f.conversation.id,
          mode: 'renew',
          workbenchConnectionId: 'connection-1',
          watchId: 'watch-0001',
          __requestUserId: 7,
          __workspaceWatchSessionHash: 'session-hash'
        })
      ).rejects.toThrow('SESSION_WATCH_NOT_FOUND');
    } finally {
      await f.service.dispose();
    }
  });

  it('rejects an old-template read after switching without mutating the new binding', async () => {
    const f = await fixture();
    await f.switchTemplate(f.request);
    const before = f.store.requireConversation(7, f.conversation.id);

    await expect(
      f.service.operations()['conversation.hosted.get']!({
        conversationId: f.conversation.id,
        __requestUserId: 7,
        __sourceTemplateId: 'template-1',
        __marAgentModels: [modelOne]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');

    expect(f.store.requireConversation(7, f.conversation.id)).toEqual(before);
    await f.service.dispose();
  });
});
