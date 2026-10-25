import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodePtyFactory, TerminalManager } from '../../src/terminal.js';

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')(
  'POSIX PTY process lifecycle',
  () => {
    it.each([
      ['/bin/sh', 'close'],
      ['/bin/sh', 'shutdown'],
      ['/bin/bash', 'close'],
      ['/bin/bash', 'shutdown'],
      ...(process.platform === 'darwin'
        ? ([
            ['/bin/zsh', 'close'],
            ['/bin/zsh', 'shutdown']
          ] as const)
        : [])
    ] as const)(
      'releases %s, its foreground job and descendant through %s',
      async (shell, operation) => {
        const directory = await mkdtemp(join(tmpdir(), 'mar-pty-process-tree-'));
        let shellPid = 0;
        let jobPid = 0;
        let descendantPid = 0;
        let output = '';
        let nativeExit = false;
        const manager = new TerminalManager({
          platform: process.platform === 'darwin' ? 'darwin' : 'linux',
          cwd: directory,
          profiles: [{ id: 'default', label: shell, shell, args: [], isDefault: true }],
          ptyFactory: (file, args, options) => {
            const pty = nodePtyFactory(file, args, options);
            shellPid = pty.pid!;
            pty.onExit(() => {
              nativeExit = true;
            });
            return pty;
          }
        });
        manager.onFrame((frame) => {
          if (frame.type === 'output') output += frame.data;
        });
        try {
          const script = join(directory, 'foreground.cjs');
          await writeFile(
            script,
            [
              'const {spawn}=require("node:child_process");',
              'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});',
              'console.log("JOB_PIDS "+process.pid+" "+process.ppid+" "+child.pid);',
              'setInterval(()=>{},1000);'
            ].join('\n')
          );
          const terminal = manager.open();
          const attachment = manager.authorizeAttach({ terminalId: terminal.id });
          await manager.acceptFrame(attachment.attachmentId, {
            type: 'input',
            terminalId: terminal.id,
            data: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`
          });
          await expect.poll(() => output).toMatch(/JOB_PIDS \d+ \d+ \d+/u);
          const match = output.match(/JOB_PIDS (\d+) (\d+) (\d+)/u)!;
          jobPid = Number(match[1]);
          descendantPid = Number(match[3]);
          expect(Number(match[2])).toBe(shellPid);
          expect(new Set([shellPid, jobPid, descendantPid]).size).toBe(3);
          expect([shellPid, jobPid, descendantPid].every(exists)).toBe(true);
          if (operation === 'shutdown') await manager.shutdown();
          else await manager.close(terminal.id);
          await expect
            .poll(
              () => ({
                shell: exists(shellPid),
                job: exists(jobPid),
                descendant: exists(descendantPid),
                nativeExit
              }),
              { timeout: 3_000 }
            )
            .toEqual({ shell: false, job: false, descendant: false, nativeExit: true });
          expect(manager.get(terminal.id).state).toBe('CLOSED');
          await manager.close(terminal.id);
          await manager.shutdown();
        } finally {
          // Baseline failures must not leave this test's own processes behind.
          for (const pid of [descendantPid, jobPid, shellPid]) {
            if (pid && exists(pid)) process.kill(pid, 'SIGKILL');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await manager.shutdown();
          await rm(directory, { recursive: true, force: true });
        }
      },
      10_000
    );
  }
);
