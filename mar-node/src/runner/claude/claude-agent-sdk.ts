import { NODE_MCP, NODE_MCP_VERSION } from '../../mcp/naming.js';
import { spawnSync } from 'node:child_process';
import {
  createSdkMcpServer,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKSessionInfo,
  type SDKUserMessage,
  type SessionMessage
} from '@anthropic-ai/claude-agent-sdk';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  minimalRunnerEnvironment,
  platformCliInvocation,
  runRunnerProbe
} from '../../operational.js';

export interface ClaudeCodeProbe {
  readonly available: boolean;
  readonly compatible: boolean;
  readonly version?: string;
  readonly authenticated: boolean;
  readonly channel: {
    readonly researchPreview: true;
    readonly requiresExplicitOptIn: true;
    readonly organizationPolicy: 'UNKNOWN';
  };
}

export interface ClaudeQueryInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly access?: string | null;
  readonly attachments?: readonly ClaudeImageAttachment[];
  readonly onPermission: CanUseTool;
  readonly onMessage: (message: SDKMessage) => void;
  readonly onChannelReply?: (content: string) => void;
  readonly environment?: Readonly<Record<string, string>>;
  readonly mcpServers?: NonNullable<Options['mcpServers']>;
  readonly personalInstructions?: string;
}

/** Image blocks accepted by the Claude Agent SDK message input. */
export interface ClaudeImageAttachment {
  readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly dataBase64: string;
}

export interface ClaudeRunHandle {
  readonly completed: Promise<void>;
  interrupt(): Promise<void>;
  cancel(): void;
}

/** A live, SDK-owned session accepts input only after the SDK consumes it. */
export interface ClaudeChannelRunHandle extends ClaudeRunHandle {
  deliver(content: string): Promise<void>;
}

/** The small injectable surface prevents tests from depending on authentication. */
export interface ClaudeSdkBindings {
  readonly query: (input: {
    readonly prompt: string | AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => Query;
  readonly listSessions: (options: {
    readonly dir?: string;
    readonly includeWorktrees?: boolean;
  }) => Promise<SDKSessionInfo[]>;
  readonly getSessionInfo: (
    sessionId: string,
    options: { readonly dir?: string }
  ) => Promise<SDKSessionInfo | undefined>;
  readonly getSessionMessages: (
    sessionId: string,
    options: { readonly dir?: string }
  ) => Promise<SessionMessage[]>;
  readonly forkSession?: typeof forkSession;
}

const nativeBindings: ClaudeSdkBindings = {
  query,
  listSessions,
  getSessionInfo,
  getSessionMessages
};

/**
 * Adapter for the supported Agent SDK APIs only. It neither parses nor writes
 * Claude JSONL transcripts. A caller must serialize resume operations itself.
 */
export class ClaudeAgentSdkAdapter {
  constructor(private readonly sdk: ClaudeSdkBindings = nativeBindings) {}

  start(input: ClaudeQueryInput): ClaudeRunHandle {
    return this.startWithPrompt(input, input.prompt);
  }

  /**
   * Opens one managed SDK stream and leaves it alive for verified Channel
   * input. This is never used for foreign CLI/VS Code sessions.
   */
  startChannel(input: ClaudeQueryInput): ClaudeChannelRunHandle {
    const channel = new ClaudeInputStream();
    const run = this.startWithPrompt(input, channel, true);
    const initial = channel.deliver(input.prompt, input.attachments);
    return {
      ...run,
      async deliver(content: string): Promise<void> {
        if (content.length === 0) throw new Error('CLAUDE_CHANNEL_MESSAGE_INVALID');
        await channel.deliver(content);
      },
      cancel() {
        channel.close();
        run.cancel();
      },
      completed: initial.then(() => run.completed)
    };
  }

  private startWithPrompt(
    input: ClaudeQueryInput,
    prompt: string | AsyncIterable<SDKUserMessage>,
    channelEnabled = false
  ): ClaudeRunHandle {
    if (channelEnabled && Object.hasOwn(input.mcpServers ?? {}, NODE_MCP.channel.name))
      throw Object.assign(
        new Error('MCP_SERVER_NAME_CONFLICT: A user MCP conflicts with the managed Channel.'),
        { code: 'MCP_SERVER_NAME_CONFLICT' }
      );
    const abortController = new AbortController();
    const stream = this.sdk.query({
      prompt,
      options: {
        cwd: input.cwd,
        ...(channelEnabled ? { includePartialMessages: true } : {}),
        // Claude SDK defaults CLAUDE_CODE_ENTRYPOINT to sdk-ts. Keep the
        // transcript discoverable by the same VS Code session filters used by
        // the external Claude Code extension.
        env: {
          ...minimalRunnerEnvironment(),
          ...input.environment,
          CLAUDE_CODE_ENTRYPOINT: 'claude-vscode'
        },
        ...(input.resumeSessionId === undefined ? {} : { resume: input.resumeSessionId }),
        ...(input.model === undefined || input.model === null ? {} : { model: input.model }),
        ...(isClaudeEffort(input.effort) ? { effort: input.effort } : {}),
        permissionMode: claudePermissionMode(input.access),
        // This is the SDK's documented API-side public summary mode. We never
        // enable or forward raw thinking deltas to the Workbench.
        settings: { showThinkingSummaries: true },
        ...(input.personalInstructions === undefined
          ? {}
          : {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: input.personalInstructions
              }
            }),
        abortController,
        canUseTool: input.onPermission,
        ...(input.mcpServers !== undefined || channelEnabled
          ? {
              mcpServers: {
                ...(input.mcpServers ?? {}),
                ...(channelEnabled ? { [NODE_MCP.channel.name]: channelMcpServer(input) } : {})
              }
            }
          : {})
      }
    });
    const completed = consume(stream, input.onMessage);
    return {
      completed,
      async interrupt() {
        await stream.interrupt();
      },
      cancel() {
        abortController.abort();
        stream.close();
      }
    };
  }

  listSessions(cwd: string): Promise<SDKSessionInfo[]> {
    // The SDK otherwise includes all sibling git worktrees by default.  A
    // MAR Workspace must only project sessions whose native cwd belongs to
    // that registered Workspace.
    return this.sdk.listSessions({ dir: cwd, includeWorktrees: false });
  }

  readSession(sessionId: string, cwd: string): Promise<SessionMessage[]> {
    return this.sdk.getSessionMessages(sessionId, { dir: cwd });
  }

  async forkSession(
    sessionId: string,
    cwd: string,
    upToMessageId: string,
    title: string
  ): Promise<string> {
    const result = await (this.sdk.forkSession ?? forkSession)(sessionId, {
      dir: cwd,
      upToMessageId,
      title
    });
    return result.sessionId;
  }

  sessionInfo(sessionId: string, cwd: string): Promise<SDKSessionInfo | undefined> {
    return this.sdk.getSessionInfo(sessionId, { dir: cwd });
  }

  /**
   * The SDK publishes the authoritative, session-specific command list in its
   * first system/init record.  Keep the input stream empty and stop as soon as
   * that record arrives so discovery never submits a user prompt.
   */
  async discoverSlashCommands(cwd: string): Promise<readonly string[]> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 3_000);
    const emptyInput: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => undefined);
        yield* [];
      }
    };
    const stream = this.sdk.query({
      prompt: emptyInput,
      options: { cwd, env: minimalRunnerEnvironment(), abortController }
    });
    try {
      for await (const message of stream) {
        const candidate = message as SDKMessage & { slash_commands?: unknown };
        if (
          candidate.type === 'system' &&
          (candidate as { subtype?: unknown }).subtype === 'init' &&
          Array.isArray(candidate.slash_commands)
        ) {
          return candidate.slash_commands.filter(
            (value): value is string =>
              typeof value === 'string' && /^[A-Za-z0-9_./-]{1,128}$/.test(value)
          );
        }
      }
      return [];
    } finally {
      clearTimeout(timeout);
      abortController.abort();
      stream.close();
    }
  }
}

function isClaudeEffort(
  value: string | null | undefined
): value is 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  );
}

function claudePermissionMode(
  access: string | null | undefined
): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' {
  if (access === 'accept-edits') return 'acceptEdits';
  if (access === 'bypass') return 'bypassPermissions';
  if (access === 'plan') return 'plan';
  return 'default';
}

function channelMcpServer(input: ClaudeQueryInput) {
  return createSdkMcpServer({
    name: NODE_MCP.channel.name,
    version: NODE_MCP_VERSION,
    instructions:
      'Use the reply tool from the mar_channel MCP server only to send a concise reply to the Admin Channel.',
    alwaysLoad: true,
    tools: [
      tool(
        NODE_MCP.channel.tools.reply,
        'Send one text reply to the authorized MyAgentRoam Admin Channel.',
        { content: z.string().min(1).max(20_000) },
        async ({ content }) => {
          input.onChannelReply?.(content);
          return { content: [{ type: 'text', text: 'Channel reply delivered.' }] };
        },
        { alwaysLoad: true }
      )
    ]
  });
}

interface QueuedInput {
  readonly message: SDKUserMessage;
  readonly received: () => void;
}

class ClaudeInputStream implements AsyncIterable<SDKUserMessage>, AsyncIterator<SDKUserMessage> {
  private readonly queued: QueuedInput[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  deliver(content: string, attachments: readonly ClaudeImageAttachment[] = []): Promise<void> {
    if (this.closed) return Promise.reject(new Error('CLAUDE_CHANNEL_CLOSED'));
    return new Promise<void>((received) => {
      const entry: QueuedInput = { message: toUserMessage(content, attachments), received };
      const waiting = this.waiting;
      this.waiting = undefined;
      if (waiting !== undefined) {
        received();
        waiting({ value: entry.message, done: false });
      } else {
        this.queued.push(entry);
      }
    });
  }

  async next(): Promise<IteratorResult<SDKUserMessage>> {
    const entry = this.queued.shift();
    if (entry !== undefined) {
      entry.received();
      return { value: entry.message, done: false };
    }
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this;
  }

  close(): void {
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }
}

function toUserMessage(
  content: string,
  attachments: readonly ClaudeImageAttachment[] = []
): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content:
        attachments.length === 0
          ? content
          : [
              { type: 'text', text: content },
              ...attachments.map((attachment) => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: attachment.mime,
                  data: attachment.dataBase64
                }
              }))
            ]
    },
    parent_tool_use_id: null,
    shouldQuery: true
  };
}

async function consume(
  stream: AsyncIterable<SDKMessage>,
  onMessage: (message: SDKMessage) => void
) {
  for await (const message of stream) onMessage(message);
}

/**
 * Channel availability deliberately remains conservative. The CLI does not
 * expose an API to read organization allowlists, so a successful executable
 * probe must never be interpreted as permission to activate a channel.
 */
export function probeClaudeCode(command = 'claude'): ClaudeCodeProbe {
  const versionInvocation = platformCliInvocation(command, ['--version']);
  const versionResult = spawnSync(versionInvocation.command, versionInvocation.args, {
    encoding: 'utf8',
    timeout: 3_000
  });
  const version = versionResult.status === 0 ? versionResult.stdout.trim() : undefined;
  const authInvocation = platformCliInvocation(command, ['auth', 'status', '--json']);
  const authResult = spawnSync(authInvocation.command, authInvocation.args, {
    encoding: 'utf8',
    timeout: 3_000
  });
  let authenticated = false;
  if (authResult.status === 0) {
    try {
      const parsed = JSON.parse(authResult.stdout) as { loggedIn?: unknown };
      authenticated = parsed.loggedIn === true;
    } catch {
      authenticated = false;
    }
  }
  return {
    available: version !== undefined,
    compatible: version !== undefined && /^2\.1\./.test(version),
    ...(version === undefined ? {} : { version }),
    authenticated,
    channel: {
      researchPreview: true,
      requiresExplicitOptIn: true,
      organizationPolicy: 'UNKNOWN'
    }
  };
}

export async function probeClaudeCodeAsync(command = 'claude'): Promise<ClaudeCodeProbe> {
  const versionInvocation = platformCliInvocation(command, ['--version']);
  const versionResult = await runRunnerProbe(versionInvocation.command, versionInvocation.args, {
    env: minimalRunnerEnvironment(),
    timeoutMs: 3_000
  });
  const version = versionResult.status === 0 ? versionResult.stdout.trim() : undefined;
  const authInvocation = platformCliInvocation(command, ['auth', 'status', '--json']);
  const authResult = await runRunnerProbe(authInvocation.command, authInvocation.args, {
    env: minimalRunnerEnvironment(),
    timeoutMs: 3_000,
    logStderr: false
  });
  let authenticated = false;
  if (authResult.status === 0) {
    try {
      const parsed = JSON.parse(authResult.stdout) as { loggedIn?: unknown };
      authenticated = parsed.loggedIn === true;
    } catch {
      authenticated = false;
    }
  }
  return {
    available: version !== undefined,
    compatible: version !== undefined && /^2\.1\./.test(version),
    ...(version === undefined ? {} : { version }),
    authenticated,
    channel: {
      researchPreview: true,
      requiresExplicitOptIn: true,
      organizationPolicy: 'UNKNOWN'
    }
  };
}

export function denyPermission(message = 'USER_DECISION_REJECTED'): PermissionResult {
  return { behavior: 'deny', message };
}
