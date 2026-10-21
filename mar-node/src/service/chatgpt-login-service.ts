import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requestHttp } from '@myagentroam/agent/host/network';
import {
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  CHATGPT_TOKEN_ENDPOINT,
  CHATGPT_JWKS_ENDPOINT,
  CHATGPT_REQUESTED_SCOPE,
  chatgptLoginStartSchema,
  chatgptTokenResponseSchema,
  verifyChatgptIdentity,
  type ChatgptLoginResult
} from '@myagentroam/protocol';

const TTL_MS = 10 * 60_000;
interface Attempt {
  id: string;
  userId: number;
  session: string;
  nonce: string;
  state: string;
  entry: string;
  verifier: string;
  clientId?: string | undefined;
  subject?: string | undefined;
  hostId: string;
  proxy?: string | undefined;
  expiresAt: number;
  redirectUri: string;
  server: Server;
  abort: AbortController;
  timer: NodeJS.Timeout;
  started: boolean;
  exchanging: boolean;
  result?: ChatgptLoginResult | undefined;
  error?: string | undefined;
}
interface StartingAttempt {
  userId: number;
  session: string;
  cancelled: boolean;
  flight?: Promise<void>;
}

/** Temporary, loopback-only OAuth provider. Only the Server may consume token results. */
export class ChatgptLoginService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly starting = new Map<string, StartingAttempt>();
  private hostIdFlight: Promise<string> | undefined;
  constructor(
    private readonly dataDirectory: () => string,
    private readonly request: (
      url: string,
      init: RequestInit,
      proxy?: string,
      signal?: AbortSignal
    ) => Promise<Response> = (url, init, proxy, signal) =>
      requestHttp(
        url,
        { request: init, httpVersion: '1.1', ...(proxy ? { socks5Url: proxy } : {}) },
        signal ?? AbortSignal.timeout(30_000),
        30_000
      )
  ) {}

  operations() {
    return {
      'chatgpt.login.start': (raw: unknown) => this.start(raw),
      'chatgpt.login.status': (raw: unknown) => this.status(raw),
      'chatgpt.login.ack': (raw: unknown) => this.remove(raw),
      'chatgpt.login.cancel': (raw: unknown) => this.remove(raw)
    };
  }

  async start(raw: unknown) {
    const { data, userId, session } = this.context(raw);
    const parsed = chatgptLoginStartSchema.safeParse(data);
    if (!parsed.success) throw new Error('CHATGPT_LOGIN_INPUT_INVALID');
    const input = parsed.data;
    if (this.attempts.has(input.attemptId)) return this.status(raw);
    const existing = this.starting.get(input.attemptId);
    if (existing) {
      if (existing.userId !== userId || existing.session !== session)
        throw new Error('CHATGPT_LOGIN_FORBIDDEN');
      await existing.flight;
      return this.status(raw);
    }
    if (this.attempts.size + this.starting.size >= 64)
      throw new Error('CHATGPT_LOGIN_LIMIT_REACHED');
    if (input.socks5Url !== undefined && new URL(input.socks5Url).protocol !== 'socks5:')
      throw new Error('CHATGPT_LOGIN_INPUT_INVALID');
    const pending: StartingAttempt = { userId, session, cancelled: false };
    this.starting.set(input.attemptId, pending);
    pending.flight = this.openAttempt(input, pending);
    try {
      await pending.flight;
      return this.status(raw);
    } finally {
      if (this.starting.get(input.attemptId) === pending) this.starting.delete(input.attemptId);
    }
  }

  private async openAttempt(
    input: ReturnType<typeof chatgptLoginStartSchema.parse>,
    pending: StartingAttempt
  ): Promise<void> {
    const hostId = await this.hostId();
    if (pending.cancelled) throw new Error('CHATGPT_LOGIN_CANCELLED');
    const server = createServer((req, res) => {
      void this.handle(input.attemptId, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end('Login failed.');
      });
    });
    server.maxHeadersCount = 32;
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (pending.cancelled) {
      server.close();
      server.closeAllConnections();
      throw new Error('CHATGPT_LOGIN_CANCELLED');
    }
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('CHATGPT_LISTENER_FAILED');
    }
    const attempt: Attempt = {
      id: input.attemptId,
      userId: pending.userId,
      session: pending.session,
      nonce: input.nonce,
      state: randomBytes(32).toString('base64url'),
      entry: randomBytes(32).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'),
      clientId: input.clientId,
      subject: input.subject,
      proxy: input.socks5Url,
      hostId,
      server,
      expiresAt: Date.now() + TTL_MS,
      redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
      abort: new AbortController(),
      started: false,
      exchanging: false,
      timer: setTimeout(() => this.clear(input.attemptId), TTL_MS)
    };
    attempt.timer.unref();
    this.attempts.set(attempt.id, attempt);
  }

  status(raw: unknown) {
    const attempt = this.owned(raw);
    if (attempt.result !== undefined) return { status: 'SUCCEEDED', result: attempt.result };
    if (attempt.error !== undefined) return { status: 'FAILED', code: attempt.error };
    return {
      status: 'PENDING',
      verificationUri: attempt.redirectUri.replace(
        '/auth/callback',
        `/auth/start?ticket=${attempt.entry}`
      ),
      expiresAt: attempt.expiresAt
    };
  }

  async remove(raw: unknown) {
    const { data, userId, session } = this.context(raw);
    const id = data['attemptId'];
    const pending = typeof id === 'string' ? this.starting.get(id) : undefined;
    if (pending) {
      if (pending.userId !== userId || pending.session !== session)
        throw new Error('CHATGPT_LOGIN_FORBIDDEN');
      pending.cancelled = true;
      await pending.flight?.catch(() => undefined);
      return { cleared: true };
    }
    const attempt = this.owned(raw);
    this.clear(attempt.id);
    return { cleared: true };
  }

  close(): void {
    for (const pending of this.starting.values()) pending.cancelled = true;
    this.starting.clear();
    for (const id of this.attempts.keys()) this.clear(id);
  }

  private clear(id: string) {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    this.attempts.delete(id);
    clearTimeout(attempt.timer);
    attempt.abort.abort();
    attempt.server.close();
    attempt.server.closeAllConnections();
    attempt.result = undefined;
    attempt.verifier = '';
    attempt.entry = '';
  }

  private context(raw: unknown) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('CHATGPT_LOGIN_INPUT_INVALID');
    const data = { ...(raw as Record<string, unknown>) };
    const userId = data['__requestUserId'],
      session = data['__workspaceWatchSessionHash'];
    delete data['__requestUserId'];
    delete data['__workspaceWatchSessionHash'];
    if (
      !Number.isSafeInteger(userId) ||
      (userId as number) < 1 ||
      typeof session !== 'string' ||
      session.length < 1
    )
      throw new Error('CHATGPT_LOGIN_FORBIDDEN');
    return { data, userId: userId as number, session };
  }

  private owned(raw: unknown): Attempt {
    const { data, userId, session } = this.context(raw);
    const id = data['attemptId'];
    const attempt = typeof id === 'string' ? this.attempts.get(id) : undefined;
    if (
      !attempt ||
      attempt.userId !== userId ||
      attempt.session !== session ||
      Date.now() >= attempt.expiresAt
    )
      throw new Error('CHATGPT_LOGIN_NOT_FOUND');
    return attempt;
  }

  private hostId(): Promise<string> {
    this.hostIdFlight ??= this.loadHostId().catch((error: unknown) => {
      this.hostIdFlight = undefined;
      throw error;
    });
    return this.hostIdFlight;
  }

  private async loadHostId(): Promise<string> {
    const directory = this.dataDirectory(),
      path = join(directory, 'chatgpt-host-id');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, `urn:uuid:${randomUUID()}`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error('CHATGPT_HOST_ID_FAILED');
    }
    const id = await readFile(path, 'utf8');
    if (!/^urn:uuid:[0-9a-f-]{36}$/u.test(id)) throw new Error('CHATGPT_HOST_ID_INVALID');
    return id;
  }

  private async json(url: string, init: RequestInit, attempt: Attempt): Promise<unknown> {
    const response = await this.request(
      url,
      { ...init, redirect: 'error' },
      attempt.proxy,
      AbortSignal.any([attempt.abort.signal, AbortSignal.timeout(30_000)])
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('CHATGPT_TOKEN_EXCHANGE_FAILED');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('CHATGPT_TOKEN_RESPONSE_INVALID');
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 524_288) throw new Error('CHATGPT_TOKEN_RESPONSE_INVALID');
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async handle(id: string, req: IncomingMessage, res: ServerResponse) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    const attempt = this.attempts.get(id);
    if (
      !attempt ||
      req.method !== 'GET' ||
      !req.url ||
      req.url.length > 16_384 ||
      req.headers.host !== new URL(attempt.redirectUri).host ||
      Date.now() >= attempt.expiresAt
    ) {
      res.writeHead(400);
      res.end('Invalid login request.');
      return;
    }
    const url = new URL(req.url, attempt.redirectUri);
    if (
      url.pathname === '/auth/start' &&
      !attempt.started &&
      url.searchParams.getAll('ticket').length === 1 &&
      url.searchParams.get('ticket') === attempt.entry
    ) {
      attempt.started = true;
      attempt.entry = '';
      const authorize = new URL(`${CHATGPT_ISSUER}/api/accounts/authorize`);
      authorize.search = new URLSearchParams({
        response_type: 'code',
        client_id: attempt.clientId ?? 'dynamic_agent_client',
        ext_agent_host_id: attempt.hostId,
        scope: CHATGPT_REQUESTED_SCOPE,
        resource: CHATGPT_RESOURCE,
        redirect_uri: attempt.redirectUri,
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        ...(attempt.clientId ? {} : { agent_name_hint: 'MyAgentRoam' })
      }).toString();
      res.writeHead(302, { location: authorize.href });
      res.end();
      return;
    }
    if (
      url.pathname !== '/auth/callback' ||
      !attempt.started ||
      attempt.exchanging ||
      attempt.result ||
      attempt.error ||
      url.searchParams.getAll('state').length !== 1 ||
      url.searchParams.get('state') !== attempt.state
    ) {
      res.writeHead(400);
      res.end('Invalid login callback.');
      return;
    }
    attempt.exchanging = true;
    try {
      if (url.searchParams.has('error')) throw new Error('CHATGPT_AUTHORIZATION_DENIED');
      const callbackClient = url.searchParams.get('client_id');
      const clientId = callbackClient ?? attempt.clientId;
      const code = url.searchParams.get('code');
      if (
        !clientId ||
        clientId === 'dynamic_agent_client' ||
        clientId.length > 512 ||
        !code ||
        code.length > 8192 ||
        url.searchParams.getAll('code').length !== 1 ||
        url.searchParams.getAll('client_id').length > 1 ||
        (attempt.clientId && clientId !== attempt.clientId)
      )
        throw new Error('CHATGPT_CALLBACK_INVALID');
      const raw = await this.json(
        CHATGPT_TOKEN_ENDPOINT,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            code_verifier: attempt.verifier,
            redirect_uri: attempt.redirectUri,
            resource: CHATGPT_RESOURCE
          }).toString()
        },
        attempt
      );
      const parsed = chatgptTokenResponseSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.id_token)
        throw new Error('CHATGPT_TOKEN_RESPONSE_INVALID');
      const jwks = await this.json(CHATGPT_JWKS_ENDPOINT, { method: 'GET' }, attempt);
      await verifyChatgptIdentity(parsed.data.id_token, jwks, {
        clientId,
        nonce: attempt.nonce,
        subject: attempt.subject
      });
      if (this.attempts.get(id) !== attempt || attempt.abort.signal.aborted)
        throw new Error('CHATGPT_LOGIN_CANCELLED');
      attempt.result = { attemptId: id, clientId, hostId: attempt.hostId, tokens: parsed.data };
      res.end('Login completed. Return to MyAgentRoam to save the credential.');
    } catch (error) {
      attempt.error =
        error instanceof Error && /^CHATGPT_[A-Z0-9_]+$/u.test(error.message)
          ? error.message
          : 'CHATGPT_LOGIN_FAILED';
      res.writeHead(400);
      res.end('Login failed. Return to MyAgentRoam to retry.');
    } finally {
      attempt.verifier = '';
      attempt.server.close();
    }
  }
}
