import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

/** The deployment owns this private configuration; component data stays beside it. */
export interface QuickStartConfig {
  readonly version: 1;
  readonly deploymentId: string;
  readonly serverPort: number;
  readonly mysql: {
    readonly port: number;
    readonly password: string;
    readonly installation?: MysqlInstallation;
  };
  readonly node: { readonly enabled: boolean };
  readonly search:
    | { readonly mode: 'disabled' | 'managed'; readonly installation?: SearchInstallation }
    | {
        readonly mode: 'external';
        readonly url: string;
        readonly installation?: SearchInstallation;
      };
}

export interface SearchInstallation {
  readonly version: string;
  readonly uvVersion: string;
  readonly pythonVersion: string;
  readonly directory: string;
  readonly platform: string;
  readonly arch: string;
  readonly port: number;
}

export interface MysqlInstallation {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly directory: string;
  readonly libraryVersion: string;
  readonly libraryDirectory: string;
}

export function resolveQuickStartConfigPath(
  path: string | undefined,
  home = homedir(),
  cwd = process.cwd()
): string {
  return path === undefined
    ? resolve(home, '.myagentroam/quick-start/server.json')
    : resolve(cwd, path);
}

export function createQuickStartConfig(input: {
  readonly serverPort: number;
  readonly mysqlPort: number;
  readonly node: boolean;
  readonly search: 'disabled' | 'managed';
}): QuickStartConfig {
  return validateConfig({
    version: 1,
    deploymentId: randomBytes(16).toString('hex'),
    serverPort: input.serverPort,
    mysql: { port: input.mysqlPort, password: randomBytes(32).toString('base64url') },
    node: { enabled: input.node },
    search: { mode: input.search }
  });
}

export function selectQuickStartComponents(
  config: QuickStartConfig,
  choices: { readonly node?: false; readonly searxng?: false }
): QuickStartConfig {
  return {
    ...config,
    node: choices.node === false ? { ...config.node, enabled: false } : config.node,
    search:
      choices.searxng === false && config.search.mode !== 'external'
        ? { ...config.search, mode: 'disabled' }
        : config.search
  };
}

export async function readQuickStartConfig(path: string): Promise<QuickStartConfig | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return validateConfig(JSON.parse(contents) as unknown);
  } catch {
    throw new Error('QUICK_START_CONFIG_INVALID');
  }
}

export async function writeQuickStartConfig(path: string, config: QuickStartConfig): Promise<void> {
  const valid = validateConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(valid, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function validateConfig(value: unknown): QuickStartConfig {
  const invalid = () => {
    throw new Error('QUICK_START_CONFIG_INVALID');
  };
  if (
    !isRecord(value) ||
    !hasOnly(value, ['version', 'deploymentId', 'serverPort', 'mysql', 'node', 'search'])
  )
    return invalid();
  const { version, deploymentId, serverPort, mysql, node, search } = value;
  if (
    version !== 1 ||
    typeof deploymentId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(deploymentId) ||
    !isPort(serverPort) ||
    !isRecord(mysql) ||
    !hasOnly(mysql, ['port', 'password', 'installation']) ||
    !isPort(mysql.port) ||
    mysql.port === serverPort ||
    typeof mysql.password !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(mysql.password) ||
    (mysql.installation !== undefined && !isMysqlInstallation(mysql.installation)) ||
    !isRecord(node) ||
    !hasOnly(node, ['enabled']) ||
    typeof node.enabled !== 'boolean' ||
    !isRecord(search) ||
    (search.installation !== undefined && !isSearchInstallation(search.installation))
  )
    return invalid();
  const mysqlConfig = {
    port: mysql.port,
    password: mysql.password,
    ...(mysql.installation === undefined
      ? {}
      : { installation: mysql.installation as MysqlInstallation })
  };
  const nodeConfig = { enabled: node.enabled };
  const searchInstallation =
    search.installation === undefined
      ? {}
      : { installation: search.installation as SearchInstallation };
  if (search.mode === 'external') {
    if (!hasOnly(search, ['mode', 'url', 'installation']) || typeof search.url !== 'string')
      return invalid();
    let url: URL;
    try {
      url = new URL(search.url);
    } catch {
      return invalid();
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return invalid();
    return {
      version,
      deploymentId,
      serverPort,
      mysql: mysqlConfig,
      node: nodeConfig,
      search: { mode: 'external', url: search.url, ...searchInstallation }
    };
  }
  if (
    !hasOnly(search, ['mode', 'installation']) ||
    (search.mode !== 'disabled' && search.mode !== 'managed')
  )
    return invalid();
  return {
    version,
    deploymentId,
    serverPort,
    mysql: mysqlConfig,
    node: nodeConfig,
    search: { mode: search.mode, ...searchInstallation }
  };
}

function isSearchInstallation(value: unknown): value is SearchInstallation {
  return (
    isRecord(value) &&
    hasOnly(value, [
      'version',
      'uvVersion',
      'pythonVersion',
      'directory',
      'platform',
      'arch',
      'port'
    ]) &&
    typeof value.version === 'string' &&
    /^[a-zA-Z0-9._-]+$/u.test(value.version) &&
    typeof value.uvVersion === 'string' &&
    /^\d+\.\d+\.\d+$/u.test(value.uvVersion) &&
    typeof value.pythonVersion === 'string' &&
    /^\d+\.\d+\.\d+$/u.test(value.pythonVersion) &&
    isComponentPath(value.directory) &&
    typeof value.platform === 'string' &&
    /^[a-z0-9]+$/u.test(value.platform) &&
    typeof value.arch === 'string' &&
    /^[a-z0-9]+$/u.test(value.arch) &&
    isPort(value.port)
  );
}

function isMysqlInstallation(value: unknown): value is MysqlInstallation {
  return (
    isRecord(value) &&
    hasOnly(value, [
      'version',
      'platform',
      'arch',
      'directory',
      'libraryVersion',
      'libraryDirectory'
    ]) &&
    typeof value.version === 'string' &&
    /^[A-Za-z0-9._-]+$/u.test(value.version) &&
    typeof value.platform === 'string' &&
    /^[a-z0-9]+$/u.test(value.platform) &&
    typeof value.arch === 'string' &&
    /^[a-z0-9]+$/u.test(value.arch) &&
    typeof value.libraryVersion === 'string' &&
    /^[A-Za-z0-9._-]+$/u.test(value.libraryVersion) &&
    isComponentPath(value.directory) &&
    isComponentPath(value.libraryDirectory)
  );
}

function isComponentPath(value: unknown): value is string {
  return (
    typeof value === 'string' && /^components(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;
}
