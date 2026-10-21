import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Environment for processes started by this Node, not for the Node service itself. */
export function nodeExecutionEnvironment(
  provided: Readonly<Record<string, string>> = {},
  inherited: NodeJS.ProcessEnv = process.env,
  options: { readonly platform?: NodeJS.Platform; readonly packageRoot?: string } = {}
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  Object.assign(environment, provided);
  environment['MAR_NODE_CONTEXT'] = '1';
  // Never identify a new execution as the user that launched the Node service.
  const username = provided['MAR_USERNAME'] ?? '';
  if (username.length > 128 || /[\r\n\0]/u.test(username))
    throw new Error('SECRET_ENVIRONMENT_INVALID');
  for (const key of Object.keys(environment))
    if (key.toUpperCase() === 'MAR_USERNAME') delete environment[key];
  environment['MAR_USERNAME'] = username;

  const platform = options.platform ?? process.platform;
  const packageRoot = options.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cliBins = [join(packageRoot, 'node_modules', '.bin')];
  const nodeModules = resolve(packageRoot, '..', '..');
  if (
    basename(packageRoot) === 'node' &&
    basename(dirname(packageRoot)) === '@myagentroam' &&
    basename(nodeModules) === 'node_modules'
  ) {
    // npm prefix installs and pnpm's virtual store place shims beside scoped packages.
    cliBins.push(join(nodeModules, '.bin'));
    const prefix = dirname(nodeModules);
    if (platform === 'win32') cliBins.push(prefix);
    else if (basename(prefix) === 'lib') cliBins.push(resolve(prefix, '..', 'bin'));
  }
  const cliBin = cliBins.find((bin) =>
    existsSync(join(bin, platform === 'win32' ? 'marnodes.cmd' : 'marnodes'))
  );
  if (cliBin === undefined) return environment;

  const separator = platform === 'win32' ? ';' : ':';
  const existingKeys = Object.keys(environment).filter((key) => key.toLowerCase() === 'path');
  const key =
    platform === 'win32'
      ? (Object.keys(provided).find((name) => name.toLowerCase() === 'path') ??
        existingKeys[0] ??
        'Path')
      : 'PATH';
  const current = environment[key] ?? environment[existingKeys[0] ?? key] ?? '';
  if (platform === 'win32')
    for (const other of existingKeys) if (other !== key) delete environment[other];
  const samePath = (entry: string) =>
    platform === 'win32'
      ? entry.replaceAll('/', '\\').toLowerCase() === cliBin.replaceAll('/', '\\').toLowerCase()
      : entry === cliBin;
  environment[key] = [
    cliBin,
    ...current.split(separator).filter((entry) => entry && !samePath(entry))
  ].join(separator);
  return environment;
}
