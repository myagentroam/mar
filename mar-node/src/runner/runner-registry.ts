import {
  AbstractRunner,
  type RegisteredRunnerName,
  type RunnerApprovalDecision,
  type RunnerCancellationIntent
} from './abstract-runner.js';
import type {
  NodeCapabilities,
  NodeEnvelope,
  RunnerName,
  RunnerProfile
} from '@myagentroam/protocol';
import { nodeLog } from '../operational.js';

export class RunnerRegistry {
  private readonly runners = new Map<RegisteredRunnerName, AbstractRunner>();

  constructor(runners: readonly AbstractRunner[] = []) {
    for (const runner of runners) this.register(runner);
  }

  register<T extends AbstractRunner>(runner: T): T {
    if (this.runners.has(runner.name)) throw new Error(`RUNNER_ALREADY_REGISTERED:${runner.name}`);
    this.runners.set(runner.name, runner);
    return runner;
  }

  optional<T extends AbstractRunner>(name: RegisteredRunnerName): T | undefined {
    return this.runners.get(name) as T | undefined;
  }

  require<T extends AbstractRunner>(name: RegisteredRunnerName): T {
    const runner = this.optional<T>(name);
    if (runner === undefined) throw new Error(`RUNNER_NOT_REGISTERED:${name}`);
    return runner;
  }

  advertised(): readonly AbstractRunner[] {
    return [...this.runners.values()].filter((runner) => runner.advertised);
  }

  product(name: unknown): AbstractRunner<RunnerName> | undefined {
    if (typeof name !== 'string') return undefined;
    const runner = this.runners.get(name as RegisteredRunnerName);
    return runner?.advertised === true ? (runner as AbstractRunner<RunnerName>) : undefined;
  }

  profiles(
    capabilities: NodeCapabilities,
    environment: Readonly<Record<string, string>> = {}
  ): readonly RunnerProfile[] {
    return this.advertised().flatMap((runner) => {
      const profile = runner.cachedProfile(capabilities, environment);
      return profile === undefined ? [] : [profile];
    });
  }

  async refreshProfiles(
    capabilities: NodeCapabilities,
    workspace?: import('../database.js').NodeWorkspace,
    environment: Readonly<Record<string, string>> = {},
    waitForRefresh = false
  ): Promise<readonly RunnerProfile[]> {
    const profiles = await Promise.all(
      this.advertised().map(async (runner) => {
        const startedAt = performance.now();
        try {
          return await runner.refreshProfile(capabilities, workspace, environment, waitForRefresh);
        } catch (error) {
          nodeLog('runner.profile.refresh.failed', {
            runner: runner.name,
            workspaceId: workspace?.id,
            error: error instanceof Error ? error.message : String(error)
          });
          return runner.cachedProfile(capabilities, environment);
        } finally {
          const durationMs = Math.round(performance.now() - startedAt);
          if (durationMs >= 100)
            nodeLog('runner.profile.refresh.completed', {
              runner: runner.name,
              workspaceId: workspace?.id,
              durationMs
            });
        }
      })
    );
    return profiles.flatMap((profile) => (profile === undefined ? [] : [profile]));
  }

  startManagedRun(envelope: NodeEnvelope): boolean {
    const runnerName = (envelope.payload as { runner?: unknown }).runner;
    const values = [...this.runners.values()];
    const runner =
      values.find((candidate) => candidate.interceptsRuns && candidate.acceptsRun(runnerName)) ??
      values.find((candidate) => candidate.acceptsRun(runnerName));
    if (runner === undefined) return false;
    runner.startManagedRun(envelope);
    return true;
  }

  cancelManagedRun(runId: string, intent: RunnerCancellationIntent): boolean {
    for (const runner of this.runners.values())
      if (runner.cancelManagedRun(runId, intent)) return true;
    return false;
  }

  migrateSessionIdentity(previousId: string, nativeSessionId: string): void {
    for (const runner of this.runners.values())
      runner.migrateSessionIdentity(previousId, nativeSessionId);
  }

  decideApproval(input: RunnerApprovalDecision): boolean {
    let handled = false;
    for (const runner of this.runners.values()) handled = runner.decideApproval(input) || handled;
    return handled;
  }

  respondUserInput(runId: string, requestId: string, answers: Record<string, unknown>): boolean {
    for (const runner of this.runners.values())
      if (runner.respondUserInput(runId, requestId, answers)) return true;
    return false;
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.runners.values()].map((runner) => runner.stop()));
  }
}
