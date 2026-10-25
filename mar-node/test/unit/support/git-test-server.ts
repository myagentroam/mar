import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { connect, type Server } from 'node:net';

export interface CommandOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly input?: string | Buffer;
}

export interface GitHttpUser {
  readonly username: string;
  readonly secret: string;
}

export interface GitHttpAuthAttempt {
  readonly path: string;
  readonly username: string | null;
  readonly authenticated: boolean;
}

export interface SshKey {
  readonly privateKey: string;
  readonly passphrase: string | undefined;
}

export async function temporaryDirectory(prefix = 'mar-git-execution-'): Promise<string> {
  return mkdtemp(join('/tmp', prefix));
}

export function randomSecret(): string {
  return randomBytes(24).toString('base64url');
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {}
): Promise<string> {
  return (await runCommandOutput(command, args, options)).toString('utf8');
}

async function runCommandOutput(
  command: string,
  args: readonly string[],
  options: CommandOptions = {}
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.environment },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', () => reject(new Error('The fixture command could not start.')));
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout));
        return;
      }
      reject(
        new Error(
          `The fixture command failed: ${commandFailureKind(
            code,
            Buffer.concat([
              ...stderr,
              ...(command === 'openssl' && args[0] === 'verify' ? stdout : [])
            ]).toString('utf8')
          )}.`
        )
      );
    });
    child.stdin.end(options.input);
  });
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {}
): Promise<string> {
  return runCommand('git', args, { cwd, environment });
}

export async function createGitEnvironment(
  root: string,
  additions: Readonly<Record<string, string | undefined>> = {}
): Promise<Record<string, string>> {
  const home = join(root, 'home');
  const xdgConfigHome = join(root, 'xdg-config');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(xdgConfigHome, { recursive: true, mode: 0o700 });
  return {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...Object.fromEntries(
      Object.entries(additions).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
  };
}

export async function contentsUnder(path: string): Promise<string> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const contents = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory()) return contentsUnder(entryPath);
        if (!entry.isFile()) return '';
        return readFile(entryPath, 'utf8');
      })
    );
    return contents.join('\n');
  } catch (error) {
    if (isMissing(error)) return '';
    throw error;
  }
}

export class GitHttpTestServer {
  readonly root: string;
  readonly certificateAuthority: string | undefined;
  readonly attempts: GitHttpAuthAttempt[] = [];

  #server: Server;
  #baseUrl: string;
  #users: Map<string, string>;
  #gitHttpBackend: string;

  private constructor(
    root: string,
    server: Server,
    baseUrl: string,
    users: readonly GitHttpUser[],
    gitHttpBackend: string,
    certificateAuthority?: string
  ) {
    this.root = root;
    this.#server = server;
    this.#baseUrl = baseUrl;
    this.#users = new Map(users.map((user) => [user.username, user.secret]));
    this.#gitHttpBackend = gitHttpBackend;
    this.certificateAuthority = certificateAuthority;
  }

  static async createHttps(users: readonly GitHttpUser[]): Promise<GitHttpTestServer> {
    const root = await temporaryDirectory('mar-git-https-');
    const certificates = await createCertificates(root);
    const gitHttpBackend = await gitHttpBackendPath();
    const server = createHttpsServer(
      {
        key: await readFile(certificates.key),
        cert: await readFile(certificates.certificate)
      },
      (request, response) => {
        void instance?.handle(request, response);
      }
    );
    const port = await listen(server);
    const instance = new GitHttpTestServer(
      root,
      server,
      `https://127.0.0.1:${port}`,
      users,
      gitHttpBackend,
      certificates.authority
    );
    return instance;
  }

  static async createHttp(users: readonly GitHttpUser[]): Promise<GitHttpTestServer> {
    const root = await temporaryDirectory('mar-git-http-');
    const gitHttpBackend = await gitHttpBackendPath();
    const server = createHttpServer((request, response) => {
      void instance?.handle(request, response);
    });
    const port = await listen(server);
    const instance = new GitHttpTestServer(
      root,
      server,
      `http://127.0.0.1:${port}`,
      users,
      gitHttpBackend
    );
    return instance;
  }

  async createRepository(name: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9/_-]*$/iu.test(name)) throw new Error('Invalid fixture repository name.');
    const repository = join(this.root, 'repositories', `${name}.git`);
    const seed = join(this.root, 'seed', name.replaceAll('/', '-'));
    await mkdir(dirname(repository), { recursive: true, mode: 0o700 });
    await mkdir(seed, { recursive: true, mode: 0o700 });
    await runGit(seed, ['init', '-b', 'main']);
    await runGit(seed, ['config', 'user.name', 'Fixture']);
    await runGit(seed, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(seed, 'README.md'), `${name}\n`);
    await runGit(seed, ['add', 'README.md']);
    await runGit(seed, ['commit', '-m', 'Initial fixture']);
    await runGit(seed, ['init', '--bare', repository]);
    await runGit(seed, ['remote', 'add', 'origin', repository]);
    await runGit(seed, ['push', 'origin', 'main']);
    await runGit(seed, ['--git-dir', repository, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    return `${this.#baseUrl}/${name}.git`;
  }

  get port(): number {
    return Number(new URL(this.#baseUrl).port);
  }

  attemptsFor(path: string): readonly GitHttpAuthAttempt[] {
    return this.attempts.filter((attempt) => attempt.path.startsWith(`/${path}`));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.#server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
    });
    await rm(this.root, { recursive: true, force: true });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', this.#baseUrl);
    const authorization = parseBasicAuthorization(request.headers.authorization);
    const authenticated =
      authorization !== undefined &&
      this.#users.get(authorization.username) === authorization.secret;
    this.attempts.push({
      path: requestUrl.pathname,
      username: authorization?.username ?? null,
      authenticated
    });
    if (!authenticated) {
      response.writeHead(401, {
        connection: 'close',
        'www-authenticate': 'Basic realm="Git fixture"'
      });
      response.end();
      return;
    }

    try {
      const body = await requestBody(request);
      const output = await runCommandOutput(this.#gitHttpBackend, [], {
        environment: {
          GIT_HTTP_EXPORT_ALL: '1',
          GIT_PROJECT_ROOT: join(this.root, 'repositories'),
          PATH_INFO: requestUrl.pathname,
          QUERY_STRING: requestUrl.search.slice(1),
          REQUEST_METHOD: request.method ?? 'GET',
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          CONTENT_LENGTH: String(body.byteLength),
          REMOTE_ADDR: '127.0.0.1',
          REMOTE_USER: authorization.username,
          GIT_PROTOCOL: String(request.headers['git-protocol'] ?? '')
        },
        input: body
      });
      writeCgiResponse(response, output);
    } catch {
      response.writeHead(500, { connection: 'close' });
      response.end();
    }
  }
}

export class GitSshTestServer {
  readonly root: string;
  readonly username = userInfo().username;
  readonly knownHosts: string;
  readonly port: number;

  #process: ReturnType<typeof spawn>;
  #repositoryRoot: string;
  #authorizedKeys: string;

  private constructor(
    root: string,
    port: number,
    process: ReturnType<typeof spawn>,
    repositoryRoot: string,
    authorizedKeys: string,
    knownHosts: string
  ) {
    this.root = root;
    this.port = port;
    this.#process = process;
    this.#repositoryRoot = repositoryRoot;
    this.#authorizedKeys = authorizedKeys;
    this.knownHosts = knownHosts;
  }

  static async create(): Promise<GitSshTestServer> {
    const root = await temporaryDirectory('mar-git-sshd-');
    const hostKey = join(root, 'host-key');
    const authorizedKeys = join(root, 'authorized_keys');
    const knownHosts = join(root, 'known_hosts');
    const repositoryRoot = join(root, 'repositories');
    const port = await availablePort();
    await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
    await writeFile(authorizedKeys, '', { mode: 0o600 });
    await generateSshKey(hostKey);
    const hostPublicKey = (await readFile(`${hostKey}.pub`, 'utf8')).trim().split(/\s+/u);
    await writeFile(knownHosts, `[127.0.0.1]:${port} ${hostPublicKey[0]} ${hostPublicKey[1]}\n`, {
      mode: 0o600
    });
    const configuration = join(root, 'sshd_config');
    await writeFile(
      configuration,
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${hostKey}`,
        `PidFile ${join(root, 'sshd.pid')}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'ChallengeResponseAuthentication no',
        'UsePAM no',
        'PermitRootLogin no',
        'PermitUserRC no',
        'StrictModes no',
        `AllowUsers ${userInfo().username}`,
        'AllowTcpForwarding no',
        'X11Forwarding no',
        'PrintMotd no',
        'LogLevel ERROR',
        'Subsystem sftp internal-sftp'
      ].join('\n') + '\n',
      { mode: 0o600 }
    );
    await runCommand('/usr/sbin/sshd', ['-t', '-f', configuration]);
    const process = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', configuration], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
    try {
      await waitForPort(port, process);
      return new GitSshTestServer(root, port, process, repositoryRoot, authorizedKeys, knownHosts);
    } catch (error) {
      process.kill('SIGTERM');
      await waitForExit(process);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async createRepository(name: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9/_-]*$/iu.test(name)) throw new Error('Invalid fixture repository name.');
    const repository = join(this.#repositoryRoot, `${name}.git`);
    const seed = join(this.root, 'seed', name.replaceAll('/', '-'));
    await mkdir(dirname(repository), { recursive: true, mode: 0o700 });
    await mkdir(seed, { recursive: true, mode: 0o700 });
    await runGit(seed, ['init', '-b', 'main']);
    await runGit(seed, ['config', 'user.name', 'Fixture']);
    await runGit(seed, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(seed, 'README.md'), `${name}\n`);
    await runGit(seed, ['add', 'README.md']);
    await runGit(seed, ['commit', '-m', 'Initial fixture']);
    await runGit(seed, ['init', '--bare', repository]);
    await runGit(seed, ['remote', 'add', 'origin', repository]);
    await runGit(seed, ['push', 'origin', 'main']);
    await runGit(seed, ['--git-dir', repository, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    return `ssh://${this.username}@127.0.0.1:${this.port}${repository}`;
  }

  async createKey(name: string, passphrase?: string): Promise<SshKey> {
    const privateKeyPath = join(this.root, `${name}-key`);
    await generateSshKey(privateKeyPath, passphrase);
    await writeFile(
      this.#authorizedKeys,
      (await readFile(this.#authorizedKeys, 'utf8')) +
        (await readFile(`${privateKeyPath}.pub`, 'utf8'))
    );
    return {
      privateKey: await readFile(privateKeyPath, 'utf8'),
      passphrase
    };
  }

  async incorrectKnownHosts(): Promise<string> {
    const wrongKey = join(this.root, 'wrong-host-key');
    await generateSshKey(wrongKey);
    const publicKey = (await readFile(`${wrongKey}.pub`, 'utf8')).trim().split(/\s+/u);
    const path = join(this.root, 'incorrect_known_hosts');
    await writeFile(path, `[127.0.0.1]:${this.port} ${publicKey[0]} ${publicKey[1]}\n`, {
      mode: 0o600
    });
    return path;
  }

  async close(): Promise<void> {
    if (!this.#process.killed) this.#process.kill('SIGTERM');
    await waitForExit(this.#process);
    await rm(this.root, { recursive: true, force: true });
  }
}

async function createCertificates(root: string): Promise<{
  readonly authority: string;
  readonly certificate: string;
  readonly key: string;
}> {
  const certificates = join(root, 'certificates');
  await mkdir(certificates, { recursive: true, mode: 0o700 });
  const authority = join(certificates, 'authority.pem');
  const authorityKey = join(certificates, 'authority-key.pem');
  const certificate = join(certificates, 'server.pem');
  const key = join(certificates, 'server-key.pem');
  const request = join(certificates, 'server.csr');
  const extensions = join(certificates, 'server.ext');
  await runCommand('openssl', [
    'req',
    '-x509',
    '-sha256',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    authorityKey,
    '-out',
    authority,
    '-days',
    '1',
    '-subj',
    '/CN=MAR Git Test Authority',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-addext',
    'subjectKeyIdentifier=hash'
  ]);
  await runCommand('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    request,
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1'
  ]);
  await writeFile(
    extensions,
    [
      'subjectAltName=IP:127.0.0.1',
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid,issuer'
    ].join('\n')
  );
  await runCommand('openssl', [
    'x509',
    '-req',
    '-sha256',
    '-in',
    request,
    '-CA',
    authority,
    '-CAkey',
    authorityKey,
    '-CAcreateserial',
    '-out',
    certificate,
    '-days',
    '1',
    '-extfile',
    extensions
  ]);
  try {
    await runCommand('openssl', [
      'verify',
      '-x509_strict',
      '-purpose',
      'sslserver',
      '-CAfile',
      authority,
      certificate
    ]);
  } catch (error) {
    // Only this isolated fixture's public certificates are diagnostic material, never its keys.
    console.info(
      'GIT_TLS_FIXTURE_PUBLIC_CHAIN',
      JSON.stringify({
        openssl: (await runCommand('openssl', ['version'])).trim(),
        authority: await readFile(authority, 'utf8'),
        certificate: await readFile(certificate, 'utf8')
      })
    );
    throw error;
  }
  return { authority, certificate, key };
}

async function gitHttpBackendPath(): Promise<string> {
  const directory = (await runCommand('git', ['--exec-path'])).trim();
  const executable = join(directory, 'git-http-backend');
  await stat(executable);
  return executable;
}

function parseBasicAuthorization(
  value: string | undefined
): { username: string; secret: string } | undefined {
  if (value === undefined || !value.startsWith('Basic ')) return undefined;
  try {
    const [username, ...secret] = Buffer.from(value.slice('Basic '.length), 'base64')
      .toString('utf8')
      .split(':');
    if (username === undefined || secret.length === 0) return undefined;
    return { username, secret: secret.join(':') };
  } catch {
    return undefined;
  }
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function writeCgiResponse(response: ServerResponse, output: Buffer): void {
  const carriageReturnSeparator = Buffer.from('\r\n\r\n');
  const lineFeedSeparator = Buffer.from('\n\n');
  const separator =
    output.indexOf(carriageReturnSeparator) >= 0 ? carriageReturnSeparator : lineFeedSeparator;
  const marker = output.indexOf(separator);
  if (marker < 0) {
    response.writeHead(500, { connection: 'close' });
    response.end();
    return;
  }
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of output.subarray(0, marker).toString('utf8').split(/\r?\n/u)) {
    const delimiter = line.indexOf(':');
    if (delimiter <= 0) continue;
    const name = line.slice(0, delimiter);
    const value = line.slice(delimiter + 1).trim();
    if (name.toLowerCase() === 'status') {
      status = Number.parseInt(value, 10);
      continue;
    }
    headers[name] = value;
  }
  response.writeHead(Number.isFinite(status) ? status : 500, headers);
  response.end(output.subarray(marker + separator.length));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('The fixture server did not bind a port.');
  return address.port;
}

async function availablePort(): Promise<number> {
  const server = createHttpServer();
  try {
    return await listen(server);
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
    });
  }
}

async function generateSshKey(path: string, passphrase = ''): Promise<void> {
  await runCommand('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-f', path]);
  await chmod(path, 0o600);
  await chmod(`${path}.pub`, 0o600);
}

async function waitForPort(port: number, process: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (process.exitCode !== null) throw new Error('The fixture SSH server could not start.');
    if (await canConnect(port)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error('The fixture SSH server did not become available.');
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(100);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => resolvePromise(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

async function waitForExit(process: ReturnType<typeof spawn>): Promise<void> {
  if (process.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => process.kill('SIGKILL'), 1_000);
    process.once('exit', () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function commandFailureKind(code: number | null, stderr: string): string {
  const certificateError = stderr.match(/error (\d+) at (\d+) depth lookup/u);
  if (certificateError) return `TLS_X509_${certificateError[1]}_DEPTH_${certificateError[2]}`;
  if (stderr.includes('SSL') && stderr.includes('certificate')) return 'TLS_CERTIFICATE_REJECTED';
  if (stderr.includes('requested URL returned error: 500')) return 'HTTP_BACKEND_FAILED';
  if (stderr.includes('Git SSH key could not be unlocked.')) return 'SSH_ASKPASS_REJECTED';
  if (stderr.includes('Host key verification failed.')) return 'SSH_HOST_UNTRUSTED';
  if (stderr.includes('Permission denied (publickey')) return 'SSH_PUBLIC_KEY_REJECTED';
  if (stderr.includes('Personal Git authentication failed.')) return 'GIT_AUTHENTICATION_REJECTED';
  return `EXIT_${code ?? 'UNKNOWN'}`;
}
