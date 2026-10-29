export interface NodeUpgradeProgress {
  readonly attemptId: string;
  readonly targetVersion: string;
  readonly state: 'WAITING_FOR_RUNS' | 'UPGRADING' | 'SUCCEEDED' | 'FAILED';
  readonly step?: 'CLOSING_NODE' | 'INSTALLING' | 'WAITING_FOR_ONLINE';
  readonly requestAccepted?: boolean;
  readonly activeRunCount?: number;
  readonly installed: boolean;
  readonly targetOnline: boolean;
  readonly operationEnded?: boolean;
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly step: string;
    readonly details?: string;
    readonly requestId?: string;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastReportReceivedAt?: number;
}

export function parseNodeUpgradeProgress(value: unknown): NodeUpgradeProgress | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value === undefined) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.attemptId !== 'string' ||
    typeof candidate.targetVersion !== 'string' ||
    !['WAITING_FOR_RUNS', 'UPGRADING', 'SUCCEEDED', 'FAILED'].includes(String(candidate.state)) ||
    typeof candidate.installed !== 'boolean' ||
    typeof candidate.targetOnline !== 'boolean' ||
    typeof candidate.createdAt !== 'number' ||
    typeof candidate.updatedAt !== 'number'
  )
    return undefined;
  return value as NodeUpgradeProgress;
}
