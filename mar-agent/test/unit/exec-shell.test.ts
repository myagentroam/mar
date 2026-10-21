import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/index.js';
import { execToolDefinition, execToolInput } from '../../src/agent-core/tools/local/exec.js';
import type { ExecResult } from '../../src/agent-core/tools/contracts.js';
import type { CoreOperationContext } from '../../src/agent-core/extensions/operation.js';
import { prepareLocalShellProcess } from '../../src/agent-core/host/local-shell.js';
import type { LocalProcessSpawnRequest } from '../../src/agent-core/host/local-process-executor.js';
import { LocalSessionEnvironment } from '../../src/agent-core/host/local-session-environment.js';

const roots: string[] = [];
const hosts: LocalAgentHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mar-exec-shell-'));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, "workspace with 'quotes'");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const host = new LocalAgentHost({
    homeDirectory: home,
    workspace,
    environment: { HOME: home, PATH: '/usr/bin:/bin', ...environment }
  });
  hosts.push(host);
  return { home, workspace, host };
}

async function exec(host: LocalAgentHost, command: string, login?: boolean) {
  const result = await host.executeTool(
    {
      name: 'exec',
      arguments: { command, yieldMs: 5_000, ...(login === undefined ? {} : { login }) }
    },
    {
      sessionId: 'session',
      executionId: 'execution',
      mode: 'run',
      signal: AbortSignal.timeout(10_000)
    }
  );
  const data = result.data as ExecResult;
  expect(data.status).toBe('completed');
  return data;
}

const operation: CoreOperationContext = {
  sessionId: 'session',
  executionId: 'execution',
  operationId: 'environment',
  sessionEpoch: 1,
  actor: 'sdk',
  entry: 'native-api',
  signal: new AbortController().signal
};

describe('exec login input', () => {
  it('publishes login with a true default and accepts explicit false', () => {
    expect(execToolDefinition.inputSchema.properties).toMatchObject({
      login: { type: 'boolean', default: true }
    });
    expect(execToolInput('exec', { command: 'echo test', login: false })).toMatchObject({
      login: false
    });
  });

  it.each(['true', 1, {}, []].map((value) => [value]))(
    'rejects a non-boolean login value: %j',
    (login) => {
      expect(() => execToolInput('exec', { command: 'echo test', login })).toThrow();
    }
  );
});

describe('executor Shell command preparation', () => {
  const request: LocalProcessSpawnRequest = {
    command: 'echo test',
    shell: '/bin/bash',
    shellLogin: true,
    cwd: '/workspace',
    environment: { HOME: '/home/test', PATH: '/usr/bin:/bin' },
    detached: true
  };

  it.each(['bash', 'zsh', 'sh'])('uses native login flags for %s', (shell) => {
    const prepared = prepareLocalShellProcess({ ...request, shell: `/bin/${shell}` }, 'linux');
    expect(prepared).toMatchObject({ command: `/bin/${shell}`, shell: false });
    expect(prepared.args?.[0]).toBe('-lc');
    expect(prepared.args?.[1]).toContain('echo test');
    expect(prepared.args?.[1]).not.toContain('/home/test');
  });

  it.each(['pwsh.exe', 'powershell.exe'])(
    'loads native profiles for %s and can disable them',
    (shell) => {
      const native = { ...request, shell: `C:\\Shell\\${shell}` };
      expect(prepareLocalShellProcess(native, 'win32')).toMatchObject({
        command: native.shell,
        args: ['-Command', 'echo test'],
        shell: false
      });
      expect(prepareLocalShellProcess({ ...native, shellLogin: false }, 'win32')).toMatchObject({
        args: ['-NoProfile', '-Command', 'echo test']
      });
    }
  );

  it('preserves legacy requests, native processes, Cmd and unknown Shells', () => {
    for (const native of [
      { ...request, shell: false },
      { ...request, shellLogin: undefined },
      { ...request, shell: 'cmd.exe' },
      { ...request, shell: '/custom/shell' }
    ]) {
      expect(prepareLocalShellProcess(native)).toBe(native);
    }
  });

  it('keeps protected values out of argv, preserves tombstones and cleans up private aliases', () => {
    const prepared = prepareLocalShellProcess({
      ...request,
      environmentOverrides: { MAR_SECRET: "private '$();\nvalue", MAR_DELETED: undefined },
      environmentKeys: []
    });
    expect(JSON.stringify(prepared.args)).not.toContain('private');
    expect(prepared.args?.[1]).toContain('unset MAR_DELETED');
    const aliases = Object.keys(prepared.environment).filter((key) =>
      key.startsWith('__MAR_SHELL_')
    );
    expect(aliases).toHaveLength(1);
    expect(prepared.environment[aliases[0]!]).toBe("private '$();\nvalue");
    expect(prepared.args?.[1]).toContain(`unset ${aliases[0]}`);
    expect(prepared.environmentKeys).toEqual(aliases);
  });

  it('normalizes Windows override names in the same order as the effective environment', async () => {
    const overlay = new LocalSessionEnvironment(
      { Path: 'base' },
      () => ({ PATH: 'execution' }),
      'win32'
    );
    await overlay.set({ key: 'Path', value: 'session' }, operation);
    const merged = overlay.forProcess({
      ...request,
      environment: { Path: 'base' },
      environmentOverrides: { PATH: 'explicit' },
      owner: { sessionId: 'session', executionId: 'execution' }
    });
    expect(merged.environment).toEqual({ PATH: 'explicit' });
    expect(merged.environmentOverrides).toEqual({ PATH: 'explicit' });
  });
});

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/bash'))(
  'exec login shell initialization',
  () => {
    it.each(['.bash_profile', '.bash_login', '.profile'])(
      'loads the native login configuration %s and preserves the Workspace cwd',
      async (profile) => {
        const { home, workspace, host } = await fixture();
        await writeFile(join(home, profile), 'export MAR_PROFILE_VALUE=loaded\n');
        const result = await exec(
          host,
          'printf "%s\\n%s\\n" "$MAR_PROFILE_VALUE" "$PWD"; shopt -q login_shell'
        );
        expect(result).toMatchObject({ exitCode: 0, stdout: `loaded\n${workspace}\n` });
      }
    );

    it('uses Bash profile priority instead of sourcing every available profile', async () => {
      const { home, host } = await fixture();
      await Promise.all(
        ['.bash_profile', '.bash_login', '.profile'].map((profile) =>
          writeFile(join(home, profile), `export MAR_PROFILE_VALUE=${profile}\n`)
        )
      );
      expect(await exec(host, 'printf "%s" "$MAR_PROFILE_VALUE"')).toMatchObject({
        exitCode: 0,
        stdout: '.bash_profile'
      });
    });

    it('seeds an unguarded bashrc and can resolve its configured tool without bash -ic', async () => {
      const { home, host } = await fixture();
      const bin = join(home, 'bin');
      await mkdir(bin);
      await writeFile(join(bin, 'python2.7'), '#!/bin/sh\nprintf fixture-python\n', {
        mode: 0o755
      });
      await writeFile(join(home, '.bashrc'), 'export PATH="$HOME/bin:$PATH"\n');
      expect(await exec(host, 'python2.7')).toMatchObject({
        exitCode: 0,
        stdout: 'fixture-python'
      });
    });

    it('does not force interactivity or bypass bashrc early-return guards', async () => {
      const { home, host } = await fixture();
      await writeFile(
        join(home, '.bashrc'),
        'case $- in *i*) ;; *) return;; esac\nexport MAR_INTERACTIVE_ONLY=loaded\n'
      );
      expect(await exec(host, 'printf "%s" "${MAR_INTERACTIVE_ONLY-missing}"')).toMatchObject({
        exitCode: 0,
        stdout: 'missing'
      });
    });

    it('loads current configuration on every exec and supports login false', async () => {
      const { home, host } = await fixture();
      const profile = join(home, '.profile');
      await writeFile(profile, 'export MAR_PROFILE_VALUE=first\n');
      const command = 'printf "%s" "${MAR_PROFILE_VALUE-missing}"';
      expect((await exec(host, command)).stdout).toBe('first');
      await writeFile(profile, 'export MAR_PROFILE_VALUE=second\n');
      expect((await exec(host, command)).stdout).toBe('second');
      expect((await exec(host, command, false)).stdout).toBe('missing');
    });

    it('does not seed bashrc when BASH_ENV already supplies the noninteractive setup', async () => {
      const { home, host } = await fixture();
      const bashEnv = join(home, 'bash-env.sh');
      await writeFile(bashEnv, 'export MAR_PROFILE_VALUE=bash-env\n');
      await writeFile(join(home, '.bashrc'), 'export MAR_PROFILE_VALUE=bashrc\n');
      await host.extensionPorts.environment!.set({ key: 'BASH_ENV', value: bashEnv }, operation);
      expect((await exec(host, 'printf "%s" "$MAR_PROFILE_VALUE"')).stdout).toBe('bash-env');
    });

    it('reapplies execution and Session overrides and unset tombstones after startup', async () => {
      const { home, host } = await fixture();
      await writeFile(
        join(home, '.profile'),
        'export MAR_EXECUTION_VALUE=profile\nexport MAR_SESSION_VALUE=profile\nexport MAR_DELETED_VALUE=profile\n'
      );
      host.bindExecutionExtensions({
        environment: { MAR_EXECUTION_VALUE: 'execution', MAR_SESSION_VALUE: 'execution' }
      });
      await host.listExecutionExtensions({
        sessionId: 'session',
        executionId: 'execution',
        claimExecutionScope: true
      });
      await host.extensionPorts.environment!.set(
        { key: 'MAR_SESSION_VALUE', value: "session '$();\nvalue" },
        operation
      );
      await host.extensionPorts.environment!.set({ key: 'MAR_DELETED_VALUE' }, operation);
      expect(
        await exec(
          host,
          'printf "%s|%s|%s" "$MAR_EXECUTION_VALUE" "$MAR_SESSION_VALUE" "${MAR_DELETED_VALUE-missing}"'
        )
      ).toMatchObject({
        exitCode: 0,
        stdout: "execution|session '$();\nvalue|missing"
      });
    });

    it('does not trace private override values when a profile enables xtrace', async () => {
      const { home, host } = await fixture();
      await writeFile(join(home, '.profile'), 'set -x\n');
      await host.extensionPorts.environment!.set(
        { key: 'MAR_PRIVATE_VALUE', value: 'must-not-be-traced' },
        operation
      );
      const result = await exec(host, 'case $- in *x*) printf tracing-restored ;; esac');
      expect(result).toMatchObject({ exitCode: 0, stdout: 'tracing-restored' });
      expect(result.stderr).not.toContain('must-not-be-traced');
    });

    it('does not initialize a shell for native processes', async () => {
      const { home, host } = await fixture();
      await writeFile(join(home, '.profile'), 'export MAR_PROFILE_VALUE=profile\n');
      const handle = await host.extensionPorts.processes!.spawn(
        {
          executable: process.execPath,
          argv: ['-e', 'process.stdout.write(process.env.MAR_PROFILE_VALUE ?? "missing")']
        },
        operation
      );
      const chunks: Uint8Array[] = [];
      for await (const chunk of handle.stdout) chunks.push(chunk);
      expect(await handle.wait()).toMatchObject({ code: 0 });
      expect(Buffer.concat(chunks).toString()).toBe('missing');
    });

    it('accepts a readonly protected value when startup leaves its value unchanged', async () => {
      const { home, host } = await fixture();
      await writeFile(join(home, '.profile'), 'readonly MAR_PROTECTED_VALUE\n');
      await host.extensionPorts.environment!.set(
        { key: 'MAR_PROTECTED_VALUE', value: 'session' },
        operation
      );
      expect(await exec(host, 'printf "%s" "$MAR_PROTECTED_VALUE"')).toMatchObject({
        exitCode: 0,
        stdout: 'session'
      });
    });

    it('accepts an already-unset tombstone when startup marks its name readonly', async () => {
      const { home, host } = await fixture();
      await writeFile(join(home, '.profile'), 'readonly MAR_DELETED_VALUE\n');
      await host.extensionPorts.environment!.set({ key: 'MAR_DELETED_VALUE' }, operation);
      expect(await exec(host, 'printf "%s" "${MAR_DELETED_VALUE-missing}"')).toMatchObject({
        exitCode: 0,
        stdout: 'missing'
      });
    });

    it('fails before executing the command when startup removes a private restoration value', async () => {
      const { home, host } = await fixture();
      await writeFile(
        join(home, '.profile'),
        'for name in ${!__MAR_SHELL_@}; do unset "$name"; done\n'
      );
      await host.extensionPorts.environment!.set(
        { key: 'MAR_PROTECTED_VALUE', value: 'private-test-value' },
        operation
      );
      const result = await exec(host, 'printf should-not-run');
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Shell startup removed a protected environment value.');
      expect(result.stderr).not.toContain('private-test-value');
    });

    it('fails before executing the command when startup makes a protected value readonly', async () => {
      const { home, host } = await fixture();
      await writeFile(join(home, '.profile'), 'readonly MAR_PROTECTED_VALUE=profile\n');
      await host.extensionPorts.environment!.set(
        { key: 'MAR_PROTECTED_VALUE', value: 'session' },
        operation
      );
      const result = await exec(host, 'printf should-not-run');
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('readonly variable');
    });

    it('retains startup output and exit status without a silent non-login fallback', async () => {
      const { home, host } = await fixture();
      await writeFile(join(home, '.profile'), 'printf startup-error >&2\nexit 23\n');
      expect(await exec(host, 'printf should-not-run')).toMatchObject({
        exitCode: 23,
        stdout: '',
        stderr: 'startup-error'
      });
    });
  }
);
