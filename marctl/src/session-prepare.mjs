import { randomUUID } from 'node:crypto';
import { messageContent } from './session-input.mjs';

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
    'mode',
    'executionId'
  ])
    if (args[name] !== undefined) input[name] = args[name];
  if (['send', 'stop', 'view', 'wait'].includes(args.action) && sessionId)
    input.agentId = sessionId;
  if (args.action === 'wait' && args.agentIds?.length) input.agentIds = args.agentIds;
  if (args.action === 'wait' && args.timeoutMs !== undefined) input.waitMs = args.timeoutMs;
  if (args.action === 'view' && args.history) input.includeHistory = true;
  if (args.message !== undefined || args.messageFile !== undefined)
    input.content = await messageContent(args, stdin, 100000, translate);
  if (args.goal !== undefined) input.goal = { objective: args.goal.trim() };
  if (args.clearGoal) input.goal = { clear: true };
  if (args.action === 'send' && args.approvalId !== undefined)
    input.approval = { approvalId: args.approvalId, decision: args.decision };
  if (args.action === 'start' || args.action === 'send')
    input.clientMessageId = args.clientMessageId ?? randomUUID();
  if (args.action === 'send')
    input.deliveryIntent = args.steer ? 'REPLACE_CURRENT' : args.queue ? 'QUEUE' : 'SEND';
  return { action: 'network', command: { operation: args.action, input } };
}

export function isAgentNetworkAction(action) {
  return networkActions.has(action);
}

export async function prepareSessionRequest({ args, env, stdin, translate, sessionId, targeted }) {
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
    'approvalId',
    'cron',
    'expectedRevision'
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
      args.action === 'goal.set' ||
        args.action.startsWith('schedule.') ||
        args.action === 'prompt.set'
        ? 20000
        : 100000,
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
