import { nodeLog } from '../operational.js';
import { isPlainRecord } from '../util/records.js';
import type { GitOperationService } from '../service/git-operation-service.js';
import type { PlannedRestartHandoff } from '../service/planned-restart-handoff.js';
import type { NodeUpgradeCoordinator } from '../service/node-upgrade-coordinator.js';

/** Owns operation admission and the in-flight work joined during shutdown. */
export class NodeOperationAdmission {
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly stopped: () => boolean,
    private readonly databaseAvailable: () => boolean,
    private readonly nodeId: () => string | undefined,
    private readonly restart: PlannedRestartHandoff,
    private readonly upgrade: NodeUpgradeCoordinator,
    private readonly git: GitOperationService,
    private readonly router: { execute(operation: string, data: unknown): Promise<unknown> }
  ) {}

  async execute(operation: string, data: unknown): Promise<unknown> {
    if (this.stopped()) throw new Error('NODE_STOPPED');
    const input = isPlainRecord(data) ? data : {};
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
    if (this.restart.blocksOperation(operation, input)) throw new Error('SESSION_RESTART_PENDING');
    if (!this.databaseAvailable()) throw new Error('NODE_DATABASE_UNAVAILABLE');
    if (this.upgrade.blocks(operation)) throw new Error('NODE_UPGRADE_PENDING');
    nodeLog('node.operation', { nodeId: this.nodeId(), operation });
    const task = this.git.execute(operation, data, (value) =>
      this.router.execute(operation, value)
    );
    this.inFlight.add(task);
    try {
      const result = await task;
      if (
        (operation === 'session.command.execute' || operation === 'session.message') &&
        sessionId !== undefined &&
        Number.isSafeInteger(input.__requestUserId)
      )
        this.restart.rememberUser(sessionId, input.__requestUserId as number);
      return result;
    } finally {
      this.inFlight.delete(task);
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}
