import { MarctlError } from './errors.mjs';
import { DirectRejectedError } from './direct-errors.mjs';
import { createTranslator } from './i18n/index.mjs';
import { raceTerminalConnections } from './terminal-race.mjs';
import { openRelayTransport } from './terminal-relay.mjs';
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
  let manifest;

  try {
    if (signal?.aborted) return signal.reason === 'SIGTERM' ? 143 : 130;
    terminalId = await client.createTerminal({
      nodeId,
      ...dimensions,
      ...(command === undefined ? {} : { command }),
      ...(copy === undefined ? {} : { copy })
    });
    if (signal?.aborted) return signal.reason === 'SIGTERM' ? 143 : 130;
    try {
      const openDirectTerminal =
        openDirectTerminalImpl ?? (await import('./direct.mjs')).openDirectTerminal;
      if (raceConnections && manifest === undefined)
        manifest = await client.getTerminalManifest(nodeId).catch(() => undefined);
      const directOptions = {
        client,
        WebSocketClass,
        nodeId,
        terminalId,
        manifest,
        afterSequence: 0,
        timeoutMs: connectionTimeoutMs,
        signal
      };
      const canRace = raceConnections && manifest?.deferredRelay === true;
      transport = canRace
        ? await raceTerminalConnections({
            openDirectTerminal,
            directOptions,
            client,
            WebSocketClass,
            nodeId,
            terminalId,
            translate,
            connectionTimeoutMs,
            signal
          })
        : await openDirectTerminal(directOptions);
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
      if (signal?.aborted) {
        result = signal.reason === 'SIGTERM' ? 143 : 130;
      } else {
        if (error?.name === 'DirectUnsafeError')
          throw new MarctlError(translate('errors.terminalDirectUnsafeFallback'));
        if (error?.name !== 'DirectFallbackError') throw error;
        transport = await openRelayTransport({
          client,
          WebSocketClass,
          nodeId,
          terminalId,
          translate,
          connectionTimeoutMs,
          signal
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
      }
    }
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

function toMarctlError(error, translate) {
  if (error instanceof DirectRejectedError)
    return new MarctlError(`${translate('errors.terminalSessionFailed')} [${error.code}]`, {
      code: error.code
    });
  return error instanceof MarctlError
    ? error
    : new MarctlError(translate('errors.terminalSessionFailed'));
}
