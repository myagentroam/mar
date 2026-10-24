import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import type { NodeAgentSession, NodeWorkspace } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import type { SessionContextService } from './session-context-service.js';
import { marctlSessionDetail } from './session-recent-activity.js';
import { isPlainRecord } from '../util/node-operation-parsers.js';
import type { RunnerName } from '@myagentroam/protocol';
import { toolResultResourceInputSchema, toolResultResourcePageSchema } from '@myagentroam/protocol';

export interface SessionQueryServiceOptions {
  readonly workspace: (workspaceId: string) => NodeWorkspace | undefined;
  readonly goal?: (sessionId: string) => unknown;
  readonly runtime: NodeRuntimeState;
  readonly runners: RunnerRegistry;
  readonly resolve: (
    sessionId: string,
    registeredOnly?: boolean
  ) => Promise<NodeAgentSession | undefined>;
  readonly similar: (sessionId: string, workspaceId: string) => string | undefined;
  readonly present: (session: NodeAgentSession) => unknown;
  readonly queuedCount: (sessionId: string) => number;
  readonly history: (
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number }
  ) => Promise<unknown>;
  readonly segments: (
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number }
  ) => Promise<unknown>;
  readonly context: SessionContextService;
  readonly discover: (
    runner: RunnerName,
    workspaceId?: string
  ) => Promise<readonly NodeAgentSession[]>;
  readonly workspaceIdForCwd: (cwd: string) => string | undefined;
}

export class SessionQueryService {
  constructor(private readonly options: SessionQueryServiceOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'session.get': (data) => this.get(record(data)),
      'session.cli.context': (data) => this.cliContext(record(data)),
      'session.goal.get': async (data) => {
        const input = record(data);
        const session = await this.requireSession(
          input.sessionId,
          input.workspaceId,
          input.registeredOnly === true
        );
        return { goal: this.options.goal?.(session.id) ?? null };
      },
      'session.runs': (data) => this.runs(record(data)),
      'session.turns.list': (data) => this.turns(record(data)),
      'session.events.read': (data) => this.events(record(data)),
      'session.context.read': (data) => this.readContext(record(data)),
      'session.tool-resource.read': (data) => this.readToolResource(record(data)),
      'session.discover': (data) => this.discover(record(data))
    };
  }

  private async get(input: Record<string, unknown>): Promise<unknown> {
    const session = await this.requireSession(
      input.sessionId,
      input.workspaceId,
      input.registeredOnly === true
    );
    return input.view === 'marctl'
      ? {
          view: 'marctl',
          workspaceId: session.workspaceId,
          session: marctlSessionDetail(
            this.options.runtime,
            session,
            this.options.queuedCount(session.id)
          )
        }
      : { session: this.options.present(session) };
  }

  private async cliContext(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.workspaceId !== 'string') throw new Error('WORKSPACE_NOT_FOUND');
    const workspace = this.options.workspace(input.workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    const session =
      input.sessionId === undefined
        ? undefined
        : await this.requireSession(input.sessionId, workspace.id, input.registeredOnly === true);
    return {
      workspace: { id: workspace.id, path: workspace.path },
      session: session === undefined ? null : this.options.present(session),
      run:
        session === undefined ? null : (this.options.runtime.activeSessionRun(session.id) ?? null)
    };
  }

  private async runs(input: Record<string, unknown>): Promise<unknown> {
    const session = await this.requireSession(
      input.sessionId,
      input.workspaceId,
      input.registeredOnly === true
    );
    return { runs: this.options.runtime.listRunsForSession(session.id, { includeTerminal: true }) };
  }

  private async turns(input: Record<string, unknown>): Promise<unknown> {
    const page = pageInput(input);
    const session = await this.requireSession(
      input.sessionId,
      input.workspaceId,
      input.registeredOnly === true
    );
    if (input.unit === 'SEGMENT') return this.options.segments(session, page);
    if (input.unit !== undefined && input.unit !== 'TURN') throw new Error('EVENT_CURSOR_INVALID');
    return this.options.history(session, page);
  }

  private events(input: Record<string, unknown>): unknown {
    const page = pageInput(input);
    if (typeof input.sessionId !== 'string') throw new Error('SESSION_NOT_FOUND');
    const session = this.options.runtime.getAgentSession(input.sessionId);
    if (
      session === undefined ||
      (input.workspaceId !== undefined && session.workspaceId !== input.workspaceId)
    )
      throw new Error('SESSION_NOT_FOUND');
    return this.options.runtime.listConversationItems({ sessionId: session.id, ...page });
  }

  private async readToolResource(input: Record<string, unknown>): Promise<unknown> {
    const session = await this.requireSession(
      input.sessionId,
      input.workspaceId,
      input.registeredOnly === true
    );
    if (typeof input.workspaceId !== 'string' || input.workspaceId !== session.workspaceId)
      throw new Error('SESSION_NOT_FOUND');
    const resource = toolResultResourceInputSchema.parse({
      resourceRef: input.resourceRef,
      cursor: input.cursor,
      maxBytes: input.maxBytes
    });
    const runner = this.options.runners.product(session.runner);
    if (!runner) throw new Error('TOOL_RESOURCE_UNSUPPORTED');
    return toolResultResourcePageSchema.parse(
      await runner.readToolResultResource(session, resource)
    );
  }

  private async readContext(input: Record<string, unknown>): Promise<unknown> {
    return this.options.context.read(
      await this.requireSession(input.sessionId, input.workspaceId, input.registeredOnly === true)
    );
  }

  private async discover(input: Record<string, unknown>): Promise<unknown> {
    const runner = this.options.runners.product(input.runner);
    if (runner === undefined) throw new Error('SESSION_INVALID');
    const workspaceId =
      typeof input.workspaceId === 'string'
        ? input.workspaceId
        : typeof input.cwd === 'string'
          ? this.options.workspaceIdForCwd(input.cwd)
          : undefined;
    if (runner.discoveryScope === 'WORKSPACE_REQUIRED' && workspaceId === undefined)
      throw new Error('SESSION_INVALID');
    const sessions = await this.options.discover(runner.name, workspaceId);
    return { sessions: sessions.map((session) => this.options.present(session)) };
  }

  private async requireSession(
    sessionId: unknown,
    workspaceId?: unknown,
    registeredOnly = false
  ): Promise<NodeAgentSession> {
    if (typeof sessionId !== 'string') throw new Error('SESSION_INVALID');
    const session =
      this.options.runtime.getAgentSession(sessionId) ??
      (await this.options.resolve(sessionId, registeredOnly));
    if (session === undefined && registeredOnly && typeof workspaceId === 'string')
      throw Object.assign(new Error('SESSION_NOT_FOUND'), {
        publicDetails: this.options.similar(sessionId, workspaceId)
      });
    if (session === undefined || (workspaceId !== undefined && session.workspaceId !== workspaceId))
      throw new Error('SESSION_NOT_FOUND');
    return session;
  }
}

function pageInput(input: Record<string, unknown>): { cursor?: string; limit?: number } {
  if (
    (input.cursor !== undefined && typeof input.cursor !== 'string') ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > 500))
  )
    throw new Error('EVENT_CURSOR_INVALID');
  return {
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {})
  };
}

function record(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}
