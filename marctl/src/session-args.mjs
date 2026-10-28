import { MarctlError } from './errors.mjs';
import { createTranslator } from './i18n/index.mjs';
import { sessionTarget } from './session-target.mjs';

const commands = {
  current: [],
  list: ['cursor', 'limit', 'query', 'parent'],
  graph: ['limit'],
  show: [],
  history: ['cursor', 'limit'],
  start: [
    'runner',
    'model',
    'effort',
    'title',
    'message',
    'message-file',
    'image',
    'client-message-id'
  ],
  config: ['model', 'effort'],
  rename: ['title'],
  'prompt.get': [],
  'prompt.set': ['message', 'message-file'],
  'prompt.clear': [],
  'approval.decide': ['run', 'approval', 'decision'],
  'schedule.list': ['cursor', 'limit'],
  'schedule.get': [],
  'schedule.create': ['cron', 'message', 'message-file'],
  'schedule.update': ['cron', 'message', 'message-file', 'expected-revision'],
  send: ['message', 'message-file', 'image', 'steer', 'queue', 'client-message-id'],
  stop: ['run'],
  'goal.get': [],
  'goal.set': ['message', 'message-file'],
  'goal.clear': [],
  wait: ['run', 'timeout', 'until']
};
const fieldNames = {
  parent: 'parentSessionId',
  'expected-revision': 'expectedRevision',
  'message-file': 'messageFile',
  'client-message-id': 'clientMessageId',
  run: 'runId',
  approval: 'approvalId',
  timeout: 'timeoutMs',
  image: 'images'
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
    return { command: 'sessions', help: true };
  const input = [...argv];
  let action = input.shift();
  if (['goal', 'schedule', 'prompt', 'approval'].includes(action)) action += '.' + input.shift();
  if (!Object.hasOwn(commands, action)) throw invalid();
  const args = { command: 'sessions', action };
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
    const name = flag.startsWith('--') ? flag.slice(2) : '';
    const key = fieldNames[name] ?? name;
    if (!commands[action].includes(name) || (name !== 'image' && Object.hasOwn(args, key)))
      throw invalid();
    const value = input.shift();
    if (
      value === undefined ||
      (value === '' && name !== 'effort') ||
      (name !== 'message' && value.startsWith('--'))
    )
      throw invalid();
    if (name === 'image') {
      (args.images ??= []).push(value);
      if (args.images.length > 5) throw invalid();
    } else if (name === 'limit' || name === 'expected-revision') {
      if (
        !/^[1-9][0-9]*$/u.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        (name === 'limit' && Number(value) > 100)
      )
        throw invalid();
      args[key] = Number(value);
    } else if (name === 'timeout') {
      const match = /^([1-9][0-9]*)(ms|s|m)$/u.exec(value);
      const ms = match === null ? 0 : Number(match[1]) * { ms: 1, s: 1000, m: 60000 }[match[2]];
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > 3600000) throw invalid();
      args[key] = ms;
    } else args[key] = value;
  }
  if (action === 'send' && (args.steer === true) === (args.queue === true))
    throw invalid('errors.sessionDeliveryRequired');
  if (args.message !== undefined && args.messageFile !== undefined) throw invalid();
  if (
    ['start', 'send', 'goal.set', 'schedule.create', 'prompt.set'].includes(action) &&
    args.messageFile === undefined &&
    args.message === undefined &&
    !args.images?.length
  )
    throw invalid();
  if (
    action === 'start' &&
    !['mar-agent', 'codex', 'claude-code', 'opencode'].includes(args.runner)
  )
    throw invalid();
  if (action === 'wait' && (args.runId === undefined || args.timeoutMs === undefined))
    throw invalid();
  if (args.until !== undefined && args.until !== 'approval')
    throw invalid(undefined, '--until: expected approval.');
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
  if (args.model !== undefined && (args.model.trim().length === 0 || args.model.length > 120))
    throw invalid();
  if (args.effort !== undefined && args.effort.length > 120) throw invalid();
  if (action === 'config' && args.model === undefined && args.effort === undefined) throw invalid();
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
