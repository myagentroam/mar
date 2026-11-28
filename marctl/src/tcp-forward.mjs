import {
  readTcpForwardNotices,
  tcpForwardControlKind,
  tcpForwardDataKind,
  tcpForwardHost,
  tcpForwardMaxConnections,
  tcpForwardPort,
  tcpForwardSetupMs
} from '@myagentroam/protocol/tcp-forward';
import { MarctlError } from './errors.mjs';
import {
  bridgeForwardSocket,
  connectForwardSocket,
  listenForwardSocket
} from './tcp-forward-socket.mjs';

export function parseTcpForward(option, spec) {
  const match =
    /^(?:(?:\[([^\]]*:[^\]]*)\]|([^:]*)):)?(\d{1,5}):(?:\[([^\]]*:[^\]]*)\]|([^:]+)):(\d{1,5})$/u.exec(
      spec ?? ''
    );
  if (!match) return undefined;
  const [, bindIp, bindName, listen, targetIp, targetName, target] = match;
  const bind = bindIp ?? bindName;
  const listenHost = tcpForwardHost.safeParse(
    bind === '' || bind === '*'
      ? '0.0.0.0'
      : bind === 'localhost' || bind === undefined
        ? '127.0.0.1'
        : bind
  );
  const listenPort = tcpForwardPort.safeParse(Number(listen));
  const targetHost = tcpForwardHost.safeParse(targetIp ?? targetName);
  const targetPort = tcpForwardPort.safeParse(Number(target));
  if (!listenHost.success || !listenPort.success || !targetHost.success || !targetPort.success)
    return undefined;
  return {
    direction: option === '-L' ? 'local' : 'reverse',
    listenHost: listenHost.data,
    listenPort: listenPort.data,
    targetHost: targetHost.data,
    targetPort: targetPort.data
  };
}

export function tcpForwardAddress({ listenHost, listenPort }) {
  return `${listenHost.includes(':') ? `[${listenHost}]` : listenHost}:${listenPort}`;
}

/** Owns the lease and sockets in the same process, regardless of how it was started. */
export async function runTcpForward({ client, nodeId, forward, onReady, translate, signal }) {
  const { direction, listenHost, listenPort, targetHost, targetPort } = forward;
  const local = direction === 'local';
  const scope = new AbortController();
  const lifetime = AbortSignal.any([scope.signal, signal]);
  let path;
  let control;
  let active = 0;
  try {
    const setup = AbortSignal.any([lifetime, AbortSignal.timeout(tcpForwardSetupMs)]);
    path = await client.openForwardRelay(nodeId, setup);
    const disconnect = () => path.close();
    lifetime.addEventListener('abort', disconnect, { once: true });
    try {
      control = await path.openStream(
        {
          kind: tcpForwardControlKind,
          // The endpoint on the CLI side stays local; the peer cannot change it.
          grant: JSON.stringify({
            direction,
            host: local ? targetHost : listenHost,
            port: local ? targetPort : listenPort
          })
        },
        setup
      );
      if (control === undefined) throw new Error('TCP_FORWARD_DISCONNECTED');
      const notices = readTcpForwardNotices(control);
      let localEnded;
      const cancelSetup = () => control.reset('TCP_FORWARD_SETUP_TIMEOUT');
      setup.addEventListener('abort', cancelSetup, { once: true });
      try {
        setup.throwIfAborted();
        if ((await notices.next()).value !== 0) throw new Error('TCP_FORWARD_CONTROL_INVALID');
        if (local) {
          // A local bind can await DNS. Losing the lease during that wait must fail startup.
          localEnded = notices.next().then(({ done }) => {
            throw new Error(done ? 'TCP_FORWARD_DISCONNECTED' : 'TCP_FORWARD_CONTROL_INVALID');
          });
          const listener = await Promise.race([
            localEnded,
            listenForwardSocket(
              { host: listenHost, port: listenPort },
              lifetime,
              (socket) => {
                void attach(0, socket);
              },
              setup
            )
          ]);
          listener.on('error', () => control.reset('TCP_FORWARD_LISTEN_FAILED'));
        }
        setup.throwIfAborted();
      } finally {
        setup.removeEventListener('abort', cancelSetup);
      }
      lifetime.throwIfAborted();
      await onReady();
      if (localEnded !== undefined) await localEnded;
      let last = 0;
      for await (const id of notices) {
        if (id <= last) throw new Error('TCP_FORWARD_CONTROL_INVALID');
        last = id;
        void attach(id);
      }
      throw new Error('TCP_FORWARD_DISCONNECTED');
    } finally {
      lifetime.removeEventListener('abort', disconnect);
    }
  } catch (error) {
    if (signal.aborted) return signal.reason === 'SIGTERM' ? 143 : 130;
    const candidates = [error?.code, error?.message];
    const code = candidates.find(
      (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/u.test(value)
    );
    throw new MarctlError(translate('errors.tcpForwardFailed'), {
      code: code ?? 'TCP_FORWARD_FAILED'
    });
  } finally {
    scope.abort();
    control?.close();
    path?.close();
  }

  async function attach(id, socket) {
    if (lifetime.aborted || active >= tcpForwardMaxConnections || socket?.destroyed) {
      socket?.destroy();
      return;
    }
    active++;
    let stream;
    try {
      const setup = AbortSignal.any([lifetime, AbortSignal.timeout(tcpForwardSetupMs)]);
      stream = await path.openStream({ kind: tcpForwardDataKind, grant: String(id) }, setup);
      if (stream === undefined) return;
      if (socket === undefined) {
        // Claim the accepted reverse socket first so a refused dial can reset that stream.
        const peerClosed = new AbortController();
        void stream.finished.then(() => peerClosed.abort());
        socket = await connectForwardSocket(
          { host: targetHost, port: targetPort },
          AbortSignal.any([setup, peerClosed.signal])
        );
      }
      await bridgeForwardSocket(socket, stream, lifetime);
    } catch {
      stream?.reset('TCP_FORWARD_TARGET_UNAVAILABLE');
    } finally {
      active--;
      socket?.destroy();
    }
  }
}
