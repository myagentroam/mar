import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeAgentSdkAdapter,
  type ClaudeSdkBindings,
  denyPermission,
  probeClaudeCode
} from '../../src/runner/claude/claude-agent-sdk.js';
import { ClaudeChannelGate } from '../../src/runner/claude/claude-channel.js';

describe('T008 Claude Agent SDK adapter', () => {
  it('detects the fixed Claude Code compatibility version and authentication state', async () => {
    expect(probeClaudeCode('definitely-not-installed-claude')).toMatchObject({
      available: false,
      compatible: false,
      authenticated: false
    });
    const directory = await mkdtemp(join(tmpdir(), 'mar-claude-probe-'));
    const command = join(directory, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    try {
      await writeFile(
        command,
        process.platform === 'win32'
          ? '@echo off\r\nif "%1"=="--version" (echo 2.1.283) else (echo {"loggedIn":true})\r\n'
          : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.1.283; else echo \'{"loggedIn":true}\'; fi\n',
        { mode: 0o700 }
      );
      expect(probeClaudeCode(command)).toMatchObject({
        available: true,
        compatible: true,
        version: '2.1.283',
        authenticated: true
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lists sessions through the authenticated local Claude Code session API', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    await expect(adapter.listSessions(process.cwd())).resolves.toEqual(expect.any(Array));
  });

  it('uses the official query/resume API, consumes structured messages, and cancels through the control handle', async () => {
    const seen: string[] = [];
    let options: Parameters<ClaudeSdkBindings['query']>[0]['options'] | undefined;
    let interrupted = 0;
    let closed = 0;
    const adapter = new ClaudeAgentSdkAdapter(
      bindings((input) => {
        options = input.options;
        return stream(
          [{ type: 'result', subtype: 'success', session_id: 'session-1' }],
          () => (interrupted += 1),
          () => (closed += 1)
        );
      })
    );
    const run = adapter.start({
      prompt: 'hello',
      cwd: '/workspace',
      resumeSessionId: 'existing-session',
      environment: { API_KEY: 'run-secret' },
      personalInstructions: 'Check the tests before execution',
      onPermission: async () => denyPermission(),
      onMessage: (message) => seen.push(message.type)
    });
    await run.completed;
    await run.interrupt();
    run.cancel();
    expect(options).toMatchObject({
      cwd: '/workspace',
      resume: 'existing-session',
      env: { API_KEY: 'run-secret', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
      settings: { showThinkingSummaries: true },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Check the tests before execution'
      }
    });
    expect(options?.includePartialMessages).toBeUndefined();
    expect(seen).toEqual(['result']);
    expect(interrupted).toBe(1);
    expect(closed).toBe(1);
  });

  it('reads history and metadata only through the SDK session API', async () => {
    const adapter = new ClaudeAgentSdkAdapter(bindings());
    await expect(adapter.listSessions('/workspace')).resolves.toEqual([{ sessionId: 'one' }]);
    await expect(adapter.readSession('one', '/workspace')).resolves.toEqual([{ uuid: 'm' }]);
    await expect(adapter.sessionInfo('one', '/workspace')).resolves.toEqual({ sessionId: 'one' });
  });

  it('creates an inclusive branch through SDK forkSession using a message UUID', async () => {
    let input: unknown;
    const adapter = new ClaudeAgentSdkAdapter({
      ...bindings(),
      forkSession: async (sessionId, options) => {
        input = { sessionId, options };
        return { sessionId: 'forked-session' };
      }
    });
    await expect(
      adapter.forkSession('source-session', '/workspace', 'message-2', 'fallback branch')
    ).resolves.toBe('forked-session');
    expect(input).toEqual({
      sessionId: 'source-session',
      options: { dir: '/workspace', upToMessageId: 'message-2', title: 'fallback branch' }
    });
  });

  it('confirms managed Channel delivery only after the SDK consumes the input', async () => {
    let queried = false;
    const collisionAdapter = new ClaudeAgentSdkAdapter(
      bindings(() => {
        queried = true;
        return pendingStream();
      })
    );
    expect(() =>
      collisionAdapter.startChannel({
        prompt: 'initial',
        cwd: '/workspace',
        mcpServers: { mar_channel: { type: 'stdio', command: 'user-command' } },
        onPermission: async () => denyPermission(),
        onMessage: () => undefined
      })
    ).toThrow('MCP_SERVER_NAME_CONFLICT');
    expect(queried).toBe(false);

    let input: AsyncIterable<{ message: { content: unknown } }> | undefined;
    let options: Parameters<ClaudeSdkBindings['query']>[0]['options'] | undefined;
    const adapter = new ClaudeAgentSdkAdapter(
      bindings((request) => {
        options = request.options;
        if (typeof request.prompt !== 'string') input = request.prompt as never;
        return pendingStream();
      })
    );
    const run = adapter.startChannel({
      prompt: 'initial',
      cwd: '/workspace',
      attachments: [{ mime: 'image/png', dataBase64: 'cG5n' }],
      personalInstructions: 'Validate the result before replying',
      onPermission: async () => denyPermission(),
      onMessage: () => undefined
    });
    const iterator = input?.[Symbol.asyncIterator]();
    expect(iterator).toBeDefined();
    expect(options?.mcpServers).toHaveProperty('mar_channel');
    expect(options?.mcpServers).not.toHaveProperty('myagentroam');
    expect(options?.includePartialMessages).toBe(true);
    expect(options?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Validate the result before replying'
    });
    await expect(iterator!.next()).resolves.toMatchObject({
      value: {
        message: {
          content: [
            { type: 'text', text: 'initial' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'cG5n' }
            }
          ]
        }
      }
    });
    const delivered = run.deliver('inserted');
    let settled = false;
    void delivered.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    await expect(iterator!.next()).resolves.toMatchObject({
      value: { message: { content: 'inserted' } }
    });
    await expect(delivered).resolves.toBeUndefined();
    run.cancel();
  });
});

describe('T008 MyAgentRoam Channel authorization and acknowledgments', () => {
  it('accepts only short-lived tokens from allowlisted senders and remains pending until Claude acknowledges', () => {
    let clock = 100;
    const channel = new ClaudeChannelGate('session-1', 'token', ['admin'], 200, () => clock);
    expect(channel.accept({ id: 'bad', senderId: 'other', token: 'token', content: 'hello' })).toBe(
      'REJECTED'
    );
    expect(channel.accept({ id: 'one', senderId: 'admin', token: 'token', content: 'hello' })).toBe(
      'PENDING_RECEIPT'
    );
    expect(channel.delivery('one')).toBe('PENDING_RECEIPT');
    expect(channel.acknowledge({ messageId: 'one', result: 'STEERED' })).toBe('STEERED');
    expect(
      channel.accept({ id: 'one', senderId: 'admin', token: 'token', content: 'duplicate' })
    ).toBe('STEERED');
    expect(channel.acknowledge({ messageId: 'one', result: 'QUEUED_NEXT_TURN' })).toBe('REJECTED');
    clock = 200;
    expect(
      channel.accept({ id: 'expired', senderId: 'admin', token: 'token', content: 'hello' })
    ).toBe('REJECTED');
  });
});

function bindings(
  factory?: (
    input: Parameters<ClaudeSdkBindings['query']>[0]
  ) => ReturnType<ClaudeSdkBindings['query']>
): ClaudeSdkBindings {
  return {
    query: factory ?? (() => stream([])),
    listSessions: async () => [{ sessionId: 'one' }] as never,
    getSessionInfo: async () => ({ sessionId: 'one' }) as never,
    getSessionMessages: async () => [{ uuid: 'm' }] as never
  };
}

function stream(
  messages: readonly unknown[],
  onInterrupt: () => void = () => undefined,
  onClose: () => void = () => undefined
): ReturnType<ClaudeSdkBindings['query']> {
  let cursor = 0;
  return {
    async next() {
      if (cursor < messages.length) return { value: messages[cursor++]!, done: false };
      return { value: undefined, done: true };
    },
    async return() {
      return { value: undefined, done: true };
    },
    async throw(error?: unknown) {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async interrupt() {
      onInterrupt();
      return undefined;
    },
    async setPermissionMode() {},
    async setMcpServerPermissionMode() {
      return {};
    },
    async setModel() {},
    async rewindFiles() {
      return {} as never;
    },
    async supportedCommands() {
      return [];
    },
    async supportedModels() {
      return [];
    },
    async mcpServerStatus() {
      return [];
    },
    async accountInfo() {
      return {};
    },
    async initializationResult() {
      return {} as never;
    },
    async getContextUsage() {
      return {
        model: 'claude-sonnet',
        totalTokens: 156_000,
        maxTokens: 258_400,
        rawMaxTokens: 258_400,
        percentage: 60.4
      } as never;
    },
    close() {
      onClose();
    }
  } as unknown as ReturnType<ClaudeSdkBindings['query']>;
}

function pendingStream(): ReturnType<ClaudeSdkBindings['query']> {
  return {
    next: () => new Promise(() => undefined),
    async return() {
      return { value: undefined, done: true };
    },
    async throw(error?: unknown) {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async interrupt() {
      return undefined;
    },
    async initializationResult() {
      return {} as never;
    },
    async getContextUsage() {
      return {
        model: 'claude-sonnet',
        totalTokens: 156_000,
        maxTokens: 258_400,
        rawMaxTokens: 258_400,
        percentage: 60.4
      } as never;
    },
    close() {}
  } as unknown as ReturnType<ClaudeSdkBindings['query']>;
}
