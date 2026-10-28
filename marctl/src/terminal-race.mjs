import { prepareRelayTransport } from './terminal-relay.mjs';
import { DirectFallbackError, DirectRejectedError } from './direct-errors.mjs';

export async function raceTerminalConnections({
  openDirectTerminal,
  directOptions,
  client,
  WebSocketClass,
  nodeId,
  terminalId,
  translate,
  connectionTimeoutMs,
  signal
}) {
  if (signal?.aborted) throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
  const abort = new AbortController();
  const relayAbort = new AbortController();
  const preparing = new Set(['direct', 'relay']);
  let start;
  const preparation = new Promise((resolve) => {
    start = resolve;
  });
  const prepared = (candidate) => {
    preparing.delete(candidate);
    if (preparing.size === 0) start();
    return preparation;
  };
  let selected;
  let announce;
  const first = new Promise((resolve) => {
    announce = resolve;
  });
  const select = (candidate) => {
    if (selected) return false;
    selected = candidate;
    announce(candidate);
    if (candidate === 'relay') abort.abort();
    else relayAbort.abort();
    return true;
  };
  const cancel = () => {
    abort.abort();
    relayAbort.abort();
    if (selected) return;
    selected = 'cancel';
    start();
    announce('cancel');
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const direct = openDirectTerminal({
    ...directOptions,
    signal: abort.signal,
    onPrepared: () => prepared('direct'),
    onRejected: () => select('direct'),
    onIceConnected: () => {
      if (!select('direct')) throw new Error('DIRECT_RACE_CANCELLED');
    },
    onTransportReady: () => {
      if (selected !== 'direct') throw new Error('DIRECT_RACE_CANCELLED');
    }
  }).then(
    (value) => {
      if (selected === 'cancel' || signal?.aborted) value.close();
      return { value };
    },
    (error) => {
      prepared('direct');
      if (error instanceof DirectRejectedError) select('direct');
      return { error };
    }
  );
  const relay = prepareRelayTransport({
    client,
    WebSocketClass,
    nodeId,
    terminalId,
    translate,
    connectionTimeoutMs,
    signal: relayAbort.signal,
    onPrepared: () => prepared('relay')
  }).then(
    (value) => {
      if (!select('relay')) value.close();
      return { value };
    },
    (error) => {
      prepared('relay');
      return { error };
    }
  );
  const winner = await Promise.race([
    first,
    Promise.all([direct, relay]).then(() => selected ?? 'none')
  ]);
  if (winner === 'cancel' || signal?.aborted) {
    signal?.removeEventListener('abort', cancel);
    abort.abort();
    relayAbort.abort();
    throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
  }
  if (winner === 'direct') {
    const result = await direct;
    signal?.removeEventListener('abort', cancel);
    if (result.error) throw result.error;
    return result.value;
  }
  if (winner === 'relay') {
    const result = await relay;
    signal?.removeEventListener('abort', cancel);
    if (result.error) throw result.error;
    return result.value.activate(signal);
  }
  const [directResult, relayResult] = await Promise.all([direct, relay]);
  signal?.removeEventListener('abort', cancel);
  if (directResult.error instanceof DirectRejectedError) throw directResult.error;
  throw relayResult.error ?? directResult.error;
}
