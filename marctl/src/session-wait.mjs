import { randomUUID } from 'node:crypto';
import { MarctlError } from './errors.mjs';
import { createTranslator } from './i18n/index.mjs';

const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

/** One CLI-owned Workbench connection and one existing Session Watch, never history polling. */
export async function waitForSessionRun({
  client,
  sessionId,
  runId,
  timeoutMs,
  until,
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
  const checkApproval = () => {
    if (settled || until !== 'approval' || progress === undefined) return;
    if (!Array.isArray(progress.pendingApprovals)) {
      fail('NODE_OPERATION_UNSUPPORTED', 'errors.sessionApprovalUnsupported', {
        stage: 'approval'
      });
      return;
    }
    const pendingApprovals = progress.pendingApprovals.filter(
      (approval) => approval.runId === runId
    );
    if (pendingApprovals.length === 0) return;
    settled = true;
    accept({
      sessionId,
      runId,
      stopReason: 'APPROVAL_REQUIRED',
      pendingApprovals,
      ...(progress.pendingApprovalsTruncated ? { pendingApprovalsTruncated: true } : {})
    });
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
      if (!settled && until === 'approval' && progress === undefined) {
        fail('NODE_OPERATION_UNSUPPORTED', 'errors.sessionApprovalUnsupported', {
          stage: 'approval'
        });
      }
      checkApproval();
    } else if (message.type === 'watch.session.event') {
      const payload = message.event?.payload;
      if (
        (payload?.sessionId ?? payload?.run?.sessionId) === sessionId &&
        payload?.progress?.runId === runId
      )
        progress = payload.progress;
      check(payload?.run);
      checkApproval();
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
