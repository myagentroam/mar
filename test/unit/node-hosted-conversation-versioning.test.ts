import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupHostedConversationRuntimeFixtures,
  createConversation,
  createRequest,
  draft,
  modelOne,
  modelTwo,
  runtimeFixture,
  seedVersion,
  stdioMcpSnapshot
} from './support/hosted-conversation-runtime-fixture.js';

afterEach(cleanupHostedConversationRuntimeFixtures);

describe('Node hosted conversation runtime', () => {
  it('keeps the active version and retries the latest version when an allowed model becomes available', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    await seedVersion(fixture, 'version-2', 2, {
      ...draft,
      allowedModels: [{ modelId: 'model-2', name: 'Model Two' }],
      defaultModelId: 'model-2'
    });
    await expect(
      fixture.service.operations()['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId: 'message-upgrade-without-models',
        prompt: 'Wait until an allowed model becomes available.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModels: []
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_UPGRADE_FAILED');
    expect(fixture.runtime.startRun).not.toHaveBeenCalled();
    expect(
      fixture.database.raw
        .prepare('SELECT active_version_id,status,model_id FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({
      active_version_id: 'version-1',
      status: 'ACTIVE',
      model_id: 'model-1'
    });

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-upgrade-with-model',
      prompt: 'Use the latest version now.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModels: [modelTwo]
    });
    expect(fixture.runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'model-2' })
    );
    expect(
      fixture.database.raw
        .prepare('SELECT active_version_id,status,model_id FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({
      active_version_id: 'version-2',
      status: 'ACTIVE',
      model_id: 'model-2'
    });
  });

  it('atomically upgrades at the next Run boundary and keeps history, uploads and output directories', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversation.id);
    await writeFile(join(paths.uploadsDirectory, 'input.txt'), 'input');
    await writeFile(join(paths.outputDirectory, 'result.txt'), 'result');
    await seedVersion(fixture, 'version-2', 2, {
      ...draft,
      allowedModels: [{ modelId: 'model-2', name: 'Model Two' }],
      defaultModelId: 'model-2'
    });
    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-upgrade',
      prompt: 'Use the new version.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelTwo,
      __marAgentModels: [modelOne, modelTwo]
    });

    expect(fixture.runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining(
          'The Host-declared mounts are the complete file boundary.'
        ),
        modelId: 'model-2',
        mcpServers: [],
        webAccess: false
      })
    );
    expect(
      fixture.database.raw
        .prepare('SELECT active_version_id,status,model_id FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({
      active_version_id: 'version-2',
      status: 'ACTIVE',
      model_id: 'model-2'
    });
    await expect(readFile(join(paths.uploadsDirectory, 'input.txt'), 'utf8')).resolves.toBe(
      'input'
    );
    await expect(readFile(join(paths.outputDirectory, 'result.txt'), 'utf8')).resolves.toBe(
      'result'
    );
  });

  it('keeps the old version when the upgraded Run cannot start', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    await seedVersion(fixture, 'version-2', 2, draft);
    fixture.runtime.startRun.mockRejectedValueOnce(new Error('RUN_START_FAILED'));

    await expect(
      fixture.service.operations()['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId: 'message-upgrade-start-failed',
        prompt: 'Do not commit the new version before the Run starts.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: modelOne,
        __marAgentModels: [modelOne]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_UPGRADE_FAILED');
    expect(
      fixture.database.raw
        .prepare('SELECT active_version_id,model_id FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ active_version_id: 'version-1', model_id: 'model-1' });
    expect(
      fixture.database.raw
        .prepare('SELECT id,reference_count FROM conversation_template_versions ORDER BY id')
        .all()
    ).toEqual([
      { id: 'version-1', reference_count: 1 },
      { id: 'version-2', reference_count: 0 }
    ]);
  });

  it('creates a conversation without recursively revalidating published template content', async () => {
    const fixture = await runtimeFixture();
    const versionDirectory = fixture.store.templateVersionDirectory('template_version_1');
    const instructions = join(versionDirectory, 'content', 'instructions.md');
    await chmod(instructions, 0o600);
    await writeFile(instructions, 'changed after publication');

    await expect(
      fixture.service.operations()['conversation.hosted.create']!({
        ...createRequest(),
        clientRequestId: 'create-after-published-content-change'
      })
    ).resolves.toMatchObject({
      conversation: { id: 'conversation-1', activeVersionId: 'version-1' }
    });
    expect(fixture.runtime.createSession).toHaveBeenCalledOnce();
  });

  it('rejects a version whose content root is no longer sealed', async () => {
    const fixture = await runtimeFixture();
    const contentDirectory = join(
      fixture.store.templateVersionDirectory('template_version_1'),
      'content'
    );
    await chmod(contentDirectory, 0o755);

    await expect(
      fixture.service.operations()['conversation.hosted.create']!({
        ...createRequest(),
        clientRequestId: 'create-with-unsealed-content-root'
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    expect(fixture.runtime.createSession).not.toHaveBeenCalled();
  });

  it('upgrades without recursively revalidating published candidate content', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const version = await seedVersion(fixture, 'version-tampered', 2, draft);
    await chmod(join(version.contentDirectory, 'instructions.md'), 0o600);
    await writeFile(join(version.contentDirectory, 'instructions.md'), 'tampered');

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-upgrade-with-published-content-change',
      prompt: 'Use the current published candidate.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    expect(fixture.runtime.startRun).toHaveBeenCalledOnce();
    expect(
      fixture.database.raw
        .prepare('SELECT active_version_id,status FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({
      active_version_id: 'version-tampered',
      status: 'ACTIVE'
    });
  });

  it('starts an active-version Run without recursively revalidating published content', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const versionDirectory = fixture.store.templateVersionDirectory('template_version_1');
    await chmod(join(versionDirectory, 'content', 'instructions.md'), 0o600);
    await writeFile(join(versionDirectory, 'content', 'instructions.md'), 'tampered');

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-active-version-with-published-content-change',
      prompt: 'Continue with the active version.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    expect(fixture.runtime.startRun).toHaveBeenCalledOnce();
  });

  it('keeps the active version when the latest MCP snapshot cannot resolve its secret', async () => {
    const fixture = await runtimeFixture({ secretEnvironment: {} });
    const conversation = await createConversation(fixture);
    await seedVersion(
      fixture,
      'version-mcp-secret-missing',
      2,
      {
        ...draft,
        revision: 2,
        mcpIds: ['mcp-stdio']
      },
      'AVAILABLE',
      [stdioMcpSnapshot]
    );
    await expect(
      fixture.service.operations()['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId: 'message-upgrade-mcp-secret-missing',
        prompt: 'Do not activate an unusable version.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: modelOne,
        __marAgentModels: [modelOne]
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_UPGRADE_FAILED');
    expect(fixture.runtime.startRun).not.toHaveBeenCalled();
    expect(
      fixture.database.raw
        .prepare('SELECT active_version_id,status FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({
      active_version_id: 'version-1',
      status: 'ACTIVE'
    });
  });

  it('retains the active version and stops future upgrades when Server confirms template deletion', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const paths = fixture.store.pathsForConversation(7, conversation.id);
    await seedVersion(fixture, 'version-2', 2, {
      ...draft,
      allowedModels: [{ modelId: 'model-2', name: 'Model Two' }],
      defaultModelId: 'model-2'
    });
    const retained = (await fixture.service.operations()['conversation.hosted.get']!({
      conversationId: conversation.id,
      __requestUserId: 7,
      __marAgentModels: [modelOne, modelTwo],
      __templateDeleted: true
    })) as {
      conversation: {
        activeVersionId: string;
        status: string;
      };
      template: { status: string; available: boolean };
    };

    expect(retained).toMatchObject({
      conversation: {
        activeVersionId: 'version-1',
        status: 'ACTIVE'
      },
      template: { status: 'DELETED', available: false }
    });
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toMatchObject({
      activeVersionId: 'version-1',
      status: 'ACTIVE',
      templateDeleted: true
    });
    expect(
      fixture.database.raw
        .prepare(
          `SELECT id,status,reference_count FROM conversation_template_versions
           ORDER BY version_number`
        )
        .all()
    ).toEqual([
      { id: 'version-1', status: 'RETAINED', reference_count: 1 },
      { id: 'version-2', status: 'AVAILABLE', reference_count: 0 }
    ]);

    await fixture.service.operations()['conversation.hosted.get']!({
      conversationId: conversation.id,
      __requestUserId: 7,
      __marAgentModels: [modelOne, modelTwo],
      __templateDeleted: true
    });
    expect(
      fixture.database.raw
        .prepare('SELECT id,status,reference_count FROM conversation_template_versions ORDER BY id')
        .all()
    ).toEqual([
      { id: 'version-1', status: 'RETAINED', reference_count: 1 },
      { id: 'version-2', status: 'AVAILABLE', reference_count: 0 }
    ]);

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-after-template-delete',
      prompt: 'Continue with the retained version.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne, modelTwo]
    });
    expect(fixture.runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining(
          'The Host-declared mounts are the complete file boundary.'
        ),
        modelId: 'model-1',
        mcpServers: [],
        webAccess: false
      })
    );
  });
});
