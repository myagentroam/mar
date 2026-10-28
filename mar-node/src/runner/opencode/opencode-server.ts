import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { McpLocalConfig, McpRemoteConfig } from '@opencode-ai/sdk/v2';
import { minimalRunnerEnvironment, platformCliInvocation } from '../../operational.js';
import { terminateProcessTree } from '../../process-tree.js';
import type { OpenCodeProviderCatalog } from '../../opencode-runtime.js';

const START_TIMEOUT_MS = 10_000;

export interface OpenCodeServerOptions {
  readonly command?: string;
  readonly startTimeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
}

export class OpenCodeServerClient {
  private child: ChildProcess | undefined;
  private client: OpencodeClient | undefined;
  private starting: Promise<void> | undefined;
  private environment: Readonly<Record<string, string>> = {};

  constructor(private readonly options: OpenCodeServerOptions = {}) {}

  configureEnvironment(environment: Readonly<Record<string, string>>): void {
    if (this.child !== undefined) throw new Error('OPENCODE_SERVER_ALREADY_STARTED');
    this.environment = { ...environment };
  }

  async start(): Promise<void> {
    if (this.client !== undefined) return;
    if (this.starting !== undefined) return this.starting;
    const starting = this.startServer();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async startServer(): Promise<void> {
    const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client');
    const port = await availablePort();
    const password = randomBytes(24).toString('base64url');
    const invocation = platformCliInvocation(this.options.command ?? 'opencode', [
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port)
    ]);
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(invocation.command, invocation.args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...minimalRunnerEnvironment(),
        ...this.environment,
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: { authorization },
      throwOnError: true
    });
    try {
      await waitUntilHealthy(
        `http://127.0.0.1:${port}/global/health`,
        authorization,
        child,
        this.options.startTimeoutMs ?? START_TIMEOUT_MS
      );
      this.client = client;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async providers(directory: string): Promise<OpenCodeProviderCatalog> {
    const client = await this.requireClient();
    return unwrap<OpenCodeProviderCatalog>(await client.provider.list({ directory }));
  }

  async configureMcp(directory: string, mcp: unknown): Promise<void> {
    const client = await this.requireClient();
    if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) return;
    for (const [name, config] of Object.entries(mcp)) {
      await client.mcp.add({
        directory,
        name,
        config: config as McpLocalConfig | McpRemoteConfig
      });
    }
  }

  async sessions(directory: string, limit = 100): Promise<readonly unknown[]> {
    const client = await this.requireClient();
    return unwrap<readonly unknown[]>(await client.session.list({ directory, limit }));
  }

  async session(directory: string, sessionID: string): Promise<unknown> {
    const client = await this.requireClient();
    return unwrap(await client.session.get({ directory, sessionID }));
  }

  async sessionStatus(
    directory: string,
    sessionID: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    const client = await this.requireClient();
    const statuses = unwrap<Record<string, unknown>>(
      await client.session.status({ directory }, { signal: signal ?? null })
    );
    return statuses[sessionID] ?? { type: 'idle' };
  }

  async createSession(directory: string, title?: string): Promise<unknown> {
    const client = await this.requireClient();
    return unwrap(
      await client.session.create({ directory, ...(title === undefined ? {} : { title }) })
    );
  }

  async forkSession(directory: string, sessionID: string, messageID: string): Promise<unknown> {
    const client = await this.requireClient();
    return unwrap(await client.session.fork({ directory, sessionID, messageID }));
  }

  async messages(
    directory: string,
    sessionID: string,
    limit = 100,
    recovery?: { readonly since: number; readonly signal: AbortSignal }
  ): Promise<readonly unknown[]> {
    let page = await this.messagePage(directory, sessionID, { limit }, recovery?.signal);
    const messages = [...page.messages];
    const cursors = new Set<string>();
    while (recovery !== undefined && page.nextCursor !== null) {
      if (
        page.messages.some((value) => {
          const created = (value as { info?: { time?: { created?: number } } })?.info?.time
            ?.created;
          return typeof created === 'number' && created < recovery.since;
        })
      )
        break;
      if (cursors.has(page.nextCursor)) throw new Error('OPENCODE_MESSAGE_CURSOR_REPEATED');
      cursors.add(page.nextCursor);
      page = await this.messagePage(
        directory,
        sessionID,
        { limit, before: page.nextCursor },
        recovery.signal
      );
      messages.unshift(...page.messages);
    }
    return messages;
  }

  async messagePage(
    directory: string,
    sessionID: string,
    input: { readonly limit: number; readonly before?: string },
    signal?: AbortSignal
  ): Promise<{ readonly messages: readonly unknown[]; readonly nextCursor: string | null }> {
    const client = await this.requireClient();
    const result = await client.session.messages(
      { directory, sessionID, ...input },
      { signal: signal ?? null }
    );
    return {
      messages: unwrap<readonly unknown[]>(result),
      nextCursor: result.response.headers.get('x-next-cursor') || null
    };
  }

  async updateSession(directory: string, sessionID: string, title: string): Promise<unknown> {
    const client = await this.requireClient();
    return unwrap(await client.session.update({ directory, sessionID, title }));
  }

  async deleteSession(directory: string, sessionID: string): Promise<unknown> {
    const client = await this.requireClient();
    return unwrap(await client.session.delete({ directory, sessionID }));
  }

  async abort(directory: string, sessionID: string): Promise<unknown> {
    const client = await this.requireClient();
    return unwrap(await client.session.abort({ directory, sessionID }));
  }

  async summarize(directory: string, sessionID: string, model: string): Promise<unknown> {
    const client = await this.requireClient();
    const separator = model.indexOf('/');
    if (separator <= 0 || separator === model.length - 1) throw new Error('OPENCODE_MODEL_INVALID');
    return unwrap(
      await client.session.summarize({
        directory,
        sessionID,
        providerID: model.slice(0, separator),
        modelID: model.slice(separator + 1)
      })
    );
  }

  async replyPermission(
    directory: string,
    requestID: string,
    decision: 'APPROVED' | 'REJECTED'
  ): Promise<unknown> {
    const client = await this.requireClient();
    return unwrap(
      await client.permission.reply({
        directory,
        requestID,
        reply: decision === 'APPROVED' ? 'once' : 'reject'
      })
    );
  }

  async replyQuestion(
    directory: string,
    requestID: string,
    answers: readonly (readonly string[])[]
  ): Promise<unknown> {
    const client = await this.requireClient();
    return unwrap(
      await client.question.reply({
        directory,
        requestID,
        answers: answers.map((answer) => [...answer])
      })
    );
  }

  async rejectQuestion(directory: string, requestID: string): Promise<unknown> {
    const client = await this.requireClient();
    return unwrap(await client.question.reject({ directory, requestID }));
  }

  async prompt(input: {
    readonly directory: string;
    readonly sessionID: string;
    readonly text: string;
    readonly model: string;
    readonly variant?: string;
    readonly agent?: 'plan' | 'build';
    readonly system?: string;
    readonly attachments?: readonly {
      readonly name: string;
      readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      readonly dataBase64: string;
    }[];
  }): Promise<unknown> {
    const client = await this.requireClient();
    const separator = input.model.indexOf('/');
    if (separator <= 0 || separator === input.model.length - 1)
      throw new Error('OPENCODE_MODEL_INVALID');
    return unwrap(
      await client.session.promptAsync({
        directory: input.directory,
        sessionID: input.sessionID,
        model: {
          providerID: input.model.slice(0, separator),
          modelID: input.model.slice(separator + 1)
        },
        ...(input.variant === undefined || input.variant.length === 0
          ? {}
          : { variant: input.variant }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.system === undefined ? {} : { system: input.system }),
        parts: [
          { type: 'text', text: input.text },
          ...(input.attachments ?? []).map((attachment) => ({
            type: 'file' as const,
            mime: attachment.mime,
            filename: attachment.name,
            url: `data:${attachment.mime};base64,${attachment.dataBase64}`
          }))
        ]
      })
    );
  }

  async subscribe(
    directory: string,
    signal: AbortSignal,
    onEvent: (event: unknown) => void,
    onReady?: () => void
  ): Promise<void> {
    const client = await this.requireClient();
    const connection = new AbortController();
    const timeout = setTimeout(
      () => connection.abort(new Error('OPENCODE_EVENT_CONNECT_TIMEOUT')),
      this.options.startTimeoutMs ?? START_TIMEOUT_MS
    );
    try {
      const stream = await client.event.subscribe(
        { directory },
        {
          signal: AbortSignal.any([signal, connection.signal]),
          // The SDK starts its SSE request only when the iterator is consumed.
          fetch: async (request, init) => {
            const response = await fetch(request, init);
            if (response.ok && response.body !== null) {
              clearTimeout(timeout);
              onReady?.();
            }
            return response;
          },
          // The Run controller owns bounded reconnection and authoritative reconciliation.
          onSseError: (error) => {
            throw error;
          }
        }
      );
      for await (const event of stream.stream) onEvent(event);
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {
    this.client = undefined;
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    if (child.pid === undefined) {
      child.kill('SIGTERM');
      return;
    }
    try {
      await terminateProcessTree({
        pid: child.pid,
        kill: (signal) => child.kill(signal)
      });
    } catch {
      child.kill('SIGTERM');
    }
  }

  private async requireClient(): Promise<OpencodeClient> {
    await this.start();
    return this.client!;
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else if (port === undefined) reject(new Error('OPENCODE_PORT_UNAVAILABLE'));
        else resolve(port);
      });
    });
  });
}

async function waitUntilHealthy(
  url: string,
  authorization: string,
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('OPENCODE_SERVER_EXITED');
    try {
      const response = await fetch(url, {
        headers: { authorization },
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now())))
      });
      if (response.ok) return;
    } catch {
      // The child may still be binding its loopback socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('OPENCODE_SERVER_START_TIMEOUT');
}

function unwrap<T = unknown>(result: unknown): T {
  if (typeof result !== 'object' || result === null || !('data' in result)) return result as T;
  const wrapped = result as { readonly data?: T; readonly error?: unknown };
  if (wrapped.error !== undefined) throw new Error('OPENCODE_REQUEST_FAILED');
  if (wrapped.data === undefined) throw new Error('OPENCODE_RESPONSE_INVALID');
  return wrapped.data;
}
