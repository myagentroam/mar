import type { RunnerDefaultConfiguration } from '@myagentroam/protocol';
import type { NodeAgentSession } from '../session/contracts.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import type { ExternalSessionActivationState } from '../session/contracts.js';

const RESUME_FAILURE_TTL_MS = 30 * 60_000;

interface ExternalSessionResumeServiceOptions {
  readonly resolveExecutionDirectory?: (session: NodeAgentSession) => Promise<string>;
  readonly runtime: NodeRuntimeState;
  readonly runners: RunnerRegistry;
  readonly available: (runner: NodeAgentSession['runner']) => boolean;
  readonly projectionFor: (session: NodeAgentSession) => NodeAgentSession | undefined;
  readonly managedAliasFor: (session: NodeAgentSession) => NodeAgentSession | undefined;
  readonly ensureConfiguration: (session: NodeAgentSession) => NodeAgentSession;
  readonly configuration: (session: NodeAgentSession) => RunnerDefaultConfiguration;
  readonly workspacePath: (workspaceId: string) => string | undefined;
  readonly rememberNative: (nativeSessionId: string, sessionId: string) => void;
  readonly resolve: (sessionId: string) => Promise<NodeAgentSession | undefined>;
}

export interface AcceptedMessageSession {
  readonly session: NodeAgentSession;
}

export class ExternalSessionResumeService {
  private readonly externalActivity = new Map<string, ExternalSessionActivationState>();
  private readonly resumedByDirectId = new Map<string, string>();
  private readonly resumeFailures = new Map<string, string>();
  private readonly messageResumeFailures = new Map<string, string>();
  private readonly resumeFailureDetails = new Map<string, string>();
  private readonly failureTimers = new Map<string, NodeJS.Timeout>();

  activity(sessionId: string): ExternalSessionActivationState | undefined {
    return this.externalActivity.get(sessionId);
  }

  private readonly transitions = new Set<string>();
  private readonly resumeTasks = new Map<string, Promise<NodeAgentSession | undefined>>();

  constructor(private readonly options: ExternalSessionResumeServiceOptions) {}

  async close(): Promise<void> {
    await Promise.allSettled([...this.resumeTasks.values()]);
    for (const timer of this.failureTimers.values()) clearTimeout(timer);
    this.failureTimers.clear();
    this.externalActivity.clear();
    this.resumedByDirectId.clear();
    this.resumeFailures.clear();
    this.messageResumeFailures.clear();
    this.resumeFailureDetails.clear();
  }

  setActivity(sessionId: string, activity: ExternalSessionActivationState): void {
    this.externalActivity.set(sessionId, activity);
  }

  forgetSessions(directIds: ReadonlySet<string>, projectionIds: ReadonlySet<string>): void {
    for (const directId of directIds) {
      this.externalActivity.delete(directId);
      this.resumedByDirectId.delete(directId);
      this.clearFailure(directId);
    }
    for (const [directId, resumedId] of this.resumedByDirectId)
      if (projectionIds.has(resumedId)) this.resumedByDirectId.delete(directId);
    for (const projectionId of projectionIds) this.externalActivity.delete(projectionId);
  }

  transitioning(sessionId: string): boolean {
    return this.transitions.has(sessionId);
  }

  async resume(external: NodeAgentSession): Promise<NodeAgentSession | undefined> {
    const existing = this.resumeTasks.get(external.id);
    if (existing !== undefined) return existing;
    const task = this.performResume(external);
    this.resumeTasks.set(external.id, task);
    try {
      return await task;
    } finally {
      if (this.resumeTasks.get(external.id) === task) this.resumeTasks.delete(external.id);
    }
  }

  private async performResume(external: NodeAgentSession): Promise<NodeAgentSession | undefined> {
    this.clearFailure(external.id);
    const priorId = this.resumedByDirectId.get(external.id);
    const prior = priorId === undefined ? undefined : this.options.runtime.getAgentSession(priorId);
    if (prior !== undefined) return this.options.ensureConfiguration(prior);
    const runner = this.options.runners.product(external.runner);
    if (runner === undefined) {
      this.externalActivity.set(external.id, 'IDLE');
      this.setFailure(external.id, 'RUNNER_UNAVAILABLE');
      return undefined;
    }
    const releaseMutation = this.options.runtime.beginSessionHistoryMutation(external.id, {
      allowQueued: true
    });
    this.transitions.add(external.id);
    let result;
    try {
      const cwd = this.options.resolveExecutionDirectory
        ? await this.options.resolveExecutionDirectory(external)
        : external.cwd;
      result = await runner.resumeExternal(
        { ...external, cwd },
        {
          available: this.options.available(external.runner),
          projectionFor: this.options.projectionFor,
          managedAliasFor: this.options.managedAliasFor,
          currentResumed: (sessionId) => {
            const resumedId = this.resumedByDirectId.get(sessionId);
            return resumedId === undefined
              ? undefined
              : this.options.runtime.getAgentSession(resumedId);
          },
          promote: (sessionId) => {
            this.options.runtime.setNativeControl(sessionId, 'MAR_MANAGED');
            return this.options.runtime.getAgentSession(sessionId);
          },
          ensureConfiguration: this.options.ensureConfiguration,
          create: (session) => {
            const configuration = this.options.configuration(session);
            return this.options.runtime.createAgentSession({
              workspaceId: session.workspaceId,
              runner: session.runner,
              ...(session.externalSessionId === null
                ? {}
                : { externalSessionId: session.externalSessionId }),
              nativeControl: 'MAR_MANAGED',
              cwd,
              createdAt: session.createdAt,
              lastActivityAt: session.lastActivityAt,
              model: configuration.model,
              effort: configuration.effort,
              access: configuration.access,
              ...(session.runnerTitle === null ? {} : { title: session.runnerTitle }),
              ...(session.customTitle === null ? {} : { customTitle: session.customTitle }),
              sessionPrompt: session.sessionPrompt ?? null,
              parentSessionId: session.parentSessionId ?? null
            });
          },
          workspacePath: this.options.workspacePath,
          rememberManagedNative: this.options.rememberNative
        }
      );
    } finally {
      this.transitions.delete(external.id);
      releaseMutation();
    }
    if (result.activity !== undefined) this.externalActivity.set(external.id, result.activity);
    else if (result.failureCode === 'RUNNER_UNAVAILABLE')
      this.externalActivity.set(external.id, 'IDLE');
    if (result.session !== undefined) {
      this.resumedByDirectId.set(external.id, result.session.id);
      return result.session;
    }
    this.setFailure(
      external.id,
      result.failureCode ?? 'SESSION_RESUME_REJECTED',
      result.failureDetail
    );
    this.messageResumeFailures.set(
      external.id,
      result.messageFailureCode ?? result.failureCode ?? 'SESSION_RESUME_REJECTED'
    );
    return undefined;
  }

  failure(sessionId: string): { readonly code: string; readonly detail?: string } {
    const code = this.resumeFailures.get(sessionId) ?? 'SESSION_RESUME_REJECTED';
    const detail = this.resumeFailureDetails.get(sessionId);
    return detail === undefined ? { code } : { code, detail };
  }

  async resolveForMessage(sessionId: string): Promise<NodeAgentSession> {
    const resumedId = this.resumedByDirectId.get(sessionId);
    const current =
      this.options.runtime.getAgentSession(resumedId ?? sessionId) ??
      (await this.options.resolve(sessionId));
    if (current === undefined) throw new Error('SESSION_NOT_FOUND');
    if (current.nativeControl !== 'EXTERNAL') return current;
    const resumed = await this.resume(current);
    if (resumed !== undefined) return resumed;
    if (this.externalActivity.get(current.id) === 'BUSY')
      throw new Error('EXTERNAL_SESSION_ACTIVE');
    throw new Error(this.messageResumeFailures.get(current.id) ?? this.failure(current.id).code);
  }

  async acceptForMessage(sessionId: string): Promise<AcceptedMessageSession> {
    return { session: await this.resolveForMessage(sessionId) };
  }

  private clearFailure(sessionId: string): void {
    const timer = this.failureTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.failureTimers.delete(sessionId);
    this.resumeFailures.delete(sessionId);
    this.resumeFailureDetails.delete(sessionId);
    this.messageResumeFailures.delete(sessionId);
  }

  private setFailure(sessionId: string, code: string, detail?: string): void {
    this.clearFailure(sessionId);
    this.resumeFailures.set(sessionId, code);
    if (detail === undefined) this.resumeFailureDetails.delete(sessionId);
    else this.resumeFailureDetails.set(sessionId, detail);
    const timer = setTimeout(() => this.clearFailure(sessionId), RESUME_FAILURE_TTL_MS);
    timer.unref();
    this.failureTimers.set(sessionId, timer);
  }
}
