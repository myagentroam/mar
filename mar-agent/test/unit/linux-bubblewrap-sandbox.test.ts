import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/index.js';
import {
  BubblewrapSandboxExecutor,
  LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
  probeBubblewrapSandbox
} from '../../src/sandbox/linux/index.js';

const directories: string[] = [];
const libreOfficeRuntimeAvailable = [
  '/usr/bin/libreoffice',
  '/etc/fonts/fonts.conf',
  '/etc/libreoffice/registry/main.xcd'
].every(existsSync);
const bubblewrapSandboxAvailable = await probeBubblewrapSandbox().then(
  () => true,
  (error: unknown) => {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'SANDBOX_UNAVAILABLE'
    )
      return false;
    throw error;
  }
);
const itRealSandbox = it.skipIf(!bubblewrapSandboxAvailable);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Linux Bubblewrap sandbox executor', () => {
  itRealSandbox(
    'initializes a login Shell only inside the sandbox and filters overrides before restoration',
    async () => {
      const home = await temporaryDirectory('host-profile');
      await writeFile(join(home, '.profile'), 'export MAR_HOST_PROFILE=host\nexit 29\n');
      await writeFile(join(home, '.bashrc'), 'export MAR_HOST_PROFILE=host\nexit 29\n');
      const child = await new BubblewrapSandboxExecutor({
        profile: { policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION }
      }).spawn({
        command: [
          'shopt -q login_shell',
          'test "$HOME" = /home/mar',
          'test -z "${MAR_HOST_PROFILE-}"',
          'test "$MAR_ALLOWED" = visible',
          'test -z "${MAR_UNLISTED-}"',
          'test "$PATH" != /host-only',
          'test -z "${MAR_DELETED-}"',
          'printf isolated-login'
        ].join(' && '),
        shell: '/bin/bash',
        shellLogin: true,
        cwd: '/',
        environment: {
          HOME: home,
          PATH: '/host-only',
          MAR_ALLOWED: 'visible',
          MAR_UNLISTED: 'private'
        },
        environmentKeys: ['HOME', 'PATH', 'MAR_ALLOWED'],
        environmentOverrides: {
          HOME: home,
          PATH: '/host-only',
          MAR_ALLOWED: 'must-not-bypass-the-filtered-environment',
          MAR_UNLISTED: 'private',
          MAR_DELETED: undefined
        },
        detached: true
      });
      child.stdin.end();
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const chunks: Buffer[] = [];
      child.stderr.resume();
      for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
      expect(await exit).toBe(0);
      expect(Buffer.concat(chunks).toString()).toBe('isolated-login');
    }
  );

  itRealSandbox(
    'accepts a real idle Session owner without inventing an Execution environment value',
    async () => {
      const child = await new BubblewrapSandboxExecutor({
        profile: { policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION }
      }).spawn({
        command: '/bin/sh',
        args: [
          '-c',
          'test "$MAR_AGENT_SESSION_ID" = session && test -z "$MAR_AGENT_EXECUTION_ID" && printf idle-owner'
        ],
        cwd: '/',
        shell: false,
        environment: {},
        detached: true,
        owner: { sessionId: 'session', operationId: 'operation', ownerInstanceId: 'instance' }
      });
      child.stdin.end();
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const chunks: Buffer[] = [];
      child.stderr.resume();
      for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
      expect(await exit).toBe(0);
      expect(Buffer.concat(chunks).toString()).toBe('idle-owner');
    }
  );

  itRealSandbox(
    'runs with no application mounts and an internal temporary working directory',
    async () => {
      const executor = new BubblewrapSandboxExecutor({
        profile: {
          policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION
        }
      });
      const child = await executor.spawn({
        command: '/bin/sh',
        args: [
          '-c',
          'test "$PWD" = /tmp && test "$HOME" = /home/mar && test ! -e /workspace && printf isolated'
        ],
        cwd: '/',
        shell: false,
        environment: {},
        detached: true
      });
      child.stdin.end();
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      await expect(
        new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        })
      ).resolves.toBe(0);
      expect(Buffer.concat(chunks).toString('utf8')).toBe('isolated');
    }
  );

  itRealSandbox(
    'supports application-defined mount destinations without a workspace convention',
    async () => {
      const source = await temporaryDirectory('custom-source');
      const results = await temporaryDirectory('custom-results');
      await writeFile(join(source, 'input.txt'), 'custom input');
      const executor = new BubblewrapSandboxExecutor({
        profile: {
          policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
          mounts: [
            { source, destination: '/project', access: 'READ_ONLY' },
            { source: results, destination: '/artifacts', access: 'READ_WRITE' }
          ],
          workingDirectory: { kind: 'REQUEST' }
        }
      });
      const child = await executor.spawn({
        command: '/bin/sh',
        args: ['-c', 'cat /project/input.txt > /artifacts/result.txt'],
        cwd: source,
        shell: false,
        environment: {},
        detached: true
      });
      child.stdin.end();
      await expect(
        new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        })
      ).resolves.toBe(0);
      await expect(readFile(join(results, 'result.txt'), 'utf8')).resolves.toBe('custom input');
    }
  );

  itRealSandbox(
    'allows a read-only parent with an independent writable child overlay',
    async () => {
      const parent = await temporaryDirectory('nested-parent');
      const child = await temporaryDirectory('nested-child');
      await mkdir(join(parent, 'overlay'));
      const allowed = new BubblewrapSandboxExecutor({
        profile: {
          policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
          mounts: [
            { source: parent, destination: '/project', access: 'READ_ONLY' },
            { source: child, destination: '/project/overlay', access: 'READ_WRITE' }
          ],
          workingDirectory: { kind: 'REQUEST' }
        }
      });
      const process = await allowed.spawn({
        command: '/bin/sh',
        args: ['-c', 'printf nested > /project/overlay/result.txt'],
        cwd: parent,
        environment: {},
        detached: true
      });
      process.stdin.end();
      await expect(
        new Promise<number | null>((resolve, reject) => {
          process.once('error', reject);
          process.once('close', resolve);
        })
      ).resolves.toBe(0);
      await expect(readFile(join(child, 'result.txt'), 'utf8')).resolves.toBe('nested');
    }
  );

  it('rejects invalid nested mount combinations', async () => {
    const parent = await temporaryDirectory('nested-policy-parent');
    const child = await temporaryDirectory('nested-policy-child');
    await mkdir(join(parent, 'overlay'));
    for (const [parentAccess, childAccess] of [
      ['READ_WRITE', 'READ_ONLY'],
      ['READ_WRITE', 'READ_WRITE'],
      ['READ_ONLY', 'READ_ONLY']
    ] as const) {
      await expect(
        new BubblewrapSandboxExecutor({
          profile: {
            policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
            mounts: [
              { source: parent, destination: '/project', access: parentAccess },
              { source: child, destination: '/project/overlay', access: childAccess }
            ]
          }
        }).spawn({
          command: '/bin/true',
          cwd: '/',
          environment: {},
          detached: true
        })
      ).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
    }
    await expect(
      new BubblewrapSandboxExecutor({
        profile: {
          policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
          mounts: [
            { source: parent, destination: '/project', access: 'READ_ONLY' },
            { source: parent, destination: '/project/alias', access: 'READ_ONLY' }
          ]
        }
      }).spawn({
        command: '/bin/true',
        cwd: '/',
        environment: {},
        detached: true
      })
    ).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
  });

  itRealSandbox(
    'runs hosted exec with a read-only workspace root and writable inbox/output overlays',
    async () => {
      const first = await sandboxFixture('first', '/home/template-source-first/workspace');
      const second = await sandboxFixture('second');
      const hostSecret = join(await temporaryDirectory('host-secret'), 'secret.txt');
      const sessionStoreDirectory = join(first.homeDirectory, '.mar', 'agent');
      await writeFile(hostSecret, 'must stay hidden');
      await writeFile(join(second.inboxDirectory, 'other-session.txt'), 'must stay hidden');
      await mkdir(sessionStoreDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(first.homeDirectory, 'sdk-home-marker.txt'),
        'sdk home must stay hidden'
      );
      await writeFile(
        join(sessionStoreDirectory, 'session.jsonl'),
        'session store must stay hidden'
      );
      await writeFile(join(first.generatedImagesDirectory, 'generated.png'), 'generated image');
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const originalHome = process.env.HOME;
      const host = hostedHost(first, {
        HOST_SECRET: 'must-not-be-inherited',
        HTTP_PROXY: 'http://127.0.0.1:9'
      });
      await mkdir(join(first.workspaceDirectory, '.venv', 'bin'), { recursive: true });
      await symlink('/usr/bin/python3', join(first.workspaceDirectory, '.venv', 'bin', 'python'));
      await writeFile(
        join(first.workspaceDirectory, '.venv', 'bin', 'template-tool'),
        `#!${first.sourceWorkspacePath}/.venv/bin/python\nprint("template tool")\n`,
        { mode: 0o755 }
      );

      try {
        const result = await host.executeTool(
          {
            name: 'exec',
            arguments: {
              command: [
                'printf \'%s\\n\' "$HOME" "$PWD" "${HOST_SECRET-unset}" "${HTTP_PROXY-unset}" > /workspace/output/environment.txt',
                'cat /workspace/instructions.md >> /workspace/output/environment.txt',
                `test ! -e ${quote(hostSecret)}`,
                `test ! -e ${quote(join(second.inboxDirectory, 'other-session.txt'))}`,
                `test ! -e ${quote(first.generatedImagesDirectory)}`,
                'test ! -e "$HOME/sdk-home-marker.txt"',
                'test ! -e "$HOME/.mar/agent/session.jsonl"',
                'if echo changed > /workspace/instructions.md 2>/dev/null; then exit 41; fi',
                'if echo changed > "$HOME/.mar/agent/sessions/session-current/generated_images/generated.png" 2>/dev/null; then exit 44; fi',
                "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status",
                'echo inbox > /workspace/inbox/agent-note.txt',
                'echo output > /workspace/output/result.txt',
                'cp "$HOME/.mar/agent/sessions/session-current/generated_images/generated.png" /workspace/output/copied-generated.png',
                `cmp /workspace/instructions.md ${quote(`${first.sourceWorkspacePath}/instructions.md`)}`,
                `echo alias-inbox > ${quote(`${first.sourceWorkspacePath}/inbox/alias-note.txt`)}`,
                `echo alias-output > ${quote(`${first.sourceWorkspacePath}/output/alias-result.txt`)}`,
                `${quote(`${first.sourceWorkspacePath}/.venv/bin/template-tool`)} > /workspace/output/template-tool.txt`,
                'test -w "$HOME"',
                'echo home > "$HOME/marker.txt"',
                'test "$(ulimit -n)" -le 256',
                'test "$(ulimit -u)" -le 64',
                `python3 -c ${quote(
                  'import mmap; region = mmap.mmap(-1, 5 * 1024**3, flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS, prot=0); region.close()'
                )}`,
                `python3 -c ${quote(
                  'import ctypes, errno, sys; libc = ctypes.CDLL(None, use_errno=True); result = libc.ptrace(0, 0, None, None); sys.exit(0 if result == -1 and ctypes.get_errno() == errno.EPERM else 43)'
                )}`,
                `node -e ${quote(
                  `const net=require('node:net');const socket=net.connect(${port},'127.0.0.1');socket.on('connect',()=>process.exit(42));socket.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),500);`
                )}`
              ].join(' && '),
              yieldMs: 2_000
            }
          },
          executionContext('session-first', 'execution-first')
        );

        expect(result.data).toMatchObject({ status: 'completed', exitCode: 0 });
        expect(await readFile(join(first.outputDirectory, 'environment.txt'), 'utf8')).toBe(
          ['/home/mar', '/workspace', 'unset', 'unset', 'template instructions', ''].join('\n')
        );
        await expect(readFile(join(first.inboxDirectory, 'agent-note.txt'), 'utf8')).resolves.toBe(
          'inbox\n'
        );
        await expect(readFile(join(first.outputDirectory, 'result.txt'), 'utf8')).resolves.toBe(
          'output\n'
        );
        await expect(
          readFile(join(first.outputDirectory, 'copied-generated.png'), 'utf8')
        ).resolves.toBe('generated image');
        await expect(
          readFile(join(first.generatedImagesDirectory, 'generated.png'), 'utf8')
        ).resolves.toBe('generated image');
        await expect(readFile(join(first.inboxDirectory, 'alias-note.txt'), 'utf8')).resolves.toBe(
          'alias-inbox\n'
        );
        await expect(
          readFile(join(first.outputDirectory, 'alias-result.txt'), 'utf8')
        ).resolves.toBe('alias-output\n');
        await expect(
          readFile(join(first.outputDirectory, 'template-tool.txt'), 'utf8')
        ).resolves.toBe('template tool\n');
        await expect(
          readFile(join(first.homeDirectory, 'marker.txt'), 'utf8')
        ).rejects.toMatchObject({
          code: 'ENOENT'
        });
        await expect(
          readFile(join(first.homeDirectory, 'sdk-home-marker.txt'), 'utf8')
        ).resolves.toBe('sdk home must stay hidden');
        await expect(readFile(join(sessionStoreDirectory, 'session.jsonl'), 'utf8')).resolves.toBe(
          'session store must stay hidden'
        );
        await expect(
          readFile(join(first.workspaceDirectory, 'instructions.md'), 'utf8')
        ).resolves.toBe('template instructions\n');
        expect(process.env.HOME).toBe(originalHome);
      } finally {
        await host.dispose();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  itRealSandbox('reuses a supplied conversation temporary directory across Runs', async () => {
    const fixture = await sandboxFixture('conversation-temporary-work');
    const firstHost = hostedHost(fixture);
    try {
      const first = await firstHost.executeTool(
        {
          name: 'exec',
          arguments: {
            command:
              "printf 'progress\\n' > /tmp/progress.txt && printf 'first\\n' > /workspace/output/first.txt"
          }
        },
        executionContext('session-persistent-work', 'execution-first-run')
      );
      expect(first.data).toMatchObject({ status: 'completed', exitCode: 0 });
    } finally {
      await firstHost.dispose();
    }

    await expect(readFile(join(fixture.temporaryDirectory, 'progress.txt'), 'utf8')).resolves.toBe(
      'progress\n'
    );

    const nextRunHost = hostedHost(fixture);
    try {
      const resumed = await nextRunHost.executeTool(
        {
          name: 'exec',
          arguments: {
            command:
              'test "$(cat /tmp/progress.txt)" = progress && printf \'resumed\\n\' > /workspace/output/resumed.txt'
          }
        },
        executionContext('session-persistent-work', 'execution-second-run')
      );
      expect(resumed.data).toMatchObject({ status: 'completed', exitCode: 0 });
    } finally {
      await nextRunHost.dispose();
    }

    await expect(readFile(join(fixture.outputDirectory, 'resumed.txt'), 'utf8')).resolves.toBe(
      'resumed\n'
    );
  });

  it.skipIf(!bubblewrapSandboxAvailable || !libreOfficeRuntimeAvailable)(
    'mounts the minimal read-only system configuration required by LibreOffice',
    async () => {
      const fixture = await sandboxFixture('libreoffice-runtime');
      await writeFile(
        join(fixture.workspaceDirectory, 'sample.txt'),
        'Hosted office conversion.\n'
      );
      const host = hostedHost(fixture);
      try {
        const result = await host.executeTool(
          {
            name: 'exec',
            arguments: {
              command: [
                'test -r /etc/fonts/fonts.conf',
                'test -r /etc/libreoffice/registry/main.xcd',
                'test ! -e /etc/shadow',
                'if touch /etc/fonts/.mar-write-test 2>/dev/null; then exit 41; fi',
                'if touch /etc/libreoffice/.mar-write-test 2>/dev/null; then exit 42; fi',
                '/usr/bin/libreoffice -env:UserInstallation=file:///tmp/libreoffice-profile --headless --convert-to docx --outdir /workspace/output /workspace/sample.txt'
              ].join(' && ')
            }
          },
          executionContext('session-libreoffice', 'execution-libreoffice')
        );

        expect(result.data).toMatchObject({ status: 'completed', exitCode: 0 });
        expect(
          (await readFile(join(fixture.outputDirectory, 'sample.docx'))).subarray(0, 2)
        ).toEqual(Buffer.from('PK'));
      } finally {
        await host.dispose();
      }
    }
  );

  itRealSandbox(
    'injects only explicitly allowed process environment and probes the production policy',
    async () => {
      const fixture = await sandboxFixture('explicit-environment');
      const executor = sandboxExecutor(fixture);
      const child = await executor.spawn({
        command: process.execPath,
        args: [
          '-e',
          "setTimeout(() => process.stdout.write(`${process.env.MCP_TOKEN ?? 'unset'}|${process.env.HOST_SECRET ?? 'unset'}|${process.env.PATH ?? 'unset'}`), 100)"
        ],
        cwd: fixture.workspaceDirectory,
        shell: false,
        environment: { MCP_TOKEN: 'allowed', HOST_SECRET: 'blocked', PATH: '/host/must-not-win' },
        environmentKeys: ['MCP_TOKEN', 'PATH'],
        detached: true,
        owner: { sessionId: 'environment-session', executionId: 'environment-execution' }
      });
      const launchArguments = child.spawnargs.join('\0');
      expect(launchArguments).not.toContain(fixture.root);
      expect(launchArguments).not.toContain('allowed');
      expect(launchArguments).not.toContain(process.execPath);
      expect(launchArguments).not.toContain('\0--as=');
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(code).toBe(0);
      expect(Buffer.concat(chunks).toString('utf8')).toBe(
        'allowed|unset|/runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      );
      await expect(probeBubblewrapSandbox()).resolves.toMatchObject({
        version: expect.any(String)
      });
    }
  );

  itRealSandbox(
    'loads the restricted engine under Bubblewrap without guest Host APIs',
    async () => {
      const fixture = await sandboxFixture('code-mode');
      const host = hostedHost(fixture, {
        PATH: '/host/must-not-win',
        HOST_SECRET: 'must-not-leak'
      });
      try {
        const result = await host.executeTool(
          {
            name: 'code_exec',
            arguments: `observe.text({ process: typeof process, console: typeof console, require: typeof require });
            try { await import("node:fs"); } catch (error) { observe.text(error.code); }`
          },
          {
            ...executionContext('session-code', 'execution-code'),
            codeMode: {
              tools: [],
              invoke: async () => ({ content: 'unused' })
            }
          }
        );
        expect(JSON.parse(result.content)).toMatchObject({
          status: 'completed',
          observations: [
            {
              type: 'value',
              format: 'json',
              value: '{"process":"undefined","console":"undefined","require":"undefined"}'
            },
            { type: 'value', format: 'text', value: 'MAR_AGENT_CODE_IMPORT_DENIED' }
          ]
        });
      } finally {
        await host.dispose();
      }
    }
  );

  it('rejects NUL-delimited environment option injection before spawning Bubblewrap', async () => {
    const fixture = await sandboxFixture('environment-injection');
    await expect(
      sandboxExecutor(fixture).spawn({
        command: '/bin/true',
        cwd: fixture.workspaceDirectory,
        shell: false,
        environment: { MCP_TOKEN: 'allowed\0--bind\0/\0/workspace' },
        environmentKeys: ['MCP_TOKEN'],
        detached: true,
        owner: { sessionId: 'environment-session', executionId: 'environment-execution' }
      })
    ).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
  });

  it('rejects runtime assets that expose broad roots or overlap application mounts', async () => {
    const fixture = await sandboxFixture('runtime-assets');
    for (const runtimeDirectories of [
      ['/'],
      ['/home'],
      [fixture.workspaceDirectory],
      ['/etc/ssl']
    ]) {
      await expect(
        sandboxExecutor(fixture).spawn({
          command: '/bin/true',
          cwd: fixture.workspaceDirectory,
          environment: {},
          detached: true,
          runtimeDirectories
        })
      ).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
    }
  });

  it('preserves cancellation raised after asynchronous policy validation', async () => {
    const fixture = await sandboxFixture('cancelled-validation');
    const reason = new Error('cancelled during validation');
    let checks = 0;
    const signal = {
      throwIfAborted() {
        checks += 1;
        if (checks === 2) throw reason;
      }
    } as AbortSignal;

    await expect(
      sandboxExecutor(fixture).spawn({
        command: '/bin/true',
        cwd: fixture.workspaceDirectory,
        shell: false,
        environment: {},
        detached: true,
        signal,
        owner: { sessionId: 'cancelled-session', executionId: 'cancelled-execution' }
      })
    ).rejects.toBe(reason);
  });

  itRealSandbox(
    'keeps concurrent sandbox virtual HOME writes isolated from Session storage',
    async () => {
      const first = await sandboxFixture('home-first');
      const second = await sandboxFixture('home-second');
      const firstHost = hostedHost(first);
      const secondHost = hostedHost(second);

      await Promise.all([
        firstHost.executeTool(
          {
            name: 'exec',
            arguments: {
              command:
                'echo first > "$HOME/value" && cat "$HOME/value" > /workspace/output/home-value'
            }
          },
          executionContext('session-first', 'execution-first')
        ),
        secondHost.executeTool(
          {
            name: 'exec',
            arguments: {
              command:
                'echo second > "$HOME/value" && cat "$HOME/value" > /workspace/output/home-value'
            }
          },
          executionContext('session-second', 'execution-second')
        )
      ]);

      await expect(readFile(join(first.outputDirectory, 'home-value'), 'utf8')).resolves.toBe(
        'first\n'
      );
      await expect(readFile(join(second.outputDirectory, 'home-value'), 'utf8')).resolves.toBe(
        'second\n'
      );
      await expect(readFile(join(first.homeDirectory, 'value'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      });
      await expect(readFile(join(second.homeDirectory, 'value'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      });
      await Promise.all([firstHost.dispose(), secondHost.dispose()]);
    }
  );

  itRealSandbox('keeps NONE offline while UNRESTRICTED preserves Node networking', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      for (const [networkMode, connectionExpected] of [
        ['NONE', false],
        ['UNRESTRICTED', true]
      ] as const) {
        const fixture = await sandboxFixture(`network-${networkMode.toLowerCase()}`);
        const script = [
          "const net=require('node:net')",
          `const socket=net.connect(${port},'localhost')`,
          connectionExpected
            ? "socket.on('connect',()=>process.exit(0));socket.on('error',()=>process.exit(41))"
            : "socket.on('connect',()=>process.exit(42));socket.on('error',()=>process.exit(0))",
          'setTimeout(()=>process.exit(43),1000)'
        ].join(';');
        const child = await sandboxExecutor(fixture, '/usr/bin/bwrap', networkMode).spawn({
          command: process.execPath,
          args: ['-e', script],
          cwd: fixture.workspaceDirectory,
          shell: false,
          environment: {},
          detached: true,
          owner: {
            sessionId: `network-${networkMode.toLowerCase()}`,
            executionId: `network-${networkMode.toLowerCase()}`
          }
        });
        child.stdin.end();
        await expect(
          new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
          })
        ).resolves.toBe(0);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('rejects invalid mounts, outside cwd and a missing backend without host spawn fallback', async () => {
    const fixture = await sandboxFixture('invalid');
    const outside = await temporaryDirectory('outside');
    const marker = join(outside, 'fallback-marker');
    const missing = hostedHost(fixture, {}, '/missing/bwrap');

    await expect(
      missing.executeTool(
        {
          name: 'exec',
          arguments: { command: `echo fallback > ${quote(marker)}` }
        },
        executionContext('session-missing', 'execution-missing')
      )
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    await expect(stat(marker)).rejects.toThrow();
    await missing.dispose();

    const invalidBackendDirectory = await temporaryDirectory('invalid-backend');
    const invalidBackend = join(invalidBackendDirectory, 'bwrap');
    await writeFile(invalidBackend, '#!/missing/interpreter\n', { mode: 0o700 });
    await expect(
      new BubblewrapSandboxExecutor({
        bubblewrapPath: invalidBackend,
        profile: {
          policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION
        }
      }).spawn({
        command: '/bin/true',
        cwd: '/',
        environment: {},
        detached: true
      })
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });

    const host = hostedHost(fixture);
    await expect(
      host.executeTool(
        {
          name: 'exec',
          arguments: { command: 'pwd', cwd: outside }
        },
        executionContext('session-outside', 'execution-outside')
      )
    ).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
    await host.dispose();

    const linked = await sandboxFixture('linked');
    const realWork = await temporaryDirectory('linked-target');
    await rm(linked.workspaceDirectory, { recursive: true, force: true });
    await symlink(realWork, linked.workspaceDirectory);
    const linkedHost = hostedHost(linked);
    await expect(
      linkedHost.executeTool(
        { name: 'exec', arguments: { command: 'true' } },
        executionContext('session-linked', 'execution-linked')
      )
    ).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
    await linkedHost.dispose();

    for (const generatedImagesMount of [
      {
        destination: fixture.generatedImagesLogicalPath,
        access: 'READ_WRITE' as const
      },
      {
        destination: '/home/mar/.mar/agent/sessions/session-current',
        access: 'READ_ONLY' as const
      },
      {
        destination: '/home/mar/other',
        access: 'READ_ONLY' as const
      }
    ]) {
      await expect(
        new BubblewrapSandboxExecutor({
          bubblewrapPath: '/usr/bin/bwrap',
          profile: {
            policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
            mounts: [
              {
                source: fixture.generatedImagesDirectory,
                ...generatedImagesMount
              }
            ]
          }
        }).spawn({
          command: '/bin/true',
          cwd: '/',
          shell: false,
          environment: {},
          detached: true
        })
      ).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
    }

    for (const destination of [
      'relative/source',
      '/home/mar/source',
      '/runtime/source',
      '/usr/local/source',
      '/etc/fonts',
      '/etc/libreoffice',
      '/tmp'
    ]) {
      await expect(
        new BubblewrapSandboxExecutor({
          bubblewrapPath: '/usr/bin/bwrap',
          profile: {
            policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
            mounts: [
              {
                source: fixture.workspaceDirectory,
                destination,
                access: 'READ_ONLY'
              }
            ],
            workingDirectory: { kind: 'REQUEST' }
          }
        }).spawn({
          command: '/bin/true',
          cwd: fixture.workspaceDirectory,
          shell: false,
          environment: {},
          detached: true
        })
      ).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
    }
  });
});

function hostedHost(
  fixture: Awaited<ReturnType<typeof sandboxFixture>>,
  environment: NodeJS.ProcessEnv = {},
  bubblewrapPath = '/usr/bin/bwrap'
): LocalAgentHost {
  return new LocalAgentHost({
    mode: 'node',
    homeDirectory: fixture.homeDirectory,
    workspace: fixture.workspaceDirectory,
    workspaceWritable: false,
    environment,
    processExecutor: sandboxExecutor(fixture, bubblewrapPath)
  });
}

function sandboxExecutor(
  fixture: Awaited<ReturnType<typeof sandboxFixture>>,
  bubblewrapPath = '/usr/bin/bwrap',
  networkMode: 'NONE' | 'UNRESTRICTED' = 'NONE'
): BubblewrapSandboxExecutor {
  return new BubblewrapSandboxExecutor({
    bubblewrapPath,
    profile: {
      policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
      networkMode,
      mounts: [
        {
          source: fixture.workspaceDirectory,
          destination: '/workspace',
          access: 'READ_ONLY'
        },
        {
          source: fixture.workspaceDirectory,
          destination: fixture.sourceWorkspacePath,
          access: 'READ_ONLY'
        },
        {
          source: fixture.inboxDirectory,
          destination: '/workspace/inbox',
          access: 'READ_WRITE'
        },
        {
          source: fixture.inboxDirectory,
          destination: `${fixture.sourceWorkspacePath}/inbox`,
          access: 'READ_WRITE'
        },
        {
          source: fixture.outputDirectory,
          destination: '/workspace/output',
          access: 'READ_WRITE'
        },
        {
          source: fixture.outputDirectory,
          destination: `${fixture.sourceWorkspacePath}/output`,
          access: 'READ_WRITE'
        },
        {
          source: fixture.generatedImagesDirectory,
          destination: fixture.generatedImagesLogicalPath,
          access: 'READ_ONLY'
        }
      ],
      temporaryDirectory: {
        kind: 'MOUNT',
        source: fixture.temporaryDirectory
      },
      workingDirectory: { kind: 'REQUEST' }
    }
  });
}

async function sandboxFixture(
  label: string,
  sourceWorkspacePath = `/home/template-source/${label}/workspace`
) {
  const root = await temporaryDirectory(label);
  const homeDirectory = join(root, 'home');
  const workspaceDirectory = join(root, 'workspace');
  const inboxDirectory = join(root, 'inbox');
  const outputDirectory = join(root, 'output');
  const generatedImagesDirectory = join(
    homeDirectory,
    '.mar',
    'agent',
    'sessions',
    'session-current',
    'generated_images'
  );
  const generatedImagesLogicalPath =
    '/home/mar/.mar/agent/sessions/session-current/generated_images';
  const tempDirectory = join(root, 'tmp');
  await Promise.all(
    [
      homeDirectory,
      workspaceDirectory,
      inboxDirectory,
      outputDirectory,
      generatedImagesDirectory,
      tempDirectory
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 }))
  );
  await Promise.all(
    ['inbox', 'output'].map((name) =>
      mkdir(join(workspaceDirectory, name), { recursive: true, mode: 0o700 })
    )
  );
  await writeFile(join(workspaceDirectory, 'instructions.md'), 'template instructions\n');
  return {
    root,
    homeDirectory,
    workspaceDirectory,
    sourceWorkspacePath,
    inboxDirectory,
    outputDirectory,
    generatedImagesDirectory,
    generatedImagesLogicalPath,
    temporaryDirectory: tempDirectory
  };
}

function executionContext(sessionId: string, executionId: string) {
  return {
    mode: 'run' as const,
    signal: AbortSignal.timeout(5_000),
    sessionId,
    executionId
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `mar-agent-bwrap-${label}-`));
  directories.push(path);
  return path;
}
