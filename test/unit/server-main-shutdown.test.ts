import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// @test-covers mar-server/src/main.ts
// Windows does not deliver POSIX signals through child.kill().
describe.skipIf(process.platform === 'win32')('Server main signal shutdown', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const outcome of ['succeed', 'fail'] as const) {
      for (const overlap of [false, true]) {
        it(`${signal} ${outcome} exits correctly with one shutdown call${overlap ? ' when signals overlap' : ''}`, async () => {
          const child = fork(resolve(__dirname, '../../mar-server/src/main.ts'), {
            execArgv: [
              '--import',
              pathToFileURL(resolve(__dirname, 'support/server-main-fixture.mts')).href
            ],
            env: { ...process.env, NODE_OPTIONS: '' },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
          });
          const messages: unknown[] = [];
          let stdout = '';
          let stderr = '';
          child.on('message', (message) => messages.push(message));
          child.stdout!.on('data', (chunk) => (stdout += String(chunk)));
          child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
          const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
            child.on('close', (code, signal) => resolve({ code, signal }));
          });
          try {
            await vi.waitFor(() => expect(messages).toContain('ready'), { timeout: 3000 });
            expect(child.kill(signal)).toBe(true);
            await vi.waitFor(() => expect(messages).toContain('shutdown'));
            if (overlap) {
              const other = signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT';
              expect(child.kill(other)).toBe(true);
              await vi.waitFor(() => expect(messages).toContain(other));
            }
            child.send(outcome);
            await vi.waitFor(() => expect(child.exitCode).not.toBeNull(), { timeout: 3000 });
            expect(await closed).toEqual({ code: outcome === 'succeed' ? 0 : 1, signal: null });
            expect(messages.filter((message) => message === 'shutdown')).toHaveLength(1);
            expect(stdout).toBe('');
            if (outcome === 'succeed') {
              expect(stderr).toBe('');
            } else {
              expect(stderr).toBe(
                `SERVER_SHUTDOWN_FAILED: Server shutdown failed after ${signal}.\n`
              );
              expect(stderr.length).toBeLessThan(128);
              expect(stderr).not.toContain('fixture-secret');
              expect(stderr).not.toContain('sensitive');
            }
          } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await closed;
          }
        });
      }
    }
  }
});
