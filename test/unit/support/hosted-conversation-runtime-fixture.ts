import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type {
  ConversationTemplateDraft,
  HostedConversationSummary,
  MarAgentRuntimeModelConfiguration,
  WorkbenchEvent
} from '../../../packages/protocol/src/index.js';
import { NodeDatabase } from '../../../mar-node/src/database.js';
import { HostedConversationStore } from '../../../mar-node/src/service/hosted-conversation-store.js';
import {
  HostedConversationNodeService,
  type HostedConversationProcessExecutorInput,
  type HostedConversationRuntime
} from '../../../mar-node/src/service/hosted-conversation-node-service.js';

const directories: string[] = [];

export async function cleanupHostedConversationRuntimeFixtures(): Promise<void> {
  await Promise.all(
    directories.splice(0).map(async (path) => {
      await makeWritable(path).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    })
  );
}

export const modelOne: MarAgentRuntimeModelConfiguration = {
  id: 'model-1',
  name: 'Model One',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test/v1',
  apiKey: 'secret-1',
  modelId: 'model-one',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  titleGeneration: false,
  enabled: true
};

export const modelTwo: MarAgentRuntimeModelConfiguration = {
  ...modelOne,
  id: 'model-2',
  name: 'Model Two',
  apiKey: 'secret-2',
  modelId: 'model-two',
  reasoningEfforts: ['low']
};

export const modelOneAlternative: MarAgentRuntimeModelConfiguration = {
  ...modelOne,
  id: 'model-1-alternative',
  name: 'Model One Alternative',
  apiKey: 'secret-1-alternative'
};

export const hostedWebModel: MarAgentRuntimeModelConfiguration = {
  ...modelOne,
  hostedWebSearch: true
};

export const draft: ConversationTemplateDraft = {
  templateId: 'template-1',
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  revision: 1,
  name: 'Research',
  description: 'Research template',
  allowedModels: [{ modelId: 'model-one', name: 'Model One' }],
  defaultModelId: 'model-one',
  mcpIds: [],
  networkMode: 'NONE',
  quotas: {
    maxStorageBytes: 1_000_000,
    maxUploadBytes: 100_000
  },
  updatedAt: 1_000
};

export const stdioMcpSnapshot = {
  id: 'mcp-stdio',
  serverName: 'local-research',
  displayName: 'Local Research',
  version: '1.0.0',
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
} as const;

export const httpMcpSnapshot = {
  id: 'mcp-http',
  serverName: 'remote-research',
  displayName: 'Remote Research',
  version: '2.0.0',
  origin: 'WORKSPACE',
  transport: 'HTTP',
  runtime: {
    transport: 'HTTP',
    url: 'https://mcp.example.test/tools',
    headers: { Authorization: { secretName: 'MCP_HTTP_TOKEN' } }
  },
  configuration: {
    headers: { 'X-Extra-Token': { secretName: 'MCP_HTTP_EXTRA_TOKEN' } }
  }
} as const;

export async function runtimeFixture(
  options: {
    readonly assertCanCreate?: () => Promise<void>;
    readonly versionDraft?: ConversationTemplateDraft;
    readonly mcpServers?: readonly Record<string, unknown>[];
    readonly secretEnvironment?: NodeJS.ProcessEnv;
    readonly readImage?: (runId: string, imageRef: string) => Promise<unknown | undefined>;
  } = {}
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
  const pendingRuns: Array<ReturnType<typeof deferredRun>> = [];
  const runtime = {
    createSession: vi.fn<HostedConversationRuntime['createSession']>(async () => ({
      sessionId: 'session-1'
    })),
    history: vi.fn<HostedConversationRuntime['history']>(async () => ({
      turns: [],
      nextCursor: null
    })),
    rollback: vi.fn<HostedConversationRuntime['rollback']>(async () => ({
      lastActivityAt: 1_500
    })),
    startRun: vi.fn<HostedConversationRuntime['startRun']>(async () => {
      const pending = deferredRun(`run-${pendingRuns.length + 1}`);
      pendingRuns.push(pending);
      return pending.handle;
    }),
    releaseSession: vi.fn<HostedConversationRuntime['releaseSession']>(async () => undefined)
  } satisfies HostedConversationRuntime;
  let id = 0;
  let now = 2_000;
  const processExecutorFactory = vi.fn<(input: HostedConversationProcessExecutorInput) => never>(
    () => ({ spawn: vi.fn() }) as never
  );
  let workbenchSequence = 0;
  const workbenchEvents: WorkbenchEvent[] = [];
  const watchFrames: unknown[] = [];
  const service = new HostedConversationNodeService({
    database,
    store,
    runtime,
    nodeId: () => 'node-1',
    nodeAppVersion: () => '0.9.55',
    now: () => now,
    id: () => `conversation-${++id}`,
    ...(options.assertCanCreate === undefined ? {} : { assertCanCreate: options.assertCanCreate }),
    ...(options.secretEnvironment === undefined
      ? {}
      : { secretEnvironment: options.secretEnvironment }),
    readImage: options.readImage ?? (async () => undefined),
    emitWatchEvent: (payload) => watchFrames.push(payload),
    nextWorkbenchEvent: (payload) => ({
      sequence: ++workbenchSequence,
      category: 'hosted-conversation',
      payload
    }),
    emitWorkbenchEvent: (event) => workbenchEvents.push(event),
    processExecutorFactory
  });
  await seedVersion(
    { database, store },
    'version-1',
    1,
    options.versionDraft ?? draft,
    'AVAILABLE',
    options.mcpServers ?? []
  );
  return {
    directory,
    dataDirectory,
    temporaryRootDirectory,
    database,
    store,
    runtime,
    pendingRuns,
    workbenchEvents,
    watchFrames,
    processExecutorFactory,
    service,
    setNow(value: number) {
      now = value;
    }
  };
}

export function hostedHistoryPage(turns: readonly unknown[], nextCursor: string | null = null) {
  return { turns, nextCursor };
}

export function createRequest(models: readonly MarAgentRuntimeModelConfiguration[] = [modelOne]) {
  return {
    templateId: 'template-1',
    clientRequestId: 'create-request-1',
    __requestUserId: 7,
    __template: {
      id: 'template-1',
      nodeId: 'node-1',
      name: 'Research',
      description: 'Research template',
      status: 'ACTIVE',
      currentVersionId: 'version-1',
      available: true,
      createdAt: 1_000,
      updatedAt: 1_000
    },
    __marAgentModels: models
  };
}

export async function createConversation(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  models: readonly MarAgentRuntimeModelConfiguration[] = [modelOne]
) {
  const result = (await fixture.service.operations()['conversation.hosted.create']!(
    createRequest(models)
  )) as { conversation: HostedConversationSummary };
  return result.conversation;
}

export async function seedVersion(
  fixture: Pick<Awaited<ReturnType<typeof runtimeFixture>>, 'database' | 'store'>,
  id: string,
  version: number,
  versionDraft: ConversationTemplateDraft,
  status: 'AVAILABLE' | 'CORRUPTED' = 'AVAILABLE',
  mcpServers: readonly Record<string, unknown>[] = []
) {
  const storageKey = `template_${id.replaceAll('-', '_')}`;
  const directory = fixture.store.templateVersionDirectory(storageKey);
  const contentDirectory = join(directory, 'content');
  await Promise.all(
    ['content', 'content/inbox', 'content/output'].map((relativePath) =>
      mkdir(join(directory, relativePath), { recursive: true })
    )
  );
  const content = Buffer.from(`version-${version}`);
  const contentSha256 = createHash('sha256').update(content).digest('hex');
  const contentFile = join(contentDirectory, 'instructions.md');
  await writeFile(contentFile, content);
  const mcpConfigHash = createHash('sha256').update(JSON.stringify(mcpServers)).digest('hex');
  const sourceWorkspacePath = `/home/template source/${id}/工作区`;
  const entries = [
    {
      kind: 'FILE',
      relativePath: 'instructions.md',
      size: content.byteLength,
      executable: false,
      sha256: contentSha256
    }
  ];
  const contentHash = createHash('sha256')
    .update(
      entries
        .map(
          (entry) =>
            `${entry.kind}\0${entry.relativePath}\0${entry.size}\0${entry.executable ? 1 : 0}\0${entry.sha256}`
        )
        .join('\n')
    )
    .digest('hex');
  const manifest = {
    schemaVersion: 2,
    templateId: 'template-1',
    versionId: id,
    versionNumber: version,
    draftRevision: versionDraft.revision,
    hostPolicyVersion: 1,
    publishedByUserId: 1,
    publishedAt: 1_000 + version,
    sourceWorkspacePath,
    draft: versionDraft,
    mcpServers,
    mcpConfigHash,
    directories: [],
    entries,
    contentHash
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
  await writeFile(join(directory, 'manifest.json'), manifestJson);
  await chmod(contentFile, 0o444);
  await Promise.all(
    ['content/inbox', 'content/output', 'content'].map((relativePath) =>
      chmod(join(directory, relativePath), 0o555)
    )
  );
  fixture.database.raw
    .prepare(
      `INSERT INTO conversation_template_versions
       (id,template_id,version_number,draft_revision,status,storage_key,manifest,content_hash,
        mcp_config_hash,manifest_hash,file_count,total_bytes,host_policy_version,published_by_user_id,
        published_at,reference_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
    )
    .run(
      id,
      'template-1',
      version,
      versionDraft.revision,
      status,
      storageKey,
      manifestJson,
      contentHash,
      mcpConfigHash,
      manifestHash,
      entries.length,
      content.byteLength,
      1,
      1,
      1_000 + version
    );
  return { directory, contentDirectory, sourceWorkspacePath };
}

export function deferredRun(runId: string) {
  let complete!: (value: {
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
    completedAt: number;
    title?: string;
  }) => void;
  const completion = new Promise<{
    status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
    completedAt: number;
    title?: string;
  }>((resolve) => (complete = resolve));
  return {
    complete,
    handle: {
      run: { id: runId, status: 'RUNNING' as const, startedAt: 2_000, completedAt: null },
      completion,
      cancel: vi.fn(() => true)
    }
  };
}

export async function readManifest(homeDirectory: string) {
  return JSON.parse(
    await readFile(join(homeDirectory, '..', 'manifest', 'conversation.json'), 'utf8')
  ) as unknown;
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

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mar-node-hosted-runtime-'));
  directories.push(path);
  return path;
}
