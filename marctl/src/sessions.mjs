import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { MarctlError } from './config.mjs';
import { createTranslator } from './i18n/index.mjs';

const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
const currentSessionActions = new Set([
  'show',
  'config',
  'history',
  'graph',
  'rename',
  'schedule.get',
  'schedule.create',
  'schedule.update'
]);
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
  'schedule.list': ['cursor', 'limit'],
  'schedule.get': [],
  'schedule.create': ['cron', 'message', 'message-file'],
  'schedule.update': ['cron', 'message', 'message-file', 'expected-revision'],
  send: ['message', 'message-file', 'image', 'steer', 'queue', 'client-message-id'],
  stop: ['run'],
  'goal.get': [],
  'goal.set': ['message', 'message-file'],
  'goal.clear': [],
  wait: ['run', 'timeout']
};
const fieldNames = {
  parent: 'parentSessionId',
  'expected-revision': 'expectedRevision',
  'message-file': 'messageFile',
  'client-message-id': 'clientMessageId',
  run: 'runId',
  timeout: 'timeoutMs',
  image: 'images'
};

export function parseSessionArgs(argv, translate = createTranslator()) {
  const invalid = (key = 'errors.invalidArguments') =>
    new MarctlError(translate(key), { code: 'MARCTL_SESSION_INPUT_INVALID' });
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
  if (action === 'goal' || action === 'schedule') action += '.' + input.shift();
  if (!Object.hasOwn(commands, action)) throw invalid();
  const args = { command: 'sessions', action };
  if (!['current', 'list', 'start', 'schedule.list'].includes(action)) {
    if ((input[0] === undefined || input[0].startsWith('-')) && !currentSessionActions.has(action))
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
    ['start', 'send', 'goal.set', 'schedule.create'].includes(action) &&
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

export async function runSessionCommand({ args, client, env, stdin, WebSocketClass, translate }) {
  const targeted = !['current', 'list', 'start', 'schedule.list'].includes(args.action);
  const sessionId =
    args.sessionId ?? (currentSessionActions.has(args.action) ? env.MAR_CTL_SESSION_ID : undefined);
  if (targeted && !sessionId)
    throw new MarctlError(translate('errors.sessionContextRequired'), {
      code: 'MARCTL_SESSION_CONTEXT_REQUIRED'
    });
  if (args.action === 'wait') {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      return await waitForSessionRun({
        client,
        sessionId,
        runId: args.runId,
        timeoutMs: args.timeoutMs,
        WebSocketClass,
        translate,
        signal: controller.signal
      });
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }
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
      args.action === 'goal.set' || args.action.startsWith('schedule.') ? 20000 : 100000,
      translate
    );
  if (args.images !== undefined) {
    body.attachments = await imageAttachments(args.images, translate);
    body.content ??= '';
  }
  if (args.action === 'start' || args.action === 'send')
    body.clientMessageId = args.clientMessageId ?? randomUUID();
  if (args.action === 'send')
    body.deliveryIntent = args.steer === true ? 'REPLACE_CURRENT' : 'QUEUE';
  try {
    const result = await client.sessionCommand(body);
    return {
      ...result,
      ...(typeof result?.session?.id === 'string' ? { sessionId: result.session.id } : {}),
      ...(typeof result?.run?.id === 'string' ? { runId: result.run.id } : {}),
      ...(body.clientMessageId === undefined ? {} : { clientMessageId: body.clientMessageId })
    };
  } catch (error) {
    if (body.clientMessageId !== undefined) error.clientMessageId = body.clientMessageId;
    if (
      [
        'start',
        'send',
        'config',
        'rename',
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

async function messageContent({ message, messageFile: path }, stdin, limit, translate) {
  let file;
  try {
    let content = message;
    if (content === undefined) {
      const input =
        path === '-'
          ? stdin
          : (file = await open(path, 'r')).createReadStream({ autoClose: false });
      const parts = [];
      let bytes = 0;
      for await (const part of input) {
        const chunk = Buffer.from(part);
        bytes += chunk.length;
        if (bytes > limit * 4) throw new Error('MESSAGE_TOO_LONG');
        parts.push(chunk);
      }
      content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
    }
    if (content.trim().length === 0 || content.length > limit) throw new Error('MESSAGE_INVALID');
    return content;
  } catch {
    throw new MarctlError(translate('errors.sessionMessageInvalid'), {
      code: 'MARCTL_SESSION_INPUT_INVALID'
    });
  } finally {
    await file?.close();
  }
}

async function imageAttachments(paths, translate) {
  const attachments = [];
  let total = 0;
  for (const path of paths) {
    let file;
    try {
      file = await open(path, 'r');
      const info = await file.stat();
      if (!info.isFile() || info.size === 0 || info.size > 5 * 1024 * 1024)
        throw new Error('IMAGE_INVALID');
      const parts = [];
      let size = 0;
      for await (const part of file.createReadStream({ autoClose: false })) {
        size += part.length;
        total += part.length;
        if (size > 5 * 1024 * 1024 || total > 10 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
        parts.push(part);
      }
      const data = Buffer.concat(parts);
      const mime = imageMime(data);
      if (mime === undefined) throw new Error('IMAGE_INVALID');
      attachments.push({ name: basename(path), mime, dataBase64: data.toString('base64') });
    } catch {
      throw new MarctlError(translate('errors.sessionImageInvalid'), {
        code: 'MARCTL_SESSION_INPUT_INVALID'
      });
    } finally {
      await file?.close();
    }
  }
  return attachments;
}

function imageMime(data) {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
}

/** One CLI-owned Workbench connection and one existing Session Watch, never history polling. */
export async function waitForSessionRun({
  client,
  sessionId,
  runId,
  timeoutMs,
  WebSocketClass,
  translate = createTranslator(),
  signal
}) {
  let socket;
  const watchId = randomUUID();
  let connectionId;
  let renewal;
  let settled = false;
  let subscribed = false;
  let progress;
  let accept;
  let rejectResult;
  const result = new Promise((resolve, fail) => {
    accept = resolve;
    rejectResult = fail;
  });
  const reject = (error, stage) => {
    if (settled) return;
    settled = true;
    Object.assign(error, { sessionId, runId, stage });
    rejectResult(error);
  };
  const fail = (code, key, { stage, upstreamCode, ...options } = {}) => {
    const error = new MarctlError(translate(key), { ...options, code });
    if (upstreamCode !== undefined) error.upstreamCode = upstreamCode;
    if (stage === 'timeout' && progress !== undefined) error.progress = progress;
    reject(error, stage);
  };
  const unknown = (stage, detail, source) =>
    fail('MARCTL_WAIT_UNKNOWN', 'errors.sessionWaitUnknown', {
      stage,
      upstreamCode:
        typeof source?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(source.code)
          ? source.code
          : undefined,
      requestId: typeof source?.requestId === 'string' ? source.requestId.slice(0, 160) : undefined,
      upstreamRequestId:
        typeof source?.upstreamRequestId === 'string'
          ? source.upstreamRequestId.slice(0, 160)
          : undefined,
      details: [detail, source?.message, source?.details]
        .filter((value) => typeof value === 'string')
        .join(' ')
        .slice(0, 4000)
    });
  const command = (mode) =>
    client.sessionCommand({
      action: 'watch',
      sessionId,
      workbenchConnectionId: connectionId,
      watchId,
      mode
    });
  const scheduleRenewal = (expiresAt) => {
    clearTimeout(renewal);
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      unknown('lease', 'The Watch lease is missing or expired.');
      return;
    }
    renewal = setTimeout(
      () => {
        command('renew')
          .then((ack) => {
            if (!settled) scheduleRenewal(ack?.expiresAt);
          })
          .catch((error) => {
            if ([401, 403].includes(error.statusCode)) reject(error, 'renew');
            else
              unknown(
                'renew',
                'The Watch lease could not be renewed.',
                error instanceof MarctlError ? error : undefined
              );
          });
      },
      Math.max(50, Math.floor(remaining / 2))
    );
  };
  const check = (run) => {
    if (run?.id === runId && run.sessionId === sessionId && terminal.has(run.status) && !settled) {
      settled = true;
      accept({ run });
    }
  };
  const onMessage = (raw) => {
    if (settled) return;
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message?.type === 'watch.event') message = message.event;
    if (!message || typeof message !== 'object') return;
    if (
      message.type === 'workbench.ready' &&
      connectionId === undefined &&
      typeof message.workbenchConnectionId === 'string'
    ) {
      connectionId = message.workbenchConnectionId;
      subscribed = true;
      command('initial').catch((error) => reject(error, 'subscribe'));
    }
    if (message.watchId !== watchId) return;
    if (message.type === 'watch.failed') {
      unknown('watch', 'The Session Watch failed.', message);
      return;
    }
    if (message.type === 'watch.session.snapshot') {
      const runs = message.payload?.runs;
      if (!Array.isArray(runs)) {
        unknown('snapshot', 'The Watch snapshot did not contain a Run list.');
        return;
      }
      const run = runs.find((value) => value?.id === runId && value.sessionId === sessionId);
      if (run === undefined) {
        unknown('snapshot', 'The requested Run was absent from the Watch snapshot.');
        return;
      }
      if (message.payload?.session?.id === sessionId && message.payload?.progress?.runId === runId)
        progress = message.payload.progress;
      check(run);
    } else if (message.type === 'watch.session.event') {
      const payload = message.event?.payload;
      if (
        (payload?.sessionId ?? payload?.run?.sessionId) === sessionId &&
        payload?.progress?.runId === runId
      )
        progress = payload.progress;
      check(payload?.run);
    }
    if (!settled && message.expiresAt !== undefined) scheduleRenewal(message.expiresAt);
  };
  const onClose = (code, reason) => {
    if (code === 1008 && String(reason) === 'UNAUTHENTICATED')
      fail('UNAUTHENTICATED', 'errors.userContextUnavailable', {
        statusCode: 401,
        stage: 'connection'
      });
    else
      unknown(
        'connection',
        Number.isInteger(code)
          ? `The Watch connection closed (code ${code}).`
          : 'The Watch connection closed.'
      );
  };
  const onError = (error) =>
    unknown('connection', 'The Watch connection failed.', { code: error?.code });
  const onOpen = () => {
    try {
      socket.send(JSON.stringify({ type: 'resume' }));
    } catch (error) {
      onError(error);
    }
  };
  const onAbort = () =>
    fail('MARCTL_WAIT_CANCELLED', 'errors.sessionWaitCancelled', { stage: 'cancel' });
  try {
    socket = client.openWorkbenchWebSocket(WebSocketClass ?? (await import('ws')).default);
  } catch (error) {
    if (error instanceof MarctlError) reject(error, 'connection');
    else unknown('connection', 'The Watch connection could not be opened.');
    return await result;
  }
  const timer = setTimeout(
    () => fail('MARCTL_WAIT_TIMEOUT', 'errors.sessionWaitTimeout', { stage: 'timeout' }),
    timeoutMs
  );
  socket.on('open', onOpen);
  socket.on('message', onMessage);
  socket.on('error', onError);
  socket.on('close', onClose);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await result;
  } finally {
    settled = true;
    clearTimeout(timer);
    clearTimeout(renewal);
    signal?.removeEventListener('abort', onAbort);
    if (subscribed) await command('stop').catch(() => undefined);
    socket.off('open', onOpen);
    socket.off('message', onMessage);
    socket.off('close', onClose);
    socket.close();
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
