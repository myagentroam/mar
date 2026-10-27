import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface LocalProcessSpawnRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly shell?: boolean | string;
  /** Shell startup for exec only; native processes and workers omit this field. */
  readonly shellLogin?: boolean;
  readonly environment: NodeJS.ProcessEnv;
  /** Explicit per-start values take precedence over execution-bound Host environment. */
  readonly environmentOverrides?: Readonly<Record<string, string | undefined>>;
  readonly environmentKeys?: readonly string[];
  /** Trusted, bounded read-only worker assets; never supplied by model tool input. */
  readonly runtimeDirectories?: readonly string[];
  readonly detached: boolean;
  readonly owner?: {
    readonly sessionId: string;
    readonly executionId?: string;
    readonly operationId?: string;
    readonly ownerInstanceId?: string;
  };
  readonly signal?: AbortSignal;
}

export interface LocalProcessExecutor {
  spawn(request: LocalProcessSpawnRequest): Promise<ChildProcessWithoutNullStreams>;
}
