import { MarctlError } from './errors.mjs';
import { createTranslator } from './i18n/index.mjs';
import { sessionTarget } from './session-target.mjs';

const commands = {
  current: [],
  list: ['scope', 'query', 'limit'],
  graph: ['limit'],
  show: [],
  view: [],
  history: ['cursor', 'limit'],
  start: [
    'runner',
    'model-id',
    'effort',
    'title',
    'message',
    'message-file',
    'client-message-id',
    'parent',
    'goal',
    'clear-goal'
  ],
  config: ['model-id', 'effort'],
  rename: ['title'],
  'prompt.get': [],
  'prompt.set': ['message', 'message-file'],
  'prompt.clear': [],
  'approval.decide': ['run', 'approval', 'decision'],
  'schedule.list': ['cursor', 'limit'],
  'schedule.get': [],
  'schedule.create': ['cron', 'message', 'message-file'],
  'schedule.update': ['cron', 'message', 'message-file', 'expected-revision'],
  send: [
    'message',
    'message-file',
    'steer',
    'queue',
    'client-message-id',
    'goal',
    'clear-goal',
    'approval',
    'decision'
  ],
  stop: ['execution'],
  'goal.get': [],
  'goal.set': ['message', 'message-file'],
  'goal.clear': [],
  wait: ['timeout', 'wait-for', 'mode', 'agent', 'run', 'until']
};
const fieldNames = {
  'model-id': 'modelId',
  parent: 'parentSessionId',
  'expected-revision': 'expectedRevision',
  'message-file': 'messageFile',
  'client-message-id': 'clientMessageId',
  run: 'runId',
  approval: 'approvalId',
  timeout: 'timeoutMs',
  execution: 'executionId',
  'wait-for': 'waitFor',
  'clear-goal': 'clearGoal'
};

export function parseSessionArgs(argv, translate = createTranslator()) {
  const invalid = (key = 'errors.invalidArguments', details) =>
    new MarctlError(translate(key), {
      code: 'MARCTL_SESSION_INPUT_INVALID',
      details:
        details ??
        (argv[0] === 'prompt'
          ? 'Use prompt get|clear [session-id], or prompt set [session-id] with exactly one of -m/--message or --message-file.'
          : argv[0] === 'approval'
            ? 'Use approval decide <session-id> --run <run-id> --approval <approval-id> --decision approve|reject.'
            : undefined)
    });
  if (
    argv.length === 0 ||
    argv.some(
      (value, index) =>
        (value === '--help' || value === '-h') && !['-m', '--message'].includes(argv[index - 1])
    )
  )
    return { command: 'agents', help: true };
  const input = [...argv];
  let action = input.shift();
  if (['goal', 'schedule', 'prompt', 'approval'].includes(action)) action += '.' + input.shift();
  if (!Object.hasOwn(commands, action)) throw invalid();
  const args = { command: 'agents', action };
  if (sessionTarget[action] !== 'workspace') {
    if (
      (input[0] === undefined || input[0].startsWith('-')) &&
      sessionTarget[action] === 'explicit'
    )
      throw invalid();
    if (input[0] !== undefined && !input[0].startsWith('-')) {
      const sessionId = input.shift();
      if (!sessionId || sessionId.length > 512) throw invalid();
      args.sessionId = sessionId;
    }
  }
  while (input.length > 0) {
    const rawFlag = input.shift();
    const flag = rawFlag === '-m' ? '--message' : rawFlag;
    if (flag === '--json' && args.json === undefined) {
      args.json = true;
      continue;
    }
    if (action === 'send' && (flag === '--steer' || flag === '--queue')) {
      const key = flag.slice(2);
      if (Object.hasOwn(args, key)) throw invalid();
      args[key] = true;
      continue;
    }
    if (flag === '--clear-goal' && ['start', 'send'].includes(action)) {
      const key = 'clearGoal';
      if (Object.hasOwn(args, key)) throw invalid();
      args[key] = true;
      continue;
    }
    const name = flag.startsWith('--') ? flag.slice(2) : '';
    const key = fieldNames[name] ?? name;
    if (
      !commands[action].includes(name) ||
      (!(name === 'agent' && action === 'wait') && Object.hasOwn(args, key))
    )
      throw invalid();
    const value = input.shift();
    if (
      value === undefined ||
      (value === '' && name !== 'effort') ||
      (name !== 'message' && value.startsWith('--'))
    )
      throw invalid();
    if (name === 'agent' && action === 'wait') {
      (args.agentIds ??= []).push(value);
      if (args.agentIds.length > 8) throw invalid();
    } else if (name === 'limit' || name === 'expected-revision') {
      if (
        !/^[1-9][0-9]*$/u.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        (name === 'limit' && Number(value) > 100)
      )
        throw invalid();
      args[key] = Number(value);
    } else if (name === 'timeout') {
      const match = /^(0|[1-9][0-9]*)(ms|s|m)$/u.exec(value);
      const ms = match === null ? 0 : Number(match[1]) * { ms: 1, s: 1000, m: 60000 }[match[2]];
      if (match === null || !Number.isSafeInteger(ms) || ms > 300000) throw invalid();
      args[key] = ms;
    } else args[key] = value;
  }
  if (action === 'send' && args.steer === true && args.queue === true)
    throw invalid('errors.sessionDeliveryRequired');
  if (
    action === 'send' &&
    ((args.approvalId === undefined) !== (args.decision === undefined) ||
      (args.decision !== undefined && !['approve', 'reject'].includes(args.decision)))
  )
    throw invalid();
  if (args.goal !== undefined && (args.clearGoal || !args.goal.trim() || args.goal.length > 20000))
    throw invalid();
  if (args.message !== undefined && args.messageFile !== undefined) throw invalid();
  if (
    ['start', 'send', 'goal.set', 'schedule.create', 'prompt.set'].includes(action) &&
    args.messageFile === undefined &&
    args.message === undefined &&
    !(
      action === 'send' &&
      (args.goal !== undefined || args.clearGoal || args.approvalId !== undefined)
    )
  )
    throw invalid();
  if (
    action === 'start' &&
    args.runner !== undefined &&
    !['mar-agent', 'codex', 'claude-code', 'opencode'].includes(args.runner)
  )
    throw invalid();
  if (action === 'stop' && !args.executionId) throw invalid();
  if (action === 'wait' && args.sessionId && args.agentIds?.length) throw invalid();
  if (
    args.until !== undefined &&
    (args.until !== 'approval' ||
      !args.sessionId ||
      !args.runId ||
      !args.timeoutMs ||
      args.agentIds?.length)
  )
    throw invalid();
  if (
    action === 'wait' &&
    args.runId !== undefined &&
    (!args.sessionId ||
      args.timeoutMs === 0 ||
      args.agentIds?.length ||
      args.mode !== undefined ||
      args.waitFor !== undefined)
  )
    throw invalid();
  if (args.waitFor !== undefined && !['message', 'completion'].includes(args.waitFor))
    throw invalid();
  if (args.mode !== undefined && !['any', 'all'].includes(args.mode)) throw invalid();
  if (args.scope !== undefined && !['tree', 'active'].includes(args.scope)) throw invalid();
  if (
    action === 'approval.decide' &&
    (!args.runId || !args.approvalId || !['approve', 'reject'].includes(args.decision))
  )
    throw invalid(
      undefined,
      'Approval decisions require --run, --approval and --decision approve|reject.'
    );
  if (action === 'rename' && args.title !== undefined) args.title = args.title.trim();
  if (args.title !== undefined && args.title.length > 160) throw invalid();
  if (args.modelId !== undefined && (args.modelId.trim().length === 0 || args.modelId.length > 120))
    throw invalid();
  if (args.effort !== undefined && args.effort.length > 120) throw invalid();
  if (action === 'config' && args.modelId === undefined && args.effort === undefined)
    throw invalid();
  if (action === 'rename') {
    if (args.title === undefined || args.title.trim().length === 0) throw invalid();
  }
  if (action === 'schedule.create' && args.cron === undefined) throw invalid();
  if (args.cron !== undefined && (args.cron.trim().length === 0 || args.cron.length > 512))
    throw invalid();
  if (
    action === 'schedule.update' &&
    (args.expectedRevision === undefined ||
      (args.cron === undefined && args.message === undefined && args.messageFile === undefined))
  )
    throw invalid();
  if (args.query !== undefined && args.query.length > 160) throw invalid();
  if (args.parentSessionId !== undefined && args.parentSessionId.length > 512) throw invalid();
  return args;
}
