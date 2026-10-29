import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { publicErrorMessage } from '@myagentroam/protocol';

export type NodeUpgradeStep = 'CLOSING_NODE' | 'INSTALLING' | 'WAITING_FOR_ONLINE';
export type NodeUpgradeFailure = {
  readonly code: string;
  readonly message: string;
  readonly details?: string;
  readonly requestId?: string;
  readonly step: NodeUpgradeStep;
  readonly kind: 'INSTALL' | 'START';
};

export interface NodeUpgradeSnapshot {
  readonly attemptId: string;
  readonly targetVersion: string;
  readonly state: 'WAITING_FOR_RUNS' | 'UPGRADING' | 'SUCCEEDED' | 'FAILED';
  readonly step?: NodeUpgradeStep;
  readonly installed: boolean;
  readonly targetOnline: boolean;
  readonly requestAccepted?: boolean;
  readonly activeRunCount?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastReportReceivedAt?: number;
  readonly failure?: NodeUpgradeFailure;
  readonly operationEnded?: boolean;
}

/** Internal storage only; never include the credential digest in public projections. */
export interface StoredNodeUpgrade extends NodeUpgradeSnapshot {
  readonly reportCredentialHash?: string;
  readonly reportCredentialExpiresAt?: number;
  readonly requesterUserId: number;
  readonly requesterSessionHash: string;
}

export interface NodeUpgradeReport {
  readonly attemptId: string;
  readonly step: NodeUpgradeStep;
  readonly result?: 'INSTALLED' | 'FAILED';
  readonly failure?: NodeUpgradeFailure;
  readonly operationEnded?: boolean;
}

export interface NodeUpgradeProgressStore {
  updateNodeUpgrade<T>(
    nodeId: string,
    update: (current: StoredNodeUpgrade | null) => {
      readonly next: StoredNodeUpgrade | null;
      readonly result: T;
    }
  ): Promise<T>;
}

/** The sole owner of upgrade facts and the narrow, per-attempt report credential. */
export class NodeUpgradeProgress {
  private readonly lastReport = new Map<string, { attemptId: string; receivedAt: number }>();

  constructor(
    private readonly store: NodeUpgradeProgressStore,
    private readonly now = Date.now,
    private readonly authorize: (
      nodeId: string,
      userId: number,
      sessionHash: string
    ) => Promise<boolean> = async () => false,
    private readonly onChange: (
      nodeId: string,
      snapshot: NodeUpgradeSnapshot | null
    ) => void = () => undefined
  ) {}

  async begin(
    nodeId: string,
    targetVersion: string,
    requester: { readonly userId: number; readonly sessionHash: string }
  ): Promise<{ attemptId: string; existing: boolean }> {
    const result = await this.store.updateNodeUpgrade<{ attemptId: string; existing: boolean }>(
      nodeId,
      (current) => {
        if (
          current !== null &&
          (current.state === 'WAITING_FOR_RUNS' || current.state === 'UPGRADING')
        ) {
          if (current.targetVersion !== targetVersion)
            throw new Error('NODE_UPGRADE_ALREADY_IN_PROGRESS');
          return { next: current, result: { attemptId: current.attemptId, existing: true } };
        }
        if (current?.state === 'FAILED' && current.operationEnded !== true)
          throw new Error('NODE_UPGRADE_ALREADY_IN_PROGRESS');
        const timestamp = this.now();
        const next: StoredNodeUpgrade = {
          attemptId: randomUUID(),
          targetVersion,
          state: 'WAITING_FOR_RUNS',
          installed: false,
          targetOnline: false,
          requesterUserId: requester.userId,
          requesterSessionHash: requester.sessionHash,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        return { next, result: { attemptId: next.attemptId, existing: false } };
      }
    );
    if (!result.existing) {
      this.lastReport.delete(nodeId);
      this.onChange(nodeId, await this.snapshot(nodeId));
    }
    return result;
  }

  async issueReportCredential(nodeId: string, attemptId: string): Promise<string> {
    const requester = await this.store.updateNodeUpgrade(nodeId, (current) => ({
      next: current,
      result:
        current?.attemptId === attemptId && current.state === 'WAITING_FOR_RUNS'
          ? { userId: current.requesterUserId, sessionHash: current.requesterSessionHash }
          : undefined
    }));
    if (
      requester === undefined ||
      !(await this.authorize(nodeId, requester.userId, requester.sessionHash))
    )
      throw new Error('NODE_UPGRADE_AUTHORIZATION_EXPIRED');
    const token = randomBytes(32).toString('base64url');
    return this.store.updateNodeUpgrade(nodeId, (current) => {
      if (
        current === null ||
        current.attemptId !== attemptId ||
        current.requesterUserId !== requester.userId ||
        current.requesterSessionHash !== requester.sessionHash ||
        current.state !== 'WAITING_FOR_RUNS'
      )
        throw new Error('NODE_UPGRADE_ATTEMPT_INVALID');
      if (current.reportCredentialHash !== undefined)
        throw new Error('NODE_UPGRADE_CREDENTIAL_ALREADY_ISSUED');
      return {
        next: {
          ...current,
          reportCredentialHash: tokenDigest(token),
          reportCredentialExpiresAt: this.now() + 30 * 60_000
        },
        result: token
      };
    });
  }

  async report(
    nodeId: string,
    token: string,
    report: NodeUpgradeReport
  ): Promise<NodeUpgradeSnapshot> {
    const result = await this.store.updateNodeUpgrade(nodeId, (current) => {
      if (
        current === null ||
        current.attemptId !== report.attemptId ||
        current.reportCredentialHash === undefined ||
        current.reportCredentialExpiresAt === undefined ||
        current.reportCredentialExpiresAt <= this.now() ||
        !equalDigest(current.reportCredentialHash, tokenDigest(token))
      )
        throw new Error('NODE_UPGRADE_REPORT_UNAUTHORIZED');
      const merged = mergeUpgradeReport(current, report, this.now());
      const next =
        merged === current && current.requestAccepted === true
          ? current
          : { ...current, ...merged, requestAccepted: true };
      return { next, result: publicUpgradeSnapshot(next) };
    });
    this.lastReport.set(nodeId, { attemptId: report.attemptId, receivedAt: this.now() });
    this.onChange(nodeId, { ...result, lastReportReceivedAt: this.now() });
    return result;
  }

  async confirmConnection(nodeId: string, attemptId: string, version: string): Promise<void> {
    await this.store.updateNodeUpgrade(nodeId, (current) => {
      if (current === null) return { next: null, result: undefined };
      const merged = confirmUpgradeConnection(current, attemptId, version, this.now());
      return { next: merged === current ? current : { ...current, ...merged }, result: undefined };
    });
    this.onChange(nodeId, await this.snapshot(nodeId));
  }

  async markAccepted(nodeId: string, attemptId: string, activeRunCount?: number): Promise<void> {
    await this.store.updateNodeUpgrade(nodeId, (current) => {
      if (
        current === null ||
        current.attemptId !== attemptId ||
        (current.requestAccepted === true &&
          (activeRunCount === undefined || current.activeRunCount === activeRunCount))
      )
        return { next: current, result: undefined };
      return {
        next: {
          ...current,
          requestAccepted: true,
          updatedAt: this.now(),
          ...(activeRunCount === undefined ? {} : { activeRunCount })
        },
        result: undefined
      };
    });
    this.onChange(nodeId, await this.snapshot(nodeId));
  }

  async failBeforeHandoff(nodeId: string, attemptId: string, code: string): Promise<void> {
    await this.store.updateNodeUpgrade(nodeId, (current) => {
      if (
        current === null ||
        current.attemptId !== attemptId ||
        current.state !== 'WAITING_FOR_RUNS'
      )
        return { next: current, result: undefined };
      return {
        next: {
          ...current,
          state: 'FAILED',
          operationEnded: true,
          updatedAt: this.now(),
          failure: {
            code,
            message: code.startsWith('NODE_UPGRADE_CREDENTIAL_')
              ? 'The Node could not obtain upgrade reporting authorization.'
              : code.startsWith('NODE_UPGRADE_HANDOFF_')
                ? 'The Node could not hand off the upgrade to its Supervisor.'
                : publicErrorMessage(code),
            step: 'CLOSING_NODE',
            kind: 'INSTALL'
          }
        },
        result: undefined
      };
    });
    this.onChange(nodeId, await this.snapshot(nodeId));
  }

  async cancel(nodeId: string, attemptId: string): Promise<void> {
    await this.store.updateNodeUpgrade(nodeId, (current) => {
      if (current?.state !== 'WAITING_FOR_RUNS' || current.attemptId !== attemptId)
        return { next: current, result: undefined };
      return { next: null, result: undefined };
    });
    this.onChange(nodeId, await this.snapshot(nodeId));
  }

  async snapshot(nodeId: string): Promise<NodeUpgradeSnapshot | null> {
    return this.store.updateNodeUpgrade(nodeId, (current) => ({
      next: current,
      result:
        current === null
          ? null
          : {
              ...publicUpgradeSnapshot(current),
              ...(this.reportReceivedAt(nodeId, current.attemptId) === undefined
                ? {}
                : { lastReportReceivedAt: this.reportReceivedAt(nodeId, current.attemptId)! })
            }
    }));
  }

  reportReceivedAt(nodeId: string, attemptId: string): number | undefined {
    const last = this.lastReport.get(nodeId);
    return last?.attemptId === attemptId ? last.receivedAt : undefined;
  }
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicUpgradeSnapshot(record: StoredNodeUpgrade): NodeUpgradeSnapshot {
  const {
    reportCredentialHash: _hash,
    reportCredentialExpiresAt: _expires,
    requesterUserId: _userId,
    requesterSessionHash: _sessionHash,
    ...snapshot
  } = record;
  return snapshot;
}

const steps: readonly NodeUpgradeStep[] = ['CLOSING_NODE', 'INSTALLING', 'WAITING_FOR_ONLINE'];

/** Merge only facts from the current attempt; a repeat does not rewrite the snapshot. */
export function mergeUpgradeReport(
  snapshot: NodeUpgradeSnapshot,
  report: NodeUpgradeReport,
  now: number
): NodeUpgradeSnapshot {
  if (snapshot.attemptId !== report.attemptId || snapshot.state === 'SUCCEEDED') return snapshot;
  if (snapshot.state === 'FAILED') {
    if (
      report.result === 'FAILED' &&
      report.operationEnded === true &&
      snapshot.operationEnded !== true &&
      report.step === snapshot.step &&
      report.failure?.code === snapshot.failure?.code &&
      report.failure?.kind === snapshot.failure?.kind
    )
      return { ...snapshot, operationEnded: true, updatedAt: now };
    return snapshot;
  }
  if (snapshot.step !== undefined && steps.indexOf(report.step) < steps.indexOf(snapshot.step))
    return snapshot;
  if (report.result === 'FAILED' && report.failure === undefined) return snapshot;
  if (report.result !== 'FAILED' && report.failure !== undefined) return snapshot;
  if (report.result === 'INSTALLED' && report.step !== 'WAITING_FOR_ONLINE') return snapshot;
  if (report.result === 'FAILED' && report.failure?.step !== report.step) return snapshot;
  if (report.failure?.kind === 'START' && report.step !== 'WAITING_FOR_ONLINE') return snapshot;
  if (snapshot.installed && report.failure?.kind === 'INSTALL') return snapshot;
  const installed =
    snapshot.installed || report.result === 'INSTALLED' || report.failure?.kind === 'START';
  const state =
    installed && snapshot.targetOnline
      ? 'SUCCEEDED'
      : report.result === 'FAILED'
        ? 'FAILED'
        : 'UPGRADING';
  if (
    snapshot.state === state &&
    snapshot.step === report.step &&
    snapshot.installed === installed &&
    report.result !== 'FAILED'
  )
    return snapshot;
  return {
    ...snapshot,
    state,
    step: report.step,
    installed,
    updatedAt: now,
    ...(report.operationEnded === true && report.result === 'FAILED'
      ? { operationEnded: true }
      : {}),
    ...(report.failure === undefined ? {} : { failure: report.failure })
  };
}

/** Authentication and the actual connected version must be checked by the caller. */
export function confirmUpgradeConnection(
  snapshot: NodeUpgradeSnapshot,
  attemptId: string,
  version: string,
  now: number
): NodeUpgradeSnapshot {
  if (
    snapshot.attemptId !== attemptId ||
    snapshot.targetVersion !== version ||
    snapshot.state === 'SUCCEEDED' ||
    (snapshot.state === 'FAILED' && snapshot.failure?.kind !== 'START')
  )
    return snapshot;
  if (snapshot.targetOnline) return snapshot;
  return {
    ...snapshot,
    targetOnline: true,
    state: snapshot.installed ? 'SUCCEEDED' : snapshot.state,
    updatedAt: now
  };
}
