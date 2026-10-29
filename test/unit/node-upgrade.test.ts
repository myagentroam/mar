import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NodeUpgradeService,
  npmViewInvocation,
  supportsSupervisedUpgrade
} from '../../packages/server-core/src/node-upgrade-service.js';
import { compareStableVersions } from '../../packages/server-core/src/node-version.js';
import { NodeUpgradeCoordinator } from '../../mar-node/src/service/node-upgrade-coordinator.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Controlled Node upgrade version detection', () => {
  it('Only older Supervisor-capable Nodes can upgrade to the latest npm stable version not exceeding Server', async () => {
    const lookup = vi.fn().mockResolvedValue(['0.19.1']);
    const service = new NodeUpgradeService('0.19.2', lookup);
    await expect(service.availability('0.19.0', true)).resolves.toEqual({
      state: 'AVAILABLE',
      targetVersion: '0.19.1'
    });
    await expect(service.availability('0.19.1', true)).resolves.toEqual({
      state: 'CURRENT',
      targetVersion: '0.19.1'
    });
    await expect(service.availability('0.19.2', true)).resolves.toEqual({
      state: 'CURRENT',
      targetVersion: '0.19.1'
    });
    await expect(service.availability('0.19.3', true)).resolves.toEqual({
      state: 'CURRENT',
      targetVersion: '0.19.1'
    });
    await expect(service.availability('0.1.5', true)).resolves.toEqual({
      state: 'NODE_UNSUPPORTED',
      targetVersion: '0.19.1'
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('@myagentroam/node');
  });

  it('The target falls back below Server when its exact version is unpublished', async () => {
    const lookup = vi.fn().mockResolvedValue(['0.19.3', '0.19.1']);
    const service = new NodeUpgradeService('0.19.2', lookup);
    await expect(service.availability('0.19.0', true)).resolves.toEqual({
      state: 'AVAILABLE',
      targetVersion: '0.19.1'
    });
    await expect(service.availability('0.19.2', true)).resolves.toEqual({
      state: 'CURRENT',
      targetVersion: '0.19.1'
    });
    expect(lookup.mock.calls).toEqual([['@myagentroam/node']]);
  });

  it('does not query npm when the Server version is invalid', async () => {
    const lookup = vi.fn().mockResolvedValue(['0.19.3']);
    const service = new NodeUpgradeService('enterprise-development', lookup);
    await expect(service.availability('0.19.1', true)).resolves.toEqual({
      state: 'PACKAGE_UNAVAILABLE',
      targetVersion: '0.19.1'
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('Older Nodes without Supervisor support cannot receive upgrade requests', async () => {
    const service = new NodeUpgradeService('0.11.39', vi.fn().mockResolvedValue(['0.11.39']));
    await expect(service.availability('0.1.6')).resolves.toEqual({
      state: 'NODE_UNSUPPORTED',
      targetVersion: '0.11.39'
    });
  });

  it('Invalid and prerelease versions are rejected and Nodes are never downgraded', () => {
    expect(compareStableVersions('0.1.6', '0.1.7')).toBeLessThan(0);
    expect(compareStableVersions('0.1.7-beta.1', '0.1.7')).toBeUndefined();
    expect(supportsSupervisedUpgrade('0.1.5')).toBe(false);
    expect(supportsSupervisedUpgrade('0.1.6')).toBe(true);
  });

  it('Windows npm version checks run cmd shims through the controlled command interpreter', () => {
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

  it('Published versions above Server cannot authorize upgrades', async () => {
    const lookup = vi.fn().mockResolvedValue(['9.0.0']);
    const service = new NodeUpgradeService('1.0.1', lookup);
    await expect(service.availability('0.9.1', true)).resolves.toEqual({
      state: 'PACKAGE_UNAVAILABLE',
      targetVersion: '0.9.1'
    });
    expect(lookup).toHaveBeenCalledWith('@myagentroam/node');
  });

  it('Failed npm queries and unstable versions cannot authorize upgrades', async () => {
    const service = new NodeUpgradeService('0.9.2', vi.fn().mockResolvedValue(['0.9.2-beta.1']));
    await expect(service.availability('0.1.6', true)).resolves.toEqual({
      state: 'PACKAGE_UNAVAILABLE',
      targetVersion: '0.1.6'
    });
  });
});

describe('Node upgrade drain coordinator', () => {
  it('clears the intent and releases admission when the host cannot hand off', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-node-upgrade-'));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, 'upgrade-request.json');
    const coordinator = new NodeUpgradeCoordinator(
      () => requestPath,
      () => 0,
      () => undefined,
      () => {
        throw new Error('NODE_UPGRADE_HANDOFF_UNAVAILABLE');
      }
    );
    coordinator.request({ targetVersion: '0.1.7' });
    await vi.waitFor(() => expect(coordinator.snapshot().state).toBe('FAILED'));
    expect(coordinator.snapshot().errorCode).toBe('NODE_UPGRADE_HANDOFF_UNAVAILABLE');
    expect(coordinator.blocks('terminal.open')).toBe(false);
    await expect(readFile(requestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('After active Runs drain, writes upgrade intent atomically and notifies Supervisor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-node-upgrade-'));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, 'upgrade-request.json');
    let activeRuns = 1;
    const statuses: string[] = [];
    const ready = vi.fn();
    const coordinator = new NodeUpgradeCoordinator(
      () => requestPath,
      () => activeRuns,
      (status) => statuses.push(status.state),
      ready,
      () => 123
    );
    expect(coordinator.request({ targetVersion: '0.1.7' })).toEqual({
      status: 'ACCEPTED',
      targetVersion: '0.1.7',
      activeRunCount: 1
    });
    expect(coordinator.blocks('session.message')).toBe(true);
    expect(coordinator.blocks('runner.command.execute')).toBe(true);
    expect(coordinator.blocks('terminal.open')).toBe(true);
    expect(coordinator.pending()).toBe(true);
    activeRuns = 0;
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 1_000 });
    expect(coordinator.snapshot().state).toBe('READY_TO_RESTART');
    expect(coordinator.blocks('session.message')).toBe(true);
    expect(coordinator.blocks('terminal.open')).toBe(true);
    expect(JSON.parse(await readFile(requestPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      targetVersion: '0.1.7',
      createdAt: 123
    });
    expect(statuses).toEqual(['WAITING_FOR_RUNS', 'READY_TO_RESTART']);
    expect(ready).toHaveBeenCalledOnce();
  });

  it.each([
    ['NODE_UPGRADE_HANDOFF_REJECTED', 'FAILED', false],
    ['NODE_UPGRADE_HANDOFF_UNCERTAIN', 'READY_TO_RESTART', true]
  ] as const)('handles %s without unsafe exit or retry', async (code, state, retained) => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-upgrade-handoff-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'upgrade-request.json');
    const ready = vi.fn();
    const attemptId = '8e601182-89f2-48e2-a885-3327df58c22f';
    const prepare = vi.fn(async () => {
      throw new Error(code);
    });
    const coordinator = new NodeUpgradeCoordinator(
      () => path,
      () => 0,
      () => undefined,
      ready,
      Date.now,
      prepare
    );
    coordinator.request({ targetVersion: '0.1.7', attemptId });
    await vi.waitFor(() => expect(coordinator.snapshot().errorCode).toBe(code));
    expect(coordinator.snapshot().state).toBe(state);
    expect(coordinator.blocks('terminal.open')).toBe(retained);
    expect(ready).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
    if (retained) expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ attemptId });
    else await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Only the waiting phase permits cancellation and same-target requests remain idempotent', () => {
    const coordinator = new NodeUpgradeCoordinator(
      () => '/unused',
      () => 1,
      () => undefined,
      () => undefined
    );
    coordinator.request({ targetVersion: '0.1.7' });
    expect(coordinator.request({ targetVersion: '0.1.7' }).status).toBe('ALREADY_PENDING');
    expect(() => coordinator.request({ targetVersion: '0.1.8' })).toThrow(
      'NODE_UPGRADE_ALREADY_PENDING'
    );
    expect(coordinator.cancel()).toEqual({ cancelled: true });
    expect(coordinator.snapshot().state).toBe('IDLE');
  });

  it('retains the cancelled attempt in IDLE capability until another request', () => {
    const statuses: unknown[] = [];
    const coordinator = new NodeUpgradeCoordinator(
      () => '/unused',
      () => 1,
      (status) => statuses.push(status),
      () => undefined,
      Date.now,
      async () => undefined
    );
    const attemptId = '8e601182-89f2-48e2-a885-3327df58c22f';
    coordinator.request({ targetVersion: '0.1.7', attemptId });
    coordinator.cancel();
    expect(statuses.at(-1)).toMatchObject({ state: 'IDLE', attemptId });
    expect(coordinator.snapshot()).toMatchObject({ state: 'IDLE', attemptId });
    coordinator.request({ targetVersion: '0.1.8' });
    expect(coordinator.snapshot()).not.toHaveProperty('attemptId');
    coordinator.cancel();
  });

  it('Failed upgrade-intent writes keep the process online and report failure', async () => {
    const coordinator = new NodeUpgradeCoordinator(
      () => '/missing-parent/forbidden/upgrade-request.json',
      () => 0,
      () => undefined,
      () => undefined
    );
    coordinator.request({ targetVersion: '0.1.7' });
    await vi.waitFor(() => expect(coordinator.snapshot().state).toBe('FAILED'));
    expect(coordinator.snapshot().errorCode).toBe('NODE_UPGRADE_REQUEST_WRITE_FAILED');
  });
});
