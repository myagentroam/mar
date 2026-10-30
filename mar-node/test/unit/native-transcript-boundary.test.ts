import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverNativeSessions,
  readNativeSession,
  removeNativeSession
} from '../../src/native-session-history.js';
import { codexNativeTranscriptAdapter } from '../../src/runner/codex/native-transcript.js';
import { claudeNativeTranscriptAdapter } from '../../src/runner/claude/native-transcript.js';
import * as codexTools from '../../src/runner/codex/tool-normalizer.js';
import * as claudeTools from '../../src/runner/claude/tool-normalizer.js';
import { readCodexNativeContextUsage } from '../../src/runner/codex/native-context-usage.js';
import { readClaudeNativeContextUsage } from '../../src/runner/claude/native-context-usage.js';
import { nativeConversationPage } from '../../src/session/runner-native-session-parsers.js';
import type { NodeAgentSession } from '../../src/database.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeConnector } from '../../src/connector.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { ConversationHistoryService } from '../../src/service/conversation-history-service.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(runner: 'codex' | 'claude-code', id: string, cwd = '/workspace') {
  const home = await mkdtemp(join(tmpdir(), 'mar-native-boundary-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
  const directory = join(home, runner === 'codex' ? '.codex/sessions' : '.claude/projects/main');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${id}.jsonl`);
  const write = (records: unknown[]) =>
    writeFile(path, records.map((record) => JSON.stringify(record)).join('\n'));
  return { home, directory, path, write, cwd };
}

describe('native transcript ownership and lazy page projection', () => {
  it.each(['codex', 'claude-code'] as const)(
    'preserves %s locally clipped output through native history',
    async (runner) => {
      const f = await fixture(runner, 'tails');
      const tail = `${'x'.repeat(11_000)}TAIL`;
      await f.write(
        runner === 'codex'
          ? [
              { type: 'session_meta', payload: { id: 'tails', cwd: f.cwd } },
              {
                type: 'response_item',
                payload: {
                  type: 'function_call',
                  call_id: 'long',
                  name: 'exec_command',
                  arguments: JSON.stringify({ command: 'run' })
                }
              },
              {
                type: 'response_item',
                payload: { type: 'function_call_output', call_id: 'long', output: tail }
              },
              {
                type: 'response_item',
                payload: {
                  type: 'function_call',
                  call_id: 'input',
                  name: 'exec_command',
                  arguments: JSON.stringify({ command: 'x'.repeat(11_000) })
                }
              },
              {
                type: 'response_item',
                payload: { type: 'function_call_output', call_id: 'input', output: 'complete' }
              }
            ]
          : [
              { type: 'user', sessionId: 'tails', cwd: f.cwd, message: { content: 'Start' } },
              {
                type: 'assistant',
                message: {
                  content: [
                    { type: 'tool_use', id: 'long', name: 'Bash', input: { command: 'run' } }
                  ]
                }
              },
              {
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: 'long', content: tail }] }
              }
            ]
      );
      expect(await discoverNativeSessions(runner, f.cwd)).toHaveLength(1);
      const history = await readNativeSession(runner, f.cwd, 'tails');
      expect(history).toBeDefined();
      const page = nativeConversationPage({ id: 'managed', runner } as NodeAgentSession, history!, {
        limit: 10
      });
      const commands = page.turns
        .flatMap((turn) => turn.items)
        .filter((item) => item.kind === 'command_execution');
      expect(commands[0]?.payload).toMatchObject({
        output: {
          blocks: [{ channel: 'COMBINED', text: expect.stringMatching(/TAIL$/u) }],
          truncation: 'HEAD'
        }
      });
      if (runner === 'codex') {
        expect(commands[1]?.payload).toMatchObject({
          output: { blocks: [{ channel: 'COMBINED', text: 'complete' }] },
          toolPresentation: { execution: { truncation: { input: true } } }
        });
        expect(
          (commands[1]?.payload as { output: { truncation?: string } }).output.truncation
        ).toBeUndefined();
      }
    }
  );
  it.each(['codex', 'claude-code'] as const)(
    'shares the %s facade parse/cache path and only normalizes the requested page',
    async (runner) => {
      const f = await fixture(runner, 'mixed');
      const adapter =
        runner === 'codex' ? codexNativeTranscriptAdapter : claudeNativeTranscriptAdapter;
      const parse = vi.spyOn(adapter, 'parse');
      const projection = vi.spyOn(adapter, 'createProjection');
      const normalize =
        runner === 'codex'
          ? vi.spyOn(codexTools, 'normalizeCodexTool')
          : vi.spyOn(claudeTools, 'normalizeClaudeTool');
      await f.write(
        runner === 'codex'
          ? [
              { type: 'session_meta', payload: { id: 'mixed', cwd: f.cwd } },
              ...[1, 2].flatMap((index) => [
                { type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${index}` } },
                {
                  type: 'response_item',
                  payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: `User ${index}` }]
                  }
                },
                {
                  type: 'response_item',
                  payload: {
                    type: 'function_call',
                    call_id: `call-${index}`,
                    name: 'exec_command',
                    arguments: JSON.stringify({ command: 'pwd' })
                  }
                },
                {
                  type: 'response_item',
                  payload: {
                    type: 'function_call_output',
                    call_id: `call-${index}`,
                    output: [{ type: 'output_text', text: 'done' }]
                  }
                }
              ]),
              {
                type: 'event_msg',
                payload: {
                  type: 'token_count',
                  info: { last_token_usage: { input_tokens: 123 }, model_context_window: 200000 }
                }
              }
            ]
          : [
              {
                type: 'user',
                sessionId: 'mixed',
                cwd: f.cwd,
                uuid: 'u1',
                message: { content: 'Start' }
              },
              {
                type: 'assistant',
                uuid: 'a1',
                message: {
                  content: [
                    {
                      type: 'tool_use',
                      id: 'start',
                      name: 'Agent',
                      input: { description: 'Review' }
                    }
                  ]
                }
              },
              {
                type: 'user',
                message: {
                  content: [{ type: 'tool_result', tool_use_id: 'start', content: 'started' }]
                },
                tool_use_result: { agentId: 'child' }
              },
              { type: 'user', uuid: 'u2', message: { content: 'Check' } },
              {
                type: 'assistant',
                uuid: 'a2',
                message: {
                  model: 'claude-test',
                  usage: { input_tokens: 123 },
                  content: [
                    { type: 'text', text: 'Checking' },
                    {
                      type: 'tool_use',
                      id: 'wait',
                      name: 'TaskOutput',
                      input: { task_id: 'child', block: true }
                    }
                  ]
                }
              },
              {
                type: 'user',
                message: {
                  content: [{ type: 'tool_result', tool_use_id: 'wait', content: 'done' }]
                }
              }
            ]
      );
      expect(await discoverNativeSessions(runner, f.cwd)).toHaveLength(1);
      expect(parse).toHaveBeenCalledTimes(1);
      const [history, concurrent] = await Promise.all([
        readNativeSession(runner, f.cwd, 'mixed'),
        readNativeSession(runner, f.cwd, 'mixed')
      ]);
      expect(history).toBe(concurrent);
      expect(await readNativeSession(runner, f.cwd, 'mixed')).toBe(history);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(projection).not.toHaveBeenCalled();
      expect(normalize).not.toHaveBeenCalled();
      const session = { id: 'managed', runner } as NodeAgentSession;
      const page = nativeConversationPage(session, history!, { limit: 1 });
      expect(projection).toHaveBeenCalledTimes(1);
      expect(projection.mock.calls[0]?.[0]).toEqual(history!.items.slice(0, 2));
      expect(normalize).toHaveBeenCalledTimes(1);
      expect(page.turns).toHaveLength(1);
      expect(page.turns[0]?.items.map((item) => item.kind)).toEqual(
        runner === 'codex'
          ? ['user_message', 'command_execution']
          : ['user_message', 'assistant_message', 'tool_call']
      );
      const tool = page.turns[0]?.items.at(-1);
      expect(tool?.payload).toMatchObject(
        runner === 'codex'
          ? { output: { blocks: [{ channel: 'COMBINED', text: 'done' }] } }
          : {
              title: 'Review',
              subagentId: 'child',
              output: { blocks: [{ channel: 'TEXT', text: 'done' }] }
            }
      );
      const usage =
        runner === 'codex'
          ? await readCodexNativeContextUsage(f.cwd, 'mixed')
          : await readClaudeNativeContextUsage(f.cwd, 'mixed', { environment: {} });
      expect(usage).toMatchObject({ usedTokens: 123, maxTokens: 200000 });
      expect(parse).toHaveBeenCalledTimes(2);
      expect(await discoverNativeSessions(runner, '/another-workspace')).toHaveLength(0);
      expect(parse).toHaveBeenCalledTimes(2);
    }
  );

  it('reconciles a managed Session through real NodeConnector, Runtime, JSONL and SQLite boundaries', async () => {
    const f = await fixture('claude-code', 'managed-history');
    await f.write([
      {
        type: 'user',
        sessionId: 'managed-history',
        cwd: f.cwd,
        uuid: 'older-user',
        message: { content: 'Older user' }
      },
      { type: 'assistant', uuid: 'older-agent', message: { content: 'Older reply' } },
      { type: 'user', uuid: 'latest-user', message: { content: 'Last user' } },
      {
        type: 'assistant',
        uuid: 'latest-agent',
        message: {
          content: [{ type: 'tool_use', id: 'command', name: 'Bash', input: { command: 'pwd' } }]
        }
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'command', content: 'done' }] }
      }
    ]);
    const database = new NodeDatabase(':memory:', 'native-history-integration');
    const workspace = database.saveWorkspace({ path: f.cwd, kind: 'DIRECTORY', gitSummary: null });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: true }
      }
    });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      conversationHistoryService: ConversationHistoryService;
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'claude-code',
        cwd: f.cwd,
        externalSessionId: 'managed-history',
        nativeControl: 'MAR_MANAGED'
      });
      const { run } = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'managed-last',
        content: 'Last user'
      });
      internals.runtime.finishRun(run.id, 'SUCCEEDED');
      const page = await internals.conversationHistoryService.read(session, { limit: 1 });
      expect(page.source).toBe('native');
      expect(page.turns).toHaveLength(1);
      expect(page.turns[0]?.runId).toBe(run.id);
      expect(page.turns[0]?.items[0]?.payload).toMatchObject({
        text: 'Last user',
        clientMessageId: 'managed-last'
      });
      // A matching managed Runtime Turn remains authoritative until it leaves memory.
      expect(page.turns[0]?.items).toHaveLength(1);
      expect(page.turns[0]?.rewind).toEqual({ before: 'older-agent', after: 'latest-agent' });
      expect(page.nextCursor).toEqual(expect.any(String));
      const older = await internals.conversationHistoryService.read(session, {
        limit: 1,
        cursor: page.nextCursor!
      });
      expect(older.turns[0]?.items[0]?.payload).toMatchObject({ text: 'Older user' });
      expect(older.turns[0]?.items[1]).toMatchObject({
        kind: 'assistant_message',
        payload: { text: 'Older reply' }
      });
    } finally {
      await connector.stop();
    }
  });

  it('verifies Claude candidate identity/canonical cwd, reuses the unique index and never locates candidates for deletion', async () => {
    const f = await fixture('claude-code', 'candidate', '/workspace/../workspace');
    const record = (sessionId: string, cwd: string) => ({
      type: 'assistant',
      sessionId,
      cwd,
      message: { model: 'claude-test', content: 'Visible', usage: { input_tokens: 321 } }
    });
    await f.write([record('wrong-id', '/workspace')]);
    const foreign = join(f.home, '.claude/projects/foreign');
    const valid = join(f.home, '.claude/projects/valid');
    await mkdir(foreign, { recursive: true });
    await mkdir(valid, { recursive: true });
    await writeFile(
      join(foreign, 'candidate.jsonl'),
      JSON.stringify(record('candidate', '/foreign'))
    );
    await writeFile(join(valid, 'candidate.jsonl'), JSON.stringify(record('candidate', f.cwd)));
    const locate = vi.spyOn(claudeNativeTranscriptAdapter, 'locateCandidates');
    const normalize = vi.spyOn(claudeTools, 'normalizeClaudeTool');
    const projection = vi.spyOn(claudeNativeTranscriptAdapter, 'createProjection');
    expect(
      await readClaudeNativeContextUsage('/workspace', 'candidate', { environment: {} })
    ).toMatchObject({ usedTokens: 321 });
    expect(locate).toHaveBeenCalledTimes(1);
    expect(await readNativeSession('claude-code', '/workspace', 'candidate')).toMatchObject({
      cwd: f.cwd
    });
    expect(
      await readClaudeNativeContextUsage('/workspace', 'candidate', { environment: {} })
    ).toMatchObject({ usedTokens: 321 });
    expect(locate).toHaveBeenCalledTimes(1);
    expect(normalize).not.toHaveBeenCalled();
    expect(projection).not.toHaveBeenCalled();
    await removeNativeSession('claude-code', '/workspace', 'candidate');
    await expect(removeNativeSession('claude-code', '/workspace', 'missing')).rejects.toThrow(
      'NATIVE_TRANSCRIPT_UNAVAILABLE'
    );
    expect(locate).toHaveBeenCalledTimes(1);
  });
});
