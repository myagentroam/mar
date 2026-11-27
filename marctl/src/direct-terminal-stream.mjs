import { randomUUID } from 'node:crypto';
import { withTimeout } from './direct-control.mjs';
import { DirectFallbackError, directControlError } from './direct-errors.mjs';
import { terminalNodeStream } from './terminal-node-stream.mjs';

/** Binds one Terminal grant and its lease to a stream on the already admitted ICE path. */
export async function openDirectTerminalStream({
  path,
  live,
  nodeId,
  nodeGeneration,
  transportSessionId,
  heartbeatMs,
  timeoutMs,
  request,
  signal
}) {
  signal.throwIfAborted();
  if (path.closed) return undefined;
  const { terminalId, computer } = request;
  let pending;
  let prepared;
  try {
    pending = requestTerminalGrant(live, {
      nodeId,
      nodeGeneration,
      transportSessionId,
      terminalId,
      computer,
      afterSequence: 0
    });
    prepared = await withTimeout(pending, timeoutMs, 'TERMINAL_DIRECT_PREPARE_FAILED', signal);
  } catch (error) {
    void pending?.then(
      ({ directSessionId }) => live.send({ type: 'terminal.direct.cancel', directSessionId }),
      () => undefined
    );
    if (error instanceof DirectFallbackError && !signal.aborted) return undefined;
    throw error;
  }

  const { directSessionId, grant } = prepared;
  const scope = new AbortController();
  let stream;
  const unsubscribe = live.onControl((message) => {
    if (message.directSessionId !== directSessionId) return;
    if (message.type === 'terminal.direct.closed' || message.type === 'terminal.direct.error') {
      scope.abort(directControlError(message.code));
      stream?.close();
    }
  });
  let heartbeat;
  const release = () => {
    clearInterval(heartbeat);
    unsubscribe();
    live.send({ type: 'terminal.direct.cancel', directSessionId });
  };
  try {
    stream = await path.openStream(
      { kind: 'terminal', grant },
      AbortSignal.any([signal, scope.signal, AbortSignal.timeout(timeoutMs)])
    );
    if (stream === undefined) {
      release();
      return undefined;
    }
    scope.signal.throwIfAborted();
    heartbeat = setInterval(() => {
      if (!live.send({ type: 'terminal.direct.heartbeat', directSessionId })) stream.close();
    }, heartbeatMs);
    heartbeat.unref?.();
    return terminalNodeStream(stream, request, release);
  } catch (error) {
    stream?.close();
    release();
    throw scope.signal.aborted ? scope.signal.reason : error;
  }
}

function requestTerminalGrant(
  live,
  { nodeId, nodeGeneration, transportSessionId, terminalId, computer, afterSequence }
) {
  return live.request(
    {
      type: 'terminal.direct.prepare',
      requestId: randomUUID().replaceAll('-', ''),
      nodeId,
      nodeGeneration,
      transportSessionId,
      terminalId,
      ...(computer ? { computer: true } : {}),
      afterSequence,
      readonly: false
    },
    (message, request) =>
      message.type === 'terminal.direct.prepared' &&
      message.requestId === request.requestId &&
      typeof message.directSessionId === 'string' &&
      typeof message.grant === 'string',
    'TERMINAL_DIRECT_PREPARE_FAILED'
  );
}
