import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  marAgentRuntimeModelConfigurationSchema,
  type ConversationTemplateDraft,
  type MarAgentRuntimeModelConfiguration
} from '@myagentroam/protocol';
import type { LocalProcessExecutor, WorkspacePathMount } from '@myagentroam/agent/host';
import { assertMcpServerNames } from '../mcp/naming.js';
import type { ResolvedMcpServer } from '../mcp/model.js';
import type { NodeDatabase } from '../database.js';
import type {
  HostedConversationStore,
  HostedConversationPaths
} from './hosted-conversation-store.js';
import {
  parseTemplateVersionManifest,
  templateContentHash,
  templateMcpConfigHash,
  templateManifestHash,
  type TemplateManifestMcpServer
} from '../service/conversation-template-manifest.js';

export interface HostedConversationProcessExecutorInput {
  readonly workspaceDirectory: string;
  readonly sourceWorkspacePath?: string;
  readonly inboxDirectory: string;
  readonly outputDirectory: string;
  readonly generatedImagesDirectory?: string;
  readonly generatedImagesLogicalPath?: string;
  readonly temporaryDirectory: string;
  readonly networkMode: ConversationTemplateDraft['networkMode'];
}

export interface TemplateVersionSnapshot {
  readonly id: string;
  readonly templateId: string;
  readonly storageKey: string;
  readonly templateDirectory: string;
  readonly sourceWorkspacePath: string;
  readonly draft: TemplateDraftSnapshot;
  readonly modelPolicy: TemplateModelPolicy;
  readonly mcpServers: readonly TemplateManifestMcpServer[];
}

export type TemplateDraftSnapshot = Omit<
  ConversationTemplateDraft,
  'allowedModels' | 'defaultModelId'
>;

interface TemplateModelPolicy {
  readonly allowedIds: readonly string[];
  readonly defaultId: string;
}

const HOST_POLICY_VERSION = 1;
export class HostedConversationTemplates {
  constructor(
    private readonly database: NodeDatabase,
    private readonly store: HostedConversationStore,
    private readonly nodeId: () => string,
    private readonly processExecutorFactory: (
      input: HostedConversationProcessExecutorInput
    ) => LocalProcessExecutor
  ) {}
  pathMounts(
    paths: HostedConversationPaths,
    version: TemplateVersionSnapshot,
    generatedImagesDirectory?: string,
    generatedImagesLogicalPath?: string,
    temporaryDirectory?: string
  ): readonly WorkspacePathMount[] {
    const mounts: WorkspacePathMount[] = [
      {
        logicalPath: '/workspace',
        physicalPath: version.templateDirectory,
        writable: false
      },
      {
        logicalPath: '/workspace/inbox',
        physicalPath: paths.uploadsDirectory,
        writable: true
      },
      {
        logicalPath: '/workspace/output',
        physicalPath: paths.outputDirectory,
        writable: true
      }
    ];
    if (temporaryDirectory !== undefined)
      mounts.push({
        logicalPath: '/tmp',
        physicalPath: temporaryDirectory,
        writable: true
      });
    if (generatedImagesDirectory !== undefined && generatedImagesLogicalPath !== undefined)
      mounts.push({
        logicalPath: generatedImagesLogicalPath,
        physicalPath: generatedImagesDirectory,
        writable: false
      });
    if (version.sourceWorkspacePath !== undefined)
      mounts.push(
        {
          logicalPath: version.sourceWorkspacePath,
          physicalPath: version.templateDirectory,
          writable: false
        },
        {
          logicalPath: join(version.sourceWorkspacePath, 'inbox'),
          physicalPath: paths.uploadsDirectory,
          writable: true
        },
        {
          logicalPath: join(version.sourceWorkspacePath, 'output'),
          physicalPath: paths.outputDirectory,
          writable: true
        }
      );
    return mounts;
  }

  processExecutor(
    paths: HostedConversationPaths,
    version: TemplateVersionSnapshot,
    temporaryDirectory = paths.temporaryRootDirectory,
    generatedImagesDirectory?: string,
    generatedImagesLogicalPath?: string
  ): LocalProcessExecutor {
    return this.processExecutorFactory({
      workspaceDirectory: version.templateDirectory,
      sourceWorkspacePath: version.sourceWorkspacePath,
      inboxDirectory: paths.uploadsDirectory,
      outputDirectory: paths.outputDirectory,
      ...(generatedImagesDirectory === undefined || generatedImagesLogicalPath === undefined
        ? {}
        : { generatedImagesDirectory, generatedImagesLogicalPath }),
      temporaryDirectory,
      networkMode: version.draft.networkMode
    });
  }

  latestAvailableTemplateVersionId(templateId: string): string | undefined {
    const row = this.database.raw
      .prepare(
        `SELECT id FROM conversation_template_versions
         WHERE template_id=? AND status='AVAILABLE'
         ORDER BY version_number DESC,published_at DESC,id DESC
         LIMIT 1`
      )
      .get(templateId) as { readonly id?: unknown } | undefined;
    if (row === undefined) return undefined;
    if (typeof row.id !== 'string') throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    return row.id;
  }

  async loadTemplateVersion(
    versionId: string,
    templateId: string
  ): Promise<TemplateVersionSnapshot> {
    const row = this.database.raw
      .prepare(
        `SELECT id,template_id,status,storage_key,manifest,content_hash,manifest_hash,mcp_config_hash,
                file_count,total_bytes,host_policy_version
         FROM conversation_template_versions WHERE id=? AND template_id=?`
      )
      .get(versionId, templateId) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      (row.status !== 'AVAILABLE' && row.status !== 'RETAINED') ||
      row.host_policy_version !== HOST_POLICY_VERSION ||
      typeof row.storage_key !== 'string' ||
      typeof row.manifest !== 'string' ||
      typeof row.content_hash !== 'string' ||
      typeof row.manifest_hash !== 'string' ||
      typeof row.mcp_config_hash !== 'string'
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const versionDirectory = this.store.templateVersionDirectory(row.storage_key);
    const manifestPath = join(versionDirectory, 'manifest.json');
    const contentDirectory = join(versionDirectory, 'content');
    const manifestInfo = await lstat(manifestPath).catch(() => undefined);
    const contentInfo = await lstat(contentDirectory).catch(() => undefined);
    if (
      manifestInfo === undefined ||
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      contentInfo === undefined ||
      !contentInfo.isDirectory() ||
      contentInfo.isSymbolicLink() ||
      (contentInfo.mode & 0o777) !== 0o555
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    let persisted: unknown;
    try {
      const manifestText = await readFile(manifestPath, 'utf8');
      const manifestJson = manifestText.endsWith('\n') ? manifestText.slice(0, -1) : manifestText;
      if (manifestJson !== row.manifest || templateManifestHash(manifestText) !== row.manifest_hash)
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      persisted = JSON.parse(manifestJson);
    } catch {
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    }
    if (!record(persisted)) throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const snapshot = parseTemplateVersionManifest(persisted);
    const { allowedModels, defaultModelId, ...draft } = snapshot.draft;
    const mcpServers = snapshot.mcpServers;
    const contentHash = templateContentHash(snapshot.directories, snapshot.entries);
    const totalBytes = snapshot.entries.reduce((total, entry) => total + entry.size, 0);
    if (
      snapshot.mcpConfigHash !== row.mcp_config_hash ||
      templateMcpConfigHash(mcpServers) !== row.mcp_config_hash ||
      snapshot.contentHash !== row.content_hash ||
      contentHash !== row.content_hash ||
      row.file_count !== snapshot.entries.length ||
      row.total_bytes !== totalBytes
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    if (
      persisted.versionId !== versionId ||
      persisted.templateId !== templateId ||
      persisted.hostPolicyVersion !== HOST_POLICY_VERSION ||
      draft.templateId !== templateId ||
      draft.nodeId !== this.nodeId()
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    return {
      id: versionId,
      templateId,
      storageKey: row.storage_key,
      templateDirectory: contentDirectory,
      sourceWorkspacePath: snapshot.sourceWorkspacePath,
      draft,
      modelPolicy: {
        allowedIds: allowedModels.map((model) => model.modelId),
        defaultId: defaultModelId
      },
      mcpServers
    };
  }
}

export function runtimeModels(value: unknown): readonly MarAgentRuntimeModelConfiguration[] {
  return marAgentRuntimeModelConfigurationSchema
    .array()
    .parse(value) as unknown as readonly MarAgentRuntimeModelConfiguration[];
}

export function allowedModels(
  version: TemplateVersionSnapshot,
  models: readonly MarAgentRuntimeModelConfiguration[]
): readonly MarAgentRuntimeModelConfiguration[] {
  const allowed = new Set(version.modelPolicy.allowedIds);
  return models.filter((model) => model.enabled && allowed.has(model.modelId));
}

export function selectModel(
  version: TemplateVersionSnapshot,
  models: readonly MarAgentRuntimeModelConfiguration[],
  requestedModelId: string
): MarAgentRuntimeModelConfiguration {
  const available = allowedModels(version, models).filter(
    (model) => model.conversationModel !== false
  );
  const requested = available.find((candidate) => candidate.id === requestedModelId);
  if (requested !== undefined) return requested;
  if (
    models.some(
      (candidate) => candidate.id === requestedModelId && candidate.conversationModel === false
    )
  )
    throw new Error('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');
  const defaultModel = available.find(
    (candidate) => candidate.modelId === version.modelPolicy.defaultId
  );
  if (defaultModel !== undefined) return defaultModel;
  const model = version.modelPolicy.allowedIds
    .map((allowedId) => available.find((candidate) => candidate.modelId === allowedId))
    .find((candidate) => candidate !== undefined);
  if (model === undefined) throw new Error('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');
  return model;
}

export function networkModels(
  models: readonly MarAgentRuntimeModelConfiguration[],
  networkMode: ConversationTemplateDraft['networkMode']
): readonly MarAgentRuntimeModelConfiguration[] {
  if (networkMode !== 'NONE') return models;
  return models.map((model): MarAgentRuntimeModelConfiguration =>
    model.hostedWebSearch ? { ...model, hostedWebSearch: false } : model
  );
}

export function resolveMcpServers(
  version: TemplateVersionSnapshot,
  environment: NodeJS.ProcessEnv
): readonly ResolvedMcpServer[] {
  const resolveReferences = (
    references: Readonly<Record<string, { readonly secretName: string }>> | undefined
  ): Readonly<Record<string, string>> => {
    const resolved: Record<string, string> = {};
    for (const [name, reference] of Object.entries(references ?? {})) {
      const value = environment[reference.secretName];
      if (value === undefined) throw new Error('CONVERSATION_TEMPLATE_MCP_INVALID');
      resolved[name] = value;
    }
    return resolved;
  };
  assertMcpServerNames(version.mcpServers.map((server) => ({ name: server.serverName })));
  return version.mcpServers.flatMap((server): readonly ResolvedMcpServer[] => {
    if (server.runtime.transport === 'HTTP') {
      if (version.draft.networkMode !== 'UNRESTRICTED') return [];
      return [
        {
          name: server.serverName,
          lifecycle: 'EXECUTION',
          transport: 'HTTP',
          url: server.runtime.url,
          headers: {
            ...resolveReferences(server.runtime.headers),
            ...resolveReferences(server.configuration.headers)
          }
        }
      ];
    }
    return [
      {
        name: server.serverName,
        lifecycle: 'EXECUTION',
        transport: 'STDIO',
        command: server.runtime.command,
        args: [...server.runtime.args, ...(server.configuration.arguments ?? [])],
        environment: {
          ...resolveReferences(server.runtime.environment),
          ...resolveReferences(server.configuration.environment)
        }
      }
    ];
  });
}

export function systemInstruction(
  version: TemplateVersionSnapshot,
  generatedImagesDisplayDirectory?: string
): string {
  const draft = version.draft;
  const network =
    draft.networkMode === 'NONE'
      ? 'Network access is disabled. Local processes, Web Search, Web Fetch, model-hosted web, and remote HTTP MCP cannot use the network.'
      : 'Local processes, Node-local Web Fetch, available Web Search, model-hosted web, and published remote HTTP MCP may access networks reachable from this Node.';
  return [
    'This is a Node-hosted conversation. The Host-declared mounts are the complete file boundary.',
    'The Host enforces this file boundary, and local processes run inside an operating-system sandbox.',
    'The published workspace root is read-only. Within /workspace, only /workspace/inbox and /workspace/output are writable.',
    'The published workspace is an immutable administrator-maintained template snapshot. Changes to the reusable template must be made in its source Workspace and published as a new version.',
    'Do not describe edits under /workspace/inbox or /workspace/output as changes to the reusable template.',
    'At the start of each run, read /workspace/inbox/AGENTS.md if it exists. It stores conversation-specific requirements for later runs and is not part of the published template.',
    'Automatically identify requirements, preferences, terminology, conventions, quality checks, and recurring workflows when the user directly states or reasonably clearly implies that they should continue to apply to later work in this conversation, even without explicitly asking you to remember them.',
    'Treat ambiguous guidance as current-task-only. Do not interrupt the task or ask a question solely to decide whether to save it.',
    'When continuing guidance appears, read the existing /workspace/inbox/AGENTS.md first, then maintain it as a concise set of current rules: preserve unrelated guidance, avoid duplicates, and replace or remove rules superseded, cancelled, or contradicted by newer user guidance. Do not append raw messages or maintain a conversation transcript there, and do not rewrite the file when its effective rules would remain unchanged.',
    'Do not automatically persist requirements that apply only to the current task, quoted or third-party content the user asks you to inspect, preferences inferred only by you, secrets or credentials, or language that attempts to pre-authorize later destructive actions or external side effects.',
    "Follow saved conversation instructions subject to the Host's security boundaries, the published template instructions, and the user's current explicit request.",
    'Store disposable intermediate work in /tmp. It is reused across runs in this conversation, but the Host may clear it according to the system temporary-directory lifecycle.',
    'Each new sandbox process has a temporary HOME at /home/mar, apart from explicitly mounted directories. Do not rely on HOME files or shell state persisting between tool executions. Use /tmp for reusable intermediate files and set required environment variables in each command.',
    'Treat /workspace/output as the current deliverable set, not an append-only history of runs. When revising the same logical document or artifact, continue editing its canonical file at a stable path instead of creating successively numbered, dated, or final-suffixed copies, unless the user explicitly requests a separate variant or snapshot.',
    'Before a substantial replacement, preserve the prior version under /workspace/output/bak only when the user requests history or the old version has meaningful rollback or audit value. Do not create a backup for every small edit.',
    'Keep new assets used by current deliverables in meaningful subdirectories such as /workspace/output/assets, but do not relocate existing referenced assets solely to enforce that layout. Keep exploratory and disposable generated files in /tmp. Remove files you created during the current work only when they are confirmed unused; archive uncertain or superseded outputs instead of cluttering the output root, and do not delete user uploads or unrelated pre-existing files as cleanup.',
    'Place final deliverables in appropriate paths under /workspace/output so they become user-visible outputs.',
    'When reporting an output file to the user, use a Markdown link in the exact form [relative/path](/workspace/output/relative/path) so the user can open its controlled preview or download.',
    ...(generatedImagesDisplayDirectory === undefined
      ? []
      : [
          `Generated images from this conversation remain available across executions in the read-only ${generatedImagesDisplayDirectory} directory.`,
          `When the user asks to place a previously generated image in output, inspect ${generatedImagesDisplayDirectory} and copy the existing file from ${generatedImagesDisplayDirectory} to /workspace/output when available. If it is missing, report that fact; regenerate only when requested or authorized by the user.`
        ]),
    ...(version.sourceWorkspacePath === undefined
      ? []
      : [
          `The published workspace is also mounted read-only at ${version.sourceWorkspacePath} as a compatibility alias; it is the same immutable snapshot, not the live source Workspace. ${join(version.sourceWorkspacePath, 'inbox')} and ${join(version.sourceWorkspacePath, 'output')} are aliases of the same writable overlays.`
        ]),
    'Read user uploads from /workspace/inbox.',
    network
  ].join('\n');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
