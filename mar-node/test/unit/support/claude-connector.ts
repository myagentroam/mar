import { connectTestSocket } from './control-socket.js';
import { createEnvelope } from '../../../../packages/protocol/src/index.js';
import type { ClaudeSdkBindings } from '../../../src/runner/claude/claude-agent-sdk.js';
import { NodeConnector } from '../../../src/connector.js';
import { NodeDatabase } from '../../../src/database.js';

export function preparedDatabase(): NodeDatabase {
  const database = new NodeDatabase(':memory:', 'node-1');
  database.saveWorkspace({
    id: 'workspace-1',
    path: '/workspace',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  return database;
}

export function attachSocket(
  connector: NodeConnector
): { type: string; payload: Record<string, unknown> }[] {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const watch = (
    connector as unknown as {
      nativeSessionWatchService: {
        emitRealtime(sessionId: string, event: Record<string, unknown>): boolean;
      };
    }
  ).nativeSessionWatchService;
  watch.emitRealtime = (_sessionId, event) => {
    recordSent(sent, { type: 'workbench.event', payload: event });
    return true;
  };
  connectTestSocket(connector, {
    readyState: 1,
    OPEN: 1,
    send(raw: string) {
      recordSent(sent, JSON.parse(raw) as { type: string; payload: Record<string, unknown> });
    },
    close() {}
  });
  return sent;
}

export function recordSent(
  sent: { type: string; payload: Record<string, unknown> }[],
  message: { type: string; payload: Record<string, unknown> }
): void {
  if (
    message.type === 'workbench.event' &&
    message.payload.category === 'conversation' &&
    typeof message.payload.payload === 'object' &&
    message.payload.payload !== null &&
    'event' in message.payload.payload
  ) {
    sent.push({
      type: 'run.event',
      payload: (message.payload.payload as { event: Record<string, unknown> }).event
    });
    return;
  }
  sent.push(message);
}

export function receive(
  connector: NodeConnector,
  envelope: ReturnType<typeof createEnvelope>
): void {
  (connector as unknown as { handleMessage(raw: string): void }).handleMessage(
    JSON.stringify(envelope)
  );
}

export function bindings(
  factory: (
    input: Parameters<ClaudeSdkBindings['query']>[0]
  ) => ReturnType<ClaudeSdkBindings['query']>
): ClaudeSdkBindings {
  return {
    query: factory,
    listSessions: async () => [],
    getSessionInfo: async () => undefined,
    getSessionMessages: async () => []
  };
}

export function permissionStream(
  requestPermission: () => Promise<unknown> | undefined
): ReturnType<ClaudeSdkBindings['query']> {
  let state = 0;
  return {
    async next() {
      if (state === 0) {
        state = 1;
        return {
          value: {
            type: 'assistant',
            session_id: 'native-session-1',
            message: { content: [{ type: 'text', text: 'hello' }] }
          } as never,
          done: false
        };
      }
      if (state === 1) {
        state = 2;
        await requestPermission();
        return {
          value: {
            type: 'result',
            subtype: 'success',
            session_id: 'native-session-1'
          } as never,
          done: false
        };
      }
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
    close() {}
  } as unknown as ReturnType<ClaudeSdkBindings['query']>;
}

export function publicConversationStream(): ReturnType<ClaudeSdkBindings['query']> {
  let state = 0;
  return {
    async next() {
      if (state === 0) {
        state = 1;
        return {
          value: {
            type: 'assistant',
            session_id: 'native-public-session',
            uuid: 'assistant-public',
            message: {
              content: [
                { type: 'thinking', thinking: 'First inspect the current directory.' },
                { type: 'redacted_thinking', data: 'Must not be shown' },
                { type: 'tool_use', id: 'tool-pwd', name: 'Bash', input: { command: 'pwd' } },
                { type: 'future_content_block' }
              ]
            }
          } as never,
          done: false
        };
      }
      if (state === 1) {
        state = 2;
        return {
          value: {
            type: 'stream_event',
            session_id: 'native-public-session',
            event: {
              type: 'content_block_delta',
              delta: { thinking: 'Hidden raw reasoning' }
            }
          } as never,
          done: false
        };
      }
      if (state === 2) {
        state = 3;
        return {
          value: {
            type: 'user',
            session_id: 'native-public-session',
            parent_tool_use_id: null,
            tool_use_result: '/workspace\\n',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tool-pwd', content: '/workspace\\n' }]
            }
          } as never,
          done: false
        };
      }
      if (state === 3) {
        state = 4;
        return {
          value: {
            type: 'result',
            subtype: 'success',
            session_id: 'native-public-session'
          } as never,
          done: false
        };
      }
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
      return undefined;
    },
    close() {}
  } as unknown as ReturnType<ClaudeSdkBindings['query']>;
}

export function pendingStream(): ReturnType<ClaudeSdkBindings['query']> {
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
    close() {}
  } as unknown as ReturnType<ClaudeSdkBindings['query']>;
}

export function nativeSessionThenPendingStream(
  sessionId: string
): ReturnType<ClaudeSdkBindings['query']> {
  let emittedSession = false;
  return {
    async next() {
      if (!emittedSession) {
        emittedSession = true;
        return {
          value: {
            type: 'assistant',
            session_id: sessionId,
            message: { content: [{ type: 'text', text: 'Resumed' }] }
          } as never,
          done: false
        };
      }
      return new Promise(() => undefined);
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
      return undefined;
    },
    close() {}
  } as unknown as ReturnType<ClaudeSdkBindings['query']>;
}

export function resultThenPendingStream(
  onClose: () => void = () => undefined
): ReturnType<ClaudeSdkBindings['query']> {
  let sentResult = false;
  return {
    async next() {
      if (!sentResult) {
        sentResult = true;
        return {
          value: { type: 'result', subtype: 'success', is_error: false, session_id: 'native-1' },
          done: false
        } as never;
      }
      return new Promise(() => undefined);
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
      return undefined;
    },
    close() {
      onClose();
    }
  } as unknown as ReturnType<ClaudeSdkBindings['query']>;
}

export function capabilities() {
  return {
    platform: 'linux' as const,
    architecture: 'x64',
    nodeVersion: process.version,
    codex: { available: false },
    claudeCode: { available: true }
  };
}

export async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('EXPECTED_EVENT_NOT_EMITTED');
}
