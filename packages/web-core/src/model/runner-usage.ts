export type RunnerUsageName = 'codex' | 'claude-code';

export interface RunnerUsageStatus {
  readonly runner: RunnerUsageName;
  readonly available: boolean;
  readonly reasonCode: string | null;
}

export interface RunnerUsageWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercentage: number;
  readonly resetsAt: number | null;
}

export interface RunnerUsage {
  readonly runner: RunnerUsageName;
  readonly windows: readonly RunnerUsageWindow[];
  readonly fetchedAt: number;
  readonly cached: boolean;
}
