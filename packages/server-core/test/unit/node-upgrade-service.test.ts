import { describe, expect, it, vi } from 'vitest';
import {
  NodeUpgradeService,
  compareStableVersions,
  npmViewInvocation,
  supportsSupervisedUpgrade
} from '../../src/node-upgrade-service.js';

describe('Node controlled upgrade version checks', () => {
  it('allows only older Supervisor-supported Nodes to upgrade to the latest npm stable version not exceeding Server', async () => {
    const lookup = vi.fn().mockResolvedValue(['0.9.1']);
    const service = new NodeUpgradeService('0.9.2', lookup);
    await expect(service.availability('0.9.0', true)).resolves.toEqual({
      state: 'AVAILABLE',
      targetVersion: '0.9.1'
    });
    await expect(service.availability('0.9.1', true)).resolves.toEqual({
      state: 'CURRENT',
      targetVersion: '0.9.1'
    });
    await expect(service.availability('0.9.2', true)).resolves.toEqual({
      state: 'CURRENT',
      targetVersion: '0.9.1'
    });
    await expect(service.availability('0.9.3', true)).resolves.toEqual({
      state: 'CURRENT',
      targetVersion: '0.9.1'
    });
    await expect(service.availability('0.1.5', true)).resolves.toEqual({
      state: 'NODE_UNSUPPORTED',
      targetVersion: '0.9.1'
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('@myagentroam/node');
  });

  it('selects the highest published stable version below Server when its exact version is unpublished', async () => {
    const lookup = vi.fn().mockResolvedValue(['0.9.3', '0.9.1']);
    const service = new NodeUpgradeService('0.9.2', lookup);
    await expect(service.availability('0.9.0', true)).resolves.toEqual({
      state: 'AVAILABLE',
      targetVersion: '0.9.1'
    });
    await expect(service.availability('0.9.2', true)).resolves.toEqual({
      state: 'CURRENT',
      targetVersion: '0.9.1'
    });
    expect(lookup.mock.calls).toEqual([['@myagentroam/node']]);
  });

  it('does not query npm when the Server version is invalid', async () => {
    const lookup = vi.fn().mockResolvedValue(['0.9.3']);
    const service = new NodeUpgradeService('enterprise-development', lookup);
    await expect(service.availability('0.9.1', true)).resolves.toEqual({
      state: 'PACKAGE_UNAVAILABLE',
      targetVersion: '0.9.1'
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not allow a push when the same application version was not started by Supervisor', async () => {
    const service = new NodeUpgradeService('0.1.7', vi.fn().mockResolvedValue(['0.1.7']));
    await expect(service.availability('0.1.6')).resolves.toEqual({
      state: 'NODE_UNSUPPORTED',
      targetVersion: '0.1.7'
    });
  });

  it('rejects invalid and prerelease versions without downgrading Nodes', () => {
    expect(compareStableVersions('0.1.6', '0.1.7')).toBeLessThan(0);
    expect(compareStableVersions('0.1.7-beta.1', '0.1.7')).toBeUndefined();
    expect(supportsSupervisedUpgrade('0.1.5')).toBe(false);
    expect(supportsSupervisedUpgrade('0.1.6')).toBe(true);
  });

  it('runs the npm version lookup through the controlled command processor for Windows cmd shims', () => {
    expect(npmViewInvocation('@myagentroam/node', 'linux')).toEqual({
      command: 'npm',
      args: ['view', '@myagentroam/node', 'versions', '--json']
    });
    expect(npmViewInvocation('@myagentroam/node', 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd view @myagentroam/node versions --json']
    });
    expect(() => npmViewInvocation('@myagentroam/node@latest', 'win32')).toThrow(
      'NODE_UPGRADE_VERSION_INVALID'
    );
  });

  it('rejects upgrades when all published stable versions exceed Server', async () => {
    const lookup = vi.fn().mockResolvedValue(['9.0.0']);
    const service = new NodeUpgradeService('1.0.1', lookup);
    await expect(service.availability('0.9.1', true)).resolves.toEqual({
      state: 'PACKAGE_UNAVAILABLE',
      targetVersion: '0.9.1'
    });
    expect(lookup).toHaveBeenCalledWith('@myagentroam/node');
  });

  it.each([undefined, [], ['0.9.2-beta.1'], ['invalid']])(
    'does not allow an upgrade when npm has no eligible stable version: %j',
    async (versions) => {
      const service = new NodeUpgradeService('0.9.2', vi.fn().mockResolvedValue(versions));
      await expect(service.availability('0.1.6', true)).resolves.toEqual({
        state: 'PACKAGE_UNAVAILABLE',
        targetVersion: '0.1.6'
      });
    }
  );

  it('selects the highest stable version numerically from an unordered list within the Server ceiling', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue(['0.9.9', '0.9.12', '0.9.11-beta.1', 'invalid', '0.9.10']);
    const service = new NodeUpgradeService('0.9.11', lookup);
    await expect(service.availability('0.9.9', true)).resolves.toEqual({
      state: 'AVAILABLE',
      targetVersion: '0.9.10'
    });
  });

  it('includes the exact Server version when it is published', async () => {
    const service = new NodeUpgradeService(
      '0.10.3',
      vi.fn().mockResolvedValue(['0.10.5', '0.10.1', '0.10.3', '0.10.2'])
    );
    await expect(service.availability('0.10.2', true)).resolves.toEqual({
      state: 'AVAILABLE',
      targetVersion: '0.10.3'
    });
  });

  it('refreshes the eligible npm target after the successful lookup cache expires', async () => {
    let now = 0;
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(['0.9.1', '0.9.3'])
      .mockResolvedValueOnce(['0.9.1', '0.9.2', '0.9.3']);
    const service = new NodeUpgradeService('0.9.2', lookup, () => now);
    await expect(service.availability('0.9.0', true)).resolves.toMatchObject({
      targetVersion: '0.9.1'
    });
    now = 299_999;
    await expect(service.availability('0.9.0', true)).resolves.toMatchObject({
      targetVersion: '0.9.1'
    });
    expect(lookup).toHaveBeenCalledOnce();
    now = 300_000;
    await expect(service.availability('0.9.0', true)).resolves.toEqual({
      state: 'AVAILABLE',
      targetVersion: '0.9.2'
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('shares one npm lookup across concurrent Node checks', async () => {
    let resolveLookup!: (versions: readonly string[]) => void;
    const lookup = vi.fn(
      () =>
        new Promise<readonly string[]>((resolve) => {
          resolveLookup = resolve;
        })
    );
    const service = new NodeUpgradeService('0.9.2', lookup);
    const older = service.availability('0.9.0', true);
    const current = service.availability('0.9.2', true);
    expect(lookup).toHaveBeenCalledOnce();
    resolveLookup(['0.9.1', '0.9.2', '0.9.3']);
    await expect(older).resolves.toEqual({ state: 'AVAILABLE', targetVersion: '0.9.2' });
    await expect(current).resolves.toEqual({ state: 'CURRENT', targetVersion: '0.9.2' });
  });

  it('briefly caches failed npm queries and retries after expiry', async () => {
    let now = 0;
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error('Registry unavailable'))
      .mockResolvedValueOnce(['0.9.1']);
    const service = new NodeUpgradeService('0.9.2', lookup, () => now);
    await expect(service.availability('0.1.6', true)).resolves.toEqual({
      state: 'PACKAGE_UNAVAILABLE',
      targetVersion: '0.1.6'
    });
    now = 29_999;
    await expect(service.availability('0.1.6', true)).resolves.toMatchObject({
      state: 'PACKAGE_UNAVAILABLE'
    });
    expect(lookup).toHaveBeenCalledOnce();
    now = 30_000;
    await expect(service.availability('0.1.6', true)).resolves.toEqual({
      state: 'AVAILABLE',
      targetVersion: '0.9.1'
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
