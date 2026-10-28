import type { RunnerDefaultConfiguration } from '@myagentroam/protocol';
import { RUNNER_EXECUTION_CONTEXT } from '../runner/execution-context.js';
import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import type { NodeAgentSession } from './contracts.js';
import type { NodeDatabase } from '../database.js';
import type { NodeAgentRun } from '../runtime-model.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import { validSessionEffort, validSessionOption, validSessionTitle } from './input-validation.js';
import { parseMessageAttachments } from './attachments.js';
import { isPlainRecord } from '../util/records.js';
import { parseSecretEnvironment } from '../mcp/secret-environment.js';
import type { NativeSessionProjectionService } from './native-session-projection-service.js';
import type { SessionIdentityService } from './session-identity-service.js';
import { ScheduledSessionStore } from '../service/scheduled-session-store.js';
import { normalizeSessionPrompt } from '../runner/personal-instructions.js';
import { resolveWorkspaceExecutionDirectory } from '../workspace/path-access.js';

interface SessionLifecycleServiceOptions {
  readonly database: () => NodeDatabase;
  readonly runtime: NodeRuntimeState;
  readonly runners: RunnerRegistry;
  readonly projection: NativeSessionProjectionService;
  readonly identity: SessionIdentityService;
  readonly present: (session: NodeAgentSession) => unknown;
  readonly emitSession: (session: NodeAgentSession) => void;
  readonly parentCleared?: (session: NodeAgentSession) => void;
  readonly invalidateWorkspaceSessions: (workspaceId: string) => void;
  readonly execute: (operation: string, data: Record<string, unknown>) => Promise<unknown>;
  readonly interceptedSessionId: (clientMessageId: string) => string | undefined;
}

export class SessionLifecycleService {
  private readonly starts = new Map<string, Promise<unknown>>();

  constructor(private readonly options: SessionLifecycleServiceOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'session.metadata.update': (data) => this.updateMetadata(record(data)),
      'session.pin.move': (data) => this.movePin(record(data)),
      'session.create': (data) => this.create(record(data)),
      'session.start': (data) => this.start(record(data)),
      'session.config.update': (data) => this.updateConfiguration(record(data))
    };
  }

  clear(): void {
    this.starts.clear();
  }

  private async updateMetadata(input: Record<string, unknown>): Promise<unknown> {
    if (
      input.parentSessionId !== undefined ||
      (input.clearParent !== undefined &&
        (input.clearParent !== true ||
          input.customTitle !== undefined ||
          input.pinned !== undefined ||
          input.sessionPrompt !== undefined))
    )
      throw new Error('SESSION_INVALID');
    const sessionPrompt =
      input.sessionPrompt === undefined ? undefined : normalizeSessionPrompt(input.sessionPrompt);
    if (
      typeof input.sessionId !== 'string' ||
      (input.customTitle !== undefined &&
        input.customTitle !== null &&
        typeof input.customTitle !== 'string') ||
      (input.pinned !== undefined && typeof input.pinned !== 'boolean')
    )
      throw new Error('SESSION_INVALID');
    if (input.customTitle === null || input.customTitle?.trim().length === 0)
      throw new Error('SESSION_TITLE_REQUIRED');
    if (input.customTitle !== undefined && input.customTitle.trim().length > 160)
      throw new Error('SESSION_TITLE_INVALID');
    const current =
      this.options.runtime.getAgentSession(input.sessionId) ??
      (await this.options.projection.createMetadataProjection(input.sessionId));
    if (current === undefined) throw new Error('SESSION_NOT_FOUND');
    if (input.clearParent === true) {
      if (current.externalSessionId === null) throw new Error('SESSION_ACTIVATION_REQUIRED');
      const metadata = this.options
        .database()
        .getNativeSessionMetadata(current.runner, current.externalSessionId, current.workspaceId);
      const parentSessionId =
        metadata === undefined ? current.parentSessionId : metadata.parentSessionId;
      if (parentSessionId == null) {
        const next =
          current.parentSessionId == null
            ? current
            : this.options.runtime.clearSessionParent(current.id);
        return { session: this.options.present(next) };
      }
      this.options
        .database()
        .clearSessionParent(current.runner, current.externalSessionId, current.workspaceId);
      const next = this.options.runtime.clearSessionParent(current.id);
      this.options.parentCleared?.(next);
      this.options.emitSession(next);
      return { session: this.options.present(next) };
    }
    if (sessionPrompt !== undefined && current.externalSessionId === null)
      throw new Error('SESSION_ACTIVATION_REQUIRED');
    if (input.pinned === false) {
      const task = new ScheduledSessionStore(this.options.database().raw).get(
        current.externalSessionId ?? current.id
      );
      if (task?.enabled === true) throw new Error('SCHEDULE_PIN_REQUIRED');
    }
    const nativeCodexRename =
      this.options.runners.require(current.runner).usesRunnerTitleForRename() &&
      current.externalSessionId !== null &&
      input.customTitle !== undefined;
    if (input.customTitle !== undefined || input.pinned !== undefined)
      await this.options.projection.rename(current, {
        ...(input.customTitle === undefined ? {} : { title: input.customTitle as string }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned as boolean })
      });
    if (sessionPrompt !== undefined && current.externalSessionId !== null)
      this.options.database().saveNativeSessionMetadata({
        runner: current.runner,
        externalSessionId: current.externalSessionId,
        workspaceId: current.workspaceId,
        sessionPrompt
      });
    const metadataTitle = nativeCodexRename ? null : input.customTitle;
    const updated = this.options.runtime.updateSessionMetadata({
      sessionId: current.id,
      ...(sessionPrompt === undefined ? {} : { sessionPrompt }),
      ...(metadataTitle === undefined ? {} : { customTitle: metadataTitle }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned as boolean })
    });
    const next = nativeCodexRename
      ? this.options.runtime.setRunnerTitleFromNative(updated.id, input.customTitle ?? '')
      : updated;
    if (
      sessionPrompt !== undefined ||
      input.customTitle !== undefined ||
      input.pinned !== undefined
    )
      this.options.emitSession(next);
    return { session: this.options.present(next) };
  }

  private movePin(input: Record<string, unknown>): unknown {
    if (
      typeof input.sessionId !== 'string' ||
      (input.direction !== 'up' && input.direction !== 'down')
    )
      throw new Error('SESSION_PIN_MOVE_INVALID');
    const workspaceId = this.options.database().movePinnedSession(input.sessionId, input.direction);
    this.options.invalidateWorkspaceSessions(workspaceId);
    return { moved: true };
  }

  private async create(input: Record<string, unknown>): Promise<unknown> {
    const runner = this.options.runners.product(input.runner);
    if (
      typeof input.workspaceId !== 'string' ||
      runner === undefined ||
      typeof input.cwd !== 'string' ||
      input.cwd.length === 0 ||
      (input.externalSessionId !== undefined && typeof input.externalSessionId !== 'string') ||
      !validSessionTitle(input.title) ||
      !validSessionTitle(input.customTitle) ||
      !validSessionOption(input.model) ||
      !validSessionEffort(input.effort) ||
      !validSessionOption(input.access)
    )
      throw new Error('SESSION_INVALID');
    const database = this.options.database();
    const workspace = database.getWorkspace(input.workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    const cwd = await resolveWorkspaceExecutionDirectory(workspace.path, input.cwd);
    if (database.getWorkspace(workspace.id)?.path !== workspace.path)
      throw new Error('WORKSPACE_NOT_FOUND');
    let parentSessionId: string | undefined;
    if (input.parentSessionId !== undefined) {
      if (
        typeof input.parentSessionId !== 'string' ||
        input.parentSessionId.length === 0 ||
        input.parentSessionId.length > 512
      )
        throw new Error('SESSION_INVALID');
      const liveParent = this.options.runtime.getAgentSession(input.parentSessionId);
      const parent = liveParent ?? database.getSessionRecord(input.parentSessionId);
      if (parent === undefined || parent.workspaceId !== workspace.id)
        throw new Error('SESSION_NOT_FOUND');
      if (liveParent?.externalSessionId === null) throw new Error('SESSION_ACTIVATION_REQUIRED');
      parentSessionId = liveParent?.externalSessionId ?? parent.id;
    }
    const environment = parseSecretEnvironment(input.secretEnvironment);
    const saved = database.getRunnerDefaults().find((value) => value.runner === runner.name);
    const fallback = runner.defaultConfiguration(workspace, environment);
    const configuration: RunnerDefaultConfiguration = {
      runner: runner.name,
      model: typeof input.model === 'string' ? input.model : (saved?.model ?? fallback.model),
      effort: typeof input.effort === 'string' ? input.effort : (saved?.effort ?? fallback.effort),
      access:
        typeof input.access === 'string'
          ? input.access
          : runner.name === 'mar-agent'
            ? fallback.access
            : (saved?.access ?? fallback.access)
    };
    if (runner.name === 'mar-agent' && !['auto', 'full-access'].includes(configuration.access))
      throw new Error('SESSION_INVALID');
    const session = this.options.runtime.createAgentSession({
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      workspaceId: input.workspaceId,
      runner: runner.name,
      cwd,
      ...(typeof input.externalSessionId === 'string'
        ? { externalSessionId: input.externalSessionId }
        : {}),
      model: configuration.model,
      effort: configuration.effort,
      access: configuration.access,
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
      ...(typeof input.customTitle === 'string' ? { customTitle: input.customTitle } : {})
    });
    if (input.bootstrapOnly === true) this.options.identity.markBootstrap(session.id);
    if (input.__marctlOrigin === undefined) database.saveRunnerDefaults(configuration);
    if (input.bootstrapOnly !== true) this.options.emitSession(session);
    return { session: this.options.present(session) };
  }

  private async updateConfiguration(input: Record<string, unknown>): Promise<unknown> {
    if (
      typeof input.sessionId !== 'string' ||
      (input.model === undefined && input.effort === undefined && input.access === undefined) ||
      !validSessionOption(input.model) ||
      !validSessionEffort(input.effort) ||
      !validSessionOption(input.access)
    )
      throw new Error('SESSION_INVALID');
    const current =
      this.options.runtime.getAgentSession(input.sessionId) ??
      (await this.options.projection.createMetadataProjection(input.sessionId));
    if (
      current === undefined ||
      (typeof input.workspaceId === 'string' && input.workspaceId !== current.workspaceId)
    )
      throw new Error('SESSION_NOT_FOUND');
    if (
      current.runner === 'mar-agent' &&
      input.access !== undefined &&
      !['auto', 'full-access'].includes(input.access as string)
    )
      throw new Error('SESSION_INVALID');
    const session = this.options.runtime.updateAgentSessionConfiguration({
      sessionId: current.id,
      ...(typeof input.model === 'string' ? { model: input.model } : {}),
      ...(typeof input.effort === 'string' ? { effort: input.effort } : {}),
      ...(typeof input.access === 'string' ? { access: input.access } : {})
    });
    if (session.externalSessionId !== null)
      this.options.database().saveNativeSessionMetadata({
        runner: session.runner,
        externalSessionId: session.externalSessionId,
        workspaceId: session.workspaceId,
        model: session.model,
        effort: session.effort,
        access: session.access
      });
    this.options.emitSession(session);
    return { session: this.options.present(session) };
  }

  private async start(input: Record<string, unknown>): Promise<unknown> {
    const attachments = parseMessageAttachments(input.attachments);
    if (
      typeof input.clientMessageId !== 'string' ||
      input.clientMessageId.length === 0 ||
      typeof input.content !== 'string' ||
      (input.content.length === 0 &&
        !(Array.isArray(input.attachmentIds) && input.attachmentIds.length > 0) &&
        attachments.length === 0)
    )
      throw new Error('MESSAGE_INVALID');
    if (
      input.deferredCommands !== undefined &&
      (!Array.isArray(input.deferredCommands) ||
        input.deferredCommands.some(
          (value) =>
            !isPlainRecord(value) ||
            typeof value.commandId !== 'string' ||
            typeof value.input !== 'string'
        ))
    )
      throw new Error('RUNNER_COMMAND_INVALID');
    const startKey = `${input.workspaceId}\u0000${input.runner}\u0000${input.clientMessageId}`;
    const existing = this.starts.get(startKey);
    if (existing !== undefined) return existing;
    const start = this.startFresh(input);
    this.starts.set(startKey, start);
    try {
      const result = await start;
      while (this.starts.size > 512) {
        const oldest = this.starts.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === startKey) break;
        this.starts.delete(oldest);
      }
      return result;
    } catch (error) {
      this.starts.delete(startKey);
      throw error;
    }
  }

  private async startFresh(input: Record<string, unknown>): Promise<unknown> {
    const created = (await this.options.execute('session.create', {
      ...input,
      bootstrapOnly: true
    })) as { readonly session: NodeAgentSession };
    const bootstrapId = created.session.id;
    const identity = this.options.identity.wait(bootstrapId);
    try {
      if (Array.isArray(input.deferredCommands))
        for (const value of input.deferredCommands)
          if (isPlainRecord(value))
            await this.options.execute('session.command.execute', {
              sessionId: bootstrapId,
              commandId: value.commandId,
              input: value.input,
              ...(input.__requestUserId === undefined
                ? {}
                : { __requestUserId: input.__requestUserId }),
              ...(input.__usageGrant === undefined ? {} : { __usageGrant: input.__usageGrant }),
              ...(input.secretEnvironment === undefined
                ? {}
                : { secretEnvironment: input.secretEnvironment })
            });
      const interceptedId = this.options.interceptedSessionId(input.clientMessageId as string);
      const messageSessionId = interceptedId ?? bootstrapId;
      if (interceptedId !== undefined) this.options.identity.promote(bootstrapId, interceptedId);
      const message = (await this.options.execute('session.message', {
        sessionId: messageSessionId,
        clientMessageId: input.clientMessageId,
        content: input.content,
        ...(input.__marctlOrigin === undefined ? {} : { __marctlOrigin: input.__marctlOrigin }),
        ...(input.__suppressNotifications === true ? { __suppressNotifications: true } : {}),
        ...(input.__requestUserId === undefined ? {} : { __requestUserId: input.__requestUserId }),
        ...(input.__usageGrant === undefined ? {} : { __usageGrant: input.__usageGrant }),
        ...(input.secretEnvironment === undefined
          ? {}
          : { secretEnvironment: input.secretEnvironment }),
        ...(input.personalInstructions === undefined
          ? {}
          : { personalInstructions: input.personalInstructions }),
        [RUNNER_EXECUTION_CONTEXT]: this.options.runners
          .require(created.session.runner)
          .prepareExecutionContext(input),
        ...(input.computerUse === undefined ? {} : { computerUse: input.computerUse }),
        ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments })
      })) as {
        readonly run: NodeAgentRun;
        readonly delivery: string;
        readonly idempotent: boolean;
      };
      const nativeSessionId = await identity;
      const session = this.options.runtime.getAgentSession(nativeSessionId);
      const run = this.options.runtime.getRun(message.run.id);
      const turn = this.options.runtime.conversationTurnForRun(message.run.id);
      if (session === undefined || run === undefined || turn === undefined)
        throw new Error('SESSION_START_FAILED');
      return {
        session: this.options.present(session),
        run,
        turn,
        delivery: message.delivery,
        idempotent: message.idempotent,
        auditReceipt: {
          sessionId: session.id,
          conversationTitle: session.customTitle ?? session.runnerTitle ?? 'Untitled session',
          runId: run.id,
          inputMode: 'NEW_SESSION'
        }
      };
    } catch (error) {
      this.options.identity.reject(bootstrapId, 'SESSION_START_FAILED');
      const promotedSessionId = await identity.catch(() => undefined);
      if (promotedSessionId !== undefined)
        try {
          this.options.runtime.removeAgentSession(promotedSessionId);
        } catch {
          // A started Run owns the promoted Session and finishes normally.
        }
      throw error;
    }
  }
}

function record(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}
