import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

export const BUNDLED_RIPGREP_VERSION = '15.1.0';

const TARGETS = {
  'linux-x64': ['linux-x64', 'rg'],
  'linux-arm64': ['linux-arm64', 'rg'],
  'darwin-x64': ['darwin-x64', 'rg'],
  'darwin-arm64': ['darwin-arm64', 'rg'],
  'win32-x64': ['win32-x64', 'rg.exe'],
  'win32-arm64': ['win32-arm64', 'rg.exe']
} as const;

export function bundledRipgrepDirectory(packageRoot?: string): string {
  return packageRoot === undefined
    ? resolve(
        dirname(createRequire(import.meta.url).resolve('@myagentroam/binaries/package.json')),
        'vendor/ripgrep'
      )
    : resolve(packageRoot, 'packages/binaries/vendor/ripgrep');
}

export function bundledRipgrepPath(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  packageRoot?: string
): string {
  const target = TARGETS[`${platform}-${architecture}` as keyof typeof TARGETS];
  if (target === undefined) throw new Error('RIPGREP_PLATFORM_UNSUPPORTED');
  return resolve(bundledRipgrepDirectory(packageRoot), ...target);
}

export function prependBundledRipgrepToPath(
  environment: NodeJS.ProcessEnv,
  executable: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const key = platform === 'win32' ? 'Path' : 'PATH';
  const alternate = platform === 'win32' ? environment['PATH'] : undefined;
  const current = environment[key] ?? alternate ?? '';
  return {
    ...environment,
    [key]: [dirname(executable), current].filter(Boolean).join(platform === 'win32' ? ';' : ':')
  };
}
