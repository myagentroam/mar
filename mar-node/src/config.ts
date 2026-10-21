import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { computerUseRuntimeVersion } from './computer-use-runtime-version.js';

export interface ConversationHostingConfig {
  readonly enabled: boolean;
  /** Relative directory inside dataDirectory. */
  readonly storeDirectory?: string;
  readonly inactiveRetentionDays?: number;
}

export interface DirectTransferConfig {
  readonly udpPortRangeBegin: number;
  readonly udpPortRangeEnd: number;
}

export interface DirectTransferUdpPortRange {
  readonly begin: number;
  readonly end: number;
}

export interface ComputerUseConfig {
  readonly enabled: boolean;
  /** Development/validation override; production distributions use the managed runtime path. */
  readonly runtimeExecutable?: string;
}

export interface NodeConfig {
  readonly serverUrl: string;
  /** Explicit roots or the platform default resolved while loading the config. */
  readonly allowedRoots: readonly string[];
  /** Absolute or config-relative root for SQLite, upgrades and other private Node data. */
  readonly dataDirectory?: string;
  readonly conversationHosting?: ConversationHostingConfig;
  readonly directTransfer?: DirectTransferConfig;
  readonly computerUse?: ComputerUseConfig;
  readonly nodeId?: string;
  readonly credential?: string;
  readonly registrationToken?: string;
}

export function nodeConfigPath(): string {
  return resolve(process.env['MAR_NODE_CONFIG'] ?? 'data/mar-node.json');
}

export async function loadNodeConfig(path = nodeConfigPath()): Promise<NodeConfig> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('serverUrl' in parsed) ||
    typeof parsed.serverUrl !== 'string' ||
    'databasePath' in parsed ||
    ('allowedRoots' in parsed &&
      (!Array.isArray(parsed.allowedRoots) ||
        !parsed.allowedRoots.every((root) => typeof root === 'string')))
  ) {
    throw new Error('NODE_CONFIG_INVALID');
  }
  const input = parsed as Record<string, unknown>;
  const optionalString = (name: string): string | undefined =>
    typeof input[name] === 'string' ? input[name] : undefined;
  const nodeId = optionalString('nodeId');
  const credential = optionalString('credential');
  const registrationToken = optionalString('registrationToken');
  const dataDirectory = optionalString('dataDirectory');
  const allowedRoots = Array.isArray(input['allowedRoots'])
    ? (input['allowedRoots'] as string[])
    : defaultAllowedRoots();
  const conversationHosting = parseConversationHosting(input['conversationHosting']);
  const directTransfer = parseDirectTransfer(input['directTransfer']);
  const computerUse = parseComputerUse(input['computerUse']);
  return {
    serverUrl: parsed.serverUrl,
    allowedRoots,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(credential === undefined ? {} : { credential }),
    ...(registrationToken === undefined ? {} : { registrationToken }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    ...(conversationHosting === undefined ? {} : { conversationHosting }),
    ...(directTransfer === undefined ? {} : { directTransfer }),
    ...(computerUse === undefined ? {} : { computerUse })
  };
}

export function directTransferUdpPortRange(
  config: Pick<NodeConfig, 'directTransfer'> | undefined
): DirectTransferUdpPortRange {
  const directTransfer = config?.directTransfer;
  return {
    begin: directTransfer?.udpPortRangeBegin ?? 49_152,
    end: directTransfer?.udpPortRangeEnd ?? 49_215
  };
}

/** Uses the Node service account's scope when no Workspace roots are configured. */
export function defaultAllowedRoots(
  platform = process.platform,
  homePath = homedir(),
  currentDirectory = process.cwd()
): readonly string[] {
  return platform === 'win32' ? [win32.parse(currentDirectory).root] : [homePath];
}

export function nodeDatabasePath(config: NodeConfig, configPath = nodeConfigPath()): string {
  return resolve(nodeDataDirectory(config, configPath), 'node-runtime.sqlite');
}

export function nodeDataDirectory(config: NodeConfig, configPath = nodeConfigPath()): string {
  if (config.dataDirectory !== undefined) return resolve(dirname(configPath), config.dataDirectory);
  return resolve(dirname(configPath));
}

export function computerUseRuntimeExecutable(
  config: NodeConfig,
  configPath = nodeConfigPath(),
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): string | undefined {
  if (config.computerUse?.enabled !== true) return undefined;
  if (config.computerUse.runtimeExecutable !== undefined)
    return resolve(dirname(configPath), config.computerUse.runtimeExecutable);
  const runtimeRoot = resolve(
    nodeDataDirectory(config, configPath),
    'computer-use',
    'runtime',
    `${computerUseRuntimeVersion}-${platform}-${architecture}`
  );
  return platform === 'win32'
    ? resolve(runtimeRoot, 'python.exe')
    : resolve(runtimeRoot, 'bin', 'python3');
}

export function hostedConversationStorePath(
  config: NodeConfig,
  configPath = nodeConfigPath()
): string | undefined {
  const hosting = config.conversationHosting;
  if (hosting?.enabled !== true) return undefined;
  const configured = hosting.storeDirectory;
  if (!validStoreDirectory(configured)) throw new Error('NODE_CONFIG_INVALID');
  const dataDirectory = nodeDataDirectory(config, configPath);
  const store = resolve(dataDirectory, configured);
  const relation = relative(dataDirectory, store);
  if (relation.length === 0 || relation === '..' || relation.startsWith(`..${sep}`))
    throw new Error('NODE_CONFIG_INVALID');
  return store;
}

/** Credentials are always written with owner-only POSIX permissions where supported. */
export async function saveNodeConfig(config: NodeConfig, path = nodeConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, undefined, 2)}\n`, {
      mode: 0o600,
      flag: 'wx'
    });
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseConversationHosting(value: unknown): ConversationHostingConfig | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)['enabled'] !== 'boolean' ||
    Object.keys(value).some(
      (key) => key !== 'enabled' && key !== 'storeDirectory' && key !== 'inactiveRetentionDays'
    )
  )
    throw new Error('NODE_CONFIG_INVALID');
  const enabled = (value as Record<string, unknown>)['enabled'] as boolean;
  const storeDirectory = (value as Record<string, unknown>)['storeDirectory'];
  const inactiveRetentionDays = (value as Record<string, unknown>)['inactiveRetentionDays'] ?? 60;
  if (
    storeDirectory !== undefined &&
    (typeof storeDirectory !== 'string' || !validStoreDirectory(storeDirectory))
  )
    throw new Error('NODE_CONFIG_INVALID');
  if (
    !Number.isInteger(inactiveRetentionDays) ||
    (inactiveRetentionDays as number) < 1 ||
    (inactiveRetentionDays as number) > 365
  )
    throw new Error('NODE_CONFIG_INVALID');
  if (enabled && storeDirectory === undefined) throw new Error('NODE_CONFIG_INVALID');
  return {
    enabled,
    ...(storeDirectory === undefined ? {} : { storeDirectory }),
    inactiveRetentionDays: inactiveRetentionDays as number
  };
}

function parseDirectTransfer(value: unknown): DirectTransferConfig | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'udpPortRangeBegin' && key !== 'udpPortRangeEnd')
  )
    throw new Error('NODE_CONFIG_INVALID');
  const input = value as Record<string, unknown>;
  const begin = input['udpPortRangeBegin'];
  const end = input['udpPortRangeEnd'];
  if (
    !Number.isInteger(begin) ||
    !Number.isInteger(end) ||
    (begin as number) < 1_024 ||
    (end as number) > 65_535 ||
    (begin as number) > (end as number) ||
    (end as number) - (begin as number) + 1 > 256
  )
    throw new Error('NODE_CONFIG_INVALID');
  return {
    udpPortRangeBegin: begin as number,
    udpPortRangeEnd: end as number
  };
}

function parseComputerUse(value: unknown): ComputerUseConfig | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)['enabled'] !== 'boolean' ||
    Object.keys(value).some((key) => key !== 'enabled' && key !== 'runtimeExecutable')
  )
    throw new Error('NODE_CONFIG_INVALID');
  const input = value as Record<string, unknown>;
  const runtimeExecutable = input['runtimeExecutable'];
  if (
    runtimeExecutable !== undefined &&
    (typeof runtimeExecutable !== 'string' ||
      runtimeExecutable.length === 0 ||
      runtimeExecutable.trim() !== runtimeExecutable)
  )
    throw new Error('NODE_CONFIG_INVALID');
  return {
    enabled: input['enabled'] as boolean,
    ...(runtimeExecutable === undefined ? {} : { runtimeExecutable })
  };
}

function validStoreDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return false;
  if (isAbsolute(value) || value === '.' || value === '..') return false;
  return !value.split('/').some((part) => part.length === 0 || part === '.' || part === '..');
}
