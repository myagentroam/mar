import type { ModelUsageGrants } from '@myagentroam/server-core/model-usage-grant';
import { emitAudit, safeAuditMetadata, type AuditObserver } from '@myagentroam/server-core/audit';
import { randomUUID } from 'node:crypto';
import { NodeRequestChannel } from '@myagentroam/server-core/node-request-channel';
import {
  NodeRequestAdmissionError,
  NodeRequestError
} from '@myagentroam/server-core/node-request-error';
import { safeErrorCode } from '@myagentroam/server-core/http-errors';
import type { GitExecutionForwarding } from '@myagentroam/server-core/git-execution-forwarding';
import type { WebSocket } from 'ws';
import {
  browserDownloadRequestSchema,
  workbenchNodeOperationSchema,
  type NodeEnvelope
} from '@myagentroam/protocol';
import type {
  NodeRequestAuthorization,
  UserNodeAuthorization
} from '@myagentroam/server-core/node-access-contracts';
import type { ServerTrafficMetrics } from './server-traffic-metrics.js';
import {
  NodeResourceScopeIndex,
  observesRelayResources,
  projectRelayResources,
  relayResourceRemoval
} from './node-resource-scope-index.js';
import { RelayAuditContextCache } from './relay-audit-context-cache.js';

const BROWSER_WORKSPACE_SAVE_TIMEOUT_MS = 120_000;

const FIXED_ADMIN_NODE_OPERATIONS = new Set<string>([
  'chatgpt.login.start',
  'chatgpt.login.status',
  'chatgpt.login.ack',
  'chatgpt.login.cancel',
  'node.metrics',
  'node.upgrade.request',
  'node.upgrade.cancel',
  'workspace.register',
  'workspace.remove',
  'workspace.list',
  'workspace.sessions.cleanup',
  'workspace.diff',
  'session.start',
  'session.list',
  'session.discover',
  'session.get',
  'session.watch',
  'session.runs',
  'session.message',
  'session.interrupt',
  'workspace.queue.get',
  'workspace.queue.pause',
  'workspace.queue.resume',
  'workspace.queue.reorder',
  'workspace.queue.message.update',
  'workspace.queue.message.delete',
  'workspace.queue.message.execute',
  'session.channel.message',
  'session.channel.token',
  'runner.command.execute',
  'run.get',
  'run.image.read',
  'run.cancel',
  'run.interrupt',
  'run.user-input.respond',
  'run.approval.decide'
]);
const AUDITED_MANAGEMENT_RELAY_OPERATIONS = new Set<string>([
  'conversation.hosting.enable',
  'conversation.hosting.disable',
  'conversation.hosting.cleanup.execute',
  'mar-agent.model.test',
  'node.upgrade.request',
  'node.upgrade.cancel',
  'computer.use.enable',
  'computer.use.disable',
  'workspace.git.settings.update',
  'workspace.sessions.cleanup',
  'session.metadata.update',
  'session.config.update',
  'session.pin.move',
  'schedule.task.create',
  'schedule.task.update',
  'schedule.task.propose',
  'schedule.task.remove',
  'schedule.task.resolveProposal',
  'session.rewind',
  'session.rollback',
  'session.remove',
  'session.command.execute',
  'runner.command.execute',
  'runner.defaults.save',
  'session.interrupt',
  'run.cancel',
  'run.interrupt',
  'run.approval.decide',
  'workspace.queue.pause',
  'workspace.queue.resume',
  'workspace.file.write',
  'workspace.files.mutate',
  'workspace.change.restore',
  'workspace.files.upload.complete',
  'workspace.files.upload.cancel',
  'terminal.open',
  'terminal.command.open',
  'node.skills.install',
  'node.skills.remove',
  'workspace.skills.install',
  'workspace.skills.remove',
  'workspace.skills.git-exclude-repair',
  'node.mcps.install',
  'node.mcps.remove',
  'workspace.mcps.install',
  'workspace.mcps.remove'
]);

interface RelayAuditContext {
  readonly nodeId: string;
  readonly workspaceId?: string;
  readonly agentSessionId?: string;
  readonly runId?: string;
  readonly clientMessageId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
}

export class NodeRequestBroker {
  private readonly channel: NodeRequestChannel;
  private readonly scopes = new NodeResourceScopeIndex();
  private readonly auditContexts = new RelayAuditContextCache();
  private closed = false;
  constructor(
    private readonly audits: AuditObserver,
    private readonly authorize: NodeRequestAuthorization,
    private readonly socketFor: (nodeId: string) => WebSocket | undefined,
    private readonly connectionPolicy: {
      readonly allows: (socket: WebSocket, operation: string) => boolean;
      readonly supportsScheduledTasks?: (nodeId: string) => boolean;
    },
    private readonly services: {
      readonly usageGrants: Pick<ModelUsageGrants, 'issue'>;
      readonly gitForwarding: Pick<GitExecutionForwarding, 'prepare'>;
    },
    log: (event: string, fields: Record<string, unknown>) => void = () => undefined,
    traffic?: ServerTrafficMetrics
  ) {
    this.channel = new NodeRequestChannel(socketFor, log, (bytes) =>
      traffic?.record('node', 'out', bytes)
    );
  }

  request(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs = 15_000,
    signal?: AbortSignal
  ): Promise<unknown> {
    const socket = this.socketFor(nodeId);
    if (socket !== undefined && !this.connectionPolicy.allows(socket, operation))
      return Promise.reject(new NodeRequestAdmissionError('NODE_UPGRADE_REQUIRED'));
    if (
      !FIXED_ADMIN_NODE_OPERATIONS.has(operation) &&
      !workbenchNodeOperationSchema.safeParse(operation).success
    )
      return Promise.reject(new NodeRequestAdmissionError('OPERATION_UNSUPPORTED'));
    if (
      operation === 'model.resource.read' &&
      user.userId === 0 &&
      user.sessionHash === 'model-resource'
    )
      return this.dispatch(
        nodeId,
        operation,
        data,
        user,
        undefined,
        timeoutMs,
        this.socketFor(nodeId),
        signal
      );
    if (!Number.isSafeInteger(user.userId) || user.userId <= 0 || user.sessionHash.length === 0)
      return Promise.reject(new NodeRequestAdmissionError('USER_AUTHORIZATION_REQUIRED'));
    const connection = this.socketFor(nodeId);
    // Cancellation and unwatch only address the authenticated caller's page intent
    // on the Node. They read no resource and must remain possible after revocation.
    if (
      operation === 'prompt-completion.cancel' ||
      operation === 'session.unwatch' ||
      operation === 'workspace.unwatch'
    )
      return this.dispatch(nodeId, operation, data, user, undefined, timeoutMs, connection, signal);
    const { workspaceId, conflict } = this.scopes.resolve(
      nodeId,
      operation,
      data,
      user.workspaceId
    );
    if (conflict || (operation.startsWith('schedule.') && workspaceId === undefined))
      return this.denyAuthorizedRequest(nodeId, operation, data, user, workspaceId);
    const ownership = this.authorize(user.userId, nodeId, operation, data, workspaceId);
    if (ownership instanceof Promise)
      return ownership.then((allowed) =>
        allowed
          ? this.dispatch(nodeId, operation, data, user, workspaceId, timeoutMs, connection, signal)
          : this.denyAuthorizedRequest(nodeId, operation, data, user, workspaceId)
      );
    if (!ownership) return this.denyAuthorizedRequest(nodeId, operation, data, user, workspaceId);
    return this.dispatch(nodeId, operation, data, user, workspaceId, timeoutMs, connection, signal);
  }

  requestScheduledTaskIndex(
    nodeId: string,
    data: { workspaceId: string; afterTaskId?: string }
  ): Promise<unknown> {
    const socket = this.socketFor(nodeId);
    if (socket === undefined) return Promise.reject(new NodeRequestAdmissionError('NODE_OFFLINE'));
    if (!this.connectionPolicy.allows(socket, 'schedule.index.list'))
      return Promise.reject(new NodeRequestAdmissionError('NODE_UPGRADE_REQUIRED'));
    return this.channel.requestScheduledTaskIndex(nodeId, data);
  }

  /** Calls the closed Browser RPC surface after the Browser owner authorizes it.
   * These operations are deliberately not on the generic Workbench allowlist. */
  async requestBrowser(
    nodeId: string,
    operation: 'resource' | 'profile' | 'attachment' | 'upload' | 'download',
    generation: string,
    payload: object,
    user: UserNodeAuthorization,
    // Only the Browser owner supplies this from the authorized attachment, never the request body.
    workspaceId?: string
  ): Promise<unknown> {
    const socket = this.socketFor(nodeId);
    if (socket === undefined) throw new NodeRequestAdmissionError('NODE_OFFLINE');
    if (!this.connectionPolicy.allows(socket, `browser.${operation}`))
      throw new NodeRequestAdmissionError('NODE_UPGRADE_REQUIRED');
    const command =
      operation === 'download' && workspaceId !== undefined
        ? browserDownloadRequestSchema.parse(payload).command
        : undefined;
    if (workspaceId !== undefined && command?.action === 'workspace') {
      const envelope = { generation, payload };
      const context = auditContext(nodeId, { workspaceId }, workspaceId);
      const eventType = 'workspace.file.write';
      const metadata = safeAuditMetadata(
        JSON.stringify({ action: eventType, relativePath: command.path })
      );
      let operationId: string | undefined;
      try {
        const result = await this.channel.request(
          nodeId,
          'browser.download',
          envelope,
          user,
          BROWSER_WORKSPACE_SAVE_TIMEOUT_MS,
          (phase, id) => {
            if (phase === 'requested') operationId = id;
          }
        );
        if (operationId !== undefined) {
          // This operation returns an explicit object only after the copy completes.
          if (!record(result)) throw unconfirmedWorkspaceSave(operationId);
          this.auditRelay(
            eventType,
            'completed',
            operationId,
            user.userId,
            context,
            undefined,
            metadata
          );
        }
        return result;
      } catch (error) {
        const failure =
          error instanceof NodeRequestError && error.source === 'transport'
            ? unconfirmedWorkspaceSave(error.upstreamRequestId)
            : error;
        if (operationId !== undefined)
          this.auditRelay(
            eventType,
            'failed',
            operationId,
            user.userId,
            context,
            safeErrorCode(failure),
            metadata
          );
        throw failure;
      }
    }
    return this.channel.request(
      nodeId,
      `browser.${operation}`,
      { generation, payload },
      user,
      30_000
    );
  }

  private denyAuthorizedRequest(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    workspaceId?: string
  ): Promise<never> {
    this.auditRelay(
      operation,
      'failed',
      randomUUID(),
      user.userId,
      auditContext(nodeId, data, workspaceId),
      'NODE_ACCESS_DENIED',
      JSON.stringify({ action: operation })
    );
    return Promise.reject(new NodeRequestAdmissionError('NODE_ACCESS_DENIED'));
  }

  requestHostedConversation(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs = 15_000
  ): Promise<unknown> {
    if (
      !operation.startsWith('conversation.hosted.') ||
      !workbenchNodeOperationSchema.safeParse(operation).success
    )
      return Promise.reject(new Error('OPERATION_UNSUPPORTED'));
    if (!Number.isSafeInteger(user.userId) || user.userId <= 0 || user.sessionHash.length === 0)
      return Promise.reject(new Error('USER_AUTHORIZATION_REQUIRED'));
    return this.dispatch(
      nodeId,
      operation,
      data,
      user,
      undefined,
      timeoutMs,
      this.socketFor(nodeId)
    );
  }

  private async dispatch(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    workspaceId: string | undefined,
    timeoutMs: number,
    connection: WebSocket | undefined,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (connection !== undefined && !this.connectionPolicy.allows(connection, operation))
      throw new NodeRequestAdmissionError('NODE_UPGRADE_REQUIRED');
    const prepared = await this.services.gitForwarding.prepare(
      nodeId,
      operation,
      data,
      user.userId
    );
    let context = auditContext(nodeId, data, workspaceId);
    const audit = this.auditContexts.context(nodeId, context.agentSessionId, context.runId);
    if (audit.sessionId) context = { ...context, agentSessionId: audit.sessionId };
    const sessionName = audit.name;
    const metadata = record(data)
      ? safeAuditMetadata(
          JSON.stringify({
            action: operation,
            sessionName,
            relativePath: data['path'],
            destination: data['destination'],
            mutation: operation === 'workspace.files.mutate' ? data['action'] : undefined,
            terminalId: data['terminalId'],
            uploadId: data['uploadId'],
            fileName: data['fileName'],
            sizeBytes: data['size'],
            after: operation === 'session.config.update' ? data['config'] : undefined
          })
        )
      : JSON.stringify({ action: operation });
    if (
      this.closed ||
      connection === undefined ||
      this.socketFor(nodeId) !== connection ||
      connection.readyState !== connection.OPEN
    ) {
      const code = this.closed ? 'NODE_CONTROL_CLOSED' : 'NODE_OFFLINE';
      this.auditRelay(operation, 'failed', randomUUID(), user.userId, context, code, metadata);
      throw new NodeRequestAdmissionError(code);
    }
    if (!this.connectionPolicy.allows(connection, operation))
      throw new NodeRequestAdmissionError('NODE_UPGRADE_REQUIRED');
    if (
      operation.startsWith('schedule.') &&
      !this.connectionPolicy.supportsScheduledTasks?.(nodeId)
    )
      throw new NodeRequestAdmissionError('CAPABILITY_VERSION_UNSUPPORTED');
    const observation = observesRelayResources(operation) ? this.scopes.begin(nodeId) : undefined;
    try {
      const result = await this.channel.request(
        nodeId,
        operation,
        prepared,
        {
          ...user,
          usageGrant:
            [
              'session.message',
              'session.channel.message',
              'session.start',
              'session.command.execute',
              'runner.command.execute',
              'conversation.hosted.message',
              'prompt-completion.generate'
            ].includes(operation) ||
            (operation === 'agent.network' &&
              record(data) &&
              (data.action === 'start' || data.action === 'send'))
              ? this.services.usageGrants.issue(
                  nodeId,
                  user.userId,
                  operation.startsWith('conversation.hosted.') ? 'conversation' : 'work'
                )
              : undefined
        },
        timeoutMs,
        (phase, id, errorCode) =>
          this.auditRelay(operation, phase, id, user.userId, context, errorCode, metadata),
        signal
      );
      if (
        !this.closed &&
        this.socketFor(nodeId) === connection &&
        connection.readyState === connection.OPEN
      ) {
        const removal = relayResourceRemoval(operation, data, result);
        if (removal !== undefined) {
          this.scopes.remove(nodeId, removal);
          this.auditContexts.remove(nodeId, removal);
        }
        if (observation !== undefined) {
          const facts = this.scopes.observe(
            observation,
            projectRelayResources(operation, data, result)
          );
          this.auditContexts.observe(nodeId, facts);
        }
      }
      return result;
    } finally {
      if (observation !== undefined) this.scopes.finish(observation);
    }
  }

  resolve(nodeId: string, envelope: NodeEnvelope): void {
    this.channel.resolve(nodeId, envelope);
  }

  rejectNode(nodeId: string, error: Error): void {
    this.channel.rejectNode(nodeId, error);
    this.scopes.removeNode(nodeId);
    this.auditContexts.removeNode(nodeId);
  }

  close(): void {
    this.closed = true;
    this.channel.close();
    this.scopes.clear();
    this.auditContexts.clear();
  }

  private auditRelay(
    operation: string,
    phase: 'requested' | 'completed' | 'failed',
    operationId: string,
    actorUserId: number,
    context: RelayAuditContext,
    errorCode?: string,
    metadata?: string
  ): void {
    if (!auditedRelayOperation(operation) || phase === 'requested') return;
    emitAudit(this.audits, {
      eventType: operation,
      actorUserId,
      result:
        phase !== 'failed'
          ? 'SUCCESS'
          : errorCode === 'NODE_ACCESS_DENIED' || errorCode === 'RBAC_DENIED'
            ? 'DENIED'
            : 'FAILED',
      operationId,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...context,
      metadata: metadata ?? JSON.stringify({ action: operation })
    });
  }
}

function auditContext(
  nodeId: string,
  data: unknown,
  resolvedWorkspaceId?: string
): RelayAuditContext {
  if (!record(data))
    return {
      nodeId,
      ...(resolvedWorkspaceId === undefined ? {} : { workspaceId: resolvedWorkspaceId })
    };
  const draft = record(data['draft']) ? data['draft'] : undefined;
  const templateId =
    typeof data['templateId'] === 'string'
      ? data['templateId']
      : typeof draft?.['templateId'] === 'string'
        ? draft['templateId']
        : undefined;
  return {
    nodeId,
    ...(resolvedWorkspaceId !== undefined
      ? { workspaceId: resolvedWorkspaceId }
      : typeof data['workspaceId'] === 'string'
        ? { workspaceId: data['workspaceId'] }
        : {}),
    ...(typeof data['sessionId'] === 'string' ? { agentSessionId: data['sessionId'] } : {}),
    ...(typeof data['runId'] === 'string' ? { runId: data['runId'] } : {}),
    ...(typeof data['clientMessageId'] === 'string'
      ? { clientMessageId: data['clientMessageId'] }
      : {}),
    ...(templateId !== undefined
      ? { targetType: 'TEMPLATE', targetId: templateId }
      : typeof data['modelId'] === 'string'
        ? { targetType: 'MODEL', targetId: data['modelId'] }
        : typeof data['runId'] === 'string'
          ? { targetType: 'RUN', targetId: data['runId'] }
          : typeof data['sessionId'] === 'string'
            ? { targetType: 'SESSION', targetId: data['sessionId'] }
            : resolvedWorkspaceId
              ? { targetType: 'WORKSPACE', targetId: resolvedWorkspaceId }
              : { targetType: 'NODE', targetId: nodeId })
  };
}

export function auditedRelayOperation(operation: string): boolean {
  return AUDITED_MANAGEMENT_RELAY_OPERATIONS.has(operation);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unconfirmedWorkspaceSave(requestId: string): NodeRequestError {
  return new NodeRequestError(
    {
      error: 'BROWSER_OUTCOME_UNKNOWN',
      message:
        'The Workspace copy could not be confirmed. Check whether the file is complete before retrying.'
    },
    requestId
  );
}
