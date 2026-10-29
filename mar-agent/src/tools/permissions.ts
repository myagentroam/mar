import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AgentError } from '../error.js';
import type { ClientToolDefinition, ToolCall } from './contracts.js';

import type {
  PermissionMode,
  ToolPermission,
  PermissionStop,
  ToolApprovalRequest,
  ToolApprovalHandler,
  ToolApprovalDecision
} from './permission-contract.js';
export type {
  PermissionMode,
  ToolPermission,
  PermissionStop,
  ToolApprovalRequest,
  ToolApprovalDecision,
  ToolApprovalHandler
} from './permission-contract.js';
type InvocationContext = {
  sessionId: string;
  executionId?: string;
  actor: string;
  entry?: string;
  parentToolCallId?: string;
  signal?: AbortSignal;
};
const permissionContext = new AsyncLocalStorage<ExecutionToolPermissions>();
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const schemaKeys = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'description',
  'title',
  '$schema',
  '$comment'
]);

export const permissionSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['allow', 'ask', 'deny'] },
    reason: { type: 'string' }
  },
  required: ['action'],
  additionalProperties: false
};

export function resolvePermissionMode(value: unknown): PermissionMode {
  if (value === undefined) return 'full-access';
  if (value === 'auto' || value === 'full-access') return value;
  throw new AgentError(
    'MAR_AGENT_TOOL_INPUT_INVALID',
    'Permission mode must be auto or full-access.'
  );
}

function flatInput(tool: ClientToolDefinition): boolean {
  const schema = tool.inputSchema;
  return (
    schema.type === 'object' &&
    schema.additionalProperties === false &&
    record(schema.properties) &&
    !Object.hasOwn(schema.properties, 'permission') &&
    Object.keys(schema).every((key) => schemaKeys.has(key))
  );
}

export function projectPermissionTool(tool: ClientToolDefinition): ClientToolDefinition {
  const flat = flatInput(tool);
  const parameterless =
    flat &&
    Object.keys(tool.inputSchema.properties as object).length === 0 &&
    (!Array.isArray(tool.inputSchema.required) || tool.inputSchema.required.length === 0);
  return {
    ...tool,
    inputMode: 'json',
    ...(parameterless ? { parameterless: true } : {}),
    inputSchema: flat
      ? {
          ...tool.inputSchema,
          properties: {
            ...(tool.inputSchema.properties as Record<string, unknown>),
            permission: permissionSchema
          }
        }
      : {
          type: 'object',
          properties: { input: tool.inputSchema, permission: permissionSchema },
          required: ['input'],
          additionalProperties: false
        }
  };
}

function parsePermission(value: unknown): ToolPermission | undefined {
  if (value === undefined || value === null) return;
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== 'action' && key !== 'reason') ||
    !['allow', 'ask', 'deny'].includes(String(value.action)) ||
    typeof value.action !== 'string' ||
    (value.reason !== undefined && value.reason !== null && typeof value.reason !== 'string')
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Invalid tool permission declaration.');
  const reason = typeof value.reason === 'string' ? value.reason.trim() : undefined;
  if ((reason !== undefined && [...reason].length > 240) || (value.action !== 'allow' && !reason))
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'ask/deny requires a public reason of 1 to 240 characters.'
    );
  return {
    action: value.action as ToolPermission['action'],
    ...(reason === undefined ? {} : { reason })
  };
}

export class ToolPermissionStopError extends AgentError {
  constructor(readonly permissionStop: PermissionStop) {
    super(
      permissionStop.action === 'ask' ? 'MAR_AGENT_PERMISSION_ASK' : 'MAR_AGENT_PERMISSION_DENIED',
      permissionStop.reason
    );
  }
}

/** One captured Execution's policy, including its retained tool frames. Not an authorization ledger. */
export class ExecutionToolPermissions {
  #stop?: PermissionStop;
  constructor(
    readonly mode: PermissionMode,
    readonly identity: { sessionId: string; executionId: string },
    private readonly approval?: {
      readonly request: ToolApprovalHandler;
      readonly signal: AbortSignal;
    }
  ) {}
  get stop(): PermissionStop | undefined {
    return this.#stop;
  }
  assertDispatch(): void {
    if (this.#stop)
      throw new AgentError(
        'MAR_AGENT_TOOL_SKIPPED_PERMISSION_STOP',
        'Tool was not executed because this execution stopped for permission.'
      );
  }
  prepare(call: ToolCall, context: InvocationContext, tool: ClientToolDefinition): ToolCall {
    if (this.mode !== 'auto') {
      if (call.permission !== undefined && call.permission !== null)
        throw new AgentError(
          'MAR_AGENT_TOOL_INPUT_INVALID',
          'Framework permission metadata requires an Auto execution.'
        );
      return call;
    }
    this.assertDispatch();
    let business = call.arguments;
    let declaration: unknown = call.permission;
    if (context.actor === 'model' || context.actor === 'code-mode') {
      if (!record(business))
        throw new AgentError(
          'MAR_AGENT_TOOL_INPUT_INVALID',
          'Auto tool input must be a JSON object.'
        );
      declaration = business.permission;
      if (flatInput(tool)) {
        const { permission: _permission, ...input } = business;
        business = input;
      } else {
        if (
          Object.keys(business).some((key) => key !== 'input' && key !== 'permission') ||
          !Object.hasOwn(business, 'input')
        )
          throw new AgentError(
            'MAR_AGENT_TOOL_INPUT_INVALID',
            'Auto input requires the original business arguments in input.'
          );
        business = business.input;
      }
    }
    const permission = parsePermission(declaration);
    const { permission: _permission, ...input } = call;
    const prepared = { ...input, arguments: business };
    if (permission?.action === 'ask' && this.approval) return { ...prepared, permission };
    if (permission && permission.action !== 'allow') {
      const stop: PermissionStop = Object.freeze({
        action: permission.action,
        reason: permission.reason!,
        source: Object.freeze({
          sessionId: this.identity.sessionId,
          executionId: this.identity.executionId,
          callId: call.callId ?? randomUUID(),
          toolName: call.name,
          ...(context.parentToolCallId === undefined
            ? {}
            : { parentCallId: context.parentToolCallId })
        })
      });
      if (permission.action === 'ask') this.#stop = stop;
      throw new ToolPermissionStopError(stop);
    }
    return prepared;
  }

  async authorize(call: ToolCall, context: InvocationContext): Promise<ToolCall> {
    if (call.permission?.action !== 'ask' || !this.approval) return call;
    const { permission, ...captured } = structuredClone(call);
    const timeout = new AbortController();
    const signal = AbortSignal.any([
      this.approval.signal,
      ...(context.signal ? [context.signal] : []),
      timeout.signal
    ]);
    signal.throwIfAborted();
    const request: ToolApprovalRequest = {
      approvalId: `mar-agent:${randomUUID()}`,
      reason: permission!.reason!,
      source: {
        ...this.identity,
        callId: call.callId ?? randomUUID(),
        toolName: call.name,
        ...(context.parentToolCallId ? { parentCallId: context.parentToolCallId } : {})
      },
      input: structuredClone(captured.arguments),
      expiresAt: Date.now() + 10 * 60_000
    };
    const timer = setTimeout(
      () =>
        timeout.abort(
          new AgentError(
            'MAR_AGENT_APPROVAL_EXPIRED',
            'Approval expired after 10 minutes without authorizing the tool call.'
          )
        ),
      10 * 60_000
    );
    timer.unref();
    let abort: () => void = () => {};
    try {
      const decision = await new Promise<ToolApprovalDecision>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return this.approval!.request(request, signal);
          })
          .then(resolve, reject);
      });
      signal.throwIfAborted();
      if (Date.now() >= request.expiresAt)
        throw new AgentError(
          'MAR_AGENT_APPROVAL_EXPIRED',
          'Approval expired after 10 minutes without authorizing the tool call.'
        );
      if (decision !== 'APPROVED')
        throw new AgentError(
          'MAR_AGENT_APPROVAL_REJECTED',
          `User rejected this tool call: ${permission!.reason}`
        );
      this.assertDispatch();
      return captured;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}

export function isToolPermissionFailure(error: unknown): boolean {
  return (
    permissionStopFromError(error)?.action === 'deny' ||
    (error instanceof AgentError &&
      ['MAR_AGENT_APPROVAL_REJECTED', 'MAR_AGENT_APPROVAL_EXPIRED'].includes(error.code))
  );
}

export function withToolPermissions<T>(policy: ExecutionToolPermissions, run: () => T): T {
  return permissionContext.run(policy, run);
}
export function currentToolPermissions(context?: {
  sessionId: string;
  executionId?: string;
}): ExecutionToolPermissions | undefined {
  const policy = permissionContext.getStore();
  return policy &&
    (!context ||
      (policy.identity.sessionId === context.sessionId &&
        policy.identity.executionId === context.executionId))
    ? policy
    : undefined;
}
export function permissionStopFromError(error: unknown): PermissionStop | undefined {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause)
    if (error instanceof ToolPermissionStopError) return error.permissionStop;
  return;
}
