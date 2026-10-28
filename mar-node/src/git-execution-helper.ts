import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitCredentialRequest, originalGitEnvironment } from './workspace/git-credential-client.js';

async function run(
  command: string,
  args: string[],
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly input?: string;
  } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.environment ?? process.env,
      windowsHide: true,
      stdio: [options.input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit']
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
    child.once('error', () => reject(new Error('GIT_TRANSPORT_UNAVAILABLE')));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function credential(operation: string | undefined): Promise<number> {
  if (!['get', 'store', 'erase'].includes(operation ?? '')) return 1;
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('GIT_CREDENTIAL_REQUEST_INVALID');
  }
  const values: Record<string, string> = {};
  for (const line of input.split('\n')) {
    if (line === '') break;
    const equals = line.indexOf('=');
    if (equals > 0) values[line.slice(0, equals)] = line.slice(equals + 1);
  }
  const matched = await gitCredentialRequest('/credential', {
    protocol: values.protocol,
    host: values.host,
    path: values.path ?? ''
  });
  if (matched.matched === true) {
    if (operation === 'get') {
      if (
        typeof matched.username !== 'string' ||
        typeof matched.password !== 'string' ||
        /[\r\n\0]/u.test(matched.username + matched.password)
      )
        throw new Error('GIT_CREDENTIAL_REQUEST_INVALID');
      process.stdout.write(`username=${matched.username}\npassword=${matched.password}\n\n`);
    }
    // Matched credentials are never written to another helper or replaced after rejection.
    return 0;
  }
  return run(
    gitExecutable(),
    ['credential', operation === 'get' ? 'fill' : operation === 'store' ? 'approve' : 'reject'],
    {
      environment: await originalGitEnvironment(),
      input
    }
  );
}

async function invoke(args: string[]): Promise<number> {
  const cwd = gitWorkingDirectory(args);
  const remote = await currentRemote(args);
  const managedSshCommand = process.env.MAR_GIT_SSH_COMMAND;
  const requestedSshCommand = process.env.GIT_SSH_COMMAND;
  const invocationSshCommand = gitCommandLineConfig(args, 'core.sshCommand');
  const originalSshCommand =
    managedSshCommand !== undefined && requestedSshCommand === managedSshCommand
      ? (await originalGitEnvironment()).GIT_SSH_COMMAND
      : undefined;
  const fallbackSshCommand =
    managedSshCommand !== undefined &&
    requestedSshCommand !== undefined &&
    requestedSshCommand !== managedSshCommand
      ? requestedSshCommand
      : managedSshCommand === undefined
        ? undefined
        : (originalSshCommand ??
          (invocationSshCommand.found
            ? invocationSshCommand.value
            : await gitOutput(['config', '--get', 'core.sshCommand'], cwd)));
  const matched =
    remote === undefined ? { matched: false } : await gitCredentialRequest('/identity', { remote });
  const identity =
    matched.matched === true &&
    typeof matched.name === 'string' &&
    typeof matched.email === 'string' &&
    !/[\r\n\0]/u.test(matched.name + matched.email)
      ? { name: matched.name, email: matched.email }
      : undefined;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(managedSshCommand === undefined
      ? {}
      : { GIT_SSH_COMMAND: managedSshCommand, GIT_SSH_VARIANT: 'ssh' }),
    ...(fallbackSshCommand === undefined
      ? {}
      : { MAR_GIT_ORIGINAL_SSH_COMMAND: fallbackSshCommand }),
    ...(identity === undefined
      ? {}
      : {
          GIT_AUTHOR_NAME: identity.name,
          GIT_COMMITTER_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_EMAIL: identity.email
        })
  };
  return run(
    gitExecutable(),
    identity === undefined
      ? args
      : ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, ...args],
    { environment }
  );
}

function gitCommandLineConfig(
  args: readonly string[],
  requestedName: string
): { readonly found: boolean; readonly value?: string } {
  let result: { readonly found: boolean; readonly value?: string } = { found: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--') break;
    if (!argument.startsWith('-')) break;
    let assignment: string | undefined;
    if (argument === '-c') assignment = args[++index];
    else if (argument.startsWith('-c') && argument.length > 2) assignment = argument.slice(2);
    else if (argument === '--config-env') {
      const reference = args[++index];
      if (reference !== undefined) assignment = configEnvironmentAssignment(reference);
    } else if (argument.startsWith('--config-env='))
      assignment = configEnvironmentAssignment(argument.slice('--config-env='.length));
    else if (['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix'].includes(argument))
      index++;
    if (assignment === undefined) continue;
    const equals = assignment.indexOf('=');
    if (equals < 1 || assignment.slice(0, equals).toLowerCase() !== requestedName.toLowerCase())
      continue;
    result = { found: true, value: assignment.slice(equals + 1) };
  }
  return result;
}

function configEnvironmentAssignment(reference: string): string | undefined {
  const equals = reference.indexOf('=');
  if (equals < 1) return undefined;
  const value = process.env[reference.slice(equals + 1)];
  return value === undefined ? undefined : `${reference.slice(0, equals)}=${value}`;
}

async function currentRemote(args: readonly string[]): Promise<string | undefined> {
  const cwd = gitWorkingDirectory(args);
  const branch = await gitOutput(['branch', '--show-current'], cwd);
  const configured =
    branch === undefined || branch === ''
      ? undefined
      : await gitOutput(['config', '--get', `branch.${branch}.remote`], cwd);
  for (const name of new Set([configured, 'origin'])) {
    if (name === undefined || name === '') continue;
    const remote = await gitOutput(['remote', 'get-url', name], cwd);
    if (remote !== undefined && remote !== '') return remote;
  }
  return undefined;
}

async function gitOutput(args: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    const child = await new Promise<{ readonly output: string }>((resolve, reject) => {
      const child = spawn(gitExecutable(), args, {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve({ output }) : resolve({ output: '' })));
    });
    return child.output.trim();
  } catch {
    return undefined;
  }
}

function gitWorkingDirectory(args: readonly string[]): string {
  let cwd = process.cwd();
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-C') {
      const directory = args[++index];
      if (directory === undefined) return cwd;
      cwd = resolve(cwd, directory);
    } else if (args[index]?.startsWith('-C') && args[index]!.length > 2)
      cwd = resolve(cwd, args[index]!.slice(2));
  }
  return cwd;
}

async function ssh(args: string[]): Promise<number> {
  const forwarded: string[] = [];
  let port = 22;
  let index = 0;
  while (args[index]?.startsWith('-')) {
    const option = args[index++]!;
    if (option === '-p') {
      const value = args[index++] ?? '';
      if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error('GIT_SSH_ARGUMENT_INVALID');
      port = Number(value);
      forwarded.push(option, value);
    } else if (option === '-o' && args[index] === 'SendEnv=GIT_PROTOCOL') {
      forwarded.push(option, args[index++]!);
    } else if (['-4', '-6', '-v'].includes(option)) forwarded.push(option);
    else throw new Error('GIT_SSH_ARGUMENT_INVALID');
  }
  const destination = args[index++];
  const command = args[index++];
  if (destination === undefined || command === undefined || index !== args.length)
    throw new Error('GIT_SSH_ARGUMENT_INVALID');
  const host = destination.slice(destination.lastIndexOf('@') + 1);
  const repository = /^(?:git-upload-pack|git-receive-pack|git-upload-archive) '(.*)'$/su.exec(
    command
  )?.[1];
  if (repository === undefined) throw new Error('GIT_SSH_ARGUMENT_INVALID');
  const path = repository.replaceAll("'\\''", "'").replaceAll("'\\!'", '!');
  const match = await gitCredentialRequest('/ssh', { host, port, path });
  if (match.matched !== true) {
    const environment = await originalGitEnvironment();
    let originalCommand = process.env.MAR_GIT_ORIGINAL_SSH_COMMAND ?? environment.GIT_SSH_COMMAND;
    if (originalCommand === undefined) {
      try {
        originalCommand = execFileSync(gitExecutable(), ['config', '--get', 'core.sshCommand'], {
          env: environment,
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        }).replace(/\r?\n$/u, '');
      } catch (error) {
        if ((error as { status?: unknown }).status !== 1)
          throw new Error('GIT_TRANSPORT_UNAVAILABLE');
      }
    }
    if (originalCommand !== undefined) {
      return run(gitShell(), ['-c', `${originalCommand} "$@"`, 'mar-git-ssh', ...args], {
        environment
      });
    }
    return run(environment.GIT_SSH ?? 'ssh', args, { environment });
  }
  if (
    typeof match.username !== 'string' ||
    typeof match.keyFile !== 'string' ||
    typeof match.configFile !== 'string' ||
    typeof match.knownHostsFile !== 'string' ||
    typeof match.askpassImport !== 'string' ||
    typeof match.id !== 'string'
  )
    throw new Error('GIT_CREDENTIAL_REQUEST_INVALID');
  return run(
    'ssh',
    [
      '-F',
      match.configFile,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${sshConfigValue(match.knownHostsFile)}`,
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'PreferredAuthentications=publickey',
      '-o',
      'BatchMode=no',
      '-i',
      match.keyFile,
      ...forwarded,
      '-l',
      match.username,
      host,
      command
    ],
    {
      environment: {
        ...process.env,
        SSH_ASKPASS: process.execPath,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env.DISPLAY || 'mar:0',
        NODE_OPTIONS: match.askpassImport,
        MAR_GIT_KEY_ID: match.id
      }
    }
  );
}

function sshConfigValue(value: string): string {
  if (/[\r\n\0"]/u.test(value)) throw new Error('GIT_SSH_ARGUMENT_INVALID');
  return `"${value.replaceAll('\\', '/')}"`;
}
function gitShell(): string {
  if (process.platform !== 'win32') return '/bin/sh';
  const execPath = execFileSync(gitExecutable(), ['--exec-path'], {
    encoding: 'utf8',
    windowsHide: true
  }).trim();
  const shell = resolve(execPath, '../../../usr/bin/sh.exe');
  if (!existsSync(shell)) throw new Error('GIT_TRANSPORT_UNAVAILABLE');
  return shell;
}
function gitExecutable(): string {
  return process.env.MAR_GIT_BINARY ?? 'git';
}

try {
  const args = process.argv.slice(2);
  const mode = args.shift();
  process.exitCode =
    mode === 'credential'
      ? await credential(args[0])
      : mode === 'ssh'
        ? await ssh(args)
        : mode === 'invoke'
          ? await invoke(args)
          : 1;
} catch {
  // Never serialize caught errors: child-process errors may contain credential output.
  if (process.argv[2] === 'credential') process.stdout.write('quit=true\n\n');
  process.stderr.write(
    'Personal Git authentication failed. Check your credentials and the Node SSH host trust.\n'
  );
  process.exitCode = 1;
}
