import { lstat, mkdir, mkdtemp, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostedConversationManifest } from '../../../packages/protocol/src/index.js';
import { NodeDatabase } from '../../src/database.js';
import { ConversationHostingMaintenanceService } from '../../src/service/conversation-hosting-maintenance-service.js';
import { HostedConversationStore } from '../../src/hosting/hosted-conversation-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});

const DAY_MS = 24 * 60 * 60 * 1_000;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node conversation hosting maintenance', () => {
  it('projects real filesystem watermarks and blocks creation at 95 percent', async () => {
    const fixture = await maintenanceFixture();
    fixture.filesystem.availableBytes = 20_000;
    await expect(fixture.service.storageCapacity()).resolves.toMatchObject({
      filesystemUsageBasisPoints: 8_000,
      capacity: 'AVAILABLE',
      acceptsNewConversations: true,
      automaticCleanupInactiveDays: 60
    });

    fixture.filesystem.availableBytes = 10_000;
    await expect(fixture.service.storageCapacity()).resolves.toMatchObject({
      filesystemUsageBasisPoints: 9_000,
      capacity: 'HIGH',
      acceptsNewConversations: true
    });

    fixture.filesystem.availableBytes = 5_000;
    const full = await fixture.service.operations()['conversation.hosting.storage.inspect']!({});
    expect(full).toMatchObject({
      storage: {
        filesystemTotalBytes: 100_000,
        filesystemAvailableBytes: 5_000,
        filesystemUsageBasisPoints: 9_500,
        capacity: 'FULL',
        acceptsNewConversations: false
      }
    });
    await expect(fixture.service.assertCanCreate()).rejects.toThrow(
      'CONVERSATION_HOSTING_STORAGE_FULL'
    );
  });

  it('treats zero available filesystem blocks as a valid full capacity state', async () => {
    const fixture = await maintenanceFixture();
    vi.mocked(statfs).mockResolvedValueOnce({
      type: 0,
      bsize: 4_096,
      blocks: 100,
      bfree: 0,
      bavail: 0,
      files: 0,
      ffree: 0
    });
    const service = new ConversationHostingMaintenanceService({
      store: fixture.store,
      inactiveRetentionDays: 60,
      now: () => 10_000,
      isConversationInUse: () => false,
      beginConversationCleanup: () => () => undefined,
      releaseConversation: async () => undefined
    });

    await expect(service.storageCapacity()).resolves.toMatchObject({
      filesystemTotalBytes: 409_600,
      filesystemAvailableBytes: 0,
      filesystemUsageBasisPoints: 10_000,
      capacity: 'FULL',
      acceptsNewConversations: false
    });
  });

  it('checks current filesystem capacity for creation without scanning hosted storage', async () => {
    const fixture = await maintenanceFixture();
    const storageScan = vi
      .spyOn(fixture.store, 'hostedStorageUsedBytes')
      .mockRejectedValue(new Error('UNEXPECTED_HOSTED_STORAGE_SCAN'));

    for (const availableBytes of [20_000, 15_000, 14_999, 5_001]) {
      fixture.filesystem.availableBytes = availableBytes;
      await expect(fixture.service.assertCanCreate()).resolves.toBeUndefined();
    }
    for (const availableBytes of [5_000, 0]) {
      fixture.filesystem.availableBytes = availableBytes;
      await expect(fixture.service.assertCanCreate()).rejects.toThrow(
        'CONVERSATION_HOSTING_STORAGE_FULL'
      );
    }
    fixture.filesystem.availableBytes = 20_000;
    await expect(fixture.service.assertCanCreate()).resolves.toBeUndefined();
    expect(storageScan).not.toHaveBeenCalled();
  });

  it.each([
    { totalBytes: 0, availableBytes: 0 },
    { totalBytes: 100_000, availableBytes: -1 },
    { totalBytes: 100_000, availableBytes: 100_001 },
    { totalBytes: 100_000, availableBytes: Number.NaN }
  ])('rejects invalid filesystem capacity before creation: %j', async (filesystem) => {
    const fixture = await maintenanceFixture();
    Object.assign(fixture.filesystem, filesystem);
    const storageScan = vi.spyOn(fixture.store, 'hostedStorageUsedBytes');

    await expect(fixture.service.assertCanCreate()).rejects.toThrow(
      'CONVERSATION_HOSTING_STORAGE_UNAVAILABLE'
    );
    expect(storageScan).not.toHaveBeenCalled();
  });

  it('counts published symlinks without following their targets', async () => {
    const fixture = await maintenanceFixture();
    const before = await fixture.store.hostedStorageUsedBytes();
    const link = join(
      fixture.store.templateVersionDirectory('template_version_0001'),
      'content',
      'python'
    );
    await symlink('/usr/bin/python3', link);
    const metadata = await lstat(link);

    await expect(fixture.service.storageCapacity()).resolves.toMatchObject({
      hostedStorageUsedBytes: before + metadata.size,
      capacity: 'AVAILABLE',
      acceptsNewConversations: true
    });
    await expect(fixture.service.assertCanCreate()).resolves.toBeUndefined();
  });

  it('runs the initial automatic cleanup immediately instead of waiting one interval', async () => {
    const now = 100 * DAY_MS;
    const fixture = await maintenanceFixture(now);
    const expired = await createConversation(
      fixture,
      'conversation-initial-cleanup',
      now - 61 * DAY_MS
    );

    await fixture.service.start();
    try {
      expect(
        fixture.database.raw
          .prepare('SELECT id FROM hosted_conversations WHERE id=?')
          .get(expired.id)
      ).toBeUndefined();
    } finally {
      fixture.service.dispose();
    }
  });

  it('serializes automatic and administrator cleanup executions', async () => {
    const now = 100 * DAY_MS;
    const fixture = await maintenanceFixture(now);
    await createConversation(fixture, 'conversation-cleanup-lock', now - 61 * DAY_MS);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    fixture.releaseConversation.mockImplementation(async () => cleanupGate);
    const execute = fixture.service.operations()['conversation.hosting.cleanup.execute']!;

    const first = execute({ inactiveDays: 60 });
    await vi.waitFor(() => expect(fixture.releaseConversation).toHaveBeenCalledTimes(1));
    const second = execute({ inactiveDays: 60 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const concurrentReleaseCalls = fixture.releaseConversation.mock.calls.length;
    let disposed = false;
    const disposal = Promise.resolve(fixture.service.dispose()).then(() => {
      disposed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const disposedBeforeRelease = disposed;
    releaseCleanup();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await disposal;

    expect(concurrentReleaseCalls).toBe(1);
    expect(disposedBeforeRelease).toBe(false);
    expect(firstResult).toMatchObject({ result: { deletedConversationCount: 1 } });
    expect(secondResult).toMatchObject({ result: { deletedConversationCount: 0 } });
  });

  it('previews only inactive unused conversations and rechecks before permanent cleanup', async () => {
    const now = 100 * DAY_MS;
    const fixture = await maintenanceFixture(now);
    const oldFree = await createConversation(fixture, 'conversation-old-free', now - 61 * DAY_MS);
    const oldBusy = await createConversation(fixture, 'conversation-old-busy', now - 62 * DAY_MS);
    const equalCutoff = await createConversation(
      fixture,
      'conversation-equal-cutoff',
      now - 60 * DAY_MS
    );
    await createConversation(fixture, 'conversation-recent', now - DAY_MS);
    fixture.inUse.add(oldBusy.id);

    const preview = await fixture.service.operations()['conversation.hosting.cleanup.preview']!({
      inactiveDays: 60
    });
    expect(preview).toMatchObject({
      preview: {
        inactiveDays: 60,
        cutoffAt: now - 60 * DAY_MS,
        candidateConversationCount: 1,
        reclaimableBytes: expect.any(Number),
        measuredAt: now
      }
    });

    fixture.releaseConversation.mockImplementation(async () => {
      fixture.setNow(now + 1_234);
    });
    const result = await fixture.service.operations()['conversation.hosting.cleanup.execute']!({
      inactiveDays: 60
    });
    expect(result).toMatchObject({
      result: {
        inactiveDays: 60,
        cutoffAt: now - 60 * DAY_MS,
        deletedConversationCount: 1,
        releasedBytes: expect.any(Number),
        skippedConversationCount: 1,
        completedAt: now + 1_234
      }
    });
    expect(
      fixture.database.raw
        .prepare('SELECT id FROM hosted_conversations ORDER BY id')
        .all()
        .map((row) => (row as { id: string }).id)
    ).toEqual(['conversation-equal-cutoff', 'conversation-old-busy', 'conversation-recent']);
    await expect(stat(oldFree.paths.conversationDirectory)).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(stat(equalCutoff.paths.conversationDirectory)).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    });
    expect(fixture.releaseConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: oldFree.id })
    );

    fixture.setNow(now);
    fixture.inUse.clear();
    await expect(
      fixture.service.operations()['conversation.hosting.cleanup.execute']!({ inactiveDays: 60 })
    ).resolves.toMatchObject({
      result: { deletedConversationCount: 1, skippedConversationCount: 0 }
    });
    await expect(stat(oldBusy.paths.conversationDirectory)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });
});

async function maintenanceFixture(now = 10_000) {
  const directory = await temporaryDirectory();
  const dataDirectory = join(directory, 'data');
  const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
  const store = new HostedConversationStore({
    dataDirectory,
    rootDirectory: join(dataDirectory, 'hosted'),
    nodeId: 'node-1',
    database
  });
  await store.initialize();
  await seedVersion(database, store);
  const filesystem = { totalBytes: 100_000, availableBytes: 20_000 };
  const inUse = new Set<string>();
  let currentNow = now;
  const releaseConversation = vi.fn(async (conversation: HostedConversationManifest) => {
    void conversation;
  });
  const service = new ConversationHostingMaintenanceService({
    store,
    inactiveRetentionDays: 60,
    now: () => currentNow,
    filesystemCapacity: async () => filesystem,
    isConversationInUse: (conversationId) => inUse.has(conversationId),
    beginConversationCleanup: (conversationId) =>
      inUse.has(conversationId) ? undefined : () => undefined,
    releaseConversation
  });
  return {
    directory,
    dataDirectory,
    database,
    store,
    filesystem,
    inUse,
    releaseConversation,
    service,
    setNow(value: number) {
      currentNow = value;
    }
  };
}

async function createConversation(
  fixture: Awaited<ReturnType<typeof maintenanceFixture>>,
  id: string,
  lastActivityAt: number
) {
  const paths = await fixture.store.prepareConversationEnvironment(7, id);
  await writeFile(join(paths.paths.outputDirectory, 'payload.txt'), `payload:${id}`);
  const manifest: HostedConversationManifest = {
    id,
    nodeId: 'node-1',
    sessionId: `session-${id}`,
    templateId: 'template-1',
    templateName: 'Research',
    activeVersionId: 'version-1',
    title: `Title ${id}`,
    titleSource: 'AUTO',
    pinnedAt: null,
    status: 'ACTIVE',
    modelId: 'model-1',
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    lastActivityAt,
    userStorageKey: paths.userStorageKey,
    conversationStorageKey: paths.conversationStorageKey,
    templateDeleted: false,
    quota: { usedBytes: 0, maxBytes: 1_000_000 }
  };
  await fixture.store.createConversation(manifest);
  return { ...manifest, paths: paths.paths };
}

async function seedVersion(database: NodeDatabase, store: HostedConversationStore): Promise<void> {
  const storageKey = 'template_version_0001';
  const directory = store.templateVersionDirectory(storageKey);
  await mkdir(join(directory, 'content'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    templateId: 'template-1',
    versionId: 'version-1',
    versionNumber: 1,
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
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
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
      JSON.stringify(manifest),
      'a'.repeat(64),
      EMPTY_MCP_CONFIG_HASH,
      'b'.repeat(64),
      0,
      0,
      1,
      1,
      1_000
    );
}

const EMPTY_MCP_CONFIG_HASH = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mar-node-hosting-maintenance-'));
  directories.push(path);
  return path;
}
