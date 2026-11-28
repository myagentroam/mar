import { loadConfig } from './config.mjs';
import { createTranslator } from './i18n/index.mjs';
import { connectCliNodeRelay } from './node-relay.mjs';
import { runTcpForward } from './tcp-forward.mjs';

// IPC belongs to startup only. An abandoned launch must not leave a listener behind.
if (process.connected) {
  const scope = new AbortController();
  const abandon = () => scope.abort();
  process.once('disconnect', abandon);
  process.once('SIGTERM', () => scope.abort('SIGTERM'));
  process.once('SIGINT', () => scope.abort('SIGINT'));
  const translate = createTranslator();
  const report = (message) =>
    new Promise((resolve, reject) =>
      process.send(message, (error) => (error ? reject(error) : resolve()))
    );
  try {
    const [, , nodeId, spec] = process.argv;
    const config = await loadConfig({ translate });
    process.exitCode = await runTcpForward({
      nodeId,
      forward: JSON.parse(spec),
      client: {
        openForwardRelay: (id, signal) => connectCliNodeRelay({ ...config, nodeId: id }, signal)
      },
      onReady: async () => {
        await report({ ready: true });
        process.off('disconnect', abandon);
        if (process.connected) process.disconnect();
      },
      translate,
      signal: scope.signal
    });
  } catch (error) {
    if (process.connected) await report({ code: error?.code }).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
