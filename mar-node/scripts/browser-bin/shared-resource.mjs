import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockLaunch } from './launch-lock.mjs';

// The pinned CLI exposes the same registry and daemon API used by its attach
// command. Find or start the daemon before the CLI handles the original command.
const require = createRequire(import.meta.url);
const core = dirname(
  require.resolve('playwright-core/package.json', {
    paths: [dirname(require.resolve('playwright/package.json'))]
  })
);
const api = join(core, 'lib', 'tools', 'cli-client');
const { Registry, createClientInfo } = require(join(api, 'registry.js'));
const { Session } = require(join(api, 'session.js'));
const client = createClientInfo();
const session = process.env.PLAYWRIGHT_CLI_SESSION;
async function available() {
  const registry = await Registry.load();
  const entry = registry.entry(client, session);
  return entry && (await new Session(entry).canConnect());
}

if (!(await available())) {
  try {
    const lock = await lockLaunch(process.env.MAR_PLAYWRIGHT_CLI_ROOT);
    const release = () => rmSync(lock, { recursive: true, force: true });
    // Early IPC cancellation exits before Playwright installs its own signal handler.
    process.once('exit', release);
    try {
      // Another command may have started the session while this one waited.
      if (!(await available()))
        await Session.startDaemon(
          client,
          {
            session,
            endpoint: process.env.MAR_PW_SHARED_RESOURCE,
            config: fileURLToPath(new URL('./playwright-isolated.json', import.meta.url))
          },
          'attach'
        );
    } finally {
      process.off('exit', release);
      release();
    }
  } catch {
    // Do not print endpoint details from the native transport.
    console.error(
      'Could not connect Playwright to the shared browser. Look up the resource again.'
    );
    process.exit(1);
  }
}
