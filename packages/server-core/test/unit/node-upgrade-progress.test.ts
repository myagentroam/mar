import { describe, expect, it } from 'vitest';
import {
  confirmUpgradeConnection,
  mergeUpgradeReport,
  NodeUpgradeProgress,
  type NodeUpgradeProgressStore,
  type StoredNodeUpgrade,
  type NodeUpgradeSnapshot
} from '../../src/node-upgrade-progress.js';

const initial: NodeUpgradeSnapshot = {
  attemptId: 'attempt-1',
  targetVersion: '0.2.0',
  state: 'WAITING_FOR_RUNS',
  installed: false,
  targetOnline: false,
  createdAt: 1,
  updatedAt: 1
};
const installed = {
  attemptId: 'attempt-1',
  step: 'WAITING_FOR_ONLINE',
  result: 'INSTALLED'
} as const;

describe('node upgrade progress facts', () => {
  it('requires both installation and authenticated matching connection, in either order', () => {
    const awaiting = mergeUpgradeReport(initial, installed, 2);
    expect(awaiting.state).toBe('UPGRADING');
    expect(confirmUpgradeConnection(awaiting, 'attempt-1', '0.2.0', 3).state).toBe('SUCCEEDED');
    const connected = confirmUpgradeConnection(initial, 'attempt-1', '0.2.0', 2);
    expect(connected.state).toBe('WAITING_FOR_RUNS');
    expect(mergeUpgradeReport(connected, installed, 3).state).toBe('SUCCEEDED');
    expect(confirmUpgradeConnection(awaiting, 'wrong', '0.2.0', 3)).toBe(awaiting);
    expect(confirmUpgradeConnection(awaiting, 'attempt-1', '0.1.0', 3)).toBe(awaiting);
  });

  it('retains startup failure diagnostics if the same installed attempt later connects', () => {
    const failure = {
      code: 'START_FAILED',
      message: 'Process exited.',
      step: 'WAITING_FOR_ONLINE',
      kind: 'START'
    } as const;
    const failed = mergeUpgradeReport(
      initial,
      { attemptId: 'attempt-1', step: 'WAITING_FOR_ONLINE', result: 'FAILED', failure },
      2
    );
    expect(failed.state).toBe('FAILED');
    const recovered = confirmUpgradeConnection(failed, 'attempt-1', '0.2.0', 3);
    expect(recovered.state).toBe('SUCCEEDED');
    expect(recovered.failure).toEqual(failure);
    expect(
      mergeUpgradeReport(
        recovered,
        { attemptId: 'attempt-1', step: 'WAITING_FOR_ONLINE', result: 'FAILED', failure },
        4
      )
    ).toBe(recovered);
  });

  it('never rewrites an installation failure or moves progress backwards', () => {
    const failure = {
      code: 'INSTALL_FAILED',
      message: 'Install failed.',
      step: 'INSTALLING',
      kind: 'INSTALL'
    } as const;
    const failed = mergeUpgradeReport(
      initial,
      { attemptId: 'attempt-1', step: 'INSTALLING', result: 'FAILED', failure },
      2
    );
    expect(confirmUpgradeConnection(failed, 'attempt-1', '0.2.0', 3)).toBe(failed);
    expect(mergeUpgradeReport(failed, installed, 3)).toBe(failed);
    const active = mergeUpgradeReport(initial, { attemptId: 'attempt-1', step: 'INSTALLING' }, 2);
    expect(mergeUpgradeReport(active, { attemptId: 'attempt-1', step: 'CLOSING_NODE' }, 3)).toBe(
      active
    );
    expect(mergeUpgradeReport(active, { attemptId: 'other', step: 'INSTALLING' }, 3)).toBe(active);
    expect(mergeUpgradeReport(active, { attemptId: 'attempt-1', step: 'INSTALLING' }, 3)).toBe(
      active
    );
    expect(
      mergeUpgradeReport(active, { attemptId: 'attempt-1', step: 'INSTALLING', failure }, 3)
    ).toBe(active);
  });
});

describe('upgrade report authorization', () => {
  it('binds short-lived credentials to the current attempt and never projects their digest', async () => {
    let record: StoredNodeUpgrade | null = null;
    let now = 10;
    const store: NodeUpgradeProgressStore = {
      async updateNodeUpgrade<T>(
        _nodeId: string,
        update: (current: StoredNodeUpgrade | null) => { next: StoredNodeUpgrade | null; result: T }
      ): Promise<T> {
        const change = update(record);
        record = change.next;
        return change.result;
      }
    };
    const progress = new NodeUpgradeProgress(
      store,
      () => now,
      async () => true
    );
    const attempt = await progress.begin('node', '0.2.0', {
      userId: 1,
      sessionHash: 'session-hash'
    });
    expect(
      (await progress.begin('node', '0.2.0', { userId: 1, sessionHash: 'session-hash' })).attemptId
    ).toBe(attempt.attemptId);
    await expect(
      progress.begin('node', '0.3.0', { userId: 1, sessionHash: 'session-hash' })
    ).rejects.toThrow('NODE_UPGRADE_ALREADY_IN_PROGRESS');
    const token = await progress.issueReportCredential('node', attempt.attemptId);
    const report = { attemptId: attempt.attemptId, step: 'INSTALLING' } as const;
    await expect(progress.report('node', 'wrong', report)).rejects.toThrow(
      'NODE_UPGRADE_REPORT_UNAUTHORIZED'
    );
    const result = await progress.report('node', token, report);
    expect(result.state).toBe('UPGRADING');
    expect(result).not.toHaveProperty('reportCredentialHash');
    expect(result).not.toHaveProperty('reportCredentialExpiresAt');
    expect(progress.reportReceivedAt('node', attempt.attemptId)).toBe(now);
    now += 30 * 60_000;
    await expect(progress.report('node', token, report)).rejects.toThrow(
      'NODE_UPGRADE_REPORT_UNAUTHORIZED'
    );
  });

  it('does not admit a new attempt until a failed operation has ended', async () => {
    let record: StoredNodeUpgrade | null = null;
    const store: NodeUpgradeProgressStore = {
      async updateNodeUpgrade<T>(
        _nodeId: string,
        update: (current: StoredNodeUpgrade | null) => { next: StoredNodeUpgrade | null; result: T }
      ): Promise<T> {
        const change = update(record);
        record = change.next;
        return change.result;
      }
    };
    const progress = new NodeUpgradeProgress(
      store,
      () => 10,
      async () => true
    );
    const { attemptId } = await progress.begin('node', '0.2.0', {
      userId: 1,
      sessionHash: 'session-hash'
    });
    const token = await progress.issueReportCredential('node', attemptId);
    const failure = {
      code: 'INSTALL_FAILED',
      message: 'Install failed.',
      step: 'INSTALLING',
      kind: 'INSTALL'
    } as const;
    const report = { attemptId, step: 'INSTALLING', result: 'FAILED', failure } as const;
    await progress.report('node', token, report);
    await expect(
      progress.begin('node', '0.2.0', { userId: 1, sessionHash: 'session-hash' })
    ).rejects.toThrow('NODE_UPGRADE_ALREADY_IN_PROGRESS');
    await progress.report('node', token, { ...report, operationEnded: true });
    expect(
      (await progress.begin('node', '0.2.0', { userId: 1, sessionHash: 'session-hash' })).attemptId
    ).not.toBe(attemptId);
    await expect(progress.report('node', token, report)).rejects.toThrow(
      'NODE_UPGRADE_REPORT_UNAUTHORIZED'
    );
  });
});
