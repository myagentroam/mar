import { randomUUID } from 'node:crypto';
import { messageContent, imageAttachments } from './session-input.mjs';

export async function prepareSessionRequest({ args, env, stdin, translate, sessionId, targeted }) {
  const body = { action: args.action };
  for (const name of [
    'sessionId',
    'parentSessionId',
    'runner',
    'model',
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
  if (args.images !== undefined) {
    body.attachments = await imageAttachments(args.images, translate);
    body.content ??= '';
  }
  if (args.action === 'start' || args.action === 'send')
    body.clientMessageId = args.clientMessageId ?? randomUUID();
  if (args.action === 'send')
    body.deliveryIntent = args.steer === true ? 'REPLACE_CURRENT' : 'QUEUE';
  return Object.freeze(body);
}
