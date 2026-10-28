import type { CodexAppServerClient } from '../../../src/runner/codex/codex-app-server.js';

export function codexProfileClientFactory(): CodexAppServerClient {
  return {
    start: async () => undefined,
    stop: () => undefined,
    listModels: async () => ({
      data: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map((model, index) => ({
        model,
        displayName: model,
        hidden: false,
        isDefault: index === 0,
        defaultReasoningEffort: index === 0 ? 'low' : 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({
          reasoningEffort,
          description: ''
        }))
      })),
      nextCursor: null
    })
  } as unknown as CodexAppServerClient;
}

export const fakeServer = `
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  const lines = input.split('\\n'); input = lines.pop() ?? '';
  for (const line of lines) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialized') continue;
    if (message.method === 'thread/list') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ id: 'vscode-thread', source: 'vscode', cwd: 'file:///workspace', name: 'VS Code thread title', preview: 'fallback preview' }, { id: 'outside-thread', sourceKind: 'cli', cwd: 'file:///outside' }] } }) + '\\n');
      continue;
    }
    if (message.method === 'thread/read') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, status: { type: 'idle' }, turns: message.params.threadId === 'vscode-thread' ? [{ id: 'official-turn', status: 'completed', startedAt: '2026-08-15T00:00:00.000Z', completedAt: '2026-08-15T00:00:01.000Z', items: [{ id: 'official-user', type: 'userMessage', content: [{ type: 'input_text', text: 'User message from the official thread/read response' }] }, { id: 'official-agent', type: 'agentMessage', text: 'Agent reply from the official thread/read response', phase: 'final_answer' }, { id: 'official-tool', type: 'mcpToolCall', server: 'filesystem', tool: 'read_file', arguments: { path: 'README.md' }, result: { content: 'ok' } }, { id: 'ctc-official-read', call_id: 'call-official-read', type: 'custom_tool_call', name: 'exec', input: 'sed -n "1,4p" README.md' }, { id: 'ctco-official-read', call_id: 'call-official-read', type: 'custom_tool_call_output', name: 'exec', output: [{ type: 'input_text', text: '# README\\n' }] }] }] : [] } } }) + '\\n');
      continue;
    }
    if (message.method === 'thread/resume') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId } } }) + '\\n');
      continue;
    }
    if (message.method === 'turn/start') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-resumed' } } }) + '\\n');
      continue;
    }
    process.stdout.write(JSON.stringify({ id: message.id, result: { method: message.method } }) + '\\n');
  }
});`;

export function captureSocket(
  sent: { type: string; payload: Record<string, unknown> }[],
  connector?: object
) {
  if (connector !== undefined) observeSessionWatch(connector, sent);
  return {
    readyState: 1,
    OPEN: 1,
    close() {},
    send(raw: string) {
      recordSent(sent, JSON.parse(raw) as { type: string; payload: Record<string, unknown> });
    }
  };
}

function observeSessionWatch(
  connector: object,
  sent: { type: string; payload: Record<string, unknown> }[]
): void {
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
}

export function recordSent(
  sent: { type: string; payload: Record<string, unknown> }[],
  message: { type: string; payload: Record<string, unknown> }
): void {
  // Runner behavior assertions consume the underlying business event; the
  // transport envelope is covered by the dedicated Workbench WS tests.
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

export function capabilities() {
  return {
    platform: 'linux' as const,
    architecture: 'x64',
    nodeVersion: process.version,
    codex: { available: true },
    claudeCode: { available: false }
  };
}

export async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (predicate()) return;
  throw new Error('EXPECTED_EVENT_NOT_EMITTED');
}
