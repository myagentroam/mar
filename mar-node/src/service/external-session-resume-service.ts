import type { RunnerDefaultConfiguration } from '@myagentroam/protocol';
import type { NodeAgentSession } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import type { ExternalSessionActivationState, SessionDomainState } from './session-domain-state.js';

const RESUME_FAILURE_TTL_MS = 30 * 60_000;

interface ExternalSessionResumeServiceOptions {
  readonly resolveExecutionDirectory?: (session: NodeAgentSession) => Promise<string>;
  readonly runtime: NodeRuntimeState;
  readonly runners: RunnerRegistry;
  readonly state: SessionDomainState<NodeAgentSession, unknown>;
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
  private readonly transitions = new Set<string>();
  private readonly resumeTasks = new Map<string, Promise<NodeAgentSession | undefined>>();

  constructor(private readonly options: ExternalSessionResumeServiceOptions) {}

  setActivity(sessionId: string, activity: ExternalSessionActivationState): void {
    this.options.state.externalActivity.set(sessionId, activity);
  }

  forgetSessions(directIds: ReadonlySet<string>, projectionIds: ReadonlySet<string>): void {
    for (const directId of directIds) {
      this.options.state.externalActivity.delete(directId);
      this.options.state.resumedByDirectId.delete(directId);
      this.clearFailure(directId);
    }
    for (const [directId, resumedId] of this.options.state.resumedByDirectId)
      if (projectionIds.has(resumedId)) this.options.state.resumedByDirectId.delete(directId);
    for (const projectionId of projectionIds)
      this.options.state.externalActivity.delete(projectionId);
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
    const priorId = this.options.state.resumedByDirectId.get(external.id);
    const prior = priorId === undefined ? undefined : this.options.runtime.getAgentSession(priorId);
    if (prior !== undefined) return this.options.ensureConfiguration(prior);
    const runner = this.options.runners.product(external.runner);
    if (runner === undefined) {
      this.options.state.externalActivity.set(external.id, 'IDLE');
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
            const resumedId = this.options.state.resumedByDirectId.get(sessionId);
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
    if (result.activity !== undefined)
      this.options.state.externalActivity.set(external.id, result.activity);
    else if (result.failureCode === 'RUNNER_UNAVAILABLE')
      this.options.state.externalActivity.set(external.id, 'IDLE');
    if (result.session !== undefined) {
      this.options.state.resumedByDirectId.set(external.id, result.session.id);
      return result.session;
    }
    this.setFailure(
      external.id,
      result.failureCode ?? 'SESSION_RESUME_REJECTED',
      result.failureDetail
    );
    this.options.state.messageResumeFailures.set(
      external.id,
      result.messageFailureCode ?? result.failureCode ?? 'SESSION_RESUME_REJECTED'
    );
    return undefined;
  }

  failure(sessionId: string): { readonly code: string; readonly detail?: string } {
    const code = this.options.state.resumeFailures.get(sessionId) ?? 'SESSION_RESUME_REJECTED';
    const detail = this.options.state.resumeFailureDetails.get(sessionId);
    return detail === undefined ? { code } : { code, detail };
  }

  async resolveForMessage(sessionId: string): Promise<NodeAgentSession> {
    const resumedId = this.options.state.resumedByDirectId.get(sessionId);
    const current =
      this.options.runtime.getAgentSession(resumedId ?? sessionId) ??
      (await this.options.resolve(sessionId));
    if (current === undefined) throw new Error('SESSION_NOT_FOUND');
    if (current.nativeControl !== 'EXTERNAL') return current;
    const resumed = await this.resume(current);
    if (resumed !== undefined) return resumed;
    if (this.options.state.externalActivity.get(current.id) === 'BUSY')
      throw new Error('EXTERNAL_SESSION_ACTIVE');
    throw new Error(
      this.options.state.messageResumeFailures.get(current.id) ?? this.failure(current.id).code
    );
  }

  async acceptForMessage(sessionId: string): Promise<AcceptedMessageSession> {
    return { session: await this.resolveForMessage(sessionId) };
  }

  private clearFailure(sessionId: string): void {
    const timer = this.options.state.failureTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.options.state.failureTimers.delete(sessionId);
    this.options.state.resumeFailures.delete(sessionId);
    this.options.state.resumeFailureDetails.delete(sessionId);
    this.options.state.messageResumeFailures.delete(sessionId);
  }

  private setFailure(sessionId: string, code: string, detail?: string): void {
    this.clearFailure(sessionId);
    this.options.state.resumeFailures.set(sessionId, code);
    if (detail === undefined) this.options.state.resumeFailureDetails.delete(sessionId);
    else this.options.state.resumeFailureDetails.set(sessionId, detail);
    const timer = setTimeout(() => this.clearFailure(sessionId), RESUME_FAILURE_TTL_MS);
    timer.unref();
    this.options.state.failureTimers.set(sessionId, timer);
  }
}
