import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  conversationTemplateDraftSchema,
  mcpRuntimeDescriptorSchema,
  mcpInstallationConfigurationSchema,
  type ConversationTemplateDraft,
  type McpRuntimeDescriptor,
  type McpInstallationConfiguration
} from '@myagentroam/protocol';

export interface TemplateManifestFile {
  readonly kind: 'FILE';
  readonly relativePath: string;
  readonly size: number;
  readonly executable: boolean;
  readonly sha256: string;
}

export interface TemplateManifestSymlink {
  readonly kind: 'SYMLINK';
  readonly relativePath: string;
  readonly size: number;
  readonly linkTarget: string;
  readonly targetKind: 'SNAPSHOT' | 'RUNTIME';
  readonly resolvedTarget: string;
}

export type TemplateManifestEntry = TemplateManifestFile | TemplateManifestSymlink;

export interface TemplateVersionManifest {
  readonly schemaVersion: 2;
  readonly templateId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly draftRevision: number;
  readonly hostPolicyVersion: 1;
  readonly publishedByUserId: number;
  readonly publishedAt: number;
  readonly sourceWorkspacePath: string;
  readonly draft: ConversationTemplateDraft;
  readonly directories: readonly string[];
  readonly entries: readonly TemplateManifestEntry[];
  readonly contentHash: string;
  readonly mcpServers: readonly TemplateManifestMcpServer[];
  readonly mcpConfigHash: string;
}

export interface TemplateManifestMcpServer {
  readonly id: string;
  readonly serverName: string;
  readonly displayName: string;
  readonly version: string;
  readonly origin: 'NODE' | 'WORKSPACE';
  readonly transport: 'STDIO' | 'HTTP';
  readonly runtime: McpRuntimeDescriptor;
  readonly configuration: McpInstallationConfiguration;
}

const RUNTIME_LINK_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64'] as const;
const RESERVED_SANDBOX_ROOTS = [
  '/workspace',
  '/home/mar',
  '/runtime',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/proc',
  '/dev',
  '/run',
  '/tmp'
] as const;

// Database identity and host-policy binding remain the consuming service's responsibility.
export type ParsedTemplateVersionManifest = Pick<
  TemplateVersionManifest,
  | 'schemaVersion'
  | 'sourceWorkspacePath'
  | 'draft'
  | 'directories'
  | 'entries'
  | 'contentHash'
  | 'mcpServers'
  | 'mcpConfigHash'
>;

export function parseTemplateVersionManifest(input: unknown): ParsedTemplateVersionManifest {
  if (
    !record(input) ||
    input['schemaVersion'] !== 2 ||
    typeof input['sourceWorkspacePath'] !== 'string' ||
    !Array.isArray(input['directories']) ||
    !Array.isArray(input['entries']) ||
    typeof input['contentHash'] !== 'string' ||
    typeof input['mcpConfigHash'] !== 'string'
  )
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  const sourceWorkspacePath = input['sourceWorkspacePath'];
  if (
    !isAbsolute(sourceWorkspacePath) ||
    resolve(sourceWorkspacePath) !== sourceWorkspacePath ||
    sourceWorkspacePath === '/' ||
    isReservedTemplateSourcePath(sourceWorkspacePath)
  )
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  const draft = conversationTemplateDraftSchema.safeParse(input['draft']);
  if (!draft.success) throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  const directories = input['directories'].map(safeManifestRelativePath);
  if (
    new Set(directories).size !== directories.length ||
    directories.includes('inbox') ||
    directories.includes('output')
  )
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  const entries = input['entries'].map(manifestEntry);
  if (new Set(entries.map((entry) => entry.relativePath)).size !== entries.length)
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  return {
    schemaVersion: 2,
    sourceWorkspacePath,
    draft: draft.data,
    directories,
    entries,
    contentHash: input['contentHash'],
    mcpServers: publishedMcpServers(input['mcpServers']),
    mcpConfigHash: input['mcpConfigHash']
  };
}

export function isTemplateRuntimeLinkTarget(path: string): boolean {
  return isAbsolute(path) && RUNTIME_LINK_ROOTS.some((root) => path === root || within(root, path));
}

export function isReservedTemplateSourcePath(path: string): boolean {
  return RESERVED_SANDBOX_ROOTS.some(
    (root) => path === root || within(root, path) || within(path, root)
  );
}

export function templateMcpConfigHash(servers: readonly TemplateManifestMcpServer[]): string {
  return hashText(JSON.stringify(servers));
}

/** Hash the persisted text after removing exactly one optional trailing newline. */
export function templateManifestHash(manifestText: string): string {
  return hashText(manifestText.endsWith('\n') ? manifestText.slice(0, -1) : manifestText);
}

function manifestEntry(input: unknown): TemplateManifestEntry {
  if (!record(input)) throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  if (input['kind'] === 'FILE') return manifestFile(input);
  if (
    input['kind'] !== 'SYMLINK' ||
    typeof input['linkTarget'] !== 'string' ||
    input['linkTarget'].length === 0 ||
    input['linkTarget'].includes('\0') ||
    (input['targetKind'] !== 'SNAPSHOT' && input['targetKind'] !== 'RUNTIME') ||
    typeof input['resolvedTarget'] !== 'string'
  )
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  const relativePath = safeManifestRelativePath(input['relativePath']);
  const size = safeNonNegativeInteger(input['size']);
  const linkTarget = input['linkTarget'];
  const targetKind = input['targetKind'];
  const resolvedTarget = input['resolvedTarget'];
  if (size !== Buffer.byteLength(linkTarget))
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  if (targetKind === 'SNAPSHOT') safeManifestRelativePath(resolvedTarget);
  else if (!isTemplateRuntimeLinkTarget(resolvedTarget))
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  return {
    kind: 'SYMLINK',
    relativePath,
    size,
    linkTarget,
    targetKind,
    resolvedTarget
  };
}

function manifestFile(input: unknown): TemplateManifestFile {
  if (
    !record(input) ||
    input['kind'] !== 'FILE' ||
    typeof input['executable'] !== 'boolean' ||
    typeof input['sha256'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input['sha256'])
  )
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  return {
    kind: 'FILE',
    relativePath: safeManifestRelativePath(input['relativePath']),
    size: safeNonNegativeInteger(input['size']),
    executable: input['executable'],
    sha256: input['sha256']
  };
}

function safeManifestRelativePath(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.startsWith('/') ||
    input.includes('\\') ||
    input.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  )
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  return input;
}

function safeNonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0)
    throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  return input as number;
}

export function templateContentHash(
  directories: readonly string[],
  entries: readonly TemplateManifestEntry[]
): string {
  return hashText(
    [
      ...directories.map((directory) => `DIRECTORY\0${directory}`),
      ...entries.map((entry) =>
        entry.kind === 'FILE'
          ? `${entry.kind}\0${entry.relativePath}\0${entry.size}\0${entry.executable ? 1 : 0}\0${entry.sha256}`
          : `${entry.kind}\0${entry.relativePath}\0${entry.size}\0${entry.linkTarget}\0${entry.targetKind}\0${entry.resolvedTarget}`
      )
    ].join('\n')
  );
}

function publishedMcpServers(value: unknown): readonly TemplateManifestMcpServer[] {
  if (!Array.isArray(value)) throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  return value.map((candidate) => {
    if (!record(candidate)) throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const keys = Object.keys(candidate).sort().join(',');
    if (keys !== 'configuration,displayName,id,origin,runtime,serverName,transport,version')
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    const runtime = mcpRuntimeDescriptorSchema.safeParse(candidate.runtime);
    const configuration = mcpInstallationConfigurationSchema.safeParse(candidate.configuration);
    if (!runtime.success || !configuration.success)
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.serverName !== 'string' ||
      typeof candidate.displayName !== 'string' ||
      typeof candidate.version !== 'string' ||
      (candidate.origin !== 'NODE' && candidate.origin !== 'WORKSPACE') ||
      candidate.transport !== runtime.data.transport
    )
      throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
    return {
      id: candidate.id,
      serverName: candidate.serverName,
      displayName: candidate.displayName,
      version: candidate.version,
      origin: candidate.origin,
      transport: runtime.data.transport,
      runtime: runtime.data,
      configuration: configuration.data
    };
  });
}

function within(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== '..' && !relation.startsWith(`..${sep}`);
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
