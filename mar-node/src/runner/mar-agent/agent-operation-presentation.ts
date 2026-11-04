import {
  agentOperationPresentationSchema,
  type AgentOperationPresentation
} from '@myagentroam/protocol';
import { isPlainRecord } from '../../util/records.js';

const actions = {
  agent_start: 'START',
  agent_send: 'SEND',
  agent_wait: 'WAIT',
  agent_stop: 'STOP',
  agent_list: 'LIST',
  agent_view: 'VIEW'
} as const;

export function agentOperationAction(toolName: string) {
  return Object.hasOwn(actions, toolName) ? actions[toolName as keyof typeof actions] : undefined;
}

function text(value: unknown, max = 128): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.slice(0, max).replace(/[\uD800-\uDBFF]$/u, '')
    : undefined;
}

function latestWaitMessage(updates: unknown) {
  if (!Array.isArray(updates)) return undefined;
  const message = updates.findLast(
    (entry) => isPlainRecord(entry) && entry.kind === 'message' && typeof entry.value === 'string'
  );
  if (!isPlainRecord(message)) return undefined;
  const value = text(message.value, 800);
  if (!value) return undefined;
  return {
    value,
    ...(message.final === true ? { final: true } : {}),
    ...(message.truncated === true || (message.value as string).length > 800
      ? { truncated: true }
      : {})
  };
}

/** Input identities are display-only; only successful Node results establish navigation. */
export function agentOperationPresentation(
  toolName: string,
  input: unknown,
  data?: unknown
): AgentOperationPresentation | undefined {
  const action = agentOperationAction(toolName);
  if (!action) return undefined;
  const parsed = agentOperationPresentationSchema.safeParse(
    isPlainRecord(data) ? data.agentOperation : undefined
  );
  if (parsed.success && parsed.data.action === action) return parsed.data;
  const value = isPlainRecord(input) ? input : {};
  const ids =
    typeof value.agentId === 'string'
      ? [value.agentId]
      : Array.isArray(value.agentIds)
        ? value.agentIds
        : [];
  return {
    action,
    targets: ids
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128)
      .slice(0, 8)
      .map((agentId) => ({ agentId })),
    ...(text(value.scope, 32) ? { scope: text(value.scope, 32) } : {})
  };
}

/** Whitelist public receipts; never serialize configuration, credentials or full history. */
export function agentOperationEvent(action: string, input: unknown, result: unknown) {
  const operation = agentOperationPresentation(`agent_${action}`, input)!;
  const value = isPlainRecord(result) ? result : {};
  const args = isPlainRecord(input) ? input : {};
  if (
    action === 'wait' &&
    (args.waitFor === 'message' || args.waitFor === 'completion') &&
    typeof args.waitMs === 'number'
  )
    operation.detail = {
      wait: {
        waitFor: args.waitFor,
        waitMs: args.waitMs,
        ...(Array.isArray(args.agentIds) && (args.mode === 'any' || args.mode === 'all')
          ? { mode: args.mode }
          : {})
      }
    };
  const message = action === 'start' || action === 'send' ? text(args.content, 2000) : undefined;
  const title = action === 'start' ? text(args.title, 500) : undefined;
  if (message || title)
    operation.detail = {
      ...(title ? { title } : {}),
      ...(message
        ? { message, ...(message !== args.content ? { messageTruncated: true as const } : {}) }
        : {})
    };
  const rows = action === 'list' ? value.sessions : action === 'wait' ? value.agents : undefined;
  const records = Array.isArray(rows)
    ? rows
    : action === 'list'
      ? []
      : action === 'view'
        ? isPlainRecord(value.session)
          ? [value.session]
          : []
        : typeof value.agentId === 'string'
          ? [value]
          : [];
  const returnedTargets = records
    .flatMap((entry) => {
      if (!isPlainRecord(entry)) return [];
      const rawId = entry.agentId ?? entry.id;
      const agentId = typeof rawId === 'string' && rawId.length <= 128 ? text(rawId) : undefined;
      if (!agentId) return [];
      const title = text(entry.title ?? (action === 'start' ? args.title : undefined), 500);
      const status = ['list', 'view', 'wait'].includes(action) ? text(entry.status) : undefined;
      const latest = action === 'wait' ? latestWaitMessage(entry.updates) : undefined;
      const viewMessage =
        action === 'view' && isPlainRecord(entry.latestMessage) ? entry.latestMessage : undefined;
      const summary = action === 'wait' ? text(entry.summary, 800) : undefined;
      const rawMessage = summary ?? latest?.value ?? text(viewMessage?.text, 800);
      const messageTruncated = summary
        ? entry.summaryTruncated === true || summary !== entry.summary
        : latest
          ? latest.truncated === true
          : viewMessage?.truncated === true ||
            (typeof viewMessage?.text === 'string' && viewMessage.text.length > 800);
      return [
        {
          agentId,
          sessionId: agentId,
          ...(title ? { title } : {}),
          ...(status ? { status } : {}),
          ...(rawMessage
            ? {
                message: rawMessage,
                ...(messageTruncated ? { messageTruncated: true as const } : {})
              }
            : {})
        }
      ];
    })
    .slice(0, 100);
  // An any-wait may return one result for several requested targets; keep the call multi-target.
  const targets: AgentOperationPresentation['targets'] =
    action === 'wait' && operation.targets.length > 0
      ? operation.targets.map(
          (target) => returnedTargets.find((result) => result.agentId === target.agentId) ?? target
        )
      : returnedTargets;
  const presentation: AgentOperationPresentation = { ...operation, targets };
  const scope = action === 'list' ? text(value.scope, 32) : undefined;
  if (scope) presentation.scope = scope;
  const messageReceipt = isPlainRecord(value.message) ? value.message : undefined;
  const messageResult = isPlainRecord(messageReceipt?.result) ? messageReceipt.result : undefined;
  const auditReceipt = isPlainRecord(messageResult?.auditReceipt)
    ? messageResult.auditReceipt
    : undefined;
  const failures = [value.message, value.goal, value.approval, value.observation, value.start]
    .filter(
      (part) =>
        isPlainRecord(part) &&
        ['unknown', 'failed', 'partial', 'not_attempted'].includes(String(part.status))
    )
    .map((part) => (isPlainRecord(part) ? (text(part.code) ?? text(part.status)) : undefined))
    .filter((part): part is string => part !== undefined);
  if (failures.length)
    presentation.detail = {
      ...presentation.detail,
      failed: true,
      error: failures.join('\n').slice(0, 500)
    };
  if (
    action === 'send' &&
    message &&
    failures.length === 0 &&
    messageReceipt?.status === 'accepted'
  ) {
    const delivery =
      messageResult?.delivery === 'QUEUED' || auditReceipt?.inputMode === 'QUEUE'
        ? 'QUEUE'
        : auditReceipt?.inputMode === 'REPLACE_CURRENT'
          ? 'STEER'
          : undefined;
    if (delivery) presentation.detail = { ...presentation.detail, delivery };
  }
  if (
    !presentation.detail &&
    ((action === 'list' && Array.isArray(value.sessions)) ||
      (action === 'view' && isPlainRecord(value.session)) ||
      (action === 'wait' && records.length > 0) ||
      (action === 'stop' && typeof value.agentId === 'string'))
  )
    presentation.detail = {};
  if (value.truncated === true || records.length > returnedTargets.length)
    presentation.targetsTruncated = true;
  // Core accepts at most 8 KiB of explicit extension event data.
  while (Buffer.byteLength(JSON.stringify({ agentOperation: presentation }), 'utf8') > 7000) {
    const targetWithMessage = targets.findLast((target) => target.message);
    if (targetWithMessage?.message) {
      const shortened = text(
        targetWithMessage.message,
        Math.floor(targetWithMessage.message.length / 2)
      );
      if (shortened) targetWithMessage.message = shortened;
      else delete targetWithMessage.message;
      targetWithMessage.messageTruncated = true;
    } else if (presentation.detail?.message) {
      const shortened = text(
        presentation.detail.message,
        Math.floor(presentation.detail.message.length / 2)
      );
      if (shortened) presentation.detail.message = shortened;
      else delete presentation.detail.message;
      presentation.detail.messageTruncated = true;
    } else if (targets.length) {
      targets.pop();
      presentation.targetsTruncated = true;
    } else break;
  }
  const receipt: Record<string, unknown> = {};
  if (action === 'list' && Array.isArray(value.models)) {
    receipt.runner = text(value.runner);
    receipt.modelCount = value.models.length;
  }
  if (action === 'view' && isPlainRecord(value.session)) {
    for (const key of ['status', 'modelId', 'effort']) {
      const field = text(value.session[key]);
      if (field) receipt[key] = field;
    }
    const message = isPlainRecord(value.session.latestMessage)
      ? value.session.latestMessage
      : undefined;
    const messageText = text(message?.text, 800);
    if (messageText)
      receipt.latestMessage = {
        text: messageText,
        truncated: message?.truncated === true || messageText !== message?.text
      };
  }
  for (const key of ['status', 'waitOutcome', 'waitFor', 'mode', 'reason', 'executionId']) {
    const field = text(value[key]);
    if (field) receipt[key] = field;
  }
  for (const key of ['message', 'cancel', 'goal', 'approval', 'observation']) {
    const item = value[key];
    if (!isPlainRecord(item)) continue;
    receipt[key] = {
      ...(text(item.status) ? { status: text(item.status) } : {}),
      ...(text(item.code) ? { code: text(item.code) } : {}),
      ...(isPlainRecord(item.result) && text(item.result.delivery)
        ? { delivery: text(item.result.delivery) }
        : {})
    };
  }
  if (Array.isArray(rows)) receipt.count = rows.length;
  if (action === 'wait' && Array.isArray(rows))
    receipt.agents = rows.slice(0, 8).map((entry) => {
      const agent = isPlainRecord(entry) ? entry : {};
      return {
        agentId: text(agent.agentId),
        status: text(agent.status),
        waitOutcome: text(agent.waitOutcome),
        summary: text(agent.summary, 800),
        latestMessage: latestWaitMessage(agent.updates),
        ...(agent.summaryTruncated === true ||
        (typeof agent.summary === 'string' && agent.summary.length > 800)
          ? { summaryTruncated: true }
          : {})
      };
    });
  if (action === 'wait' && !Array.isArray(rows))
    receipt.latestMessage = latestWaitMessage(value.updates);
  const summary = text(value.summary, 4000);
  if (summary) receipt.summary = summary;
  if (
    value.summaryTruncated === true ||
    (typeof value.summary === 'string' && value.summary.length > 4000)
  )
    receipt.summaryTruncated = true;
  return {
    eventData: { agentOperation: presentation },
    eventSummary: JSON.stringify(receipt)
  };
}
