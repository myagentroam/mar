import { MarctlError } from './errors.mjs';
import { DirectRejectedError } from './direct-errors.mjs';
import { createTranslator } from './i18n/index.mjs';
import { raceTerminalConnections } from './terminal-race.mjs';
import { attachTerminalSocket, openRelayTransport } from './terminal-relay.mjs';
import { getDimensions, runAttachedTerminal } from './terminal-interaction.mjs';

const DEFAULT_CONNECTION_TIMEOUT_MS = 15000;

export async function runTerminalSession({
  client,
  WebSocketClass,
  nodeId,
  command,
  copy,
  attached,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  signal,
  translate = createTranslator(),
  connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
  openDirectTerminal: openDirectTerminalImpl,
  raceConnections = false
}) {
  const dimensions = getDimensions(stdout);
  let terminalId;
  let transport;
  let result;
  let primaryError;

  try {
    if (signal?.aborted) return signal.reason === 'SIGTERM' ? 143 : 130;
    terminalId = await client.createTerminal({
      nodeId,
      ...dimensions,
      ...(command === undefined ? {} : { command }),
      ...(copy === undefined ? {} : { copy })
    });
    if (signal?.aborted) return signal.reason === 'SIGTERM' ? 143 : 130;
    transport = await openTerminalAttachment({
      client,
      WebSocketClass,
      nodeId,
      terminalId,
      translate,
      connectionTimeoutMs,
      signal,
      openDirectTerminal: openDirectTerminalImpl,
      raceConnections
    });
    if (signal?.aborted) return signal.reason === 'SIGTERM' ? 143 : 130;
    result =
      attached === undefined
        ? await runAttachedTerminal({
            transport,
            terminalId,
            commandMode: command !== undefined,
            stdin,
            stdout,
            stderr,
            signal,
            translate
          })
        : await attached({ transport, terminalId, translate });
  } catch (error) {
    if (signal?.aborted) result = signal.reason === 'SIGTERM' ? 143 : 130;
    else primaryError = toMarctlError(error, translate);
  } finally {
    transport?.close?.();
    if (terminalId !== undefined) {
      try {
        await client.deleteTerminal({ nodeId, terminalId });
      } catch {
        if (primaryError === undefined && result === undefined)
          primaryError = new MarctlError(translate('errors.terminalCloseFailed'));
      }
    }
  }

  if (primaryError !== undefined) throw primaryError;
  return result;
}

/** Opens a task substream without rebuilding an already admitted Node connection. */
export async function openTerminalAttachment({
  client,
  WebSocketClass,
  nodeId,
  terminalId,
  translate,
  signal,
  ticket,
  computer = false,
  connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
  openDirectTerminal: openDirectTerminalImpl,
  raceConnections = true
}) {
  if (signal?.aborted) throw signal.reason;
  const options = {
    client,
    WebSocketClass,
    nodeId,
    terminalId,
    ticket,
    translate,
    connectionTimeoutMs,
    signal
  };
  if (openDirectTerminalImpl === undefined) {
    const socket = client.openPooledTerminal?.(WebSocketClass, {
      nodeId,
      terminalId,
      ticket,
      computer
    });
    if (socket !== undefined) return attachTerminalSocket({ ...options, socket });
  }
  const openDirectTerminal =
    openDirectTerminalImpl ?? (await import('./direct.mjs')).openDirectTerminal;
  const manifest = raceConnections
    ? await client.getTerminalManifest?.(nodeId).catch(() => undefined)
    : undefined;
  const directOptions = {
    client,
    WebSocketClass,
    nodeId,
    terminalId,
    computer,
    manifest,
    afterSequence: 0,
    timeoutMs: connectionTimeoutMs,
    signal
  };
  try {
    // A desktop has one relay ticket and cannot reserve it on a losing standby socket.
    return await (raceConnections && !computer && manifest?.deferredRelay === true
      ? raceTerminalConnections({ ...options, openDirectTerminal, directOptions })
      : openDirectTerminal(directOptions));
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === 'DirectUnsafeError')
      throw new MarctlError(translate('errors.terminalDirectUnsafeFallback'));
    if (error?.name !== 'DirectFallbackError') throw toMarctlError(error, translate);
    return openRelayTransport(options);
  }
}

function toMarctlError(error, translate) {
  if (error instanceof DirectRejectedError)
    return new MarctlError(`${translate('errors.terminalSessionFailed')} [${error.code}]`, {
      code: error.code
    });
  return error instanceof MarctlError
    ? error
    : new MarctlError(translate('errors.terminalSessionFailed'));
}
