import { FakeRunner, type FakeRunnerCallbacks, type FakeRunnerStep } from '../fake-runner.js';
import { AbstractRunner } from './abstract-runner.js';
import type { RunnerDefaultConfiguration, RunnerProfile } from '@myagentroam/protocol';
import type { NodeAgentSession } from '../session/contracts.js';
import type { ExternalResumeResult } from './contracts.js';

/** Registered only by tests; never contributes a production Runner Profile. */
export class FakeTestRunner extends AbstractRunner<'fake'> {
  readonly name = 'fake' as const;
  readonly discoveryScope = 'WORKSPACE_REQUIRED' as const;
  override readonly advertised = false;
  override readonly interceptsRuns = true;

  constructor(private readonly runner: FakeRunner) {
    super();
  }

  stop(): void {}

  profile(): undefined {
    return undefined;
  }

  available(): boolean {
    return false;
  }

  protected profileForValidation(): RunnerProfile {
    throw new Error('FAKE_RUNNER_NOT_ADVERTISED');
  }

  defaultConfiguration(): RunnerDefaultConfiguration {
    throw new Error('FAKE_RUNNER_NOT_ADVERTISED');
  }

  resumeExternal(): Promise<ExternalResumeResult> {
    return Promise.resolve({ failureCode: 'RUNNER_CAPABILITY_UNSUPPORTED' });
  }

  discoverSessions(): Promise<readonly NodeAgentSession[]> {
    return Promise.resolve([]);
  }

  readContextUsage(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  start(
    runId: string,
    script: readonly FakeRunnerStep[],
    callbacks: FakeRunnerCallbacks
  ): Promise<void> {
    return this.runner.start(runId, script, callbacks);
  }

  decide(runId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED'): boolean {
    return this.runner.decide(runId, approvalId, decision);
  }

  interrupt(runId: string): boolean {
    return this.runner.interrupt(runId);
  }

  cancel(runId: string): boolean {
    return this.runner.cancel(runId);
  }
}
