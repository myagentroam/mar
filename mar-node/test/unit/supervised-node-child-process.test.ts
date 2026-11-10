import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runSupervisedNodeChild } from '../../src/service/supervised-node-child.js';

it('requests a graceful IPC stop and waits for the real child to exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-supervisor-ipc-stop-'));
  try {
    const script = join(directory, 'child.cjs');
    const ready = join(directory, 'ready');
    const stopped = join(directory, 'stopped');
    await writeFile(
      script,
      `
      const fs = require('node:fs');
      process.on('message', message => {
        if (message.type === 'node-quick-start-stop') {
          fs.writeFileSync(${JSON.stringify(stopped)}, 'graceful');
          process.exit(0);
        }
      });
      setTimeout(() => process.exit(2), 4000);
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    `
    );
    const controller = new AbortController();
    const result = runSupervisedNodeChild(
      script,
      join(directory, 'config'),
      async () => false,
      () => undefined,
      undefined,
      controller.signal
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (
        await readFile(ready, 'utf8').then(
          () => true,
          () => false
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readFile(ready, 'utf8')).toBe('ready');
    controller.abort();
    expect(await result).toMatchObject({ code: 0, signalled: true });
    expect(await readFile(stopped, 'utf8')).toBe('graceful');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

it('performs the handshake and observes exit with an isolated Node child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-upgrade-child-'));
  try {
    const script = join(directory, 'child.cjs');
    await writeFile(
      script,
      `
      process.on('message', (message) => {
        if (message.type === 'node-upgrade-ready') {
          process.send({ type: 'node-upgrade-handoff', channelId: 'channel', id: 'id',
            attemptId: 'attempt', targetVersion: '1.2.3', credential: 'token' });
        } else if (message.type === 'node-upgrade-ack' && message.accepted) process.exit(75);
      });
      process.send({ type: 'node-upgrade-hello', channelId: 'channel' });
    `
    );
    const result = await runSupervisedNodeChild(
      script,
      join(directory, 'config'),
      async () => true,
      () => undefined
    );
    expect(result).toMatchObject({ code: 75, signalled: false, handoff: { attemptId: 'attempt' } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

it('reclaims a real child whose main thread blocks after accepting the upgrade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-upgrade-blocked-child-'));
  const pidPath = join(directory, 'child.pid');
  let completed = false;
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    if (completed) return;
    watchdogFired = true;
    void readFile(pidPath, 'utf8')
      .then((pid) => {
        if (!completed) process.kill(Number(pid), 'SIGKILL');
      })
      .catch(() => undefined);
  }, 38_000);
  try {
    const script = join(directory, 'child.cjs');
    await writeFile(
      script,
      `
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      process.on('message', (message) => {
        if (message.type === 'node-upgrade-ready') {
          process.send({ type: 'node-upgrade-handoff', channelId: 'blocked', id: 'id',
            attemptId: 'attempt', targetVersion: '1.2.3', credential: 'token' });
        } else if (message.type === 'node-upgrade-ack' && message.accepted) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      });
      process.send({ type: 'node-upgrade-hello', channelId: 'blocked' });
    `
    );
    const result = await runSupervisedNodeChild(
      script,
      join(directory, 'config'),
      async () => true,
      () => undefined
    );
    completed = true;
    expect(watchdogFired).toBe(false);
    expect(result).toMatchObject({
      signalled: false,
      forced: true,
      handoff: { attemptId: 'attempt' }
    });
    expect(result.reclaimFailed).not.toBe(true);
    const pid = Number(await readFile(pidPath, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    clearTimeout(watchdog);
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
