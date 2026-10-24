import { registerHooks } from 'node:module';

// Replace only app construction; the child executes the real Server entrypoint.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === '@myagentroam-enterprise/server-implementation' ||
      specifier === '@myagentroam-enterprise/server-implementation/license-host'
    ) {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});

export const readLicenseHostUuid = () => 'fixture-host';

export function createServerApp() {
  let resolveShutdown!: () => void;
  let rejectShutdown!: (error: unknown) => void;
  const pending = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  process.on('message', (message) => {
    if (message === 'succeed') resolveShutdown();
    if (message === 'fail') {
      rejectShutdown(new Error(`password=fixture-secret\n${'sensitive'.repeat(10000)}`));
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => process.send?.(signal));
  }
  return {
    async listen() {
      process.send?.('ready');
    },
    shutdown() {
      process.send?.('shutdown');
      return pending;
    }
  };
}
