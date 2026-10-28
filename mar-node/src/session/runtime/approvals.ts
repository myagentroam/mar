import type { NodeAgentRun, NodeApproval } from '../../runtime-model.js';

export class RuntimeApprovals {
  private readonly approvals = new Map<string, NodeApproval>();
  constructor(
    private readonly getRun: (id: string) => NodeAgentRun | undefined,
    private readonly currentExecutionId: (id: string) => string | undefined,
    private readonly canonicalRunId: (id: string) => string,
    private readonly now: () => number
  ) {}
  createApproval(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly payload: unknown;
    readonly expiresAt: number;
  }): NodeApproval {
    const run = this.getRun(input.runId);
    if (run === undefined) throw new Error('RUN_NOT_FOUND');
    if (input.runId !== run.id && this.currentExecutionId(run.id) !== input.runId)
      throw new Error('RUN_EXECUTION_NOT_CURRENT');
    if (this.approvals.has(input.approvalId)) throw new Error('APPROVAL_ALREADY_EXISTS');
    if (input.expiresAt <= this.now()) throw new Error('APPROVAL_EXPIRED');
    const value: NodeApproval = {
      id: input.approvalId,
      runId: input.runId,
      status: 'PENDING',
      payload: input.payload,
      expiresAt: input.expiresAt,
      createdAt: this.now(),
      decidedAt: null
    };
    this.approvals.set(value.id, value);
    return value;
  }
  getApproval(id: string): NodeApproval | undefined {
    const value = this.approvals.get(id);
    if (value?.status === 'PENDING' && value.expiresAt <= this.now())
      return this.expireApproval(id);
    return value;
  }
  listApprovals(runId: string): readonly NodeApproval[] {
    const canonicalRunId = this.canonicalRunId(runId);
    return [...this.approvals.values()]
      .filter((value) => this.canonicalRunId(value.runId) === canonicalRunId)
      .map((value) => this.getApproval(value.id) as NodeApproval);
  }
  expireApproval(id: string): NodeApproval {
    const value = this.requireApproval(id);
    if (value.status !== 'PENDING') return value;
    if (value.expiresAt > this.now()) throw new Error('APPROVAL_NOT_EXPIRED');
    const next = { ...value, status: 'EXPIRED' as const, decidedAt: this.now() };
    this.approvals.set(id, next);
    return next;
  }
  decideApproval(id: string, decision: 'APPROVED' | 'REJECTED'): NodeApproval {
    const value = this.getApproval(id);
    if (value === undefined) throw new Error('APPROVAL_NOT_FOUND');
    if (value.status === 'EXPIRED') throw new Error('APPROVAL_EXPIRED');
    if (value.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
    const next = { ...value, status: decision, decidedAt: this.now() };
    this.approvals.set(id, next);
    return next;
  }
  expireDueApprovals(): readonly NodeApproval[] {
    return [...this.approvals.values()]
      .filter((value) => value.status === 'PENDING' && value.expiresAt <= this.now())
      .map((value) => this.expireApproval(value.id));
  }
  private requireApproval(id: string): NodeApproval {
    const value = this.approvals.get(id);
    if (value === undefined) throw new Error('APPROVAL_NOT_FOUND');
    return value;
  }
  removeRuns(runIds: ReadonlySet<string>, executionIds: ReadonlySet<string>): void {
    for (const [id, approval] of this.approvals)
      if (runIds.has(approval.runId) || executionIds.has(approval.runId)) this.approvals.delete(id);
  }
  removeRun(runId: string, executionIds: ReadonlySet<string>): void {
    for (const [id, approval] of this.approvals)
      if (runId === approval.runId || executionIds.has(approval.runId)) this.approvals.delete(id);
  }
}
