import { randomUUID } from 'node:crypto';
import { messageContent } from './session-input.mjs';
import { MarctlError } from './errors.mjs';

const networkActions = new Set(['start', 'send', 'wait', 'stop', 'list', 'view']);

/** Adapt CLI syntax to the same Node Agent Network command used by native tools. */
export async function prepareAgentNetworkRequest({ args, stdin, translate, sessionId }) {
  const input = {};
  for (const name of [
    'runner',
    'modelId',
    'effort',
    'title',
    'cursor',
    'limit',
    'query',
    'parentSessionId',
    'scope',
    'waitFor',
    'mode'
  ])
    if (args[name] !== undefined) input[name] = args[name];
  if (['send', 'stop', 'view'].includes(args.action) && sessionId) input.agentId = sessionId;
  if (args.action === 'wait') {
    const agentIds = sessionId ? [sessionId] : args.agentIds;
    if (agentIds !== undefined) input.agentIds = agentIds;
    if (args.timeoutMs !== undefined) input.waitMs = args.timeoutMs;
  }
  if (args.message !== undefined || args.messageFile !== undefined)
    input.content = await messageContent(args, stdin, 100000, translate);
  if (args.goal !== undefined) input.goal = { objective: args.goal.trim() };
  if (args.clearGoal) input.goal = { clear: true };
  if (args.action === 'send' && args.approvalId !== undefined)
    input.approval = { approvalId: args.approvalId, decision: args.decision };
  if (args.action === 'start' || args.action === 'send')
    input.clientMessageId = args.clientMessageId ?? randomUUID();
  if (args.action === 'send' && input.content !== undefined)
    input.deliveryIntent = args.queue ? 'QUEUE' : 'REPLACE_CURRENT';
  return { action: 'network', command: { operation: args.action, input } };
}

export function isAgentNetworkAction(action) {
  return networkActions.has(action);
}

// Adapt task commands without reimplementing the Server's time-group schema or Node's rules.
async function prepareScheduleRequest(args, env, stdin, translate) {
  const { action, taskId, sessionId, cursor, limit, page, expectedRevision, name, groupsFile } =
    args;
  if (action === 'schedule.list') {
    return {
      action,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit })
    };
  }
  if (action === 'schedule.get') return { action, taskId };
  if (action === 'schedule.runs') return { action, taskId, occurrencePage: page ?? 1 };

  let target;
  if (action === 'schedule.create') {
    const targetSessionId = sessionId ?? env.MAR_CTL_SESSION_ID;
    if (!args.newSession && !targetSessionId)
      throw new MarctlError(translate('errors.scheduleContextRequired'), {
        code: 'MARCTL_SESSION_CONTEXT_REQUIRED'
      });
    target = args.newSession
      ? {
          kind: 'newSession',
          runner: args.runner,
          model: args.defaultModel ? { kind: 'default' } : { kind: 'fixed', modelId: args.modelId },
          ...(args.effort === undefined ? {} : { effort: args.effort })
        }
      : { kind: 'existing', sessionId: targetSessionId };
  }
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (groupsFile !== undefined) {
    try {
      const groups = JSON.parse(
        await messageContent({ messageFile: groupsFile }, stdin, 64_000, translate)
      );
      if (!Array.isArray(groups) || groups.length === 0) throw new Error('GROUPS_INVALID');
      fields.groups = groups;
    } catch {
      throw new MarctlError(translate('errors.scheduleGroupsInvalid'), {
        code: 'MARCTL_SESSION_INPUT_INVALID'
      });
    }
  }
  if (args.messageFile !== undefined || args.message !== undefined)
    fields.objective = await messageContent(args, stdin, 20_000, translate);
  return target === undefined
    ? { action, taskId, expectedRevision, patch: fields }
    : { action, target, ...fields };
}

export async function prepareSessionRequest({ args, env, stdin, translate, sessionId, targeted }) {
  if (args.action.startsWith('schedule.'))
    return Object.freeze(await prepareScheduleRequest(args, env, stdin, translate));
  const body = { action: args.action };
  for (const name of [
    'sessionId',
    'parentSessionId',
    'runner',
    'modelId',
    'effort',
    'title',
    'cursor',
    'limit',
    'query',
    'runId',
    'approvalId'
  ])
    if (args[name] !== undefined) body[name] = args[name];
  if (targeted) body.sessionId = sessionId;
  if (args.action === 'current' && env.MAR_CTL_SESSION_ID) body.sessionId = env.MAR_CTL_SESSION_ID;
  if (args.action === 'start' && env.MAR_CTL_SESSION_ID)
    body.parentSessionId = env.MAR_CTL_SESSION_ID;
  if (['start', 'send'].includes(args.action) && env.MAR_CTL_SESSION_ID)
    body.sourceSessionId = env.MAR_CTL_SESSION_ID;
  if (args.messageFile !== undefined || args.message !== undefined)
    body.content = await messageContent(
      args,
      stdin,
      args.action === 'goal.set' || args.action === 'prompt.set' ? 20_000 : 100_000,
      translate,
      args.action === 'prompt.set'
    );
  if (args.action === 'approval.decide')
    body.decision = args.decision === 'approve' ? 'APPROVED' : 'REJECTED';
  if (args.action === 'start' || args.action === 'send')
    body.clientMessageId = args.clientMessageId ?? randomUUID();
  if (args.action === 'send')
    body.deliveryIntent = args.steer === true ? 'REPLACE_CURRENT' : 'QUEUE';
  return Object.freeze(body);
}
