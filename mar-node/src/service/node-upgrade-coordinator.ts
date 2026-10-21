import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { NodeUpgradeStatus } from '@myagentroam/protocol';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export class NodeUpgradeCoordinator {
  private status: NodeUpgradeStatus = { state: 'IDLE', updatedAt: Date.now() };
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly requestPath: () => string,
    private readonly activeRunCount: () => number,
    private readonly onStatus: (status: NodeUpgradeStatus) => void,
    private readonly onReady: () => void,
    private readonly now: () => number = Date.now
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
    const targetVersion = record(data).targetVersion;
    if (typeof targetVersion !== 'string' || !STABLE_VERSION.test(targetVersion))
      throw new Error('NODE_UPGRADE_VERSION_INVALID');
    if (this.status.state !== 'IDLE' && this.status.state !== 'FAILED') {
      if (this.status.targetVersion !== targetVersion)
        throw new Error('NODE_UPGRADE_ALREADY_PENDING');
      return { status: 'ALREADY_PENDING', targetVersion, activeRunCount: this.activeRunCount() };
    }
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
    this.update({ state: 'IDLE', updatedAt: this.now() });
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
      `${JSON.stringify({ schemaVersion: 1, targetVersion, createdAt: this.now() })}\n`,
      { mode: 0o600 }
    );
    await rename(temporary, path).catch(async (error) => {
      await rm(temporary, { force: true });
      throw error;
    });
    this.onReady();
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
    this.status = status;
    this.onStatus(status);
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
