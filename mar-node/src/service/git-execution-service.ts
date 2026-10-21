import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  personalGitRuntimeSchema,
  selectGitCredential,
  type PersonalGitRuntime
} from '@myagentroam/protocol';

const execute = promisify(execFile);
export interface GitExecutionLease {
  readonly environment: Readonly<Record<string, string>>;
  release(): void;
}
interface Context {
  readonly key: string;
  readonly token: string;
  readonly configuration: PersonalGitRuntime;
  readonly environment: Readonly<Record<string, string>>;
  readonly restore: Readonly<Record<string, string | null>>;
  readonly keys: Map<string, Promise<string>>;
  directory?: Promise<string>;
  references: number;
  timer?: NodeJS.Timeout;
}

/** Owns only process-scoped Git credentials, never repository or global configuration. */
export class GitExecutionService {
  private readonly contexts = new Map<string, Context>();
  private readonly tokens = new Map<string, Context>();
  private readonly removals = new Set<Promise<void>>();
  private server: Server | undefined;
  private starting: Promise<string> | undefined;
  private root: Promise<string> | undefined;
  private readonly wrappers = new Map<string, Promise<string>>();
  private closed = false;

  constructor(
    private readonly options: {
      readonly idleTimeoutMs?: number;
      readonly directory?: string;
      /** Trusted Node/test configuration, never a browser-provided path. */
      readonly knownHostsFile?: string;
    } = {}
  ) {}

  async acquire(
    userId: number,
    configuration: PersonalGitRuntime,
    baseEnvironment: Readonly<Record<string, string>> = {}
  ): Promise<GitExecutionLease> {
    if (this.closed) throw new Error('GIT_EXECUTION_CLOSED');
    if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('USER_AUTHORIZATION_REQUIRED');
    const parsed = personalGitRuntimeSchema.safeParse(configuration);
    if (!parsed.success) throw new Error('GIT_CONFIGURATION_INVALID');
    // Execution credentials rotate independently of the user's stable Git capability.
    const stableEnvironment = Object.fromEntries(
      Object.entries(baseEnvironment).filter(([name]) => name !== 'MAR_CTL_USER_TOKEN')
    );
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          userId,
          parsed.data,
          Object.entries(stableEnvironment).sort(([a], [b]) => a.localeCompare(b))
        ])
      )
      .digest('hex');
    const endpoint = await this.start();
    if (this.closed) throw new Error('GIT_EXECUTION_CLOSED');
    let context = this.contexts.get(key);
    if (context === undefined) {
      const token = randomBytes(32).toString('hex');
      const original = { ...process.env, ...stableEnvironment };
      const binary = await gitExecutable(original);
      const environment: Record<string, string> = {
        ...stableEnvironment,
        MAR_GIT_ENDPOINT: endpoint,
        MAR_GIT_TOKEN: token
      };
      const count = Number(original.GIT_CONFIG_COUNT ?? 0);
      if (!Number.isSafeInteger(count) || count < 0 || count > 128)
        throw new Error('GIT_ENVIRONMENT_INVALID');
      const entries = parsed.data.credentials.some((entry) => entry.protocol === 'HTTPS')
        ? [
            ['credential.helper', ''],
            ['credential.helper', `!${helperCommand('git-execution-helper')} credential`],
            ['credential.useHttpPath', 'true']
          ]
        : [];
      if (entries.length > 0) environment.GIT_CONFIG_COUNT = String(count + entries.length);
      for (const [index, [name, value]] of entries.entries()) {
        environment[`GIT_CONFIG_KEY_${count + index}`] = name!;
        environment[`GIT_CONFIG_VALUE_${count + index}`] = value!;
      }
      if (parsed.data.credentials.some((entry) => entry.protocol === 'SSH')) {
        const sshCommand = `${helperCommand('git-execution-helper')} ssh`;
        environment.GIT_SSH_COMMAND = sshCommand;
        environment.GIT_SSH_VARIANT = 'ssh';
        environment.MAR_GIT_SSH_COMMAND = sshCommand;
      }
      const pathKey = process.platform === 'win32' && original.Path !== undefined ? 'Path' : 'PATH';
      environment[pathKey] =
        `${await this.gitWrapper(binary)}${delimiter}${original[pathKey] ?? ''}`;
      const restore = Object.fromEntries(
        Object.keys(environment)
          .filter(
            (name) => environment[name] !== stableEnvironment[name] || name.startsWith('MAR_GIT_')
          )
          .map((name) => [name, name.startsWith('MAR_GIT_') ? null : (original[name] ?? null)])
      );
      if (this.closed) throw new Error('GIT_EXECUTION_CLOSED');
      // Binary discovery and wrapper creation yield; another acquire may have published it.
      context = this.contexts.get(key) ?? {
        key,
        token,
        configuration: parsed.data,
        environment: Object.freeze(environment),
        restore,
        keys: new Map(),
        references: 0
      };
      this.contexts.set(key, context);
      this.tokens.set(context.token, context);
    }
    return {
      environment: Object.freeze({ ...baseEnvironment, ...context.environment }),
      release: this.reference(context)
    };
  }

  retain(environment: Readonly<Record<string, string>>): () => void {
    if (environment.MAR_GIT_TOKEN === undefined) return () => undefined;
    const context = this.tokens.get(environment.MAR_GIT_TOKEN);
    if (context === undefined || this.closed) throw new Error('GIT_CREDENTIAL_CONTEXT_EXPIRED');
    return this.reference(context);
  }

  private reference(context: Context): () => void {
    clearTimeout(context.timer);
    delete context.timer;
    context.references++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--context.references !== 0 || this.closed) return;
      // Warm runtimes retain their own reference; this grace period starts after the last owner.
      context.timer = setTimeout(() => this.retire(context), this.options.idleTimeoutMs ?? 70_000);
      context.timer.unref();
    };
  }

  private retire(context: Context): void {
    this.contexts.delete(context.key);
    this.tokens.delete(context.token);
    clearTimeout(context.timer);
    const removal = Promise.allSettled(context.keys.values())
      .then(async () => {
        if (context.directory !== undefined)
          await rm(await context.directory, { recursive: true, force: true });
      })
      .catch(() => undefined);
    this.removals.add(removal);
    void removal.finally(() => this.removals.delete(removal));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => undefined);
    if (this.server !== undefined) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    for (const context of this.contexts.values()) this.retire(context);
    await Promise.all(this.removals);
    if (this.root !== undefined) await rm(await this.root, { recursive: true, force: true });
  }

  private start(): Promise<string> {
    this.starting ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.respond(request, response).catch(() => {
          if (!response.headersSent)
            response.writeHead(500, { 'content-type': 'application/json' });
          response.end('{"error":"GIT_CREDENTIAL_UNAVAILABLE"}');
        });
      });
      this.server = server;
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string')
          return reject(new Error('GIT_CREDENTIAL_UNAVAILABLE'));
        server.unref();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return this.starting;
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    const token = request.headers.authorization?.replace(/^Bearer /u, '');
    const context = token === undefined ? undefined : this.tokens.get(token);
    if (
      request.method !== 'POST' ||
      request.headers.origin !== undefined ||
      context === undefined ||
      this.closed
    ) {
      response.writeHead(403).end('{"error":"GIT_CREDENTIAL_CONTEXT_EXPIRED"}');
      return;
    }
    const release = this.reference(context);
    try {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 64 * 1024) {
          response.writeHead(413).end('{"error":"GIT_CREDENTIAL_REQUEST_INVALID"}');
          return;
        }
      }
      const input = JSON.parse(body) as Record<string, unknown>;
      if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw new Error('GIT_CREDENTIAL_REQUEST_INVALID');
      if (request.url === '/restore') {
        response.end(JSON.stringify({ restore: context.restore }));
        return;
      }
      if (request.url === '/passphrase') {
        const credential = context.configuration.credentials.find(
          (candidate) => candidate.id === input.id && candidate.protocol === 'SSH'
        );
        response.end(JSON.stringify({ passphrase: credential?.passphrase ?? '' }));
        return;
      }
      if (request.url === '/identity') {
        const match =
          typeof input.remote === 'string'
            ? matchRemoteCredential(context.configuration.credentials, input.remote)
            : undefined;
        if (match?.commitName) {
          response.end(
            JSON.stringify({
              matched: true,
              name: match.commitName,
              email: match.commitEmail
            })
          );
        } else response.end('{"matched":false}');
        return;
      }
      if (request.url !== '/credential' && request.url !== '/ssh') {
        response.writeHead(404).end('{}');
        return;
      }
      const protocol = request.url === '/ssh' ? 'SSH' : 'HTTPS';
      let match;
      try {
        if (protocol === 'HTTPS' && input.protocol !== 'https') throw new Error('UNMATCHED');
        if (typeof input.host !== 'string' || typeof input.path !== 'string')
          throw new Error('UNMATCHED');
        const address = new URL(`${protocol === 'SSH' ? 'ssh' : 'https'}://${input.host}`);
        match = selectGitCredential(context.configuration.credentials, {
          protocol,
          host: address.hostname,
          port: Number(input.port ?? (address.port || (protocol === 'SSH' ? 22 : 443))),
          path: protocol === 'SSH' ? input.path : decodeURIComponent(input.path)
        });
      } catch {
        match = undefined;
      }
      if (match === undefined) {
        response.end('{"matched":false}');
        return;
      }
      if (protocol === 'HTTPS') {
        response.end(
          JSON.stringify({ matched: true, username: match.username, password: match.secret })
        );
        return;
      }
      let key = context.keys.get(match.id);
      if (key === undefined) {
        const credential = match;
        key = (async () => {
          context.directory ??= this.privateRoot().then(async (root) => {
            const directory = await mkdtemp(join(root, 'context-'));
            try {
              await writeFile(join(directory, 'ssh_config'), '', { mode: 0o600, flag: 'wx' });
              return directory;
            } catch (error) {
              await rm(directory, { recursive: true, force: true });
              throw error;
            }
          });
          const file = join(await context.directory, `${randomBytes(16).toString('hex')}.key`);
          await writeFile(file, `${credential.secret.trim()}\n`, { mode: 0o600, flag: 'wx' });
          return file;
        })();
        context.keys.set(match.id, key);
      }
      response.end(
        JSON.stringify({
          matched: true,
          id: match.id,
          username: match.username,
          keyFile: await key,
          configFile: join(await context.directory!, 'ssh_config'),
          knownHostsFile: this.options.knownHostsFile ?? join(homedir(), '.ssh', 'known_hosts'),
          askpassImport: helperImport('git-askpass')
        })
      );
    } finally {
      release();
    }
  }

  private privateRoot(): Promise<string> {
    this.root ??= (async () => {
      const parent = this.options.directory ?? tmpdir();
      if (this.options.directory !== undefined) {
        await mkdir(parent, { recursive: true, mode: 0o700 });
        if ((await lstat(parent)).isSymbolicLink())
          throw new Error('GIT_CREDENTIAL_DIRECTORY_INVALID');
        for (const item of await readdir(parent, { withFileTypes: true })) {
          const pid = /^mar-git-(\d+)-/u.exec(item.name)?.[1];
          if (pid === undefined || !item.isDirectory()) continue;
          try {
            process.kill(Number(pid), 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH')
              await rm(join(parent, item.name), { recursive: true, force: true });
          }
        }
      }
      const root = await mkdtemp(join(parent, `mar-git-${process.pid}-`));
      try {
        if (process.platform === 'win32') {
          const { stdout } = await execute('whoami', [], { windowsHide: true });
          await execute(
            'icacls',
            [root, '/inheritance:r', '/grant:r', `${stdout.trim()}:(OI)(CI)F`],
            { windowsHide: true }
          );
        } else await chmod(root, 0o700);
        return root;
      } catch {
        await rm(root, { recursive: true, force: true });
        throw new Error('GIT_CREDENTIAL_DIRECTORY_INVALID');
      }
    })();
    return this.root;
  }

  private gitWrapper(binary: string): Promise<string> {
    let wrapper = this.wrappers.get(binary);
    if (wrapper !== undefined) return wrapper;
    wrapper = (async () => {
      const directory = join(
        await this.privateRoot(),
        `bin-${createHash('sha256').update(binary).digest('hex').slice(0, 16)}`
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform === 'win32') {
        await writeFile(
          join(directory, 'git.cmd'),
          `@echo off\r\nset "MAR_GIT_BINARY=${windowsEnvironmentValue(binary)}"\r\n${windowsCommand([...helperArguments('git-execution-helper'), 'invoke'])} %*\r\n`,
          { mode: 0o700, flag: 'wx' }
        );
      } else {
        const executable = join(directory, 'git');
        await writeFile(
          executable,
          `#!/bin/sh\nMAR_GIT_BINARY=${shellArgument(binary)}\nexport MAR_GIT_BINARY\nexec ${helperCommand('git-execution-helper')} invoke "$@"\n`,
          { mode: 0o700, flag: 'wx' }
        );
        await chmod(executable, 0o700);
      }
      return directory;
    })();
    this.wrappers.set(binary, wrapper);
    return wrapper;
  }
}

function matchRemoteCredential(
  credentials: PersonalGitRuntime['credentials'],
  remote: string
): PersonalGitRuntime['credentials'][number] | undefined {
  try {
    if (remote.startsWith('https://')) {
      const address = new URL(remote);
      return selectGitCredential(credentials, {
        protocol: 'HTTPS',
        host: address.hostname,
        port: Number(address.port || 443),
        path: decodeURIComponent(address.pathname)
      });
    }
    if (remote.startsWith('ssh://')) {
      const address = new URL(remote);
      return selectGitCredential(credentials, {
        protocol: 'SSH',
        host: address.hostname,
        port: Number(address.port || 22),
        path: decodeURIComponent(address.pathname)
      });
    }
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(remote);
    if (scp === null) return undefined;
    return selectGitCredential(credentials, {
      protocol: 'SSH',
      host: scp[1]!,
      port: 22,
      path: scp[2]!
    });
  } catch {
    return undefined;
  }
}

async function gitExecutable(environment: NodeJS.ProcessEnv): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['git.exe'] : ['-lc', 'command -v git'];
  const { stdout } = await execute(command, args, {
    env: environment,
    windowsHide: true,
    maxBuffer: 64 * 1024
  });
  const executable = stdout
    .split(/\r?\n/u)
    .find((value) => value.trim() !== '')
    ?.trim();
  if (executable === undefined) throw new Error('GIT_TRANSPORT_UNAVAILABLE');
  return executable;
}

function helperLocation(name: string): URL {
  const built = new URL(`../${name}.js`, import.meta.url);
  return existsSync(built) ? built : new URL(`../${name}.ts`, import.meta.url);
}
function helperArguments(name: string): string[] {
  const url = helperLocation(name);
  return [
    process.execPath,
    ...(url.pathname.endsWith('.ts') ? ['--import', import.meta.resolve('tsx/esm')] : []),
    fileURLToPath(url)
  ];
}
function helperImport(name: string): string {
  const url = helperLocation(name);
  return `${url.pathname.endsWith('.ts') ? `--import ${JSON.stringify(import.meta.resolve('tsx/esm'))} ` : ''}--import ${JSON.stringify(url.href)}`;
}
function helperCommand(name: string): string {
  return helperArguments(name).map(shellArgument).join(' ');
}
function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''").replaceAll('\\', '/')}'`;
}
function windowsCommand(args: readonly string[]): string {
  return args.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ');
}
function windowsEnvironmentValue(value: string): string {
  if (/[\r\n\0"]/u.test(value)) throw new Error('GIT_TRANSPORT_UNAVAILABLE');
  return value.replaceAll('%', '%%');
}
