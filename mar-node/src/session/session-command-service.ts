import type { RunnerExecutionContext } from '../runner/execution-context.js';
import { modelUsageGrantSchema } from '@myagentroam/protocol';
import type { RunnerCommandDescriptor, RunnerProfile } from '@myagentroam/protocol';
import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import type { NodeAgentSession } from './contracts.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import { parseCommandInvocation } from '../runner-command-engine.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import { isPlainRecord } from '../util/records.js';
import type { NativeSessionProjectionService } from './native-session-projection-service.js';
import { parseSecretEnvironment } from '../mcp/secret-environment.js';
import { personalInstructionsForRunner } from '../runner/personal-instructions.js';

interface SessionCommandServiceOptions {
  readonly runtime: NodeRuntimeState;
  readonly runners: RunnerRegistry;
  readonly projection: NativeSessionProjectionService;
  readonly resolveForCommand: (sessionId: string) => Promise<NodeAgentSession>;
  readonly profiles: () => readonly RunnerProfile[];
  readonly mcps: (workspaceId: string) => readonly unknown[];
  readonly present: (session: NodeAgentSession) => unknown;
  readonly resumeQueueAfterCommandRun: (sessionId: string) => void;
  readonly invalidateHistory: (sessionId: string) => void;
  readonly invalidateWorkspaceSessions: (workspaceId: string) => void;
  readonly emitSession: (session: NodeAgentSession) => void;
  readonly goal: (input: {
    readonly session: NodeAgentSession;
    readonly objective: string;
    readonly initiatedByUserId?: number;
    readonly suppressNotifications?: boolean;
    readonly secretEnvironment: Readonly<Record<string, string>>;
    readonly personalInstructions?: string;
    readonly executionContext: RunnerExecutionContext;
    readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
  }) => Promise<unknown>;
  readonly beginGoal: (session: NodeAgentSession) => unknown;
  readonly clearGoal: (session: NodeAgentSession) => unknown;
}

export class SessionCommandService {
  constructor(private readonly options: SessionCommandServiceOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'runner.command.execute': (data) => this.runnerCommand(record(data)),
      'session.command.execute': (data) => this.sessionCommand(record(data))
    };
  }

  private runnerCommand(input: Record<string, unknown>): unknown {
    const runner = this.options.runners.product(input.runner);
    if (
      runner === undefined ||
      typeof input.commandId !== 'string' ||
      typeof input.input !== 'string'
    )
      throw new Error('RUNNER_COMMAND_INVALID');
    try {
      return runner.executeGlobalCommand(input.commandId, input.input);
    } catch (error) {
      if (error instanceof Error && error.message === 'RUNNER_COMMAND_INVALID') throw error;
      throw new Error('RUNNER_COMMAND_INVALID');
    }
  }

  private async sessionCommand(input: Record<string, unknown>): Promise<unknown> {
    if (
      typeof input.sessionId !== 'string' ||
      typeof input.commandId !== 'string' ||
      input.commandId.length === 0 ||
      typeof input.input !== 'string' ||
      input.input.length < 2 ||
      input.input.length > 20_000
    )
      throw new Error('RUNNER_COMMAND_INVALID');
    const resolved =
      this.options.runtime.getAgentSession(input.sessionId) ??
      (await this.options.projection.resolveCurrent(input.sessionId));
    if (
      resolved === undefined ||
      (input.workspaceId !== undefined && resolved.workspaceId !== input.workspaceId)
    )
      throw new Error('SESSION_NOT_FOUND');
    const command = this.options
      .profiles()
      .find((profile) => profile.runner === resolved.runner)
      ?.commands.find(
        (candidate) => isPlainRecord(candidate) && candidate.id === input.commandId
      ) as RunnerCommandDescriptor | undefined;
    if (resolved.nativeControl === 'EXTERNAL' && command?.source !== 'MAR_RUNTIME')
      throw new Error('SESSION_ACTIVATION_REQUIRED');
    if (command?.available !== true) throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    const session =
      resolved.nativeControl === 'EXTERNAL' && command.source === 'MAR_RUNTIME'
        ? await this.options.resolveForCommand(input.sessionId)
        : resolved;
    if (session.nativeControl === 'EXTERNAL') throw new Error('SESSION_ACTIVATION_REQUIRED');
    if (
      (command.interaction === 'IMMEDIATE_ACTION' ||
        command.interaction === 'DESTRUCTIVE_ACTION') &&
      this.options.runtime.hasActiveSessionLease(session.id)
    )
      throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    const invocation = parseCommandInvocation({ descriptor: command }, input.input);
    const secretEnvironment = parseSecretEnvironment(input.secretEnvironment);
    if (command.id === 'goal') {
      if (invocation.argument === '--clear') return this.options.clearGoal(session);
      if (invocation.argument.length === 0) return this.options.beginGoal(session);
      const instructions =
        typeof input.personalInstructions === 'string'
          ? input.personalInstructions
          : personalInstructionsForRunner(input.personalInstructions, session.runner);
      return this.options.goal({
        session,
        objective: invocation.argument,
        ...(input.__suppressNotifications === true ? { suppressNotifications: true } : {}),
        ...(input.__usageGrant === undefined
          ? {}
          : { usageGrant: modelUsageGrantSchema.parse(input.__usageGrant) }),
        ...(Number.isSafeInteger(input.__requestUserId)
          ? { initiatedByUserId: input.__requestUserId as number }
          : {}),
        secretEnvironment,
        ...(instructions === undefined ? {} : { personalInstructions: instructions }),
        executionContext: this.options.runners
          .require(session.runner)
          .prepareExecutionContext(input)
      });
    }
    const runner = this.options.runners.product(session.runner);
    if (runner === undefined) throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    if (command.interaction === 'DESTRUCTIVE_ACTION') {
      const releaseMutation = this.options.runtime.beginSessionHistoryMutation(session.id);
      try {
        const lastActivityAt = await runner.clearNative(session);
        const runtimeSession = this.options.runtime.getAgentSession(session.id);
        const cleared =
          runtimeSession === undefined
            ? { ...session, lastActivityAt }
            : this.options.runtime.resetAgentSessionHistory(runtimeSession.id, lastActivityAt);
        this.options.projection.remember([cleared]);
        this.options.invalidateHistory(cleared.id);
        this.options.invalidateWorkspaceSessions(cleared.workspaceId);
        this.options.emitSession(cleared);
        return {
          command: command.id,
          session: this.options.present(cleared)
        };
      } finally {
        releaseMutation();
      }
    }
    const result = await runner.executeCommand(session, command, invocation.input, {
      secretEnvironment,
      mcpInstallations: this.options.mcps(session.workspaceId),
      executionContext: runner.prepareExecutionContext(input),
      ...(Number.isSafeInteger(input.__requestUserId)
        ? { initiatedByUserId: input.__requestUserId as number }
        : {})
    });
    if (
      command.interaction === 'IMMEDIATE_ACTION' &&
      isPlainRecord(result) &&
      isPlainRecord(result.run)
    )
      this.options.resumeQueueAfterCommandRun(session.id);
    return {
      ...(isPlainRecord(result) ? result : { result }),
      session: this.options.present(session)
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
