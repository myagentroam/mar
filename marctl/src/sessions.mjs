import { MarctlError } from './errors.mjs';
import { sessionTarget } from './session-target.mjs';
import {
  isAgentNetworkAction,
  prepareAgentNetworkRequest,
  prepareSessionRequest
} from './session-prepare.mjs';
import { waitForSessionRun } from './session-wait.mjs';

export async function runSessionCommand({
  args,
  client,
  env,
  stdin,
  WebSocketClass,
  translate,
  signal
}) {
  args = { ...args, ...(args.images === undefined ? {} : { images: [...args.images] }) };
  const targeted = sessionTarget[args.action] !== 'workspace';
  const sessionId =
    args.sessionId ??
    (sessionTarget[args.action] === 'current' ? env.MAR_CTL_SESSION_ID : undefined);
  if (targeted && !sessionId && sessionTarget[args.action] !== 'optional')
    throw new MarctlError(translate('errors.sessionContextRequired'), {
      code: 'MARCTL_SESSION_CONTEXT_REQUIRED'
    });
  if (args.action === 'wait' && args.runId !== undefined)
    return waitForSessionRun({
      client,
      sessionId,
      runId: args.runId,
      timeoutMs: args.timeoutMs ?? 30000,
      until: args.until,
      WebSocketClass,
      translate,
      signal
    });
  const network = isAgentNetworkAction(args.action);
  const body = network
    ? await prepareAgentNetworkRequest({ args, stdin, translate, sessionId })
    : await prepareSessionRequest({ args, env, stdin, translate, sessionId, targeted });
  const clientMessageId = network ? body.command.input.clientMessageId : body.clientMessageId;
  try {
    const requestedWait = args.timeoutMs ?? 30000;
    const effectiveWait = requestedWait === 0 ? 0 : Math.max(10000, requestedWait);
    const result = await client.sessionCommand(
      body,
      args.action === 'wait' ? { timeoutMs: effectiveWait + 10000, signal } : undefined
    );
    return {
      ...result,
      ...(typeof result?.session?.id === 'string' ? { sessionId: result.session.id } : {}),
      ...(typeof result?.run?.id === 'string' ? { runId: result.run.id } : {}),
      ...(clientMessageId === undefined ? {} : { clientMessageId })
    };
  } catch (error) {
    if (clientMessageId !== undefined) error.clientMessageId = clientMessageId;
    if (
      [
        'start',
        'send',
        'config',
        'rename',
        'prompt.set',
        'prompt.clear',
        'approval.decide',
        'schedule.create',
        'schedule.update',
        'stop',
        'goal.set',
        'goal.clear'
      ].includes(args.action) &&
      ['MARCTL_REQUEST_TIMEOUT', 'MARCTL_SERVER_UNREACHABLE', 'MARCTL_RESPONSE_INVALID'].includes(
        error.code
      )
    ) {
      error.code = 'MARCTL_OUTCOME_UNKNOWN';
      error.message = translate('errors.sessionOutcomeUnknown');
    }
    throw error;
  }
}

export function sessionExitCode(error) {
  if (error.code === 'MARCTL_SESSION_INPUT_INVALID') return 2;
  if ([401, 403].includes(error.statusCode)) return 3;
  if (error.code?.includes('UNSUPPORTED')) return 4;
  if (error.code === 'MARCTL_WAIT_TIMEOUT' || error.code === 'MARCTL_REQUEST_TIMEOUT') return 5;
  if (['MARCTL_OUTCOME_UNKNOWN', 'MARCTL_WAIT_UNKNOWN'].includes(error.code)) return 6;
  if (error.code === 'MARCTL_WAIT_CANCELLED') return 130;
  return 1;
}
