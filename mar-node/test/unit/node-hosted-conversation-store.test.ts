import {
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
import { NodeDatabase } from '../../src/database.js';
import { HostedConversationStore } from '../../src/service/hosted-conversation-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node hosted conversation store', () => {
  it('orders related files by last update then relative path instead of opaque file ID', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const { prepared, conversation } = await createActiveConversation(
      fixture,
      'conversation-file-order'
    );
    const reportsDirectory = join(prepared.paths.outputDirectory, 'reports');
    const newestPath = join(prepared.paths.outputDirectory, 'newest.txt');
    const alphaPath = join(reportsDirectory, 'alpha.txt');
    const betaPath = join(reportsDirectory, 'beta.txt');
    const zetaPath = join(prepared.paths.outputDirectory, 'zeta.txt');
    await mkdir(reportsDirectory, { recursive: true });
    await Promise.all(
      [newestPath, alphaPath, betaPath, zetaPath].map((path) => writeFile(path, path))
    );
    const tiedAt = new Date('2030-01-01T00:00:00.000Z');
    const newestAt = new Date('2030-01-02T00:00:00.000Z');
    await Promise.all([
      utimes(newestPath, newestAt, newestAt),
      utimes(alphaPath, tiedAt, tiedAt),
      utimes(betaPath, tiedAt, tiedAt),
      utimes(zetaPath, tiedAt, tiedAt)
    ]);
    await fixture.store.reconcileFiles(42, conversation.id);
    fixture.database.raw
      .prepare(
        `UPDATE conversation_files
         SET id=CASE relative_path
           WHEN 'newest.txt' THEN 'file-z'
           WHEN 'reports/alpha.txt' THEN 'file-y'
           WHEN 'reports/beta.txt' THEN 'file-x'
           WHEN 'zeta.txt' THEN 'file-a'
         END
         WHERE conversation_id=?`
      )
      .run(conversation.id);

    expect(fixture.store.listFiles(42, conversation.id).map((file) => file.relativePath)).toEqual([
      'newest.txt',
      'reports/alpha.txt',
      'reports/beta.txt',
      'zeta.txt'
    ]);
    fixture.database.close();
  });

  it('permanently removes the legacy recovery directory before rebuilding active manifests', async () => {
    const directory = await temporaryDirectory('legacy-recovery');
    const dataDirectory = join(directory, 'data');
    const rootDirectory = join(dataDirectory, 'hosted');
    const legacyDirectory = join(
      rootDirectory,
      'recoverable-deleted',
      'user_legacy',
      'conversation_legacy'
    );
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, 'history.jsonl'), 'legacy');
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const store = new HostedConversationStore({
      dataDirectory,
      rootDirectory,
      nodeId: 'node-1',
      database
    });

    await store.initialize();

    await expect(readdir(join(rootDirectory, 'recoverable-deleted'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    database.close();
  });

  it('creates an opaque isolated layout and rebuilds SQLite from conversation manifests', async () => {
    const fixture = await storeFixture();
    expect(fixture.store.userStorageKey(42)).toMatch(/^[A-Za-z0-9_-]{8,160}$/u);
    expect(fixture.store.userStorageKey(42)).not.toContain('42');
    expect(fixture.store.userStorageKey(42)).toBe(fixture.store.userStorageKey(42));

    seedVersion(fixture.database);
    const environment = await fixture.store.prepareConversationEnvironment(42, 'conversation-1');
    const { userStorageKey, conversationStorageKey } = environment;
    const conversationDirectory = environment.paths.conversationDirectory;
    await writeFile(
      join(conversationDirectory, 'manifest', 'conversation.json'),
      JSON.stringify({
        id: 'conversation-1',
        nodeId: 'node-1',
        sessionId: 'session-1',
        templateId: 'template-1',
        templateName: 'Research',
        activeVersionId: 'version-1',
        pendingVersionId: null,
        title: 'Research chat',
        pinnedAt: null,
        status: 'ACTIVE',
        modelId: 'model-1',
        createdAt: 1_000,
        updatedAt: 2_000,
        lastActivityAt: 2_000,
        userStorageKey,
        conversationStorageKey,
        templateDeleted: false,
        recoverableUntil: null,
        quota: { usedBytes: 10, maxBytes: 1_000_000 }
      })
    );

    await fixture.store.rebuildConversationIndex();
    expect(
      fixture.database.raw
        .prepare(
          'SELECT id,user_storage_key,conversation_storage_key,session_id,status FROM hosted_conversations'
        )
        .get()
    ).toEqual({
      id: 'conversation-1',
      user_storage_key: userStorageKey,
      conversation_storage_key: conversationStorageKey,
      session_id: 'session-1',
      status: 'ACTIVE'
    });
    expect(JSON.parse(await readFile(environment.paths.manifestPath, 'utf8'))).not.toHaveProperty(
      'pendingVersionId'
    );

    fixture.store.createMessage({
      conversationId: 'conversation-1',
      clientMessageId: 'message-1',
      runId: 'run-1',
      userTextPresent: true,
      status: 'SUCCEEDED',
      createdAt: 2_000,
      updatedAt: 2_000
    });
    fixture.database.raw.exec('PRAGMA foreign_keys = OFF');
    fixture.database.raw.prepare('DELETE FROM hosted_conversations').run();
    fixture.database.raw.exec('PRAGMA foreign_keys = ON');

    await fixture.store.rebuildConversationIndex();

    expect(
      fixture.database.raw
        .prepare(
          'SELECT conversation_id,client_message_id FROM hosted_conversation_messages WHERE conversation_id=?'
        )
        .get('conversation-1')
    ).toEqual({
      conversation_id: 'conversation-1',
      client_message_id: 'message-1'
    });
    expect(fixture.database.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects messages whose parent conversation does not exist', async () => {
    const fixture = await storeFixture();
    expect(() =>
      fixture.store.createMessage({
        conversationId: 'missing-conversation',
        clientMessageId: 'message-missing-parent',
        runId: 'run-1',
        userTextPresent: true,
        status: 'RUNNING',
        createdAt: 1_000,
        updatedAt: 1_000
      })
    ).toThrow('HOSTED_CONVERSATION_NOT_FOUND');
    expect(
      fixture.database.raw.prepare('SELECT * FROM hosted_conversation_messages').all()
    ).toEqual([]);
    fixture.database.close();
  });

  it('requires an existing template version with the conversation template id when creating', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    seedVersion(fixture.database, 'version-other-template', 'template_version_0002', 2);
    fixture.database.raw
      .prepare('UPDATE conversation_template_versions SET template_id=? WHERE id=?')
      .run('template-2', 'version-other-template');

    const missingVersion = await fixture.store.prepareConversationEnvironment(
      42,
      'conversation-missing-version'
    );
    const base = {
      nodeId: fixture.nodeId,
      sessionId: 'session-missing-version',
      templateId: 'template-1',
      templateName: 'Research',
      title: 'Missing version',
      titleSource: 'AUTO' as const,
      pinnedAt: null,
      status: 'ACTIVE' as const,
      modelId: 'model-1',
      createdAt: 1_000,
      updatedAt: 1_000,
      lastActivityAt: 1_000,
      userStorageKey: missingVersion.userStorageKey,
      conversationStorageKey: missingVersion.conversationStorageKey,
      templateDeleted: false,
      quota: { usedBytes: 0, maxBytes: 1_000_000 }
    };
    await expect(
      fixture.store.createConversation({
        ...base,
        id: 'conversation-missing-version',
        activeVersionId: 'missing-version'
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');

    const mismatchedVersion = await fixture.store.prepareConversationEnvironment(
      42,
      'conversation-mismatched-version'
    );
    await expect(
      fixture.store.createConversation({
        ...base,
        id: 'conversation-mismatched-version',
        sessionId: 'session-mismatched-version',
        title: 'Mismatched version',
        userStorageKey: mismatchedVersion.userStorageKey,
        conversationStorageKey: mismatchedVersion.conversationStorageKey,
        activeVersionId: 'version-other-template'
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    expect(
      fixture.database.raw.prepare('SELECT id FROM hosted_conversations ORDER BY id').all()
    ).toEqual([]);
    fixture.database.close();
  });

  it('reuses isolated host temporary directories and recreates them after system cleanup', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    await createActiveConversation(fixture, 'conversation-first', 42);
    await createActiveConversation(fixture, 'conversation-second', 43);

    const first = await fixture.store.prepareConversationTemporaryDirectory(
      42,
      'conversation-first'
    );
    await writeFile(join(first, 'progress.txt'), 'progress');
    await expect(
      fixture.store.prepareConversationTemporaryDirectory(42, 'conversation-first')
    ).resolves.toBe(first);
    await expect(readFile(join(first, 'progress.txt'), 'utf8')).resolves.toBe('progress');

    const second = await fixture.store.prepareConversationTemporaryDirectory(
      43,
      'conversation-second'
    );
    expect(second).not.toBe(first);
    expect(first).toContain(fixture.temporaryRootDirectory);
    expect(first).not.toContain('conversation-first');
    expect(second).not.toContain('conversation-second');

    const otherNodeFixture = await storeFixture('node-2', fixture.temporaryRootDirectory);
    seedVersion(otherNodeFixture.database);
    await createActiveConversation(otherNodeFixture, 'conversation-other-node', 42);
    const otherNode = await otherNodeFixture.store.prepareConversationTemporaryDirectory(
      42,
      'conversation-other-node'
    );
    expect(otherNode).not.toBe(first);
    await expect(readdir(otherNode)).resolves.toEqual([]);

    await rm(fixture.temporaryRootDirectory, { recursive: true, force: true });
    await expect(
      fixture.store.prepareConversationTemporaryDirectory(42, 'conversation-first')
    ).resolves.toBe(first);
    await expect(readdir(first)).resolves.toEqual([]);

    const outside = await temporaryDirectory('host-tmp-outside');
    await rm(first, { recursive: true, force: true });
    await symlink(outside, first);
    await expect(
      fixture.store.prepareConversationTemporaryDirectory(42, 'conversation-first')
    ).rejects.toThrow('HOSTED_CONVERSATION_STORAGE_INVALID');

    await rm(fixture.temporaryRootDirectory, { recursive: true, force: true });
    await symlink(outside, fixture.temporaryRootDirectory);
    await expect(
      fixture.store.prepareConversationTemporaryDirectory(42, 'conversation-first')
    ).rejects.toThrow('HOSTED_CONVERSATION_STORAGE_INVALID');
  });

  it('reuses the same host temporary directory and content after the Store restarts', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    await createActiveConversation(fixture, 'conversation-restarted', 42);
    const temporaryDirectory = await fixture.store.prepareConversationTemporaryDirectory(
      42,
      'conversation-restarted'
    );
    await writeFile(join(temporaryDirectory, 'progress.txt'), 'progress');
    fixture.database.close();

    const restartedDatabase = new NodeDatabase(fixture.databasePath, fixture.nodeId);
    const restartedStore = new HostedConversationStore({
      dataDirectory: fixture.dataDirectory,
      rootDirectory: fixture.rootDirectory,
      temporaryRootDirectory: fixture.temporaryRootDirectory,
      nodeId: fixture.nodeId,
      database: restartedDatabase
    });
    await restartedStore.initialize();

    await expect(
      restartedStore.prepareConversationTemporaryDirectory(42, 'conversation-restarted')
    ).resolves.toBe(temporaryDirectory);
    await expect(readFile(join(temporaryDirectory, 'progress.txt'), 'utf8')).resolves.toBe(
      'progress'
    );
    restartedDatabase.close();
  });

  it('upgrades legacy manifests with pinned metadata and preserves their existing title as CUSTOM', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const environment = await fixture.store.prepareConversationEnvironment(42, 'conversation-1');
    await writeFile(
      environment.paths.manifestPath,
      JSON.stringify({
        id: 'conversation-1',
        nodeId: 'node-1',
        sessionId: 'session-1',
        templateId: 'template-1',
        templateName: 'Research',
        activeVersionId: 'version-1',
        pendingVersionId: null,
        title: 'Research chat',
        status: 'ACTIVE',
        modelId: 'model-1',
        createdAt: 1_000,
        updatedAt: 2_000,
        lastActivityAt: 2_000,
        userStorageKey: environment.userStorageKey,
        conversationStorageKey: environment.conversationStorageKey,
        templateDeleted: false,
        recoverableUntil: null,
        quota: { usedBytes: 0, maxBytes: 1_000_000 }
      })
    );

    await fixture.store.rebuildConversationIndex();

    expect(
      fixture.database.raw
        .prepare('SELECT title_source,pinned_at FROM hosted_conversations WHERE id=?')
        .get('conversation-1')
    ).toEqual({ title_source: 'CUSTOM', pinned_at: null });
    expect(JSON.parse(await readFile(environment.paths.manifestPath, 'utf8'))).toMatchObject({
      titleSource: 'CUSTOM',
      pinnedAt: null
    });
  });

  it('rejects a symlinked conversation directory instead of indexing content outside the store', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const outside = await temporaryDirectory('outside');
    const userStorageKey = fixture.store.userStorageKey(8);
    const sessions = join(fixture.store.usersDirectory, userStorageKey, 'sessions');
    await mkdir(sessions, { recursive: true });
    await symlink(outside, join(sessions, 'conversation_escape'));

    await expect(fixture.store.rebuildConversationIndex()).rejects.toThrow(
      'HOSTED_CONVERSATION_STORAGE_INVALID'
    );
    expect(
      fixture.database.raw.prepare('SELECT COUNT(*) AS count FROM hosted_conversations').get()
    ).toEqual({ count: 0 });
  });

  it('rejects symlinked fixed-directory parents before creating content outside the store', async () => {
    const directory = await temporaryDirectory('fixed-parent');
    const dataDirectory = join(directory, 'data');
    const rootDirectory = join(dataDirectory, 'hosted');
    const outside = await temporaryDirectory('fixed-parent-outside');
    await mkdir(rootDirectory, { recursive: true });
    await symlink(outside, join(rootDirectory, 'templates'));
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const store = new HostedConversationStore({
      dataDirectory,
      rootDirectory,
      nodeId: 'node-1',
      database
    });

    await expect(store.initialize()).rejects.toThrow('HOSTED_CONVERSATION_STORAGE_INVALID');
    expect(await readdir(outside)).toEqual([]);
  });

  it('paginates pinned conversations first, then by activity and stable id', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    seedConversation(fixture, {
      id: 'conversation-a',
      userId: 42,
      conversationStorageKey: 'conversation_opaque_0001',
      lastActivityAt: 3_000
    });
    seedConversation(fixture, {
      id: 'conversation-c',
      userId: 42,
      conversationStorageKey: 'conversation_opaque_0002',
      lastActivityAt: 2_000,
      pinnedAt: 4_000
    });
    seedConversation(fixture, {
      id: 'conversation-b',
      userId: 42,
      conversationStorageKey: 'conversation_opaque_0003',
      lastActivityAt: 2_000
    });
    seedConversation(fixture, {
      id: 'conversation-other-user',
      userId: 43,
      conversationStorageKey: 'conversation_opaque_0004',
      lastActivityAt: 4_000
    });

    const firstPage = fixture.store.listConversations({
      userId: 42,
      limit: 2
    });
    expect(firstPage.items.map((conversation) => conversation.id)).toEqual([
      'conversation-c',
      'conversation-a'
    ]);
    const firstCursor = firstPage.nextCursor;
    expect(firstCursor).toEqual(expect.any(String));
    if (firstCursor === null) throw new Error('EXPECTED_HOSTED_CONVERSATION_CURSOR');
    expect(firstPage.items[0]).not.toHaveProperty('userStorageKey');
    expect(firstPage.items[0]).not.toHaveProperty('conversationStorageKey');

    const secondPage = fixture.store.listConversations({
      userId: 42,
      limit: 2,
      cursor: firstCursor
    });
    expect(secondPage.items.map((conversation) => conversation.id)).toEqual(['conversation-b']);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      [...firstPage.items, ...secondPage.items].map((conversation) => conversation.id)
    ).toEqual(['conversation-c', 'conversation-a', 'conversation-b']);
    expect(firstPage.items[0]?.pinnedAt).toBe(4_000);
  });

  it('binds hosted conversation cursors to the Node, authorized user, limit and sort version', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    seedConversation(fixture, {
      id: 'conversation-a',
      userId: 42,
      conversationStorageKey: 'conversation_opaque_0001',
      lastActivityAt: 3_000
    });
    seedConversation(fixture, {
      id: 'conversation-b',
      userId: 42,
      conversationStorageKey: 'conversation_opaque_0002',
      lastActivityAt: 2_000
    });

    const firstPage = fixture.store.listConversations({ userId: 42, limit: 1 });
    const firstCursor = firstPage.nextCursor;
    expect(firstCursor).toEqual(expect.any(String));
    if (firstCursor === null) throw new Error('EXPECTED_HOSTED_CONVERSATION_CURSOR');
    expect(() =>
      fixture.store.listConversations({
        userId: 43,
        limit: 1,
        cursor: firstCursor
      })
    ).toThrow('HOSTED_CONVERSATION_CURSOR_INVALID');
    expect(() =>
      fixture.store.listConversations({
        userId: 42,
        limit: 2,
        cursor: firstCursor
      })
    ).toThrow('HOSTED_CONVERSATION_CURSOR_INVALID');

    const otherFixture = await storeFixture('node-2');
    seedVersion(otherFixture.database);
    expect(() =>
      otherFixture.store.listConversations({
        userId: 42,
        limit: 1,
        cursor: firstCursor
      })
    ).toThrow('HOSTED_CONVERSATION_CURSOR_INVALID');

    const decoded = JSON.parse(Buffer.from(firstCursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(decoded).not.toHaveProperty('userStorageKey');
    expect(decoded).not.toHaveProperty('conversationStorageKey');
    expect(decoded).not.toHaveProperty('nodeId');
    expect(() =>
      fixture.store.listConversations({
        userId: 42,
        limit: 1,
        cursor: Buffer.from(JSON.stringify({ ...decoded, sortVersion: 1 }), 'utf8').toString(
          'base64url'
        )
      })
    ).toThrow('HOSTED_CONVERSATION_CURSOR_INVALID');
  });

  it('rejects malformed hosted conversation cursors', async () => {
    const fixture = await storeFixture();

    expect(() =>
      fixture.store.listConversations({
        userId: 42,
        limit: 20,
        cursor: 'not-a-valid-cursor'
      })
    ).toThrow('HOSTED_CONVERSATION_CURSOR_INVALID');
  });

  it('counts only the active template version reference', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const prepared = await fixture.store.prepareConversationEnvironment(
      42,
      'conversation-same-version'
    );

    await fixture.store.createConversation({
      id: 'conversation-same-version',
      nodeId: 'node-1',
      sessionId: 'session-same-version',
      templateId: 'template-1',
      templateName: 'Research',
      activeVersionId: 'version-1',
      title: 'Research',
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

    expect(
      fixture.database.raw
        .prepare('SELECT reference_count FROM conversation_template_versions WHERE id=?')
        .get('version-1')
    ).toEqual({ reference_count: 1 });
  });

  it('serializes manual and automatic title writes so a queued automatic title cannot replace CUSTOM', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const prepared = await fixture.store.prepareConversationEnvironment(
      42,
      'conversation-title-race'
    );
    const conversation = await fixture.store.createConversation({
      id: 'conversation-title-race',
      nodeId: 'node-1',
      sessionId: 'session-title-race',
      templateId: 'template-1',
      templateName: 'Research',
      activeVersionId: 'version-1',
      title: 'Temporary title',
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
    const internals = fixture.store as unknown as {
      writeManifest(path: string, manifest: unknown): Promise<void>;
    };
    const writeManifest = internals.writeManifest.bind(fixture.store);
    let releaseManualWrite!: () => void;
    let reportManualWrite!: () => void;
    const manualWriteReleased = new Promise<void>((resolve) => {
      releaseManualWrite = resolve;
    });
    const manualWriteStarted = new Promise<void>((resolve) => {
      reportManualWrite = resolve;
    });
    vi.spyOn(internals, 'writeManifest').mockImplementation(async (path, manifest) => {
      if ((manifest as { readonly title?: string }).title === 'Custom title') {
        reportManualWrite();
        await manualWriteReleased;
      }
      await writeManifest(path, manifest);
    });

    const manual = fixture.store.saveConversation({
      ...conversation,
      title: 'Custom title',
      titleSource: 'CUSTOM',
      updatedAt: 2_000
    });
    await manualWriteStarted;
    const automatic = fixture.store.saveAutomaticTitle(conversation.id, 'Generated title', 3_000);
    releaseManualWrite();

    await expect(manual).resolves.toMatchObject({
      title: 'Custom title',
      titleSource: 'CUSTOM'
    });
    await expect(automatic).resolves.toBeUndefined();
    expect(
      fixture.database.raw
        .prepare('SELECT title,title_source FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ title: 'Custom title', title_source: 'CUSTOM' });
    expect(JSON.parse(await readFile(prepared.paths.manifestPath, 'utf8'))).toMatchObject({
      title: 'Custom title',
      titleSource: 'CUSTOM'
    });
  });

  it('serializes file reconciliation with metadata writes so stale manifests cannot replace CUSTOM', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const prepared = await fixture.store.prepareConversationEnvironment(
      42,
      'conversation-file-race'
    );
    const conversation = await fixture.store.createConversation({
      id: 'conversation-file-race',
      nodeId: 'node-1',
      sessionId: 'session-file-race',
      templateId: 'template-1',
      templateName: 'Research',
      activeVersionId: 'version-1',
      title: 'Temporary title',
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
    await writeFile(join(prepared.paths.outputDirectory, 'result.txt'), 'result');
    const internals = fixture.store as unknown as {
      scanConversationFiles(
        manifest: unknown,
        paths: unknown,
        existing: unknown
      ): Promise<readonly unknown[]>;
    };
    const scanConversationFiles = internals.scanConversationFiles.bind(fixture.store);
    let releaseScan!: () => void;
    let reportScanStarted!: () => void;
    const scanReleased = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const scanStarted = new Promise<void>((resolve) => {
      reportScanStarted = resolve;
    });
    vi.spyOn(internals, 'scanConversationFiles').mockImplementation(
      async (manifest, paths, existing) => {
        reportScanStarted();
        await scanReleased;
        return scanConversationFiles(manifest, paths, existing);
      }
    );

    const reconciliation = fixture.store.reconcileFiles(42, conversation.id);
    await scanStarted;
    const metadataWrite = fixture.store.saveConversation({
      ...conversation,
      title: 'Custom title',
      titleSource: 'CUSTOM',
      updatedAt: 2_000
    });
    releaseScan();
    await Promise.all([reconciliation, metadataWrite]);

    expect(
      fixture.database.raw
        .prepare('SELECT title,title_source FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ title: 'Custom title', title_source: 'CUSTOM' });
    expect(JSON.parse(await readFile(prepared.paths.manifestPath, 'utf8'))).toMatchObject({
      title: 'Custom title',
      titleSource: 'CUSTOM'
    });
  });

  it('serializes file deletion with metadata writes so stale manifests cannot replace CUSTOM', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const { prepared, conversation } = await createActiveConversation(
      fixture,
      'conversation-file-delete-race'
    );
    await writeFile(join(prepared.paths.outputDirectory, 'result.txt'), 'result');
    await fixture.store.reconcileFiles(42, conversation.id);
    const file = fixture.store.listFiles(42, conversation.id)[0]!;
    const internals = fixture.store as unknown as {
      scanConversationFiles(
        manifest: unknown,
        paths: unknown,
        existing: unknown
      ): Promise<readonly unknown[]>;
    };
    const scanConversationFiles = internals.scanConversationFiles.bind(fixture.store);
    let releaseScan!: () => void;
    let reportScanStarted!: () => void;
    const scanReleased = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const scanStarted = new Promise<void>((resolve) => {
      reportScanStarted = resolve;
    });
    vi.spyOn(internals, 'scanConversationFiles').mockImplementation(
      async (manifest, paths, existing) => {
        reportScanStarted();
        await scanReleased;
        return scanConversationFiles(manifest, paths, existing);
      }
    );

    const deletion = fixture.store.deleteFile(42, conversation.id, file.id, 3_000);
    await scanStarted;
    const metadataWrite = fixture.store.updateConversation(conversation.id, (latest) => ({
      ...latest,
      title: 'Custom title',
      titleSource: 'CUSTOM',
      updatedAt: 2_000
    }));
    releaseScan();
    await Promise.all([deletion, metadataWrite]);

    expect(
      fixture.database.raw
        .prepare('SELECT title,title_source FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ title: 'Custom title', title_source: 'CUSTOM' });
    expect(JSON.parse(await readFile(prepared.paths.manifestPath, 'utf8'))).toMatchObject({
      title: 'Custom title',
      titleSource: 'CUSTOM'
    });
  });

  it('serializes file registration manifest rewrites with metadata writes', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const { prepared, conversation } = await createActiveConversation(
      fixture,
      'conversation-file-register-race'
    );
    const path = join(prepared.paths.uploadsDirectory, 'input.txt');
    await writeFile(path, 'input');
    const file = {
      id: fixture.store.fileProjectionId(conversation.id, 'UPLOAD', 'input.txt'),
      conversationId: conversation.id,
      category: 'UPLOAD',
      relativePath: 'input.txt',
      displayName: 'input.txt',
      mimeType: 'text/plain',
      size: 5,
      source: 'USER',
      createdAt: 1_000,
      updatedAt: 1_000
    } as const;
    const internals = fixture.store as unknown as {
      writeManifest(path: string, manifest: unknown): Promise<void>;
    };
    const writeManifest = internals.writeManifest.bind(fixture.store);
    let releaseRegistrationWrite!: () => void;
    let reportRegistrationWriteStarted!: () => void;
    const registrationWriteReleased = new Promise<void>((resolve) => {
      releaseRegistrationWrite = resolve;
    });
    const registrationWriteStarted = new Promise<void>((resolve) => {
      reportRegistrationWriteStarted = resolve;
    });
    vi.spyOn(internals, 'writeManifest').mockImplementation(async (manifestPath, manifest) => {
      const value = manifest as {
        readonly id?: string;
        readonly titleSource?: string;
        readonly quota?: { readonly usedBytes?: number };
      };
      if (
        value.id === conversation.id &&
        value.titleSource === 'AUTO' &&
        value.quota?.usedBytes === file.size
      ) {
        reportRegistrationWriteStarted();
        await registrationWriteReleased;
      }
      await writeManifest(manifestPath, manifest);
    });

    const registration = fixture.store.registerFile(42, file);
    await registrationWriteStarted;
    const metadataWrite = fixture.store.updateConversation(conversation.id, (latest) => ({
      ...latest,
      title: 'Custom title',
      titleSource: 'CUSTOM',
      updatedAt: 2_000
    }));
    releaseRegistrationWrite();
    await Promise.all([registration, metadataWrite]);

    expect(
      fixture.database.raw
        .prepare('SELECT title,title_source,used_bytes FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ title: 'Custom title', title_source: 'CUSTOM', used_bytes: file.size });
    expect(JSON.parse(await readFile(prepared.paths.manifestPath, 'utf8'))).toMatchObject({
      title: 'Custom title',
      titleSource: 'CUSTOM',
      quota: { usedBytes: file.size }
    });
  });

  it('releases the active template reference when permanently deleting a conversation', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    seedVersion(fixture.database, 'version-2', 'template_version_0002', 2);
    const prepared = await fixture.store.prepareConversationEnvironment(
      42,
      'conversation-active-delete'
    );
    await fixture.store.createConversation({
      id: 'conversation-active-delete',
      nodeId: 'node-1',
      sessionId: 'session-pending-delete',
      templateId: 'template-1',
      templateName: 'Research',
      activeVersionId: 'version-1',
      title: 'Active delete',
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

    fixture.database.raw
      .prepare(
        `INSERT INTO conversation_files
         (id,conversation_id,category,relative_path,display_name,mime_type,size,source,turn_id,item_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'file-active-delete',
        'conversation-active-delete',
        'OUTPUT',
        'result.txt',
        'result.txt',
        'text/plain',
        4,
        'AGENT',
        null,
        null,
        1_000,
        1_000
      );
    fixture.store.createMessage({
      conversationId: 'conversation-active-delete',
      clientMessageId: 'message-active-delete',
      runId: 'run-active-delete',
      userTextPresent: true,
      status: 'SUCCEEDED',
      createdAt: 1_000,
      updatedAt: 1_000
    });

    await fixture.store.permanentDeleteConversation('conversation-active-delete');

    expect(
      fixture.database.raw
        .prepare(
          'SELECT id,reference_count FROM conversation_template_versions ORDER BY version_number'
        )
        .all()
    ).toEqual([
      { id: 'version-1', reference_count: 0 },
      { id: 'version-2', reference_count: 0 }
    ]);
    expect(
      fixture.database.raw
        .prepare('SELECT id FROM hosted_conversations WHERE id=?')
        .get('conversation-active-delete')
    ).toBeUndefined();
    expect(
      fixture.database.raw
        .prepare('SELECT * FROM conversation_files WHERE conversation_id=?')
        .all('conversation-active-delete')
    ).toEqual([]);
    expect(
      fixture.database.raw
        .prepare('SELECT * FROM hosted_conversation_messages WHERE conversation_id=?')
        .all('conversation-active-delete')
    ).toEqual([]);
    await expect(readdir(prepared.paths.conversationDirectory)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rolls back child cleanup and restores the directory when template reference release fails', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const { prepared, conversation } = await createActiveConversation(
      fixture,
      'conversation-delete-rollback'
    );
    fixture.database.raw
      .prepare(
        `INSERT INTO conversation_files
         (id,conversation_id,category,relative_path,display_name,mime_type,size,source,turn_id,item_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'file-delete-rollback',
        conversation.id,
        'OUTPUT',
        'result.txt',
        'result.txt',
        'text/plain',
        4,
        'AGENT',
        null,
        null,
        1_000,
        1_000
      );
    fixture.store.createMessage({
      conversationId: conversation.id,
      clientMessageId: 'message-delete-rollback',
      runId: 'run-delete-rollback',
      userTextPresent: true,
      status: 'SUCCEEDED',
      createdAt: 1_000,
      updatedAt: 1_000
    });
    fixture.database.raw
      .prepare('UPDATE conversation_template_versions SET reference_count=0 WHERE id=?')
      .run(conversation.activeVersionId);

    await expect(fixture.store.permanentDeleteConversation(conversation.id)).rejects.toThrow(
      'CONVERSATION_TEMPLATE_VERSION_CORRUPTED'
    );
    expect(
      fixture.database.raw
        .prepare('SELECT id FROM hosted_conversations WHERE id=?')
        .get(conversation.id)
    ).toEqual({ id: conversation.id });
    expect(
      fixture.database.raw
        .prepare('SELECT id FROM conversation_files WHERE conversation_id=?')
        .all(conversation.id)
    ).toEqual([{ id: 'file-delete-rollback' }]);
    expect(
      fixture.database.raw
        .prepare(
          'SELECT client_message_id FROM hosted_conversation_messages WHERE conversation_id=?'
        )
        .all(conversation.id)
    ).toEqual([{ client_message_id: 'message-delete-rollback' }]);
    await expect(readdir(prepared.paths.conversationDirectory)).resolves.toBeDefined();
  });

  it('keeps a permanent deletion committed when temporary directory cleanup fails validation', async () => {
    const fixture = await storeFixture();
    seedVersion(fixture.database);
    const { prepared } = await createActiveConversation(
      fixture,
      'conversation-temporary-cleanup-failure'
    );
    await fixture.store.prepareConversationTemporaryDirectory(
      42,
      'conversation-temporary-cleanup-failure'
    );
    const outside = await temporaryDirectory('temporary-cleanup-failure-outside');
    await rm(fixture.temporaryRootDirectory, { recursive: true, force: true });
    await symlink(outside, fixture.temporaryRootDirectory);

    await expect(
      fixture.store.permanentDeleteConversation('conversation-temporary-cleanup-failure')
    ).resolves.toMatchObject({
      conversation: { id: 'conversation-temporary-cleanup-failure' }
    });

    expect(
      fixture.database.raw
        .prepare('SELECT id FROM hosted_conversations WHERE id=?')
        .get('conversation-temporary-cleanup-failure')
    ).toBeUndefined();
    await expect(readdir(prepared.paths.conversationDirectory)).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});

async function storeFixture(nodeId = 'node-1', temporaryRootDirectoryOverride?: string) {
  const directory = await temporaryDirectory('store');
  const dataDirectory = join(directory, 'data');
  const rootDirectory = join(dataDirectory, 'hosted');
  const temporaryRootDirectory = temporaryRootDirectoryOverride ?? join(directory, 'host-tmp');
  const databasePath = join(directory, 'node-runtime.sqlite');
  const database = new NodeDatabase(databasePath, nodeId);
  const store = new HostedConversationStore({
    dataDirectory,
    rootDirectory,
    temporaryRootDirectory,
    nodeId,
    database
  });
  await store.initialize();
  return {
    database,
    databasePath,
    dataDirectory,
    rootDirectory,
    store,
    nodeId,
    temporaryRootDirectory
  };
}

async function createActiveConversation(
  fixture: Awaited<ReturnType<typeof storeFixture>>,
  conversationId: string,
  userId = 42
) {
  const prepared = await fixture.store.prepareConversationEnvironment(userId, conversationId);
  const conversation = await fixture.store.createConversation({
    id: conversationId,
    nodeId: fixture.nodeId,
    sessionId: `session-${conversationId}`,
    templateId: 'template-1',
    templateName: 'Research',
    activeVersionId: 'version-1',
    title: 'Temporary title',
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
  return { prepared, conversation };
}

function seedConversation(
  fixture: Awaited<ReturnType<typeof storeFixture>>,
  input: {
    readonly id: string;
    readonly userId: number;
    readonly conversationStorageKey: string;
    readonly lastActivityAt: number;
    readonly pinnedAt?: number | null;
  }
): void {
  fixture.database.raw
    .prepare(
      `INSERT INTO hosted_conversations
       (id,user_storage_key,conversation_storage_key,node_id,session_id,template_id,template_name,
        active_version_id,title,pinned_at,status,model_id,template_deleted,
        used_bytes,max_bytes,created_at,updated_at,last_activity_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.id,
      fixture.store.userStorageKey(input.userId),
      input.conversationStorageKey,
      fixture.nodeId,
      `session-${input.id}`,
      'template-1',
      'Research',
      'version-1',
      `Title ${input.id}`,
      input.pinnedAt ?? null,
      'ACTIVE',
      'model-1',
      0,
      10,
      1_000_000,
      1_000,
      input.lastActivityAt,
      input.lastActivityAt
    );
}

function seedVersion(
  database: NodeDatabase,
  id = 'version-1',
  storageKey = 'template_version_0001',
  versionNumber = 1
): void {
  const manifest = {
    schemaVersion: 1,
    templateId: 'template-1',
    versionId: id,
    versionNumber,
    draftRevision: 1,
    hostPolicyVersion: 1,
    publishedByUserId: 1,
    publishedAt: 1_000,
    draft: {
      templateId: 'template-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      revision: 1,
      name: 'Research',
      description: 'Research template',
      allowedModels: [{ modelId: 'model-1', name: 'Model One' }],
      defaultModelId: 'model-1',
      mcpIds: [],
      networkMode: 'NONE',
      quotas: {
        maxStorageBytes: 1_000_000,
        maxUploadBytes: 100_000
      },
      updatedAt: 1_000
    },
    mcpServers: [],
    mcpConfigHash: EMPTY_MCP_CONFIG_HASH,
    files: [],
    contentHash: 'a'.repeat(64)
  };
  database.raw
    .prepare(
      `INSERT INTO conversation_template_versions
       (id,template_id,version_number,draft_revision,status,storage_key,manifest,content_hash,
        mcp_config_hash,manifest_hash,file_count,total_bytes,host_policy_version,published_by_user_id,
        published_at,reference_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      'template-1',
      versionNumber,
      1,
      'AVAILABLE',
      storageKey,
      JSON.stringify(manifest),
      'a'.repeat(64),
      EMPTY_MCP_CONFIG_HASH,
      'b'.repeat(64),
      0,
      0,
      1,
      1,
      1_000,
      0
    );
}

const EMPTY_MCP_CONFIG_HASH = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `mar-node-hosted-store-${label}-`));
  directories.push(path);
  return path;
}
