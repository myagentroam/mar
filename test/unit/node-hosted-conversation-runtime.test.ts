import { createHash } from 'node:crypto';
import { lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const filesystemGate = vi.hoisted(() => ({ wait: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      await filesystemGate.wait?.();
      return original.lstat(...args);
    }
  };
});
import { WorkspacePathResolver } from '../../mar-agent/src/tools/shared/path-resolver.js';
import { ReadTool } from '../../mar-agent/src/tools/local/read.js';
import { ApplyPatchTool } from '../../mar-agent/src/tools/local/apply-patch.js';
import type {
  HostedConversationSummary,
  MarAgentRuntimeModelConfiguration
} from '../../packages/protocol/src/index.js';
import {
  cleanupHostedConversationRuntimeFixtures,
  createConversation,
  createRequest,
  deferredRun,
  draft,
  hostedHistoryPage,
  hostedWebModel,
  httpMcpSnapshot,
  modelOne,
  modelOneAlternative,
  modelTwo,
  readManifest,
  runtimeFixture,
  seedVersion,
  stdioMcpSnapshot
} from './support/hosted-conversation-runtime-fixture.js';

afterEach(cleanupHostedConversationRuntimeFixtures);

describe('Node hosted conversation runtime', () => {
  it('reads only the authenticated conversation image namespace', async () => {
    const image = {
      name: 'generated.png',
      mime: 'image/png',
      dataBase64: Buffer.from('hosted-image').toString('base64')
    };
    const readImage = vi.fn(async () => image);
    const fixture = await runtimeFixture({ readImage });
    const conversation = await createConversation(fixture);
    const operation = fixture.service.operations()['conversation.hosted.image.read']!;
    const runId = `native-history:hosted:${conversation.id}`;

    await expect(
      operation({
        conversationId: conversation.id,
        runId,
        imageRef: 'file:session%3Agenerated.png',
        __requestUserId: 7
      })
    ).resolves.toEqual({ image });
    expect(readImage).toHaveBeenCalledWith(runId, 'file:session%3Agenerated.png');

    readImage.mockClear();
    await expect(
      operation({
        conversationId: conversation.id,
        runId: 'native-history:hosted:conversation-other',
        imageRef: 'file:session%3Agenerated.png',
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    await expect(
      operation({
        conversationId: conversation.id,
        runId,
        imageRef: 'file:session%3Agenerated.png',
        __requestUserId: 8
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    expect(readImage).not.toHaveBeenCalled();
  });

  it('matches template permissions by upstream model ID and preserves concrete configuration preference', async () => {
    const fixture = await runtimeFixture({
      versionDraft: {
        ...draft,
        allowedModels: [
          { modelId: 'model-one', name: 'Saved Model One' },
          { modelId: 'model-two', name: 'Saved Model Two' }
        ],
        defaultModelId: 'model-one'
      }
    });
    const conversation = await createConversation(fixture, [
      modelOneAlternative,
      modelTwo,
      modelOne
    ]);
    expect(conversation.modelId).toBe('model-1-alternative');

    const snapshot = (await fixture.service.operations()['conversation.hosted.get']!({
      conversationId: conversation.id,
      __requestUserId: 7,
      __marAgentModels: [modelOneAlternative, modelTwo, modelOne]
    })) as { models: readonly { id: string }[] };
    expect(snapshot.models.map((model) => model.id)).toEqual([
      'model-1-alternative',
      'model-2',
      'model-1'
    ]);

    await fixture.service.operations()['conversation.hosted.config.update']!({
      conversationId: conversation.id,
      modelId: 'model-2',
      __requestUserId: 7,
      __marAgentModels: [modelOneAlternative, modelTwo, modelOne]
    });
    const recoveredSnapshot = (await fixture.service.operations()['conversation.hosted.get']!({
      conversationId: conversation.id,
      __requestUserId: 7,
      __marAgentModels: [modelOne, modelOneAlternative]
    })) as { conversation: { modelId: string } };
    expect(recoveredSnapshot.conversation.modelId).toBe('model-1');
    expect(fixture.store.requireConversation(7, conversation.id).modelId).toBe('model-1');

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-model-fallback',
      prompt: 'Use the current visible fallback.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModels: [modelOne, modelOneAlternative]
    });
    expect(fixture.runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'model-1' })
    );
  });

  it('projects runtime credential models without exposing private runtime fields', async () => {
    const fixture = await runtimeFixture();
    const { credential: _credential, ...modelConfiguration } = modelOne;
    void _credential;
    const runtimeModel = {
      ...modelConfiguration,
      inputCapabilities: ['TEXT', 'IMAGE'],
      credential: {
        type: 'RUNTIME_TICKET',
        credentialId: 'credential-1',
        ticket: {
          userId: 7,
          credentialId: 'credential-1',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          runtimeScopeId: 'scope-1',
          allowedModelIds: ['model-1'],
          issuedAt: 1_000,
          expiresAt: 901_000,
          nonce: 'ticket-1',
          signature: 'a'.repeat(64)
        }
      },
      imageGeneration: {
        generateEndpoint: 'https://models.example.test/v1/images/generations',
        editEndpoint: 'https://models.example.test/v1/images/edits',
        imageModelId: 'gpt-image-2',
        httpVersion: '1.1'
      }
    } satisfies MarAgentRuntimeModelConfiguration;

    const created = (await fixture.service.operations()['conversation.hosted.create']!({
      ...createRequest([runtimeModel]),
      __marAgentRuntimeScopeId: 'scope-1'
    })) as {
      conversation: HostedConversationSummary;
      models: readonly Record<string, unknown>[];
    };
    expect(fixture.runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeScopeId: 'scope-1',
        models: [expect.objectContaining({ ...runtimeModel, codeMode: false })]
      })
    );
    expect(created.models).toEqual([
      expect.objectContaining({
        id: 'model-1',
        modelId: 'model-one',
        codeMode: false
      })
    ]);
    expect(created.models[0]).not.toHaveProperty('apiKey');
    expect(created.models[0]).not.toHaveProperty('credential');
    expect(created.models[0]).not.toHaveProperty('imageGeneration');

    const opened = (await fixture.service.operations()['conversation.hosted.get']!({
      conversationId: created.conversation.id,
      __requestUserId: 7,
      __marAgentModels: [runtimeModel]
    })) as { models: readonly Record<string, unknown>[] };
    expect(opened.models).toEqual(created.models);
  });

  it('preserves the authorized model order and model capabilities for the MAR Agent SDK', async () => {
    const fixture = await runtimeFixture({
      versionDraft: {
        ...draft,
        allowedModels: [
          { modelId: 'model-one', name: 'Model One' },
          { modelId: 'model-two', name: 'Model Two' }
        ]
      }
    });
    const titleModel = { ...modelTwo, titleGeneration: true, codeMode: true };

    await fixture.service.operations()['conversation.hosted.create']!(
      createRequest([titleModel, modelOne])
    );

    expect(fixture.runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultModelId: 'model-1',
        models: [
          expect.objectContaining({ id: 'model-2', titleGeneration: true, codeMode: true }),
          expect.objectContaining({ id: 'model-1' })
        ]
      })
    );
  });

  it('rejects a schema v1 sealed version that uses legacy model configuration IDs', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const row = fixture.database.raw
      .prepare('SELECT manifest FROM conversation_template_versions WHERE id=?')
      .get('version-1') as { manifest: string };
    const persisted = JSON.parse(row.manifest) as {
      schemaVersion: number;
      sourceWorkspacePath?: string;
      directories?: readonly string[];
      entries?: readonly {
        kind: string;
        relativePath: string;
        size: number;
        executable: boolean;
        sha256: string;
      }[];
      files?: readonly {
        relativePath: string;
        size: number;
        executable: boolean;
        sha256: string;
      }[];
      contentHash: string;
      draft: Record<string, unknown>;
    };
    const legacyDraft = { ...persisted.draft };
    delete legacyDraft.allowedModels;
    legacyDraft.allowedModelIds = ['model-1'];
    legacyDraft.defaultModelId = 'model-1';
    const files = (persisted.entries ?? []).map(({ relativePath, size, executable, sha256 }) => ({
      relativePath,
      size,
      executable,
      sha256
    }));
    persisted.schemaVersion = 1;
    persisted.files = files;
    persisted.contentHash = createHash('sha256')
      .update(files.map((file) => `${file.relativePath}\0${file.size}\0${file.sha256}`).join('\n'))
      .digest('hex');
    delete persisted.sourceWorkspacePath;
    delete persisted.directories;
    delete persisted.entries;
    persisted.draft = legacyDraft;
    const manifestJson = JSON.stringify(persisted);
    const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
    const manifestPath = join(
      fixture.store.templateVersionDirectory('template_version_1'),
      'manifest.json'
    );
    await writeFile(manifestPath, manifestJson);
    fixture.database.raw
      .prepare(
        'UPDATE conversation_template_versions SET manifest=?,manifest_hash=?,content_hash=? WHERE id=?'
      )
      .run(manifestJson, manifestHash, persisted.contentHash, 'version-1');

    await expect(
      fixture.service.operations()['conversation.hosted.get']!({
        conversationId: conversation.id,
        __requestUserId: 7,
        __marAgentModels: [modelOneAlternative, modelOne]
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestJson);
    expect(
      fixture.database.raw
        .prepare('SELECT manifest,manifest_hash FROM conversation_template_versions WHERE id=?')
        .get('version-1')
    ).toEqual({ manifest: manifestJson, manifest_hash: manifestHash });
  });

  it('creates one isolated MAR Agent Session storage HOME idempotently and always starts Full Access runs', async () => {
    const fixture = await runtimeFixture();
    const create = fixture.service.operations()['conversation.hosted.create']!;
    const first = (await create(createRequest([modelOne, modelTwo]))) as {
      conversation: { id: string; sessionId: string };
    };
    const repeated = (await create(createRequest([modelOne, modelTwo]))) as {
      conversation: { id: string; sessionId: string };
    };

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      conversation: {
        id: 'conversation-1',
        sessionId: 'session-1',
        modelId: 'model-1',
        title: 'New conversation',
        titleSource: 'DEFAULT'
      },
      template: {
        id: 'template-1',
        currentVersionId: 'version-1',
        available: true
      },
      run: null,
      turns: [],
      files: [],
      models: [{ id: 'model-1', modelId: 'model-one' }],
      error: null,
      snapshotSequence: 0
    });
    const listed = (await fixture.service.operations()['conversation.hosted.list']!({
      limit: 20,
      __requestUserId: 7
    })) as { items: HostedConversationSummary[] };
    expect(listed.items[0]).toMatchObject({
      id: 'conversation-1',
      title: 'New conversation',
      titleSource: 'DEFAULT'
    });
    expect(fixture.runtime.createSession).toHaveBeenCalledTimes(1);
    const created = fixture.runtime.createSession.mock.calls[0]![0];
    expect(created.homeDirectory).toContain('/users/');
    expect(created.homeDirectory).toContain('/sessions/');
    expect(created.homeDirectory).toMatch(/\/home$/u);
    expect(created.workspaceDirectory).toMatch(/\/content$/u);
    expect(created.systemInstruction).toContain(
      'The Host-declared mounts are the complete file boundary.'
    );
    expect(created.systemInstruction).toContain(
      'Within /workspace, only /workspace/inbox and /workspace/output are writable.'
    );
    expect(created.systemInstruction).toContain(
      'Do not rely on HOME files or shell state persisting between tool executions.'
    );
    expect(created.systemInstruction).not.toContain(
      'Only /workspace/inbox and /workspace/output are writable.'
    );
    expect(created.systemInstruction).not.toMatch(/PowerPoint|LibreOffice|PPT|PDF|Word/);

    expect(created.systemInstruction).toContain(
      'The Host enforces this file boundary, and local processes run inside an operating-system sandbox.'
    );
    expect(created.systemInstruction).toContain(
      'The published workspace is an immutable administrator-maintained template snapshot. Changes to the reusable template must be made in its source Workspace and published as a new version.'
    );
    expect(created.systemInstruction).toContain(
      'At the start of each run, read /workspace/inbox/AGENTS.md if it exists.'
    );
    expect(created.systemInstruction).toContain(
      'Automatically identify requirements, preferences, terminology, conventions, quality checks, and recurring workflows'
    );
    expect(created.systemInstruction).toContain(
      'When continuing guidance appears, read the existing /workspace/inbox/AGENTS.md first'
    );
    expect(created.systemInstruction).toContain(
      'Do not automatically persist requirements that apply only to the current task'
    );
    expect(created.systemInstruction).toContain(
      'Treat /workspace/output as the current deliverable set, not an append-only history of runs.'
    );
    expect(created.systemInstruction).toContain(
      'Store disposable intermediate work in /tmp. It is reused across runs in this conversation, but the Host may clear it according to the system temporary-directory lifecycle.'
    );
    expect(created.systemInstruction).toContain(
      'Place final deliverables in appropriate paths under /workspace/output so they become user-visible outputs.'
    );
    expect(created.systemInstruction).toContain(
      'When reporting an output file to the user, use a Markdown link in the exact form [relative/path](/workspace/output/relative/path) so the user can open its controlled preview or download.'
    );
    expect(created.systemInstruction).not.toContain(
      'Generated images from this conversation remain available'
    );
    expect(created.systemInstruction).toContain(
      '/home/template source/version-1/工作区/inbox and /home/template source/version-1/工作区/output are aliases of the same writable overlays.'
    );
    expect(created.systemInstruction).toContain('Network access is disabled.');
    expect(created.systemInstruction).not.toContain('Version one instruction.');
    expect(created.defaultModelId).toBe('model-1');
    expect(created.models[0]).toMatchObject({
      id: 'model-1',
      credential: { type: 'INLINE_API_KEY', value: 'secret-1' }
    });
    expect(created.models.map((model) => model.id)).toEqual(['model-1']);
    expect(created.pathMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logicalPath: '/workspace', writable: false }),
        expect.objectContaining({ logicalPath: '/workspace/inbox', writable: true }),
        expect.objectContaining({ logicalPath: '/workspace/output', writable: true }),
        expect.objectContaining({
          logicalPath: '/home/template source/version-1/工作区',
          writable: false
        }),
        expect.objectContaining({
          logicalPath: '/home/template source/version-1/工作区/inbox',
          writable: true
        }),
        expect.objectContaining({
          logicalPath: '/home/template source/version-1/工作区/output',
          writable: true
        })
      ])
    );
    await expect(stat(created.homeDirectory)).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    });
    expect(fixture.processExecutorFactory.mock.calls[0]![0]).not.toHaveProperty('homeDirectory');
    expect(fixture.processExecutorFactory.mock.calls[0]![0]).toMatchObject({
      sourceWorkspacePath: '/home/template source/version-1/工作区'
    });

    const message = fixture.service.operations()['conversation.hosted.message']!;
    const accepted = (await message({
      conversationId: first.conversation.id,
      clientMessageId: 'message-1',
      prompt: 'Create a report.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne, modelTwo]
    })) as { run: { id: string } };
    expect(accepted.run.id).toBe('run-1');
    expect(fixture.runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        access: 'full-access',
        modelId: 'model-1',
        clientMessageId: 'message-1',
        prompt: 'Create a report.',
        mcpServers: [],
        webAccess: false,
        models: [expect.objectContaining({ id: 'model-1' })]
      })
    );
    const runInput = fixture.runtime.startRun.mock.calls[0]![0];
    expect(runInput.systemInstruction).toContain(
      'If it is missing, report that fact; regenerate only when requested or authorized by the user.'
    );
    expect(runInput.systemInstruction).toContain(
      'Generated images from this conversation remain available across executions in the read-only /home/mar/.mar/agent/sessions/session-1/generated_images directory.'
    );
    expect(runInput.systemInstruction).toContain(
      'copy the existing file from /home/mar/.mar/agent/sessions/session-1/generated_images to /workspace/output when available'
    );
    expect(runInput.systemInstruction).toContain(
      'When reporting an output file to the user, use a Markdown link in the exact form [relative/path](/workspace/output/relative/path) so the user can open its controlled preview or download.'
    );
    expect(runInput.pathMounts).toContainEqual({
      logicalPath: '/home/mar/.mar/agent/sessions/session-1/generated_images',
      physicalPath: expect.stringMatching(
        /\/home\/\.mar\/agent\/sessions\/session-1\/generated_images$/u
      ),
      writable: false
    });
    expect(fixture.processExecutorFactory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generatedImagesDirectory: expect.stringMatching(
          /\/home\/\.mar\/agent\/sessions\/session-1\/generated_images$/u
        ),
        generatedImagesLogicalPath: '/home/mar/.mar/agent/sessions/session-1/generated_images'
      })
    );
    expect(JSON.stringify(await readManifest(created.homeDirectory))).not.toContain('secret-1');
  });

  it('reuses one isolated temporary directory across Runs in the same conversation', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const message = fixture.service.operations()['conversation.hosted.message']!;

    await message({
      conversationId: conversation.id,
      clientMessageId: 'message-tmp-first',
      prompt: 'Save progress.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    const first = fixture.runtime.startRun.mock.calls[0]![0];
    await writeFile(join(first.temporaryDirectory, 'progress.txt'), 'first-run-progress');
    fixture.pendingRuns[0]!.complete({ status: 'SUCCEEDED', completedAt: 3_000 });
    let releaseDisable: (() => void) | undefined;
    await vi.waitFor(() => {
      releaseDisable = fixture.service.prepareForDisable();
      expect(releaseDisable).toBeTypeOf('function');
    });
    releaseDisable!();
    expect(fixture.store.listFiles(7, conversation.id)).toEqual([]);
    expect(fixture.store.requireConversation(7, conversation.id).quota.usedBytes).toBe(0);

    await message({
      conversationId: conversation.id,
      clientMessageId: 'message-tmp-second',
      prompt: 'Resume progress.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    const second = fixture.runtime.startRun.mock.calls[1]![0];
    expect(second.temporaryDirectory).toBe(first.temporaryDirectory);
    const paths = new WorkspacePathResolver(second.workspaceDirectory, {
      restrictPaths: true,
      rootWritable: false,
      mounts: second.pathMounts
    });
    expect(await paths.resolve('/tmp/progress.txt')).toBe(
      join(second.temporaryDirectory, 'progress.txt')
    );
    expect(await paths.resolve('/tmp/next.txt', true, 'write')).toBe(
      join(second.temporaryDirectory, 'next.txt')
    );
    await expect(paths.resolve('/tmp/../private.txt')).rejects.toMatchObject({
      code: 'MAR_AGENT_FILE_ACCESS_DENIED'
    });
    const read = await new ReadTool(paths).execute({ reads: [{ path: '/tmp/progress.txt' }] });
    expect(read.results[0]).toMatchObject({ text: 'first-run-progress' });
    await new ApplyPatchTool(paths).execute(
      '*** Begin Patch\n*** Add File: /tmp/next.txt\n+next-run-progress\n*** End Patch'
    );
    await expect(readFile(join(second.temporaryDirectory, 'next.txt'), 'utf8')).resolves.toBe(
      'next-run-progress\n'
    );
    await expect(readFile(join(second.temporaryDirectory, 'progress.txt'), 'utf8')).resolves.toBe(
      'first-run-progress'
    );

    const other = (await fixture.service.operations()['conversation.hosted.create']!({
      ...createRequest([modelOne]),
      clientRequestId: 'create-request-other'
    })) as { conversation: { id: string } };
    await message({
      conversationId: other.conversation.id,
      clientMessageId: 'message-tmp-other',
      prompt: 'Use isolated progress.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    const otherRun = fixture.runtime.startRun.mock.calls[2]![0];
    expect(otherRun.temporaryDirectory).not.toBe(first.temporaryDirectory);
    expect(otherRun.pathMounts).toContainEqual({
      logicalPath: '/tmp',
      physicalPath: otherRun.temporaryDirectory,
      writable: true
    });
    expect(first.temporaryDirectory).toMatch(
      new RegExp(`^${fixture.temporaryRootDirectory.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`)
    );
    expect(first.temporaryDirectory).not.toContain(conversation.id);
  });

  it('rechecks storage capacity before creation but keeps completed create requests idempotent', async () => {
    const assertCanCreate = vi.fn(async () => undefined);
    const fixture = await runtimeFixture({ assertCanCreate });
    const create = fixture.service.operations()['conversation.hosted.create']!;

    const first = await create(createRequest());
    assertCanCreate.mockRejectedValueOnce(new Error('CONVERSATION_HOSTING_STORAGE_FULL'));
    await expect(create(createRequest())).resolves.toEqual(first);
    expect(assertCanCreate).toHaveBeenCalledTimes(1);

    await expect(
      create({ ...createRequest(), clientRequestId: 'create-request-full' })
    ).rejects.toThrow('CONVERSATION_HOSTING_STORAGE_FULL');
    expect(fixture.runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it('projects NONE and UNRESTRICTED across models, Host Web, Bubblewrap and MCP', async () => {
    const cases = [
      {
        networkMode: 'NONE',
        hostedWebSearch: false,
        webAccess: false,
        mcpTransports: ['STDIO']
      },
      {
        networkMode: 'UNRESTRICTED',
        hostedWebSearch: true,
        webAccess: true,
        mcpTransports: ['STDIO', 'HTTP']
      }
    ] as const;

    for (const expected of cases) {
      const fixture = await runtimeFixture({
        versionDraft: {
          ...draft,
          mcpIds: ['mcp-stdio', 'mcp-http'],
          networkMode: expected.networkMode
        },
        mcpServers: [stdioMcpSnapshot, httpMcpSnapshot],
        secretEnvironment: {
          MCP_TOKEN: 'stdio-runtime-secret',
          MCP_EXTRA_TOKEN: 'stdio-config-secret',
          MCP_HTTP_TOKEN: 'http-runtime-secret',
          MCP_HTTP_EXTRA_TOKEN: 'http-config-secret'
        }
      });
      const conversation = await createConversation(fixture, [hostedWebModel]);
      expect(fixture.runtime.createSession.mock.calls[0]![0].models[0]!.hostedWebSearch).toBe(
        expected.hostedWebSearch
      );

      await fixture.service.operations()['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId: `message-${expected.networkMode.toLowerCase()}`,
        prompt: 'Use the configured capabilities.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: hostedWebModel,
        __marAgentModels: [hostedWebModel]
      });

      const run = fixture.runtime.startRun.mock.calls[0]![0];
      expect(run.models[0]!.hostedWebSearch).toBe(expected.hostedWebSearch);
      expect(run.webAccess).toBe(expected.webAccess);
      expect(run.mcpServers.map((server) => server.transport)).toEqual(expected.mcpTransports);
      expect(run.mcpServers[0]).toMatchObject({
        name: 'local-research',
        lifecycle: 'EXECUTION',
        transport: 'STDIO',
        args: ['server.js', '--workspace'],
        environment: {
          TOKEN: 'stdio-runtime-secret',
          EXTRA_TOKEN: 'stdio-config-secret'
        }
      });
      if (expected.networkMode === 'UNRESTRICTED')
        expect(run.mcpServers[1]).toMatchObject({
          name: 'remote-research',
          lifecycle: 'EXECUTION',
          transport: 'HTTP',
          url: 'https://mcp.example.test/tools',
          headers: {
            Authorization: 'http-runtime-secret',
            'X-Extra-Token': 'http-config-secret'
          }
        });
      expect(fixture.processExecutorFactory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceDirectory: expect.stringMatching(/\/content$/u),
          sourceWorkspacePath: expect.stringMatching(/^\/home\/template source\//u),
          inboxDirectory: expect.stringMatching(/\/data\/inbox$/u),
          outputDirectory: expect.stringMatching(/\/data\/output$/u),
          networkMode: expected.networkMode
        })
      );
      expect(fixture.processExecutorFactory.mock.calls.at(-1)![0]).not.toHaveProperty(
        'homeDirectory'
      );
      fixture.pendingRuns[0]!.complete({ status: 'SUCCEEDED', completedAt: 3_000 });
      await vi.waitFor(async () => {
        await expect(stat(run.temporaryDirectory)).resolves.toMatchObject({
          isDirectory: expect.any(Function)
        });
      });
    }
  });

  it('rejects a Run when an immutable MCP snapshot secret is unavailable', async () => {
    const fixture = await runtimeFixture({
      versionDraft: { ...draft, mcpIds: ['mcp-stdio'], networkMode: 'NONE' },
      mcpServers: [stdioMcpSnapshot],
      secretEnvironment: {}
    });
    const conversation = await createConversation(fixture);

    await expect(
      fixture.service.operations()['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId: 'message-missing-mcp-secret',
        prompt: 'Use MCP.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: modelOne,
        __marAgentModels: [modelOne]
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_MCP_INVALID');
    expect(fixture.runtime.startRun).not.toHaveBeenCalled();
  });

  it('advances last activity when a message is accepted and when its settlement completes', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    fixture.setNow(5_000);

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-activity',
      prompt: 'Continue.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    expect(
      fixture.database.raw
        .prepare('SELECT last_activity_at FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ last_activity_at: 5_000 });

    fixture.pendingRuns[0]!.complete({ status: 'SUCCEEDED', completedAt: 6_000 });
    await vi.waitFor(() =>
      expect(
        fixture.database.raw
          .prepare('SELECT last_activity_at FROM hosted_conversations WHERE id=?')
          .get(conversation.id)
      ).toEqual({ last_activity_at: 6_000 })
    );
    fixture.setNow(1_000);
    await fixture.service.operations()['conversation.hosted.config.update']!({
      conversationId: conversation.id,
      modelId: 'model-1',
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    expect(
      fixture.database.raw
        .prepare('SELECT updated_at,last_activity_at FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ updated_at: 6_000, last_activity_at: 6_000 });
  });

  it('updates title and pin metadata without advancing last activity', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    fixture.setNow(5_000);

    const updated = (await fixture.service.operations()['conversation.hosted.metadata.update']!({
      conversationId: conversation.id,
      title: '  Renamed conversation  ',
      pinned: true,
      __requestUserId: 7
    })) as { conversation: { title: string; pinnedAt: number | null; lastActivityAt: number } };

    expect(updated.conversation).toMatchObject({
      title: 'Renamed conversation',
      pinnedAt: 5_000,
      lastActivityAt: conversation.lastActivityAt
    });
    expect(
      fixture.database.raw
        .prepare(
          'SELECT title,title_source,pinned_at,updated_at,last_activity_at FROM hosted_conversations WHERE id=?'
        )
        .get(conversation.id)
    ).toEqual({
      title: 'Renamed conversation',
      title_source: 'CUSTOM',
      pinned_at: 5_000,
      updated_at: 5_000,
      last_activity_at: conversation.lastActivityAt
    });
  });

  it('does not let a delayed configuration update replace title metadata changed while it loads', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    let reportVersionLoad!: () => void;
    let releaseVersionLoad!: () => void;
    const versionLoadStarted = new Promise<void>((resolve) => {
      reportVersionLoad = resolve;
    });
    const versionLoadReleased = new Promise<void>((resolve) => {
      releaseVersionLoad = resolve;
    });
    filesystemGate.wait = async () => {
      filesystemGate.wait = undefined;
      reportVersionLoad();
      await versionLoadReleased;
    };

    const configuration = fixture.service.operations()['conversation.hosted.config.update']!({
      conversationId: conversation.id,
      modelId: 'model-1',
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    await versionLoadStarted;
    await fixture.service.operations()['conversation.hosted.metadata.update']!({
      conversationId: conversation.id,
      title: 'Custom during configuration',
      __requestUserId: 7
    });
    releaseVersionLoad();

    await expect(configuration).resolves.toMatchObject({
      conversation: {
        title: 'Custom during configuration'
      }
    });
    expect(
      fixture.database.raw
        .prepare('SELECT title,title_source FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ title: 'Custom during configuration', title_source: 'CUSTOM' });
  });

  it('uses the first non-empty user message as an automatic title and lets only a non-placeholder MAR Agent title replace it', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    fixture.setNow(5_000);

    const first = (await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-title-first',
      prompt: '  New conversation  ',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    })) as { conversation: HostedConversationSummary };

    expect(first.conversation).toMatchObject({
      title: 'New conversation',
      titleSource: 'AUTO'
    });
    expect(
      fixture.database.raw
        .prepare('SELECT title,title_source FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ title: 'New conversation', title_source: 'AUTO' });

    fixture.pendingRuns[0]!.complete({
      status: 'SUCCEEDED',
      completedAt: 6_000,
      title: '  Generated hosted title  '
    });
    await vi.waitFor(() =>
      expect(
        fixture.database.raw
          .prepare('SELECT title,title_source FROM hosted_conversations WHERE id=?')
          .get(conversation.id)
      ).toEqual({ title: 'Generated hosted title', title_source: 'AUTO' })
    );

    const second = (await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-title-second',
      prompt: 'Second message must not reset the title.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    })) as { conversation: HostedConversationSummary };
    expect(second.conversation.title).toBe('Generated hosted title');
    fixture.pendingRuns[1]!.complete({ status: 'SUCCEEDED', completedAt: 7_000 });
  });

  it('projects versioned directory activity and only notifies terminal unexpected outcomes', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const operations = fixture.service.operations();
    const activityPayloads = () =>
      fixture.workbenchEvents
        .map((event) => event.payload)
        .filter(
          (payload): payload is Record<string, unknown> =>
            typeof payload === 'object' &&
            payload !== null &&
            (payload as { kind?: unknown }).kind === 'activity'
        );
    const notifications = () =>
      fixture.workbenchEvents
        .map((event) => event.payload)
        .filter(
          (payload): payload is { event: { payload: Record<string, unknown> } } =>
            typeof payload === 'object' &&
            payload !== null &&
            (payload as { kind?: unknown }).kind === 'notification'
        );
    const send = (clientMessageId: string) =>
      operations['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId,
        prompt: `Prompt ${clientMessageId}`,
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: modelOne,
        __marAgentModels: [modelOne]
      });

    expect(
      (
        (await operations['conversation.hosted.list']!({
          limit: 20,
          __requestUserId: 7
        })) as { items: HostedConversationSummary[] }
      ).items[0]?.activity
    ).toEqual({ status: 'IDLE', version: 0, updatedAt: 0 });

    await send('message-activity-success');
    expect(activityPayloads().map((payload) => payload.activity)).toEqual([
      { status: 'STARTING', version: 1, updatedAt: 2_000 },
      { status: 'RUNNING', version: 2, updatedAt: 2_000 }
    ]);
    expect(
      (
        (await operations['conversation.hosted.list']!({
          limit: 20,
          __requestUserId: 7
        })) as { items: HostedConversationSummary[] }
      ).items[0]?.activity.status
    ).toBe('RUNNING');

    fixture.pendingRuns[0]!.complete({
      status: 'SUCCEEDED',
      completedAt: 3_000,
      title: 'Generated terminal title'
    });
    await vi.waitFor(() =>
      expect(activityPayloads().at(-1)?.activity).toEqual({
        status: 'IDLE',
        version: 3,
        updatedAt: 3_000
      })
    );
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0]?.event.payload).toMatchObject({
      targetType: 'HOSTED_CONVERSATION',
      userId: 7,
      templateId: 'template-1',
      conversationId: conversation.id,
      conversationTitle: 'Generated terminal title',
      runId: 'run-1',
      notificationId: `run:node-1:${conversation.id}:run-1`,
      kind: 'RUN_TERMINAL',
      outcome: 'SUCCEEDED',
      occurredAt: 3_000
    });

    await send('message-activity-stop');
    expect(
      await operations['conversation.hosted.interrupt']!({
        conversationId: conversation.id,
        __requestUserId: 7
      })
    ).toEqual({ interrupted: true });
    expect(activityPayloads().at(-1)?.activity).toMatchObject({ status: 'CANCELLING' });
    fixture.pendingRuns[1]!.complete({ status: 'INTERRUPTED', completedAt: 4_000 });
    await vi.waitFor(() =>
      expect(activityPayloads().at(-1)?.activity).toMatchObject({ status: 'IDLE', version: 7 })
    );
    expect(notifications()).toHaveLength(1);

    await send('message-activity-unexpected');
    fixture.pendingRuns[2]!.complete({ status: 'INTERRUPTED', completedAt: 5_000 });
    await vi.waitFor(() => expect(notifications()).toHaveLength(2));
    expect(notifications()[1]?.event.payload).toMatchObject({
      outcome: 'INTERRUPTED',
      runId: 'run-3'
    });

    await send('message-activity-delete');
    const deletion = operations['conversation.hosted.delete']!({
      conversationId: conversation.id,
      __requestUserId: 7
    });
    await vi.waitFor(() => expect(fixture.pendingRuns[3]!.handle.cancel).toHaveBeenCalledOnce());
    fixture.pendingRuns[3]!.complete({ status: 'INTERRUPTED', completedAt: 6_000 });
    await deletion;
    expect(notifications()).toHaveLength(2);
  });

  it('keeps the creation title for an attachment-only first send and titles from the next non-empty message', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const operations = fixture.service.operations();
    const upload = (await operations['conversation.hosted.files.upload.create']!({
      conversationId: conversation.id,
      clientRequestId: 'upload-title-attachment-only',
      name: 'context.txt',
      size: 1,
      mimeType: 'text/plain',
      __requestUserId: 7
    })) as { upload: { uploadId: string } };
    await operations['conversation.hosted.files.upload.chunk']!({
      conversationId: conversation.id,
      uploadId: upload.upload.uploadId,
      offset: 0,
      dataBase64: Buffer.from('x').toString('base64'),
      __requestUserId: 7
    });
    const completed = (await operations['conversation.hosted.files.upload.complete']!({
      conversationId: conversation.id,
      uploadId: upload.upload.uploadId,
      __requestUserId: 7
    })) as { upload: { file: { id: string } } };

    const attachmentOnly = (await operations['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-title-attachment-only',
      prompt: '   ',
      attachmentIds: [completed.upload.file.id],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    })) as { conversation: HostedConversationSummary };
    expect(attachmentOnly.conversation).toMatchObject({
      title: 'New conversation',
      titleSource: 'DEFAULT'
    });
    fixture.pendingRuns[0]!.complete({ status: 'SUCCEEDED', completedAt: 6_000 });
    await vi.waitFor(() =>
      expect(
        fixture.database.raw
          .prepare(
            'SELECT status FROM hosted_conversation_messages WHERE conversation_id=? AND client_message_id=?'
          )
          .get(conversation.id, 'message-title-attachment-only')
      ).toEqual({ status: 'SUCCEEDED' })
    );

    const firstText = (await operations['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-title-first-text',
      prompt: '  First text after attachment  ',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    })) as { conversation: HostedConversationSummary };
    expect(firstText.conversation.title).toBe('First text after attachment');
    fixture.pendingRuns[1]!.complete({ status: 'SUCCEEDED', completedAt: 7_000 });
  });

  it('settles the Run and advances activity when automatic title persistence fails', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-title-failure',
      prompt: 'Temporary title.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    vi.spyOn(fixture.store, 'saveAutomaticTitle').mockRejectedValueOnce(
      new Error('TITLE_PERSIST_FAILED')
    );
    fixture.pendingRuns[0]!.complete({
      status: 'SUCCEEDED',
      completedAt: 6_000,
      title: 'Generated title'
    });

    await vi.waitFor(() =>
      expect(
        fixture.database.raw
          .prepare(
            `SELECT hosted_conversation_messages.status AS status,
                    hosted_conversations.last_activity_at AS last_activity_at
             FROM hosted_conversations
             JOIN hosted_conversation_messages
               ON hosted_conversation_messages.conversation_id=hosted_conversations.id
             WHERE hosted_conversations.id=?`
          )
          .get(conversation.id)
      ).toEqual({ status: 'SUCCEEDED', last_activity_at: 6_000 })
    );
  });

  it('does not let a late MAR Agent title replace a user-customized Hosted Conversation title', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);

    await fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-title-custom',
      prompt: 'Temporary title.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    await fixture.service.operations()['conversation.hosted.metadata.update']!({
      conversationId: conversation.id,
      title: 'Custom title',
      __requestUserId: 7
    });
    fixture.pendingRuns[0]!.complete({
      status: 'SUCCEEDED',
      completedAt: 6_000,
      title: 'Late generated title'
    });

    await vi.waitFor(() =>
      expect(
        fixture.database.raw
          .prepare(
            `SELECT title,title_source,hosted_conversation_messages.status AS status
             FROM hosted_conversations
             JOIN hosted_conversation_messages
               ON hosted_conversation_messages.conversation_id=hosted_conversations.id
             WHERE hosted_conversations.id=?`
          )
          .get(conversation.id)
      ).toEqual({ title: 'Custom title', title_source: 'CUSTOM', status: 'SUCCEEDED' })
    );
  });

  it('does not let the first-message temporary title replace a title customized while the Run starts', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const pending = deferredRun('run-delayed-title');
    let reportRunStarting!: () => void;
    let releaseRunStart!: () => void;
    const runStarting = new Promise<void>((resolve) => {
      reportRunStarting = resolve;
    });
    const runStartReleased = new Promise<void>((resolve) => {
      releaseRunStart = resolve;
    });
    fixture.runtime.startRun.mockImplementationOnce(async () => {
      reportRunStarting();
      await runStartReleased;
      fixture.pendingRuns.push(pending);
      return pending.handle;
    });

    const message = fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'message-title-start-race',
      prompt: 'Temporary first title.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    await runStarting;
    await fixture.service.operations()['conversation.hosted.metadata.update']!({
      conversationId: conversation.id,
      title: 'Custom during startup',
      __requestUserId: 7
    });
    releaseRunStart();

    await expect(message).resolves.toMatchObject({
      conversation: {
        title: 'Custom during startup'
      }
    });
    expect(
      fixture.database.raw
        .prepare('SELECT title,title_source FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ title: 'Custom during startup', title_source: 'CUSTOM' });
    pending.complete({ status: 'SUCCEEDED', completedAt: 6_000, title: 'Generated title' });
  });

  it('deduplicates clientMessageId across repeated requests and restores history from the assigned HOME', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const message = fixture.service.operations()['conversation.hosted.message']!;
    const request = {
      conversationId: conversation.id,
      clientMessageId: 'message-idempotent',
      prompt: 'Continue.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    };

    const first = await message(request);
    const repeated = await message(request);
    expect(repeated).toEqual(first);
    expect(fixture.runtime.startRun).toHaveBeenCalledTimes(1);

    fixture.runtime.history.mockResolvedValueOnce(
      hostedHistoryPage([
        {
          id: 'turn-1',
          sessionId: 'session-1',
          runId: 'run-1',
          userItemId: 'turn-1:user',
          status: 'SUCCEEDED',
          model: 'model-1',
          effort: null,
          access: 'full-access',
          items: [],
          startedAt: 1_000,
          completedAt: 1_100
        }
      ])
    );
    const snapshot = (await fixture.service.operations()['conversation.hosted.get']!({
      conversationId: conversation.id,
      __requestUserId: 7,
      __marAgentModels: [modelOne]
    })) as { turns: unknown[] };
    expect(snapshot.turns).toHaveLength(1);
    expect(fixture.runtime.history).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        homeDirectory: expect.stringMatching(/\/home$/u)
      })
    );
  });

  it('rejects a second message while the first message is still starting its Run', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const pending = deferredRun('run-starting');
    let reportRunStarting!: () => void;
    let releaseRunStart!: () => void;
    const runStarting = new Promise<void>((resolve) => {
      reportRunStarting = resolve;
    });
    const runStartReleased = new Promise<void>((resolve) => {
      releaseRunStart = resolve;
    });
    fixture.runtime.startRun.mockImplementationOnce(async () => {
      reportRunStarting();
      await runStartReleased;
      fixture.pendingRuns.push(pending);
      return pending.handle;
    });
    const message = fixture.service.operations()['conversation.hosted.message']!;
    const first = message({
      conversationId: conversation.id,
      clientMessageId: 'message-starting-first',
      prompt: 'Start once.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    await runStarting;

    try {
      expect(fixture.service.prepareForDisable()).toBeUndefined();
      await expect(
        message({
          conversationId: conversation.id,
          clientMessageId: 'message-starting-second',
          prompt: 'Do not start concurrently.',
          attachmentIds: [],
          __requestUserId: 7,
          __marAgentModel: modelOne,
          __marAgentModels: [modelOne]
        })
      ).rejects.toThrow('HOSTED_CONVERSATION_RUN_ACTIVE');
      expect(fixture.runtime.startRun).toHaveBeenCalledOnce();
    } finally {
      releaseRunStart();
      await first;
      for (const run of fixture.pendingRuns)
        run.complete({ status: 'SUCCEEDED', completedAt: 6_000 });
    }
  });

  it('waits for an admitted start, cancels its eventual handle and joins settlement during dispose', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    const pending = deferredRun('run-dispose-starting');
    let entered!: () => void;
    let release!: () => void;
    const starting = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    fixture.runtime.startRun.mockImplementationOnce(async () => {
      entered();
      await gate;
      return pending.handle;
    });
    const message = fixture.service.operations()['conversation.hosted.message']!({
      conversationId: conversation.id,
      clientMessageId: 'dispose-starting',
      prompt: 'Start.',
      attachmentIds: [],
      __requestUserId: 7,
      __marAgentModel: modelOne,
      __marAgentModels: [modelOne]
    });
    await starting;
    let disposed = false;
    const closing = fixture.service.dispose().then(() => (disposed = true));
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await message;
    await vi.waitFor(() => expect(pending.handle.cancel).toHaveBeenCalledOnce());
    expect(disposed).toBe(false);
    pending.complete({ status: 'INTERRUPTED', completedAt: 3_000 });
    await closing;
    expect(fixture.store.findMessage(7, conversation.id, 'dispose-starting')).toMatchObject({
      status: 'INTERRUPTED'
    });
  });

  it('continues cancellation and cleanup after a handle fails, then reports the first failure', async () => {
    const fixture = await runtimeFixture();
    const first = await createConversation(fixture);
    const second = (await fixture.service.operations()['conversation.hosted.create']!({
      ...createRequest(),
      clientRequestId: 'create-second-close-failure'
    })) as { conversation: HostedConversationSummary };
    const operations = fixture.service.operations();
    for (const [index, conversation] of [first, second.conversation].entries()) {
      await operations['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId: `close-failure-${index}`,
        prompt: 'Run',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: modelOne,
        __marAgentModels: [modelOne]
      });
    }
    const failure = new Error('FIRST_CANCEL_FAILED');
    fixture.pendingRuns[0]!.handle.cancel.mockImplementation(() => {
      throw failure;
    });
    const uploads = (fixture.service as unknown as { hostedUploads: { close(): Promise<void> } })
      .hostedUploads;
    const closeUploads = vi
      .spyOn(uploads, 'close')
      .mockRejectedValue(new Error('UPLOAD_CLOSE_FAILED'));
    const closing = fixture.service.dispose();
    expect(fixture.pendingRuns[1]!.handle.cancel).toHaveBeenCalledOnce();
    fixture.pendingRuns[0]!.complete({ status: 'FAILED', completedAt: 3_000 });
    fixture.pendingRuns[1]!.complete({ status: 'INTERRUPTED', completedAt: 3_000 });
    await expect(closing).rejects.toBe(failure);
    expect(closeUploads).toHaveBeenCalledOnce();
    expect(fixture.store.findMessage(7, first.id, 'close-failure-0')?.status).toBe('FAILED');
    expect(fixture.store.findMessage(7, second.conversation.id, 'close-failure-1')?.status).toBe(
      'INTERRUPTED'
    );
    closeUploads.mockRestore();
  });

  it('cancels and waits for a started Run when message acceptance persistence fails', async () => {
    const fixture = await runtimeFixture();
    const conversation = await createConversation(fixture);
    await seedVersion(fixture, 'version-2', 2, draft);
    const pending = deferredRun('run-persistence-failed');
    fixture.runtime.startRun.mockImplementationOnce(async () => {
      fixture.pendingRuns.push(pending);
      return pending.handle;
    });
    vi.spyOn(fixture.store, 'saveMessageAcceptance').mockRejectedValueOnce(
      new Error('PERSISTENCE_FAILED')
    );
    let rejected = false;
    const operation = Promise.resolve(
      fixture.service.operations()['conversation.hosted.message']!({
        conversationId: conversation.id,
        clientMessageId: 'message-persistence-failed',
        prompt: 'Do not leave this execution running.',
        attachmentIds: [],
        __requestUserId: 7,
        __marAgentModel: modelOne,
        __marAgentModels: [modelOne]
      })
    ).then(
      () => undefined,
      (error: unknown) => {
        rejected = true;
        return error;
      }
    );

    await vi.waitFor(() => expect(pending.handle.cancel).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(rejected).toBe(false);

    pending.complete({ status: 'INTERRUPTED', completedAt: 6_000 });
    await expect(operation).resolves.toMatchObject({ message: 'PERSISTENCE_FAILED' });
    expect(
      fixture.store.findMessage(7, conversation.id, 'message-persistence-failed')
    ).toMatchObject({
      runId: 'run-persistence-failed',
      status: 'INTERRUPTED',
      updatedAt: 6_000
    });
    expect(
      fixture.database.raw
        .prepare('SELECT active_version_id FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ active_version_id: 'version-1' });
    expect(
      fixture.database.raw
        .prepare('SELECT id,reference_count FROM conversation_template_versions ORDER BY id')
        .all()
    ).toEqual([
      { id: 'version-1', reference_count: 1 },
      { id: 'version-2', reference_count: 0 }
    ]);
    const runInput = fixture.runtime.startRun.mock.calls[0]![0];
    await expect(lstat(runInput.temporaryDirectory)).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    });
  });
});
