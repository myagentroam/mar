import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conversationTemplatePublishResultSchema,
  type ConversationTemplateDraft,
  type ConversationTemplatePublishResult,
  type ConversationTemplateVersion
} from '../../../packages/protocol/src/index.js';
import { NodeDatabase } from '../../src/database.js';
import { HostedConversationStore } from '../../src/hosting/hosted-conversation-store.js';
import { ConversationTemplateNodeService } from '../../src/service/conversation-template-node-service.js';
import {
  HostedConversationNodeService,
  type HostedConversationRuntime
} from '../../src/hosting/hosted-conversation-node-service.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => {
      await makeWritable(path).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    })
  );
});

describe('Node conversation template publication', () => {
  it('preserves the schema v2 JSON and hashes through real publication and hosted recovery', async () => {
    const fixture = await publisherFixture('/projects/manifest-vector');
    await mkdir(join(fixture.workspace, 'lib'));
    await writeFile(join(fixture.workspace, 'lib', 'data.txt'), 'template data');
    await writeFile(join(fixture.workspace, 'run.sh'), '#!/bin/sh\necho ok\n');
    await chmod(join(fixture.workspace, 'run.sh'), 0o755);
    await symlink('lib/data.txt', join(fixture.workspace, 'data-link'));
    await symlink('/usr', join(fixture.workspace, 'runtime-link'));
    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'manifest-vector',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const completed = await waitForSuccessfulPublish(
      fixture.operations,
      'template-1',
      'manifest-vector'
    );
    const row = fixture.database.raw
      .prepare('SELECT * FROM conversation_template_versions WHERE id=?')
      .get(completed.version.id) as {
      storage_key: string;
      manifest: string;
      manifest_hash: string;
      content_hash: string;
      mcp_config_hash: string;
    };
    await expect(row.manifest).toMatchFileSnapshot('./support/template-version-manifest-v2.txt');
    expect(
      await readFile(
        join(fixture.store.templateVersionDirectory(row.storage_key), 'manifest.json'),
        'utf8'
      )
    ).toBe(`${row.manifest}\n`);
    expect(row.manifest_hash).toBe(createHash('sha256').update(row.manifest).digest('hex'));
    expect(row.manifest_hash).toBe(
      '888eabbe6c7987c1bb446b6e67098047865dab96bb802602f8d60417bc4ed029'
    );
    expect(row.content_hash).toBe(
      'c182488cea50bb4b8975c47b544e20729671000c49354bf1e2594c720fdab0b8'
    );
    expect(row.mcp_config_hash).toBe(
      '1cc721806e02d0c9554fda333d2f02f9554d7d1b87fc8a98827c49f677556d66'
    );
    await expect(
      fixture.operations['conversation.template.version.inspect']!({
        templateId: 'template-1',
        versionId: completed.version.id
      })
    ).resolves.toMatchObject({ valid: true, code: null });
    const hosted = hostedPublisherConsumer(fixture, completed.version.id);
    const created = (await hosted.create()) as {
      conversation: { id: string; activeVersionId: string; sessionId: string };
    };
    expect(created.conversation).toMatchObject({
      activeVersionId: completed.version.id,
      sessionId: 'published-session'
    });
    expect(hosted.runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDirectory: join(
          fixture.store.templateVersionDirectory(row.storage_key),
          'content'
        ),
        defaultModelId: 'model-1'
      })
    );
    await hosted.service.dispose();
    fixture.database.close();
    const recoveredDatabase = new NodeDatabase(fixture.databasePath, 'node-1');
    const recoveredStore = new HostedConversationStore({
      dataDirectory: fixture.dataDirectory,
      rootDirectory: fixture.store.rootDirectory,
      nodeId: 'node-1',
      database: recoveredDatabase
    });
    await recoveredStore.initialize();
    const recovered = hostedPublisherConsumer(
      { ...fixture, database: recoveredDatabase, store: recoveredStore },
      completed.version.id
    );
    await expect(
      recovered.service.operations()['conversation.hosted.get']!({
        conversationId: created.conversation.id,
        __requestUserId: 7,
        __marAgentModels: [hostedModel]
      })
    ).resolves.toMatchObject({ conversation: created.conversation });
    expect(recovered.runtime.createSession).not.toHaveBeenCalled();
    expect(recovered.runtime.history).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'published-session' })
    );
    await recovered.service.dispose();
    recoveredDatabase.close();
  });

  it.each(['relative/source', '/tmp/template'])(
    'distinguishes source input from persisted corruption: %s',
    async (sourceWorkspacePath) => {
      const invalidSource = await publisherFixture(sourceWorkspacePath);
      await expect(
        invalidSource.operations['conversation.template.source.inspect']!({
          mode: 'VALIDATE',
          draft: invalidSource.draft
        })
      ).resolves.toMatchObject({ valid: false, code: 'CONVERSATION_TEMPLATE_SOURCE_INVALID' });
      invalidSource.database.close();

      const fixture = await publishedEmptyFixture();
      const hosted = hostedPublisherConsumer(fixture, fixture.versionId);
      await rewritePublishedManifest(fixture, { sourceWorkspacePath });
      await expect(hosted.create()).rejects.toThrow('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      expect(hosted.runtime.createSession).not.toHaveBeenCalled();
      await expect(
        fixture.operations['conversation.template.version.inspect']!({
          templateId: 'template-1',
          versionId: fixture.versionId
        })
      ).resolves.toMatchObject({ valid: false, code: 'CONVERSATION_TEMPLATE_VERSION_CORRUPTED' });
      await hosted.service.dispose();
      fixture.database.close();
    }
  );

  it.each([
    'version identity',
    'template identity',
    'draft node',
    'host policy',
    'content hash',
    'MCP hash',
    'file count',
    'byte total',
    'raw JSON',
    'content directory mode'
  ])('preserves Hosted binding validation for %s', async (corruption) => {
    const fixture = await publishedEmptyFixture();
    const hosted = hostedPublisherConsumer(fixture, fixture.versionId);
    const columns: Record<string, string> = {
      'content hash': 'content_hash',
      'MCP hash': 'mcp_config_hash',
      'file count': 'file_count',
      'byte total': 'total_bytes'
    };
    const column = columns[corruption];
    if (column !== undefined) {
      fixture.database.raw
        .prepare(`UPDATE conversation_template_versions SET ${column}=? WHERE id=?`)
        .run(column.endsWith('hash') ? '0'.repeat(64) : 1, fixture.versionId);
    } else if (corruption === 'content directory mode') {
      await chmod(join(fixture.versionDirectory, 'content'), 0o755);
    } else if (corruption === 'raw JSON') {
      const path = join(fixture.versionDirectory, 'manifest.json');
      await chmod(path, 0o644);
      await writeFile(path, `${await readFile(path, 'utf8')}\n`);
      await chmod(path, 0o444);
    } else {
      const patch: Record<string, unknown> =
        corruption === 'version identity'
          ? { versionId: 'other' }
          : corruption === 'template identity'
            ? { templateId: 'other' }
            : corruption === 'host policy'
              ? { hostPolicyVersion: 2 }
              : { draft: { ...fixture.draft, nodeId: 'other' } };
      await rewritePublishedManifest(fixture, patch);
    }
    await expect(hosted.create()).rejects.toThrow('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    expect(hosted.runtime.createSession).not.toHaveBeenCalled();
    await hosted.service.dispose();
    fixture.database.close();
  });

  it('publishes template instructions while excluding root maintenance documents', async () => {
    const fixture = await publisherFixture();
    await mkdir(join(fixture.workspace, 'knowledge'));
    await mkdir(join(fixture.workspace, '.agents', 'skills', 'research'), { recursive: true });
    await mkdir(join(fixture.workspace, 'node_modules', 'cached-package'), { recursive: true });
    await mkdir(join(fixture.workspace, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(fixture.workspace, '.venv', 'bin'), { recursive: true });
    await mkdir(join(fixture.workspace, '.venv', 'lib'), { recursive: true });
    await writeFile(join(fixture.workspace, 'knowledge', 'guide.txt'), 'published guide');
    await writeFile(join(fixture.workspace, 'knowledge', '.draft-note'), 'hidden');
    await writeFile(join(fixture.workspace, 'instructions.md'), 'follow instructions');
    await writeFile(join(fixture.workspace, 'README.md'), 'template maintainer guide');
    await writeFile(join(fixture.workspace, 'AGENTS.md'), 'maintain this template workspace');
    await writeFile(
      join(fixture.workspace, 'AGENTS.template.md'),
      'published conversation instructions'
    );
    await writeFile(
      join(fixture.workspace, '.agents', 'skills', 'research', 'SKILL.md'),
      '---\ndescription: Research skill\n---\n'
    );
    await writeFile(join(fixture.workspace, '.editorconfig'), 'root = true');
    await writeFile(join(fixture.workspace, '.env'), 'SECRET=not-published');
    await writeFile(join(fixture.workspace, '.envrc'), 'export TOKEN=not-published');
    await writeFile(
      join(fixture.workspace, 'node_modules', 'cached-package', 'index.js'),
      'module.exports = "published dependency";'
    );
    await writeFile(join(fixture.workspace, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    await writeFile(join(fixture.workspace, '.venv', 'lib', 'site.py'), 'VALUE = 1\n');
    const consoleScript = join(fixture.workspace, '.venv', 'bin', 'docoffice');
    await writeFile(
      consoleScript,
      `#!${join(fixture.sourceWorkspacePath, '.venv', 'bin', 'python')}\nprint("ok")\n`
    );
    await chmod(consoleScript, 0o755);
    await symlink('/usr/bin/python3', join(fixture.workspace, '.venv', 'bin', 'python'));
    await symlink('lib', join(fixture.workspace, '.venv', 'lib64'));
    await symlink(
      '../cached-package/index.js',
      join(fixture.workspace, 'node_modules', '.bin', 'cached-package')
    );

    const queued = await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-1',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    expect(queued).toMatchObject({ job: { status: 'QUEUED', stage: 'VALIDATING' } });

    const completed = await waitForSuccessfulPublish(fixture.operations, 'template-1', 'job-1');
    expect(completed).toMatchObject({
      job: { status: 'SUCCEEDED', stage: 'REGISTERED', versionId: expect.any(String) },
      version: {
        templateId: 'template-1',
        version: 1,
        status: 'AVAILABLE',
        fileCount: 13,
        mcpConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        publishedByUserId: 7
      }
    });

    const row = fixture.database.raw
      .prepare(
        'SELECT storage_key,manifest,mcp_config_hash FROM conversation_template_versions WHERE id=?'
      )
      .get(completed.version.id) as {
      storage_key: string;
      manifest: string;
      mcp_config_hash: string;
    };
    const versionRoot = fixture.store.templateVersionDirectory(row.storage_key);
    const manifest = JSON.parse(row.manifest) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      sourceWorkspacePath: fixture.sourceWorkspacePath,
      mcpConfigHash: row.mcp_config_hash,
      entries: expect.arrayContaining([
        expect.objectContaining({
          kind: 'SYMLINK',
          relativePath: '.venv/bin/python',
          linkTarget: '/usr/bin/python3'
        }),
        expect.objectContaining({
          kind: 'SYMLINK',
          relativePath: '.venv/lib64',
          linkTarget: 'lib'
        }),
        expect.objectContaining({
          kind: 'SYMLINK',
          relativePath: 'node_modules/.bin/cached-package',
          linkTarget: '../cached-package/index.js'
        })
      ]),
      mcpServers: [
        {
          id: 'mcp-local',
          serverName: 'local-research',
          origin: 'NODE',
          transport: 'STDIO',
          runtime: {
            transport: 'STDIO',
            command: 'node',
            args: ['server.js'],
            environment: { TOKEN: { secretName: 'MCP_TOKEN' } }
          },
          configuration: {
            arguments: ['--workspace'],
            environment: { EXTRA_TOKEN: { secretName: 'MCP_EXTRA_TOKEN' } }
          }
        }
      ]
    });
    expect(JSON.stringify(manifest)).not.toContain('resolved-secret-value');
    expect(JSON.stringify(manifest)).not.toContain('README.md');
    expect(JSON.stringify(manifest)).not.toContain('AGENTS.template.md');
    await expect(
      fixture.operations['conversation.template.version.inspect']!({
        templateId: 'template-1',
        versionId: completed.version.id,
        unexpected: true
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_INPUT_INVALID');
    await expect(
      readFile(join(versionRoot, 'content', 'knowledge', 'guide.txt'), 'utf8')
    ).resolves.toBe('published guide');
    await expect(readFile(join(versionRoot, 'content', 'instructions.md'), 'utf8')).resolves.toBe(
      'follow instructions'
    );
    await expect(readFile(join(versionRoot, 'content', 'AGENTS.md'), 'utf8')).resolves.toBe(
      'published conversation instructions'
    );
    await expect(readFile(join(versionRoot, 'content', 'README.md'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(join(versionRoot, 'content', 'AGENTS.template.md'), 'utf8')
    ).rejects.toThrow();
    await expect(
      readFile(join(versionRoot, 'content', '.agents', 'skills', 'research', 'SKILL.md'), 'utf8')
    ).resolves.toContain('Research skill');
    await expect(readFile(join(versionRoot, 'content', '.editorconfig'), 'utf8')).resolves.toBe(
      'root = true'
    );
    await expect(readFile(join(versionRoot, 'content', '.env'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(versionRoot, 'content', '.envrc'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(join(versionRoot, 'content', 'knowledge', '.draft-note'), 'utf8')
    ).resolves.toBe('hidden');
    await expect(
      readFile(join(versionRoot, 'content', 'node_modules', 'cached-package', 'index.js'), 'utf8')
    ).resolves.toContain('published dependency');
    await expect(
      readFile(join(versionRoot, 'content', '.venv', 'bin', 'docoffice'), 'utf8')
    ).resolves.toContain(fixture.sourceWorkspacePath);
    await expect(readlink(join(versionRoot, 'content', '.venv', 'bin', 'python'))).resolves.toBe(
      '/usr/bin/python3'
    );
    await expect(readlink(join(versionRoot, 'content', '.venv', 'lib64'))).resolves.toBe('lib');
    await expect(
      readlink(join(versionRoot, 'content', 'node_modules', '.bin', 'cached-package'))
    ).resolves.toBe('../cached-package/index.js');
    const source = await stat(join(fixture.workspace, 'knowledge', 'guide.txt'));
    const copied = await stat(join(versionRoot, 'content', 'knowledge', 'guide.txt'));
    expect(copied.ino).not.toBe(source.ino);
    expect((await stat(join(versionRoot, 'content', 'knowledge', 'guide.txt'))).mode & 0o777).toBe(
      0o444
    );
    expect(
      (await stat(join(versionRoot, 'content', '.venv', 'bin', 'docoffice'))).mode & 0o777
    ).toBe(0o555);
    await expect(stat(join(versionRoot, 'content', 'inbox'))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
      mode: expect.any(Number)
    });
    expect((await stat(join(versionRoot, 'content', 'inbox'))).mode & 0o777).toBe(0o555);
    expect((await stat(join(versionRoot, 'content', 'output'))).mode & 0o777).toBe(0o555);

    const repeated = await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-1',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    expect(repeated).toEqual(completed);
    expect(
      fixture.database.raw
        .prepare('SELECT COUNT(*) AS count FROM conversation_template_versions')
        .get()
    ).toEqual({ count: 1 });
  });

  it('discovers effective MCP options and rejects incompatible or missing selections', async () => {
    const fixture = await publisherFixture();
    await expect(
      fixture.operations['conversation.template.source.inspect']!({
        mode: 'DRAFT_TEST',
        draft: fixture.draft
      })
    ).resolves.toMatchObject({
      valid: true,
      mcpServers: [
        {
          id: 'mcp-local',
          serverName: 'local-research',
          transport: 'STDIO',
          origin: 'NODE'
        },
        {
          id: 'mcp-remote',
          serverName: 'remote-research',
          transport: 'HTTP',
          origin: 'WORKSPACE'
        }
      ]
    });
    await expect(
      fixture.operations['conversation.template.source.inspect']!({
        mode: 'DRAFT_TEST',
        draft: { ...fixture.draft, mcpIds: ['mcp-remote'] }
      })
    ).resolves.toMatchObject({ valid: false, code: 'CONVERSATION_TEMPLATE_MCP_INVALID' });
    await expect(
      fixture.operations['conversation.template.source.inspect']!({
        mode: 'DRAFT_TEST',
        draft: { ...fixture.draft, mcpIds: ['mcp-missing'] }
      })
    ).resolves.toMatchObject({ valid: false, code: 'CONVERSATION_TEMPLATE_MCP_INVALID' });
  });

  it('rejects reserved root directories and symlink escapes without sealing a partial version', async () => {
    const fixture = await publisherFixture();
    const temporarySource = await publisherFixture('/tmp/template-publisher-tests/workspace');
    await expect(
      temporarySource.operations['conversation.template.source.inspect']!({
        mode: 'DRAFT_TEST',
        draft: temporarySource.draft
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_SOURCE_INVALID'
    });
    await mkdir(join(fixture.workspace, 'inbox'));
    const reserved = await fixture.operations['conversation.template.source.inspect']!({
      mode: 'DRAFT_TEST',
      draft: fixture.draft
    });
    expect(reserved).toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_RESERVED_PATH'
    });
    await rm(join(fixture.workspace, 'inbox'), { recursive: true, force: true });
    await writeFile(join(fixture.workspace, 'output'), 'reserved');
    await expect(
      fixture.operations['conversation.template.source.inspect']!({
        mode: 'DRAFT_TEST',
        draft: fixture.draft
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_RESERVED_PATH'
    });
    await rm(join(fixture.workspace, 'output'));
    await symlink('/usr', join(fixture.workspace, 'inbox'));
    await expect(
      fixture.operations['conversation.template.source.inspect']!({
        mode: 'DRAFT_TEST',
        draft: fixture.draft
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_RESERVED_PATH'
    });
    await rm(join(fixture.workspace, 'inbox'));
    await mkdir(join(fixture.workspace, 'AGENTS.template.md'));
    await expect(
      fixture.operations['conversation.template.source.inspect']!({
        mode: 'DRAFT_TEST',
        draft: fixture.draft
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_SOURCE_TYPE_INVALID'
    });
    await rm(join(fixture.workspace, 'AGENTS.template.md'), { recursive: true, force: true });
    await writeFile(join(fixture.workspace, 'template-instructions.md'), 'instructions');
    await symlink('template-instructions.md', join(fixture.workspace, 'AGENTS.template.md'));
    await expect(
      fixture.operations['conversation.template.source.inspect']!({
        mode: 'DRAFT_TEST',
        draft: fixture.draft
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_SOURCE_TYPE_INVALID'
    });
    await rm(join(fixture.workspace, 'AGENTS.template.md'));
    const outside = await temporaryDirectory('outside');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(fixture.workspace, 'linked'));

    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-link',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const failed = await waitForPublish(fixture.operations, 'template-1', 'job-link');
    expect(failed).toMatchObject({
      job: { status: 'FAILED', errorCode: 'CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID' }
    });
    expect(await readdir(fixture.store.templatesVersionsDirectory)).toEqual([]);
    expect(await readdir(fixture.store.templatesPublishingDirectory)).toEqual([]);
  });

  it('allows an empty workspace and creates only runtime overlay mount points', async () => {
    const fixture = await publisherFixture();
    await mkdir(join(fixture.workspace, 'empty-directory'));
    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-empty',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const completed = await waitForSuccessfulPublish(fixture.operations, 'template-1', 'job-empty');
    expect(completed.version.fileCount).toBe(0);
    const row = fixture.database.raw
      .prepare('SELECT storage_key,manifest FROM conversation_template_versions WHERE id=?')
      .get(completed.version.id) as { storage_key: string; manifest: string };
    const content = join(fixture.store.templateVersionDirectory(row.storage_key), 'content');
    expect((await readdir(content)).sort()).toEqual(['empty-directory', 'inbox', 'output']);
    expect(JSON.parse(row.manifest)).toMatchObject({
      directories: ['empty-directory'],
      entries: []
    });
  });

  it('marks a sealed version corrupted when its content no longer matches the manifest', async () => {
    const fixture = await publisherFixture();
    await writeFile(join(fixture.workspace, 'instructions.md'), 'original');
    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-tamper',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const completed = await waitForSuccessfulPublish(
      fixture.operations,
      'template-1',
      'job-tamper'
    );
    expect(completed).toMatchObject({
      job: { status: 'SUCCEEDED' },
      version: { id: expect.any(String) }
    });
    const row = fixture.database.raw
      .prepare('SELECT storage_key FROM conversation_template_versions WHERE id=?')
      .get(completed.version.id) as { storage_key: string };
    const file = join(
      fixture.store.templateVersionDirectory(row.storage_key),
      'content',
      'instructions.md'
    );
    await chmod(file, 0o600);
    await writeFile(file, 'tampered');

    const inspection = await fixture.operations['conversation.template.version.inspect']!({
      templateId: 'template-1',
      versionId: completed.version.id
    });
    expect(inspection).toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_VERSION_CORRUPTED',
      version: { status: 'CORRUPTED' }
    });
    expect(
      fixture.database.raw
        .prepare('SELECT status FROM conversation_template_versions WHERE id=?')
        .get(completed.version.id)
    ).toEqual({ status: 'CORRUPTED' });
  });

  it('rejects an obsolete manifest even when its disk and database hashes agree', async () => {
    const fixture = await publisherFixture();
    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-obsolete-manifest',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const completed = await waitForSuccessfulPublish(
      fixture.operations,
      'template-1',
      'job-obsolete-manifest'
    );
    const row = fixture.database.raw
      .prepare('SELECT storage_key,manifest FROM conversation_template_versions WHERE id=?')
      .get(completed.version.id) as { storage_key: string; manifest: string };
    const legacy = JSON.stringify({ ...JSON.parse(row.manifest), schemaVersion: 1 });
    const hash = createHash('sha256').update(legacy).digest('hex');
    const path = join(fixture.store.templateVersionDirectory(row.storage_key), 'manifest.json');
    await chmod(path, 0o600);
    await writeFile(path, `${legacy}\n`);
    await chmod(path, 0o444);
    fixture.database.raw
      .prepare('UPDATE conversation_template_versions SET manifest=?,manifest_hash=? WHERE id=?')
      .run(legacy, hash, completed.version.id);
    await expect(
      fixture.operations['conversation.template.version.inspect']!({
        templateId: 'template-1',
        versionId: completed.version.id
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_VERSION_CORRUPTED'
    });
  });

  it('marks a sealed version corrupted when published file permissions become writable', async () => {
    const fixture = await publisherFixture();
    await writeFile(join(fixture.workspace, 'instructions.md'), 'original');
    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-permission-tamper',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const completed = await waitForSuccessfulPublish(
      fixture.operations,
      'template-1',
      'job-permission-tamper'
    );
    if (completed.version === undefined) throw new Error('EXPECTED_PUBLISHED_VERSION');
    const row = fixture.database.raw
      .prepare('SELECT storage_key FROM conversation_template_versions WHERE id=?')
      .get(completed.version.id) as { storage_key: string };
    const file = join(
      fixture.store.templateVersionDirectory(row.storage_key),
      'content',
      'instructions.md'
    );
    await chmod(file, 0o644);

    await expect(
      fixture.operations['conversation.template.version.inspect']!({
        templateId: 'template-1',
        versionId: completed.version.id
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_VERSION_CORRUPTED',
      version: { status: 'CORRUPTED' }
    });
  });

  it('marks a sealed version corrupted when a symlink resolves differently from its manifest', async () => {
    const fixture = await publisherFixture();
    await writeFile(join(fixture.workspace, 'first.txt'), 'first');
    await writeFile(join(fixture.workspace, 'second.txt'), 'second');
    await symlink('first.txt', join(fixture.workspace, 'current.txt'));
    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-symlink-target-tamper',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const completed = await waitForSuccessfulPublish(
      fixture.operations,
      'template-1',
      'job-symlink-target-tamper'
    );
    if (completed.version === undefined) throw new Error('EXPECTED_PUBLISHED_VERSION');
    const row = fixture.database.raw
      .prepare('SELECT storage_key,manifest FROM conversation_template_versions WHERE id=?')
      .get(completed.version.id) as { storage_key: string; manifest: string };
    const manifest = JSON.parse(row.manifest) as {
      directories: string[];
      entries: Array<Record<string, unknown>>;
      contentHash: string;
    };
    const link = manifest.entries.find((entry) => entry['relativePath'] === 'current.txt');
    if (link === undefined) throw new Error('EXPECTED_PUBLISHED_SYMLINK');
    link['resolvedTarget'] = 'second.txt';
    manifest.contentHash = manifestV2ContentHash(manifest.directories, manifest.entries);
    const manifestJson = JSON.stringify(manifest);
    const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
    const manifestPath = join(
      fixture.store.templateVersionDirectory(row.storage_key),
      'manifest.json'
    );
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, `${manifestJson}\n`);
    await chmod(manifestPath, 0o444);
    fixture.database.raw
      .prepare(
        'UPDATE conversation_template_versions SET manifest=?,manifest_hash=?,content_hash=? WHERE id=?'
      )
      .run(manifestJson, manifestHash, manifest.contentHash, completed.version.id);

    await expect(
      fixture.operations['conversation.template.version.inspect']!({
        templateId: 'template-1',
        versionId: completed.version.id
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_VERSION_CORRUPTED',
      version: { status: 'CORRUPTED' }
    });
  });

  it('marks a sealed version corrupted when an unexpected directory is added', async () => {
    const fixture = await publisherFixture();
    await writeFile(join(fixture.workspace, 'instructions.md'), 'original');
    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-directory-tamper',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const completed = await waitForSuccessfulPublish(
      fixture.operations,
      'template-1',
      'job-directory-tamper'
    );
    if (completed.version === undefined) throw new Error('EXPECTED_PUBLISHED_VERSION');
    const row = fixture.database.raw
      .prepare('SELECT storage_key FROM conversation_template_versions WHERE id=?')
      .get(completed.version.id) as { storage_key: string };
    const contentDirectory = join(
      fixture.store.templateVersionDirectory(row.storage_key),
      'content'
    );
    const unexpectedDirectory = join(contentDirectory, 'unexpected');
    await chmod(contentDirectory, 0o755);
    await mkdir(unexpectedDirectory);
    await chmod(unexpectedDirectory, 0o555);
    await chmod(contentDirectory, 0o555);

    await expect(
      fixture.operations['conversation.template.version.inspect']!({
        templateId: 'template-1',
        versionId: completed.version.id
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_VERSION_CORRUPTED',
      version: { status: 'CORRUPTED' }
    });
  });

  it('recovers interrupted publish jobs and removes writable or sealed candidates', async () => {
    const fixture = await publisherFixture();
    const candidate = fixture.store.templatePublishingDirectory('template_interrupted_0001');
    const orphan = fixture.store.templateVersionDirectory('template_orphaned_0001');
    await mkdir(join(candidate, 'content'), { recursive: true });
    await writeFile(join(candidate, 'content', 'partial.txt'), 'partial');
    await chmod(join(candidate, 'content'), 0o555);
    await chmod(candidate, 0o555);
    await mkdir(join(orphan, 'content'), { recursive: true });
    await writeFile(join(orphan, 'content', 'orphan.txt'), 'orphan');
    await chmod(join(orphan, 'content', 'orphan.txt'), 0o444);
    await chmod(join(orphan, 'content'), 0o555);
    await chmod(orphan, 0o555);
    fixture.database.raw
      .prepare(
        `INSERT INTO conversation_template_publish_jobs
         (id,template_id,draft_revision,stage,status,version_id,error_code,error_summary,
          requested_by_user_id,draft,created_at,updated_at)
         VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)`
      )
      .run(
        'job-interrupted',
        'template-1',
        fixture.draft.revision,
        'COPYING',
        'RUNNING',
        7,
        JSON.stringify(fixture.draft),
        1_000,
        1_500
      );

    await fixture.service.recoverInterruptedPublications();

    expect(
      fixture.database.raw
        .prepare(
          `SELECT status,error_code,error_summary
           FROM conversation_template_publish_jobs WHERE id=?`
        )
        .get('job-interrupted')
    ).toEqual({
      status: 'FAILED',
      error_code: 'CONVERSATION_TEMPLATE_PUBLISH_INTERRUPTED',
      error_summary:
        'The publish request was interrupted before the template version was registered.'
    });
    expect(await readdir(fixture.store.templatesPublishingDirectory)).toEqual([]);
    expect(await readdir(fixture.store.templatesVersionsDirectory)).toEqual([]);
  });

  it('registers a new version without mutating existing conversations', async () => {
    const fixture = await publisherFixture();
    await writeFile(join(fixture.workspace, 'instructions.md'), 'version two');
    seedPublishedVersion(fixture.database, {
      id: 'existing-version-1',
      storageKey: 'template_version_0001',
      referenceCount: 0,
      draft: fixture.draft
    });
    const prepared = await fixture.store.prepareConversationEnvironment(7, 'conversation-1');
    await fixture.store.createConversation({
      id: 'conversation-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
      templateId: 'template-1',
      templateName: 'Research',
      activeVersionId: 'existing-version-1',
      title: 'Research chat',
      titleSource: 'AUTO',
      pinnedAt: null,
      status: 'ACTIVE',
      modelId: 'model-1',
      createdAt: 1_000,
      updatedAt: 1_000,
      lastActivityAt: 1_000,
      userStorageKey: prepared.userStorageKey,
      conversationStorageKey: prepared.conversationStorageKey,
      templateDeleted: false,
      quota: { usedBytes: 0, maxBytes: 1_000_000 }
    });
    const originalManifest = await readFile(prepared.paths.manifestPath, 'utf8');

    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-upgrade',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const completed = await waitForSuccessfulPublish(
      fixture.operations,
      'template-1',
      'job-upgrade'
    );
    expect(completed).toMatchObject({
      job: { status: 'SUCCEEDED' },
      version: { id: 'version-1', version: 2 }
    });
    expect(
      fixture.database.raw
        .prepare('SELECT active_version_id,status FROM hosted_conversations WHERE id=?')
        .get('conversation-1')
    ).toEqual({ active_version_id: 'existing-version-1', status: 'ACTIVE' });
    expect(await readFile(prepared.paths.manifestPath, 'utf8')).toBe(originalManifest);
    expect(
      fixture.database.raw
        .prepare(
          'SELECT id,reference_count FROM conversation_template_versions ORDER BY version_number'
        )
        .all()
    ).toEqual([
      { id: 'existing-version-1', reference_count: 1 },
      { id: 'version-1', reference_count: 0 }
    ]);
    await writeFile(prepared.paths.manifestPath, originalManifest);
    fixture.database.raw
      .prepare(
        `UPDATE conversation_template_publish_jobs
         SET status='RUNNING' WHERE id='job-upgrade'`
      )
      .run();
    await fixture.service.recoverInterruptedPublications();
    expect(
      fixture.database.raw
        .prepare(
          'SELECT stage,status,version_id FROM conversation_template_publish_jobs WHERE id=?'
        )
        .get('job-upgrade')
    ).toEqual({ stage: 'REGISTERED', status: 'SUCCEEDED', version_id: 'version-1' });
    fixture.database.raw.prepare('DELETE FROM hosted_conversations').run();
    await fixture.store.rebuildConversationIndex();
    expect(
      fixture.database.raw
        .prepare('SELECT active_version_id,status FROM hosted_conversations WHERE id=?')
        .get('conversation-1')
    ).toEqual({ active_version_id: 'existing-version-1', status: 'ACTIVE' });
  });

  it('serializes concurrent publications for one template into distinct versions', async () => {
    const fixture = await publisherFixture();
    await writeFile(join(fixture.workspace, 'instructions.md'), 'concurrent');

    await Promise.all([
      fixture.operations['conversation.template.publish']!({
        templateId: 'template-1',
        jobId: 'job-concurrent-1',
        draft: fixture.draft,
        requestedByUserId: 7
      }),
      fixture.operations['conversation.template.publish']!({
        templateId: 'template-1',
        jobId: 'job-concurrent-2',
        draft: fixture.draft,
        requestedByUserId: 7
      })
    ]);

    const [first, second] = await Promise.all([
      waitForSuccessfulPublish(fixture.operations, 'template-1', 'job-concurrent-1'),
      waitForSuccessfulPublish(fixture.operations, 'template-1', 'job-concurrent-2')
    ]);
    expect(first.job.status).toBe('SUCCEEDED');
    expect(second.job.status).toBe('SUCCEEDED');
    expect([first.version.version, second.version.version].sort()).toEqual([1, 2]);
  });

  it('finishes an interrupted registered publication before publishing a newer version', async () => {
    const fixture = await publisherFixture();
    await writeFile(join(fixture.workspace, 'instructions.md'), 'next version');
    seedPublishedVersion(fixture.database, {
      id: 'interrupted-version-1',
      storageKey: 'template_version_interrupted_0001',
      referenceCount: 0,
      draft: fixture.draft
    });
    fixture.database.raw
      .prepare(
        `INSERT INTO conversation_template_publish_jobs
         (id,template_id,draft_revision,stage,status,version_id,error_code,error_summary,
          requested_by_user_id,draft,created_at,updated_at)
         VALUES (?,?,?,'REGISTERED','RUNNING',?,NULL,NULL,?,?,?,?)`
      )
      .run(
        'job-interrupted-registered',
        'template-1',
        fixture.draft.revision,
        'interrupted-version-1',
        7,
        JSON.stringify(fixture.draft),
        1_000,
        1_500
      );

    await fixture.operations['conversation.template.publish']!({
      templateId: 'template-1',
      jobId: 'job-after-interruption',
      draft: fixture.draft,
      requestedByUserId: 7
    });
    const completed = await waitForSuccessfulPublish(
      fixture.operations,
      'template-1',
      'job-after-interruption'
    );

    expect(completed.version.version).toBe(2);
    expect(
      fixture.database.raw
        .prepare('SELECT status FROM conversation_template_publish_jobs WHERE id=?')
        .get('job-interrupted-registered')
    ).toEqual({ status: 'SUCCEEDED' });
  });

  it('binds a publish idempotency key to the original draft snapshot and requester', async () => {
    const fixture = await publisherFixture();
    await writeFile(join(fixture.workspace, 'instructions.md'), 'idempotent');
    const request = {
      templateId: 'template-1',
      jobId: 'job-idempotent',
      draft: fixture.draft,
      requestedByUserId: 7
    };
    await fixture.operations['conversation.template.publish']!(request);
    await waitForSuccessfulPublish(fixture.operations, 'template-1', 'job-idempotent');

    await expect(
      fixture.operations['conversation.template.publish']!({
        ...request,
        draft: { ...request.draft, name: 'Changed with the same revision' }
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_REVISION_CONFLICT');
    await expect(
      fixture.operations['conversation.template.publish']!({
        ...request,
        requestedByUserId: 8
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
  });

  it('rolls back registration when the publish job is no longer running at the sealed stage', async () => {
    const fixture = await publisherFixture();
    fixture.database.raw
      .prepare(
        `INSERT INTO conversation_template_publish_jobs
         (id,template_id,draft_revision,stage,status,version_id,error_code,error_summary,
          requested_by_user_id,draft,created_at,updated_at)
         VALUES (?,?,?,'SEALED','FAILED',NULL,'FAILED','Failed before registration',?,?,?,?)`
      )
      .run(
        'job-registration-stale',
        'template-1',
        fixture.draft.revision,
        7,
        JSON.stringify(fixture.draft),
        1_000,
        1_500
      );
    const version: ConversationTemplateVersion = {
      id: 'version-registration-stale',
      templateId: 'template-1',
      version: 1,
      status: 'AVAILABLE',
      contentHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      mcpConfigHash: 'c'.repeat(64),
      fileCount: 0,
      totalBytes: 0,
      hostPolicyVersion: 1,
      publishedByUserId: 7,
      publishedAt: 2_000
    };
    const registerVersion = (
      fixture.service as unknown as {
        registerVersion(
          jobId: string,
          storageKey: string,
          manifest: string,
          version: ConversationTemplateVersion
        ): void;
      }
    ).registerVersion.bind(fixture.service);

    expect(() =>
      registerVersion('job-registration-stale', 'template_registration_stale', '{}', version)
    ).toThrow('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    expect(
      fixture.database.raw
        .prepare('SELECT id FROM conversation_template_versions WHERE id=?')
        .get(version.id)
    ).toBeUndefined();
    expect(
      fixture.database.raw
        .prepare(
          'SELECT stage,status,version_id FROM conversation_template_publish_jobs WHERE id=?'
        )
        .get('job-registration-stale')
    ).toEqual({ stage: 'SEALED', status: 'FAILED', version_id: null });
  });
});

async function publisherFixture(sourceWorkspacePathOverride?: string) {
  const directory = await temporaryDirectory('publisher');
  const workspace = join(directory, 'workspace');
  const sourceWorkspacePath =
    sourceWorkspacePathOverride ??
    `/home/template-publisher-tests/${basename(directory)}/workspace`;
  const storeRoot = join(directory, 'data', 'hosted');
  await mkdir(workspace, { recursive: true });
  const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1', () => 2_000);
  database.saveWorkspace({
    id: 'workspace-1',
    path: workspace,
    kind: 'DIRECTORY',
    gitSummary: null
  });
  database.saveMcpInstallation({
    targetKind: 'NODE',
    entry: {
      id: 'mcp-local',
      sourceId: 'source-1',
      scope: 'ENTERPRISE',
      serverName: 'local-research',
      displayName: 'Local Research',
      description: 'Local research tools',
      version: '1.0.0',
      featured: false,
      tags: [],
      runtime: {
        transport: 'STDIO',
        command: 'node',
        args: ['server.js'],
        environment: { TOKEN: { secretName: 'MCP_TOKEN' } }
      },
      createdAt: 1_000,
      updatedAt: 1_000
    },
    enabled: true,
    configuration: {
      arguments: ['--workspace'],
      environment: { EXTRA_TOKEN: { secretName: 'MCP_EXTRA_TOKEN' } }
    }
  });
  database.saveMcpInstallation({
    targetKind: 'WORKSPACE',
    targetId: 'workspace-1',
    entry: {
      id: 'mcp-remote',
      sourceId: 'source-1',
      scope: 'ENTERPRISE',
      serverName: 'remote-research',
      displayName: 'Remote Research',
      description: 'Remote research tools',
      version: '2.0.0',
      featured: false,
      tags: [],
      runtime: {
        transport: 'HTTP',
        url: 'https://mcp.example.test/tools',
        headers: { Authorization: { secretName: 'MCP_HTTP_TOKEN' } }
      },
      createdAt: 1_000,
      updatedAt: 1_000
    },
    enabled: true,
    configuration: {}
  });
  const store = new HostedConversationStore({
    dataDirectory: join(directory, 'data'),
    rootDirectory: storeRoot,
    nodeId: 'node-1',
    database
  });
  await store.initialize();
  const service = new ConversationTemplateNodeService({
    database,
    store,
    nodeId: () => 'node-1',
    sourceWorkspacePath: () => sourceWorkspacePath,
    now: () => 2_000,
    id: (() => {
      let sequence = 0;
      return () => `version-${++sequence}`;
    })()
  });
  const draft: ConversationTemplateDraft = {
    templateId: 'template-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    revision: 1,
    name: 'Research',
    description: 'Research template',
    allowedModels: [{ modelId: 'model-1', name: 'Model One' }],
    defaultModelId: 'model-1',
    mcpIds: ['mcp-local'],
    networkMode: 'NONE',
    quotas: {
      maxStorageBytes: 1_000_000,
      maxUploadBytes: 100_000
    },
    updatedAt: 1_900
  };
  return {
    dataDirectory: join(directory, 'data'),
    databasePath: join(directory, 'node-runtime.sqlite'),
    database,
    store,
    service,
    operations: service.operations(),
    workspace,
    sourceWorkspacePath,
    draft
  };
}

async function publishedEmptyFixture() {
  const fixture = await publisherFixture();
  await fixture.operations['conversation.template.publish']!({
    templateId: 'template-1',
    jobId: 'binding-vector',
    draft: fixture.draft,
    requestedByUserId: 7
  });
  const completed = await waitForSuccessfulPublish(
    fixture.operations,
    'template-1',
    'binding-vector'
  );
  const row = fixture.database.raw
    .prepare('SELECT storage_key FROM conversation_template_versions WHERE id=?')
    .get(completed.version.id) as { storage_key: string };
  return {
    ...fixture,
    versionId: completed.version.id,
    versionDirectory: fixture.store.templateVersionDirectory(row.storage_key)
  };
}

async function rewritePublishedManifest(
  fixture: Awaited<ReturnType<typeof publishedEmptyFixture>>,
  patch: Record<string, unknown>
) {
  const path = join(fixture.versionDirectory, 'manifest.json');
  const manifest = JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), ...patch });
  await chmod(path, 0o644);
  await writeFile(path, `${manifest}\n`);
  await chmod(path, 0o444);
  // Rebind raw text/hash so the test reaches semantic checks, not an earlier digest failure.
  fixture.database.raw
    .prepare('UPDATE conversation_template_versions SET manifest=?,manifest_hash=? WHERE id=?')
    .run(manifest, createHash('sha256').update(manifest).digest('hex'), fixture.versionId);
}

const hostedModel = {
  id: 'model-1',
  name: 'Model One',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test/v1',
  credential: { type: 'INLINE_API_KEY', value: 'test-key' },
  modelId: 'model-1',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

function hostedPublisherConsumer(
  fixture: Awaited<ReturnType<typeof publisherFixture>>,
  versionId: string
) {
  const runtime = {
    createSession: vi.fn<HostedConversationRuntime['createSession']>(async () => ({
      sessionId: 'published-session'
    })),
    history: vi.fn<HostedConversationRuntime['history']>(async () => ({
      turns: [],
      nextCursor: null
    })),
    rollback: vi.fn<HostedConversationRuntime['rollback']>(async () => ({ lastActivityAt: 2_000 })),
    startRun: vi.fn<HostedConversationRuntime['startRun']>(),
    releaseSession: vi.fn<HostedConversationRuntime['releaseSession']>(async () => undefined)
  } satisfies HostedConversationRuntime;
  const service = new HostedConversationNodeService({
    database: fixture.database,
    store: fixture.store,
    runtime,
    nodeId: () => 'node-1',
    processExecutorFactory: () => ({ spawn: vi.fn() }) as never,
    readImage: async () => undefined
  });
  return {
    service,
    runtime,
    create: () =>
      service.operations()['conversation.hosted.create']!({
        templateId: 'template-1',
        clientRequestId: 'published-create',
        __requestUserId: 7,
        __template: {
          id: 'template-1',
          nodeId: 'node-1',
          name: 'Research',
          description: 'Research template',
          status: 'ACTIVE',
          currentVersionId: versionId,
          available: true,
          createdAt: 1_000,
          updatedAt: 2_000
        },
        __marAgentModels: [hostedModel]
      })
  };
}

async function waitForSuccessfulPublish(
  operations: Readonly<Record<string, (data: unknown) => Promise<unknown> | unknown>>,
  templateId: string,
  jobId: string
) {
  const result = await waitForPublish(operations, templateId, jobId);
  if (result.job.status !== 'SUCCEEDED' || result.version === undefined)
    throw new Error('PUBLISH_DID_NOT_SUCCEED');
  return { ...result, version: result.version };
}

async function waitForPublish(
  operations: Readonly<Record<string, (data: unknown) => Promise<unknown> | unknown>>,
  templateId: string,
  jobId: string
): Promise<ConversationTemplatePublishResult> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = conversationTemplatePublishResultSchema.parse(
      await operations['conversation.template.publish.status']!({
        templateId,
        jobId
      })
    );
    if (result.job.status === 'SUCCEEDED' || result.job.status === 'FAILED') return result;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('PUBLISH_DID_NOT_SETTLE');
}

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `mar-node-conversation-${label}-`));
  directories.push(path);
  return path;
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

function manifestV2ContentHash(
  directories: readonly string[],
  entries: readonly Record<string, unknown>[]
): string {
  return createHash('sha256')
    .update(
      [
        ...directories.map((directory) => `DIRECTORY\0${directory}`),
        ...entries.map((entry) =>
          entry['kind'] === 'FILE'
            ? `FILE\0${entry['relativePath']}\0${entry['size']}\0${entry['executable'] ? 1 : 0}\0${entry['sha256']}`
            : `SYMLINK\0${entry['relativePath']}\0${entry['size']}\0${entry['linkTarget']}\0${entry['targetKind']}\0${entry['resolvedTarget']}`
        )
      ].join('\n')
    )
    .digest('hex');
}

function seedPublishedVersion(
  database: NodeDatabase,
  input: {
    readonly id: string;
    readonly storageKey: string;
    readonly referenceCount: number;
    readonly draft: ConversationTemplateDraft;
  }
): void {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    templateId: input.draft.templateId,
    versionId: input.id,
    versionNumber: 1,
    draftRevision: input.draft.revision,
    hostPolicyVersion: 1,
    publishedByUserId: 7,
    publishedAt: 1_000,
    draft: input.draft,
    files: [],
    contentHash: 'a'.repeat(64)
  });
  database.raw
    .prepare(
      `INSERT INTO conversation_template_versions
       (id,template_id,version_number,draft_revision,status,storage_key,manifest,content_hash,
        manifest_hash,file_count,total_bytes,host_policy_version,published_by_user_id,published_at,
        reference_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.id,
      'template-1',
      1,
      1,
      'AVAILABLE',
      input.storageKey,
      manifest,
      'a'.repeat(64),
      'b'.repeat(64),
      0,
      0,
      1,
      7,
      1_000,
      input.referenceCount
    );
}
