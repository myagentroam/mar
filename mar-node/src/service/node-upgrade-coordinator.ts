import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { NodeCapabilities, NodeUpgradeStatus } from '@myagentroam/protocol';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export class NodeUpgradeCoordinator {
  private status: NodeUpgradeStatus = { state: 'IDLE', updatedAt: Date.now() };
  private timer: NodeJS.Timeout | undefined;
  private attemptId: string | undefined;

  constructor(
    private readonly requestPath: () => string,
    private readonly activeRunCount: () => number,
    private readonly onStatus: (status: NodeUpgradeStatus) => void,
    private readonly onReady: () => void,
    private readonly now: () => number = Date.now,
    private readonly prepareHandoff?: (attemptId: string, targetVersion: string) => Promise<void>
  ) {}

  snapshot(): NodeUpgradeStatus {
    return this.status;
  }

  async loadResult(resultPath: string): Promise<void> {
    try {
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>;
      if (result['state'] === 'FAILED' && typeof result['errorCode'] === 'string')
        this.update({
          state: 'FAILED',
          errorCode: result['errorCode'],
          updatedAt: typeof result['updatedAt'] === 'number' ? result['updatedAt'] : this.now()
        });
    } catch {
      // Missing or malformed historical result does not prevent Node startup.
    }
  }

  request(data: unknown): {
    status: 'ACCEPTED' | 'ALREADY_PENDING';
    targetVersion: string;
    activeRunCount: number;
  } {
    const input = record(data);
    const targetVersion = input.targetVersion;
    if (typeof targetVersion !== 'string' || !STABLE_VERSION.test(targetVersion))
      throw new Error('NODE_UPGRADE_VERSION_INVALID');
    const attemptId = input.attemptId;
    if (
      attemptId !== undefined &&
      (typeof attemptId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          attemptId
        ) ||
        this.prepareHandoff === undefined)
    )
      throw new Error('NODE_UPGRADE_REQUEST_INVALID');
    if (this.status.state !== 'IDLE' && this.status.state !== 'FAILED') {
      if (this.status.targetVersion !== targetVersion || this.attemptId !== attemptId)
        throw new Error('NODE_UPGRADE_ALREADY_PENDING');
      return { status: 'ALREADY_PENDING', targetVersion, activeRunCount: this.activeRunCount() };
    }
    this.attemptId = attemptId as string | undefined;
    this.update({
      state: 'WAITING_FOR_RUNS',
      targetVersion,
      activeRunCount: this.activeRunCount(),
      updatedAt: this.now()
    });
    this.timer = setInterval(() => void this.checkReadySafely(), 250);
    void this.checkReadySafely();
    return { status: 'ACCEPTED', targetVersion, activeRunCount: this.activeRunCount() };
  }

  cancel(): { cancelled: true } {
    if (this.status.state !== 'WAITING_FOR_RUNS') throw new Error('NODE_UPGRADE_NOT_CANCELLABLE');
    this.clearTimer();
    const attemptId = this.attemptId;
    this.attemptId = undefined;
    this.update({
      state: 'IDLE',
      ...(attemptId === undefined ? {} : { attemptId }),
      updatedAt: this.now()
    });
    return { cancelled: true };
  }

  blocks(operation: string): boolean {
    return (
      this.pending() &&
      (operation === 'session.start' ||
        operation === 'session.message' ||
        operation === 'session.command.execute' ||
        operation === 'runner.command.execute' ||
        operation === 'session.channel.message' ||
        operation === 'workspace.queue.message.execute' ||
        operation === 'terminal.open')
    );
  }

  pending(): boolean {
    return this.status.state === 'WAITING_FOR_RUNS' || this.status.state === 'READY_TO_RESTART';
  }

  stop(): void {
    this.clearTimer();
  }

  private async checkReady(): Promise<void> {
    if (this.status.state !== 'WAITING_FOR_RUNS') return;
    const activeRunCount = this.activeRunCount();
    if (activeRunCount > 0) {
      if (this.status.activeRunCount !== activeRunCount)
        this.update({ ...this.status, activeRunCount, updatedAt: this.now() });
      return;
    }
    this.clearTimer();
    const targetVersion = this.status.targetVersion!;
    this.update({
      state: 'READY_TO_RESTART',
      targetVersion,
      activeRunCount: 0,
      updatedAt: this.now()
    });
    const path = this.requestPath();
    const temporary = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      `${JSON.stringify({
        schemaVersion: 1,
        targetVersion,
        createdAt: this.now(),
        ...(this.attemptId === undefined ? {} : { attemptId: this.attemptId })
      })}\n`,
      { mode: 0o600 }
    );
    await rename(temporary, path).catch(async (error) => {
      await rm(temporary, { force: true });
      throw error;
    });
    try {
      if (this.attemptId !== undefined) await this.prepareHandoff!(this.attemptId, targetVersion);
      this.onReady();
    } catch (error) {
      if (error instanceof Error && error.message === 'NODE_UPGRADE_HANDOFF_UNCERTAIN') {
        this.update({
          state: 'READY_TO_RESTART',
          targetVersion,
          activeRunCount: 0,
          errorCode: 'NODE_UPGRADE_HANDOFF_UNCERTAIN',
          updatedAt: this.now()
        });
        return;
      }
      await rm(path, { force: true });
      this.update({
        state: 'FAILED',
        targetVersion,
        errorCode:
          error instanceof Error && /^NODE_UPGRADE_[A-Z_]+$/u.test(error.message)
            ? error.message
            : 'NODE_UPGRADE_HANDOFF_UNAVAILABLE',
        updatedAt: this.now()
      });
    }
  }

  private async checkReadySafely(): Promise<void> {
    try {
      await this.checkReady();
    } catch {
      this.clearTimer();
      this.update({
        state: 'FAILED',
        targetVersion: this.status.targetVersion,
        errorCode: 'NODE_UPGRADE_REQUEST_WRITE_FAILED',
        updatedAt: this.now()
      });
    }
  }

  private update(status: NodeUpgradeStatus): void {
    this.status =
      status.state !== 'IDLE' && this.attemptId !== undefined
        ? { ...status, attemptId: this.attemptId }
        : status;
    this.onStatus(this.status);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function nodeUpgradeRequestPath(databasePath: string): string {
  return resolve(dirname(databasePath), 'upgrade-request.json');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('NODE_UPGRADE_REQUEST_INVALID');
  return value as Record<string, unknown>;
}

export function upgradeMetadata(
  metadata: NodeCapabilities['metadata'],
  status: ReturnType<NodeUpgradeCoordinator['snapshot']>,
  progressAvailable: boolean
): NonNullable<NodeCapabilities['metadata']> {
  const next = { ...(metadata ?? {}) };
  if (process.env['MAR_NODE_SUPERVISED'] === '1') next.supervisedUpgrade = true;
  else delete next.supervisedUpgrade;
  if (progressAvailable) next.upgradeProgress = { apiVersion: 1 };
  else delete next.upgradeProgress;
  const attemptId = process.env['MAR_NODE_UPGRADE_ATTEMPT_ID'];
  if (progressAvailable && attemptId && /^[0-9a-f-]{36}$/iu.test(attemptId))
    next.upgradeAttemptId = attemptId;
  else delete next.upgradeAttemptId;
  if (status.state === 'IDLE' && status.attemptId === undefined) delete next.upgrade;
  else next.upgrade = status;
  return next;
}
