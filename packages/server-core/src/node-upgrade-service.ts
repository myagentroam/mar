import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareStableVersions, MIN_NODE_BUSINESS_VERSION } from './node-version.js';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const execFileAsync = promisify(execFile);
type PackageVersionsLookup = (specifier: string) => Promise<readonly string[] | undefined>;

export type NodeUpgradeAvailability =
  | { readonly state: 'AVAILABLE'; readonly targetVersion: string }
  | {
      readonly state: 'CURRENT' | 'VERSION_INVALID' | 'NODE_UNSUPPORTED' | 'PACKAGE_UNAVAILABLE';
      readonly targetVersion: string;
    };

export class NodeUpgradeService {
  private readonly cached = new Map<
    string,
    { readonly version: string | undefined; readonly expiresAt: number }
  >();
  private readonly pending = new Map<string, Promise<string | undefined>>();

  constructor(
    readonly serverVersion: string,
    private readonly lookupPackageVersions: PackageVersionsLookup = lookupNpmPackageVersions,
    private readonly now: () => number = Date.now
  ) {}

  async availability(
    nodeVersion: string,
    supervisedUpgrade = false,
    upgradeOnly = false
  ): Promise<NodeUpgradeAvailability> {
    if (!STABLE_VERSION.test(nodeVersion))
      return { state: 'VERSION_INVALID', targetVersion: nodeVersion };
    const targetVersion = await this.selectedPublishedVersion();
    if (
      targetVersion === undefined ||
      compareStableVersions(targetVersion, MIN_NODE_BUSINESS_VERSION)! < 0
    )
      return { state: 'PACKAGE_UNAVAILABLE', targetVersion: nodeVersion };
    const targetComparison = compareStableVersions(nodeVersion, targetVersion);
    if (targetComparison === undefined) return { state: 'VERSION_INVALID', targetVersion };
    if (targetComparison >= 0)
      return { state: upgradeOnly ? 'PACKAGE_UNAVAILABLE' : 'CURRENT', targetVersion };
    if (!supervisedUpgrade || !supportsSupervisedUpgrade(nodeVersion))
      return { state: 'NODE_UNSUPPORTED', targetVersion };
    return { state: 'AVAILABLE', targetVersion };
  }

  private selectedPublishedVersion(): Promise<string | undefined> {
    if (!STABLE_VERSION.test(this.serverVersion)) return Promise.resolve(undefined);
    return this.publishedVersion('@myagentroam/node');
  }

  private publishedVersion(specifier: string): Promise<string | undefined> {
    const cached = this.cached.get(specifier);
    if (cached !== undefined && cached.expiresAt > this.now())
      return Promise.resolve(cached.version);
    const pending = this.pending.get(specifier);
    if (pending !== undefined) return pending;
    const lookup = this.lookupPackageVersions(specifier)
      .then((versions) => {
        let selected: string | undefined;
        for (const version of versions ?? []) {
          const comparison = compareStableVersions(version, this.serverVersion);
          if (comparison === undefined || comparison > 0) continue;
          if (selected === undefined || compareStableVersions(version, selected)! > 0)
            selected = version;
        }
        return selected;
      })
      .catch(() => undefined)
      .then((version) => {
        this.cached.set(specifier, {
          version,
          expiresAt: this.now() + (version === undefined ? 30_000 : 300_000)
        });
        return version;
      })
      .finally(() => {
        this.pending.delete(specifier);
      });
    this.pending.set(specifier, lookup);
    return lookup;
  }
}

async function lookupNpmPackageVersions(specifier: string): Promise<readonly string[] | undefined> {
  const invocation = npmViewInvocation(specifier);
  const { stdout } = await execFileAsync(invocation.command, invocation.args, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true
  });
  const versions: unknown = JSON.parse(stdout);
  return Array.isArray(versions) && versions.every((version) => typeof version === 'string')
    ? versions
    : undefined;
}

export function npmViewInvocation(
  specifier: string,
  platform = process.platform,
  comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
): { readonly command: string; readonly args: readonly string[] } {
  if (!/^@myagentroam\/node(?:@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))?$/u.test(specifier))
    throw new Error('NODE_UPGRADE_VERSION_INVALID');
  const args = ['view', specifier, 'versions', '--json'];
  return platform === 'win32'
    ? { command: comspec, args: ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] }
    : { command: 'npm', args };
}

export function supportsSupervisedUpgrade(version: string): boolean {
  const comparison = compareStableVersions(version, '0.1.6');
  return comparison !== undefined && comparison >= 0;
}
