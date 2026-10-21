import { appendFile, mkdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverAllNativeSessions,
  discoverNativeSessions,
  claudeContextWindowTokens,
  readClaudeNativeContextUsage,
  readCodexNativeContextUsage,
  readNativeSession,
  removeNativeSession
} from '../../src/native-session-history.js';
import type { NodeAgentSession } from '../../src/database.js';
import { nativeConversationPage } from '../../src/util/runner-native-session-parsers.js';

const directories: string[] = [];
let previousHome: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  previousHome = undefined;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('native session history adapter', () => {
  it('keeps Claude subagent identity stable when earlier turns fall outside the requested page', () => {
    const tool = (id: string, toolName: string, input: unknown, output: unknown) => ({
      kind: 'tool_call' as const,
      toolUseId: id,
      toolName,
      input,
      inputSummary: JSON.stringify(input),
      inputTruncated: false,
      outputSummary: JSON.stringify(output),
      outputTruncated: false,
      failed: false,
      createdAt: 1
    });
    const session = { id: 'session', runner: 'claude-code' } as NodeAgentSession;
    const history = {
      runner: 'claude-code' as const,
      externalSessionId: 'session',
      cwd: '/workspace',
      digest: 'test',
      lastActivityAt: 1,
      items: [
        { kind: 'message' as const, role: 'USER' as const, text: 'Start', createdAt: 1 },
        tool('start', 'Agent', { description: 'Review' }, { agentId: 'child' }),
        { kind: 'message' as const, role: 'USER' as const, text: 'Check', createdAt: 2 },
        tool('wait', 'TaskOutput', { task_id: 'child', block: true }, 'Still running')
      ]
    };
    const full = nativeConversationPage(session, history, { limit: 2 }).turns.at(-1)?.items.at(-1);
    const page = nativeConversationPage(session, history, { limit: 1 }).turns.at(-1)?.items.at(-1);
    expect(full?.payload).toMatchObject({
      subagentId: 'child',
      subagentOperation: 'STATUS',
      title: 'Review'
    });
    expect(page?.payload).toEqual(full?.payload);
  });

  it('links Claude subagent controls by confirmed identities in native history', () => {
    const tool = (id: string, name: string, input: unknown, output: unknown) => ({
      kind: 'tool_call' as const,
      toolUseId: id,
      toolName: name,
      input,
      inputSummary: JSON.stringify(input),
      inputTruncated: false,
      outputSummary: JSON.stringify(output),
      outputTruncated: false,
      failed: false,
      createdAt: 1
    });
    const page = nativeConversationPage(
      { id: 'session', runner: 'claude-code' } as NodeAgentSession,
      {
        runner: 'claude-code',
        externalSessionId: 'session',
        cwd: '/workspace',
        digest: 'test',
        lastActivityAt: 1,
        items: [
          tool('start', 'Agent', { description: 'Review' }, { agentId: 'child' }),
          tool('wait', 'TaskOutput', { task_id: 'child', block: true }, {}),
          tool('shell', 'TaskStop', { task_id: 'shell' }, { task_type: 'local_bash' })
        ]
      },
      {}
    );
    const items = page.turns.flatMap((turn) => turn.items);
    expect(items[0]?.payload).toMatchObject({ subagentId: 'child', subagentOperation: 'START' });
    expect(items[1]?.payload).toMatchObject({
      subagentId: 'child',
      subagentOperation: 'STATUS',
      subagentWait: true,
      title: 'Review'
    });
    expect(items[2]?.payload).not.toHaveProperty('subagentOperation');
  });

  it('preserves the complete managed Claude Turn when native history backfills only part of the Agent response', () => {
    const session = {
      id: 'claude-partial-history',
      runner: 'claude-code',
      externalSessionId: 'claude-partial-history'
    } as NodeAgentSession;
    const runtimeTurn = {
      id: 'managed-claude-partial-turn',
      sessionId: session.id,
      runId: 'run-claude-partial',
      userItemId: 'local-user',
      status: 'SUCCEEDED',
      model: null,
      effort: null,
      access: null,
      startedAt: 10,
      completedAt: 30,
      items: [
        {
          id: 'local-user',
          sessionId: session.id,
          turnId: 'managed-claude-partial-turn',
          runId: 'run-claude-partial',
          parentItemId: null,
          sourceSequence: 1,
          revision: 1,
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { text: 'hello', clientMessageId: 'claude-partial-message' },
          startedAt: 10,
          completedAt: 10
        },
        ...['First live message', 'Second live message', 'Third live message'].map(
          (text, index) => ({
            id: `run-claude-partial:assistant:${index + 2}`,
            sessionId: session.id,
            turnId: 'managed-claude-partial-turn',
            runId: 'run-claude-partial',
            parentItemId: null,
            sourceSequence: index + 2,
            revision: 1,
            kind: 'assistant_message' as const,
            status: 'COMPLETED' as const,
            payload: { text, format: 'markdown', model: null },
            startedAt: 11 + index,
            completedAt: 11 + index
          })
        )
      ]
    } as const;

    const page = nativeConversationPage(
      session,
      {
        runner: 'claude-code',
        externalSessionId: 'claude-partial-history',
        cwd: '/workspace',
        digest: 'claude-partial-history',
        lastActivityAt: 11,
        items: [
          { kind: 'message', role: 'USER', text: 'hello', createdAt: 10 },
          { kind: 'message', role: 'ASSISTANT', text: 'First', createdAt: 11 }
        ]
      },
      { limit: 30 },
      [runtimeTurn as never]
    );

    expect(
      page.turns[0]?.items
        .filter((item) => item.kind === 'assistant_message')
        .map((item) => (item.payload as { text?: string }).text)
    ).toEqual(['First live message', 'Second live message', 'Third live message']);
  });

  it.each(['codex', 'claude-code'] as const)(
    '%s preserves the final non-image attachment prompt from native history after a Node restart',
    (runner) => {
      const runnerInput =
        'Read the attachment\n\nAttachments available in the Workspace:\n- .mar/temp-files/run/notes.pdf';
      const session = {
        id: `${runner}-attachment-history`,
        runner,
        externalSessionId: `${runner}-attachment-history`,
        cwd: '/workspace'
      } as NodeAgentSession;
      const page = nativeConversationPage(
        session,
        {
          runner,
          externalSessionId: session.externalSessionId!,
          cwd: session.cwd,
          digest: `${runner}-attachment-history`,
          lastActivityAt: 11,
          items: [
            { kind: 'message', role: 'USER', text: runnerInput, createdAt: 10 },
            { kind: 'message', role: 'ASSISTANT', text: 'Attachment read', createdAt: 11 }
          ]
        },
        { limit: 30 }
      );

      const user = page.turns[0]?.items.find((item) => item.kind === 'user_message');
      expect(user?.payload).toMatchObject({ text: runnerInput });
    }
  );

  it('merges a Codex attachment marker into the current local message while preserving the image', () => {
    const session = {
      id: 'codex-image-echo',
      runner: 'codex',
      externalSessionId: 'codex-image-echo',
      cwd: '/workspace'
    } as NodeAgentSession;
    const page = nativeConversationPage(
      session,
      {
        runner: 'codex',
        externalSessionId: 'codex-image-echo',
        cwd: '/workspace',
        digest: 'codex-image-echo',
        lastActivityAt: 11,
        items: [
          {
            kind: 'message',
            role: 'USER',
            text: 'Add a down arrow icon\n<image name=[Image #1] path="/tmp/myagentroam-attachment-example/1.png">\n</image>',
            createdAt: 10
          },
          { kind: 'message', role: 'ASSISTANT', text: 'Processed', createdAt: 11 }
        ]
      },
      { limit: 30 },
      [
        {
          id: 'runtime-turn',
          sessionId: session.id,
          runId: 'run-image-echo',
          userItemId: 'runtime-user',
          status: 'SUCCEEDED',
          model: null,
          effort: null,
          access: null,
          items: [
            {
              id: 'runtime-user',
              sessionId: session.id,
              turnId: 'runtime-turn',
              runId: 'run-image-echo',
              parentItemId: null,
              sourceSequence: null,
              revision: 0,
              kind: 'user_message',
              status: 'COMPLETED',
              payload: {
                clientMessageId: 'image-echo-message',
                text: 'Add a down arrow icon',
                contexts: [],
                delivery: 'ACCEPTED',
                attachments: [
                  {
                    name: '1.png',
                    mime: 'image/png',
                    runId: 'run-image-echo',
                    imageIndex: 0
                  }
                ]
              },
              startedAt: 10,
              completedAt: 10
            }
          ],
          startedAt: 10,
          completedAt: 11
        }
      ]
    );

    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]?.items[0]?.payload).toMatchObject({
      clientMessageId: 'image-echo-message',
      text: 'Add a down arrow icon',
      attachments: [{ name: '1.png', imageIndex: 0 }]
    });
    expect(JSON.stringify(page.turns)).not.toContain('myagentroam-attachment');
  });

  it('converts Codex JSONL Composer image markers into internal attachment metadata', async () => {
    const home = join(tmpdir(), `mar-native-history-codex-image-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    const localPath = join(tmpdir(), 'myagentroam-attachment-history', '1.png');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'codex-image.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'codex-image', cwd: '/workspace/current' }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Add a down arrow icon' },
              {
                type: 'input_text',
                text: `<image name=[Image #1] path="${localPath}">`
              },
              { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
              { type: 'input_text', text: '</image>' }
            ]
          }
        })
      ].join('\n')
    );

    await discoverNativeSessions('codex', '/workspace/current');
    const history = await readNativeSession('codex', '/workspace/current', 'codex-image');
    expect(history).toMatchObject({
      title: 'Add a down arrow icon',
      items: [
        {
          kind: 'message',
          role: 'USER',
          text: 'Add a down arrow icon',
          imageAttachments: [{ localPath, mime: 'image/png' }]
        }
      ]
    });
    const session = {
      id: 'codex-image',
      runner: 'codex',
      externalSessionId: 'codex-image',
      cwd: '/workspace/current'
    } as NodeAgentSession;
    const page = nativeConversationPage(session, history!, {}, [], () => [
      { name: 'image.png', mime: 'image/png', runId: 'run-image', imageIndex: 0 }
    ]);
    expect(page.turns[0]?.items[0]?.payload).toMatchObject({
      text: 'Add a down arrow icon',
      attachments: [{ runId: 'run-image', imageIndex: 0 }]
    });
  });

  it('projects Codex task IDs as native Rewind boundaries', async () => {
    const home = join(tmpdir(), `mar-native-history-codex-rewind-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'codex-rewind.jsonl'),
      [
        { type: 'session_meta', payload: { id: 'codex-rewind', cwd: '/workspace/current' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'setup-turn' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '# AGENTS.md instructions for /workspace/current <INSTRUCTIONS>context</INSTRUCTIONS>'
              }
            ]
          }
        },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First' }]
          }
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'First answer' }]
          }
        },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Second' }]
          }
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Second answer' }]
          }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    );

    await discoverNativeSessions('codex', '/workspace/current');
    const history = await readNativeSession('codex', '/workspace/current', 'codex-rewind');
    const session = {
      id: 'codex-rewind',
      runner: 'codex',
      externalSessionId: 'codex-rewind',
      cwd: '/workspace/current'
    } as NodeAgentSession;
    const page = nativeConversationPage(session, history!, {});
    expect(page.turns.map((turn) => turn.rewind)).toEqual([
      { before: null, after: 'turn-1' },
      { before: 'turn-1', after: 'turn-2' }
    ]);
    expect(nativeConversationPage(session, history!, { limit: 1 }).turns[0]?.rewind).toEqual({
      before: 'turn-1',
      after: 'turn-2'
    });
    expect(
      nativeConversationPage(session, { ...history!, truncated: true }, {}).turns.map(
        (turn) => turn.rewind
      )
    ).toEqual([undefined, { before: 'turn-1', after: 'turn-2' }]);
  });

  it.each(['codex', 'claude-code'] as const)(
    '%s reuses the global discovery snapshot across workspaces and refreshes only changed files after expiration',
    async (runner) => {
      const home = join(tmpdir(), `mar-native-discovery-cache-${runner}-${crypto.randomUUID()}`);
      directories.push(home);
      previousHome = process.env.HOME;
      process.env.HOME = home;
      const directory =
        runner === 'codex'
          ? join(home, '.codex', 'sessions', '2026', '08')
          : join(home, '.claude', 'projects', 'workspaces');
      await mkdir(directory, { recursive: true });
      const transcript = (id: string, cwd: string, title: string) =>
        runner === 'codex'
          ? [
              JSON.stringify({ type: 'session_meta', payload: { id, cwd } }),
              JSON.stringify({
                type: 'response_item',
                payload: { role: 'user', content: [{ type: 'input_text', text: title }] }
              })
            ].join('\n')
          : JSON.stringify({
              type: 'user',
              sessionId: id,
              cwd,
              message: { role: 'user', content: title }
            });
      const firstPath = join(directory, 'first.jsonl');
      const secondPath = join(directory, 'second.jsonl');
      await writeFile(firstPath, transcript('first', '/workspace/first', 'First workspace'));
      await writeFile(secondPath, transcript('second', '/workspace/second', 'Old title'));
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);

      await expect(discoverNativeSessions(runner, '/workspace/first')).resolves.toEqual([
        expect.objectContaining({ externalSessionId: 'first' })
      ]);
      await writeFile(secondPath, transcript('second', '/workspace/second', 'Refreshed title'));
      now += 14_999;
      await expect(discoverNativeSessions(runner, '/workspace/second')).resolves.toEqual([
        expect.objectContaining({ externalSessionId: 'second', title: 'Old title' })
      ]);

      now += 2;
      await expect(discoverNativeSessions(runner, '/workspace/second')).resolves.toEqual([
        expect.objectContaining({
          externalSessionId: 'second',
          title: 'Refreshed title'
        })
      ]);
      await expect(discoverNativeSessions(runner, '/workspace/first')).resolves.toEqual([
        expect.objectContaining({
          externalSessionId: 'first',
          title: 'First workspace'
        })
      ]);

      await unlink(secondPath);
      now += 15_001;
      await expect(discoverNativeSessions(runner, '/workspace/second')).resolves.toEqual([]);
    }
  );

  it('keeps the native history cursor anchored to the live snapshot and switches to the preceding byte window when a page is exhausted', () => {
    const session = {
      id: 'session-native-cursor',
      runner: 'codex',
      externalSessionId: 'native-cursor',
      cwd: '/workspace/current'
    } as NodeAgentSession;
    const history = {
      runner: 'codex' as const,
      externalSessionId: 'native-cursor',
      cwd: '/workspace/current',
      digest: 'digest',
      lastActivityAt: 4,
      truncated: true,
      windowStart: 100,
      windowEnd: 300,
      snapshotEnd: 500,
      fileAnchor: 'stable-anchor',
      anchorBytes: 4096,
      items: [
        {
          kind: 'message' as const,
          role: 'USER' as const,
          text: 'Question one',
          createdAt: 1
        },
        {
          kind: 'message' as const,
          role: 'ASSISTANT' as const,
          text: 'Answer one',
          createdAt: 2
        },
        {
          kind: 'message' as const,
          role: 'USER' as const,
          text: 'Question two',
          createdAt: 3
        },
        {
          kind: 'message' as const,
          role: 'ASSISTANT' as const,
          text: 'Answer two',
          createdAt: 4
        }
      ]
    };

    const latest = nativeConversationPage(session, history, { limit: 1 });
    const withinWindow = JSON.parse(Buffer.from(latest.nextCursor!, 'base64url').toString('utf8'));
    expect(withinWindow).toMatchObject({
      sessionId: session.id,
      snapshotEnd: 500,
      nextEnd: 300,
      fileAnchor: 'stable-anchor',
      anchorBytes: 4096,
      readLimit: 1,
      end: 1
    });

    const older = nativeConversationPage(session, history, {
      cursor: latest.nextCursor!,
      limit: 1
    });
    expect(JSON.parse(Buffer.from(older.nextCursor!, 'base64url').toString('utf8'))).toEqual({
      sessionId: session.id,
      snapshotEnd: 500,
      nextEnd: 100,
      fileAnchor: 'stable-anchor',
      anchorBytes: 4096,
      readLimit: 1
    });

    const reset = nativeConversationPage(
      session,
      { ...history, cursorReset: true },
      { cursor: latest.nextCursor!, limit: 1 }
    );
    expect(reset.turns[0]?.items[0]?.payload).toMatchObject({ text: 'Question two' });

    const shiftedWindow = nativeConversationPage(
      session,
      { ...history, windowStart: 200, windowEnd: 400, snapshotEnd: 600 },
      { limit: 1 }
    );
    expect(shiftedWindow.turns[0]?.id).toBe(latest.turns[0]?.id);
    expect(shiftedWindow.turns[0]?.items.map((item) => item.id)).toEqual(
      latest.turns[0]?.items.map((item) => item.id)
    );

    const appended = nativeConversationPage(
      session,
      {
        ...history,
        items: [
          ...history.items,
          {
            kind: 'message' as const,
            role: 'ASSISTANT' as const,
            text: 'Answer two appended in real time',
            createdAt: 5
          }
        ]
      },
      { limit: 1 }
    );
    expect(appended.turns[0]?.id).toBe(latest.turns[0]?.id);
    expect(appended.turns[0]?.items.slice(0, -1).map((item) => item.id)).toEqual(
      latest.turns[0]?.items.map((item) => item.id)
    );
  });

  it.each(['codex', 'claude-code'] as const)(
    '%s JSONL fallback groups the user message and following contiguous events into one Turn',
    (runner) => {
      const session = {
        id: `session-${runner}`,
        runner,
        externalSessionId: `native-${runner}`,
        cwd: '/workspace/current'
      } as NodeAgentSession;
      const page = nativeConversationPage(
        session,
        {
          runner,
          externalSessionId: `native-${runner}`,
          cwd: '/workspace/current',
          digest: 'digest',
          lastActivityAt: 4,
          items: [
            {
              kind: 'message',
              role: 'USER',
              text: 'Inspect the project',
              createdAt: 1,
              nativeId: 'user-1'
            },
            {
              kind: 'tool_call',
              toolUseId: 'read-1',
              toolName: 'Read',
              input: { file_path: 'a.ts' },
              inputSummary: '{"file_path":"a.ts"}',
              inputTruncated: false,
              outputSummary: 'Content A',
              outputTruncated: false,
              failed: false,
              createdAt: 2
            },
            {
              kind: 'tool_call',
              toolUseId: 'read-2',
              toolName: 'Read',
              input: { file_path: 'b.ts' },
              inputSummary: '{"file_path":"b.ts"}',
              inputTruncated: false,
              outputSummary: 'Content B',
              outputTruncated: false,
              failed: false,
              createdAt: 3
            },
            {
              kind: 'message',
              role: 'ASSISTANT',
              text: 'Inspection complete',
              createdAt: 4,
              nativeId: 'assistant-1'
            }
          ]
        },
        {}
      );

      expect(page.turns).toHaveLength(1);
      expect(page.turns[0]?.items.map((item) => item.kind)).toEqual([
        'user_message',
        'tool_call',
        'tool_call',
        'assistant_message'
      ]);
      expect(page.turns[0]?.rewind).toEqual(
        runner === 'claude-code' ? { before: null, after: 'assistant-1' } : undefined
      );
      expect(new Set(page.turns[0]?.items.map((item) => item.turnId))).toEqual(
        new Set([page.turns[0]?.id])
      );
    }
  );

  it('scans complete history before filtering by Workspace instead of truncating at a fixed file count', async () => {
    const home = join(tmpdir(), `mar-native-history-all-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 513 }, (_, index) => {
        const id = `session-${index}`;
        return writeFile(
          join(directory, `${id}.jsonl`),
          JSON.stringify({
            type: 'session_meta',
            payload: {
              session_id: id,
              cwd: index === 512 ? '/workspace/target' : '/workspace/other'
            }
          })
        );
      })
    );

    await expect(discoverAllNativeSessions('codex')).resolves.toHaveLength(513);
    await expect(discoverNativeSessions('codex', '/workspace/target')).resolves.toEqual([
      expect.objectContaining({ externalSessionId: 'session-512' })
    ]);
  });

  it('builds an index only for the current Workspace during discovery and reads details from one JSONL file', async () => {
    const home = join(tmpdir(), `mar-native-history-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'session-1.jsonl');
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            session_id: 'session-1',
            cwd: '/workspace/current'
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '# AGENTS.md instructions for /workspace/current <INSTRUCTIONS> injected context </INSTRUCTIONS>'
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<turn_aborted>internal interruption state</turn_aborted>'
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<subagent_notification>{"status":"completed"}</subagent_notification>'
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<environment_context><timezone>Asia/Shanghai</timezone></environment_context>'
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<codex_internal_context source="goal">hidden</codex_internal_context>'
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [{ type: 'input_text', text: 'Title read from file' }]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'assistant',
            content: [{ type: 'output_text', text: 'First response' }]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'future_codex_item' }
        })
      ].join('\n')
    );

    const discovered = await discoverNativeSessions('codex', '/workspace/current');
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      externalSessionId: 'session-1',
      title: 'Title read from file'
    });

    const [detail, concurrentDetail] = await Promise.all([
      readNativeSession('codex', '/workspace/current', 'session-1'),
      readNativeSession('codex', '/workspace/current', 'session-1')
    ]);
    expect(concurrentDetail).toBe(detail);
    expect(detail?.items).toEqual([
      {
        kind: 'message',
        role: 'USER',
        text: 'Title read from file',
        createdAt: null
      },
      {
        kind: 'message',
        role: 'ASSISTANT',
        text: 'First response',
        createdAt: null
      },
      {
        kind: 'unknown',
        sourceEventType: 'codex:future_codex_item',
        label: 'Codex future_codex_item',
        createdAt: null
      }
    ]);
    expect(detail?.truncated).toBe(false);

    await appendFile(
      path,
      `\n${JSON.stringify({
        type: 'response_item',
        payload: {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Response after file changes' }]
        }
      })}`
    );
    await expect(
      readNativeSession('codex', '/workspace/current', 'session-1')
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: 'message',
          text: 'Response after file changes'
        })
      ])
    });
  });

  it('marks Codex JSONL records beyond the detail-read window instead of treating them as complete history', async () => {
    const home = join(tmpdir(), `mar-native-history-truncated-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'truncated.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'truncated', cwd: '/workspace/current' }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [{ type: 'input_text', text: `Large record${'x'.repeat(17 * 1024 * 1024)}` }]
          }
        })
      ].join('\n')
    );

    await discoverNativeSessions('codex', '/workspace/current');
    await expect(
      readNativeSession('codex', '/workspace/current', 'truncated')
    ).resolves.toMatchObject({
      truncated: true
    });
  });

  it('reads complete Codex JSONL history across windows using stable byte cursors', async () => {
    const home = join(tmpdir(), `mar-native-history-pages-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    const records: string[] = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'paged-history', cwd: '/workspace/current' }
      })
    ];
    for (let index = 0; index < 300; index += 1) {
      records.push(
        JSON.stringify({
          type: 'response_item',
          timestamp: index * 2 + 1,
          payload: {
            role: 'user',
            content: [{ type: 'input_text', text: `Question-${index}` }]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: index * 2 + 2,
          payload: {
            role: 'assistant',
            content: [{ type: 'output_text', text: `Answer-${index}` }]
          }
        })
      );
    }
    await writeFile(join(directory, 'paged-history.jsonl'), records.join('\n'));
    await discoverNativeSessions('codex', '/workspace/current');
    const session = {
      id: 'session-paged-history',
      runner: 'codex',
      externalSessionId: 'paged-history',
      cwd: '/workspace/current'
    } as NodeAgentSession;
    const questions: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const decoded =
        cursor === undefined
          ? undefined
          : (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
              snapshotEnd?: number;
              nextEnd?: number;
              fileAnchor?: string;
              anchorBytes?: number;
            });
      const history = await readNativeSession(
        'codex',
        '/workspace/current',
        'paged-history',
        decoded?.snapshotEnd !== undefined &&
          decoded.nextEnd !== undefined &&
          decoded.fileAnchor !== undefined &&
          decoded.anchorBytes !== undefined
          ? {
              snapshotEnd: decoded.snapshotEnd,
              nextEnd: decoded.nextEnd,
              fileAnchor: decoded.fileAnchor,
              anchorBytes: decoded.anchorBytes
            }
          : undefined,
        10
      );
      expect(history).toBeDefined();
      const page = nativeConversationPage(session, history!, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: 10
      });
      questions.unshift(
        ...page.turns.flatMap((turn) =>
          turn.items.flatMap((item) =>
            item.kind === 'user_message' &&
            typeof (item.payload as { text?: unknown }).text === 'string'
              ? [(item.payload as { text: string }).text]
              : []
          )
        )
      );
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(questions).toEqual(Array.from({ length: 300 }, (_, index) => `Question-${index}`));
  });

  it('preserves structured Claude subagent identity without copying the raw result into history', async () => {
    const home = join(tmpdir(), `mar-native-claude-subagent-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.claude', 'projects', 'workspace');
    await mkdir(directory, { recursive: true });
    const record = (value: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'claude-subagent', cwd: '/workspace/current', ...value });
    await writeFile(
      join(directory, 'claude-subagent.jsonl'),
      [
        record({ type: 'user', message: { role: 'user', content: 'Review' } }),
        record({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'start', name: 'Agent', input: { description: 'Review' } }
            ]
          }
        }),
        record({
          type: 'user',
          tool_use_result: { content: 'x'.repeat(12_000), agentId: 'child' },
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'start', content: 'Agent started' }]
          }
        }),
        record({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'wait',
                name: 'TaskOutput',
                input: { task_id: 'child', block: true }
              }
            ]
          }
        }),
        record({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'wait', content: 'Wait timed out' }]
          }
        })
      ].join('\n')
    );
    await discoverNativeSessions('claude-code', '/workspace/current');
    const history = await readNativeSession('claude-code', '/workspace/current', 'claude-subagent');
    expect(history).toBeDefined();
    const page = nativeConversationPage(
      { id: 'session', runner: 'claude-code' } as NodeAgentSession,
      history!,
      {}
    );
    const tools = page.turns
      .flatMap((turn) => turn.items)
      .filter((item) => item.kind === 'tool_call');
    expect(tools).toMatchObject([
      {
        payload: { subagentId: 'child', subagentOperation: 'START', outputSummary: 'Agent started' }
      },
      {
        payload: {
          subagentId: 'child',
          subagentOperation: 'STATUS',
          title: 'Review',
          outputSummary: 'Wait timed out'
        }
      }
    ]);
    expect(JSON.stringify(history)).not.toContain('x'.repeat(100));
  });

  it('normalizes Claude tool_use and user/tool_result into one tool card', async () => {
    const home = join(tmpdir(), `mar-native-history-claude-tools-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.claude', 'projects', 'workspace');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'claude-tools.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-tools',
          cwd: '/workspace/current',
          message: { role: 'user', content: 'Inspect the current directory' }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-tools',
          cwd: '/workspace/current',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-pwd', name: 'Bash', input: { command: 'pwd' } }]
          }
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-tools',
          cwd: '/workspace/current',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-pwd', content: '/workspace/current\n' }
            ]
          }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-tools',
          cwd: '/workspace/current',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Directory confirmed.' }]
          }
        })
      ].join('\n')
    );

    await discoverNativeSessions('claude-code', '/workspace/current');
    await expect(
      readNativeSession('claude-code', '/workspace/current', 'claude-tools')
    ).resolves.toMatchObject({
      title: 'Inspect the current directory',
      items: [
        { kind: 'message', role: 'USER', text: 'Inspect the current directory' },
        {
          kind: 'tool_call',
          toolUseId: 'tool-pwd',
          toolName: 'Bash',
          inputSummary: '{"command":"pwd"}',
          outputSummary: '/workspace/current\n',
          failed: false
        },
        { kind: 'message', role: 'ASSISTANT', text: 'Directory confirmed.' }
      ]
    });
  });

  it('preserves line breaks and table whitespace in Claude Agent Markdown', async () => {
    const home = join(tmpdir(), `mar-native-history-claude-markdown-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.claude', 'projects', 'workspace');
    await mkdir(directory, { recursive: true });
    const markdown =
      '## Project overview\n\n- First item\n- Second item\n\n| Module | Responsibility |\n| --- | --- |\n| Web | Console |';
    await writeFile(
      join(directory, 'claude-markdown.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'claude-markdown',
        cwd: '/workspace/current',
        message: { role: 'assistant', content: [{ type: 'text', text: markdown }] }
      })
    );

    await discoverNativeSessions('claude-code', '/workspace/current');
    await expect(
      readNativeSession('claude-code', '/workspace/current', 'claude-markdown')
    ).resolves.toMatchObject({ items: [{ kind: 'message', role: 'ASSISTANT', text: markdown }] });
  });

  it('normalizes Codex custom_tool_call/function_call output into tool cards by shared call_id', async () => {
    const home = join(tmpdir(), `mar-native-history-codex-tools-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'codex-tools.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'codex-tools', cwd: '/workspace/current' }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            id: 'ctc-read',
            call_id: 'call-read',
            name: 'exec',
            input: 'const file = await tools.exec_command({ cmd: \'sed -n "1,4p" README.md\' });'
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            id: 'ctco-read',
            call_id: 'call-read',
            output: [
              { type: 'input_text', text: 'Script completed\nOutput:\n' },
              { type: 'input_text', text: '# README\n' }
            ]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            id: 'fc-wait',
            call_id: 'call-wait',
            name: 'wait',
            arguments: '{"cell_id":"task-1"}'
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            id: 'fco-wait',
            call_id: 'call-wait',
            output: [{ type: 'input_text', text: 'Script completed' }]
          }
        })
      ].join('\n')
    );

    await discoverNativeSessions('codex', '/workspace/current');
    await expect(
      readNativeSession('codex', '/workspace/current', 'codex-tools')
    ).resolves.toMatchObject({
      items: [
        {
          kind: 'tool_call',
          toolUseId: 'call-read',
          toolName: 'exec',
          inputSummary:
            'const file = await tools.exec_command({ cmd: \'sed -n "1,4p" README.md\' });',
          outputSummary: 'Script completed\nOutput:\n# README\n',
          failed: false
        },
        {
          kind: 'tool_call',
          toolUseId: 'call-wait',
          toolName: 'wait',
          inputSummary: '{"cell_id":"task-1"}',
          outputSummary: 'Script completed',
          failed: false
        }
      ]
    });
  });

  it('ignores tool results without a preceding call in truncated or out-of-order records', async () => {
    const home = join(tmpdir(), `mar-native-history-orphan-tools-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    const records = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'orphan-tools', cwd: '/workspace/current' }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call-before-window',
          name: 'exec',
          input: 'echo before-window'
        }
      })
    ];
    for (let index = 0; index < 1_300; index += 1)
      records.push(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', index } }));
    records.push(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-before-window',
          output: 'orphaned by the bounded window'
        }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-out-of-order',
          output: 'must not attach to a later invocation'
        }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-out-of-order',
          name: 'wait',
          arguments: '{}'
        }
      })
    );
    for (let index = 1_300; index < 2_200; index += 1)
      records.push(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', index } }));
    records.push(
      JSON.stringify({
        type: 'response_item',
        payload: {
          role: 'user',
          content: [{ type: 'input_text', text: 'Final question' }]
        }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Final answer' }]
        }
      })
    );
    await writeFile(join(directory, 'orphan-tools.jsonl'), records.join('\n'));

    await discoverNativeSessions('codex', '/workspace/current');
    const initial = await readNativeSession(
      'codex',
      '/workspace/current',
      'orphan-tools',
      undefined,
      30
    );
    const refreshed = await readNativeSession(
      'codex',
      '/workspace/current',
      'orphan-tools',
      undefined,
      10
    );

    expect(initial).toMatchObject({ truncated: true });
    expect(initial?.items).toEqual([
      {
        kind: 'tool_call',
        toolUseId: 'call-out-of-order',
        toolName: 'wait',
        input: '{}',
        inputSummary: '{}',
        inputTruncated: false,
        outputSummary: null,
        outputTruncated: false,
        failed: false,
        createdAt: null
      },
      { kind: 'message', role: 'USER', text: 'Final question', createdAt: null },
      {
        kind: 'message',
        role: 'ASSISTANT',
        text: 'Final answer',
        createdAt: null
      }
    ]);
    expect(refreshed?.items).toEqual([
      { kind: 'message', role: 'USER', text: 'Final question', createdAt: null },
      {
        kind: 'message',
        role: 'ASSISTANT',
        text: 'Final answer',
        createdAt: null
      }
    ]);
  });

  it('ignores interruption, compaction, and local-command metadata records and their follow-up replies in Claude transcripts', async () => {
    const home = join(tmpdir(), `mar-native-history-claude-meta-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.claude', 'projects', 'workspace');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'claude-meta.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-meta',
          cwd: '/workspace/current',
          uuid: 'actual-user',
          message: { role: 'user', content: 'Actual user question' }
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-meta',
          cwd: '/workspace/current',
          uuid: 'interrupted',
          interruptedByShutdown: true,
          message: { role: 'user', content: '[Request interrupted by user]' }
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-meta',
          cwd: '/workspace/current',
          uuid: 'resume-meta',
          parentUuid: 'interrupted',
          isMeta: true,
          message: { role: 'user', content: 'Continue from where you left off.' }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-meta',
          cwd: '/workspace/current',
          uuid: 'meta-answer',
          parentUuid: 'resume-meta',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'No response requested.' }]
          }
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-meta',
          cwd: '/workspace/current',
          uuid: 'compact-summary',
          isVisibleInTranscriptOnly: true,
          isCompactSummary: true,
          message: {
            role: 'user',
            content: 'This session is being continued from a previous conversation.'
          }
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-meta',
          cwd: '/workspace/current',
          uuid: 'local-command',
          message: { role: 'user', content: '<command-name>/compact</command-name>' }
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-meta',
          cwd: '/workspace/current',
          uuid: 'local-output',
          parentUuid: 'local-command',
          message: {
            role: 'user',
            content: '<local-command-stdout>Compacted</local-command-stdout>'
          }
        })
      ].join('\n')
    );

    await discoverNativeSessions('claude-code', '/workspace/current');
    const history = await readNativeSession('claude-code', '/workspace/current', 'claude-meta');
    expect(history).toMatchObject({
      title: 'Actual user question',
      items: [
        { kind: 'message', role: 'USER', text: 'Actual user question' },
        {
          kind: 'context_compaction',
          phase: 'COMPLETED',
          summary: null,
          nativeId: 'local-command'
        }
      ]
    });
    expect(JSON.stringify(history?.items)).not.toContain(
      'This session is being continued from a previous conversation.'
    );
    const page = nativeConversationPage(
      {
        id: 'managed-claude-meta',
        runner: 'claude-code',
        externalSessionId: 'claude-meta'
      } as NodeAgentSession,
      history!,
      { limit: 30 }
    );
    expect(page.turns[0]?.items).toContainEqual(
      expect.objectContaining({
        kind: 'context_compaction',
        status: 'COMPLETED',
        payload: { phase: 'COMPLETED', summary: null }
      })
    );
  });

  it('sorts long sessions by valid conversation records while ignoring transcript file modification time', async () => {
    const home = join(tmpdir(), `mar-native-history-recency-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'recent.jsonl');
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'recent', cwd: '/workspace/current' }
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2020-01-01T00:00:00.000Z',
          payload: {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Old first message${'x'.repeat(130 * 1024)}`
              }
            ]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2025-08-16T01:00:00.000Z',
          payload: {
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Final response' }]
          }
        })
      ].join('\n')
    );
    const metadataTouchedAt = Date.parse('2026-08-16T01:00:00.000Z');
    await utimes(path, metadataTouchedAt / 1_000, metadataTouchedAt / 1_000);

    const [session] = await discoverNativeSessions('codex', '/workspace/current');
    expect(session?.lastActivityAt).toBe(Date.parse('2025-08-16T01:00:00.000Z'));
  });

  it('reads actual prompt tokens and context window from the Codex transcript tail only', async () => {
    const home = join(tmpdir(), `mar-native-context-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'context.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'context', cwd: '/workspace/current' }
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 156_000 },
              model_context_window: 258_400
            }
          }
        })
      ].join('\n')
    );
    await discoverNativeSessions('codex', '/workspace/current');
    await expect(readCodexNativeContextUsage('/workspace/current', 'context')).resolves.toEqual({
      usedTokens: 156_000,
      maxTokens: 258_400
    });
  });

  it('reads the latest valid Claude Assistant usage without accumulating history, output, or synthetic records', async () => {
    const home = join(tmpdir(), `mar-native-claude-context-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.claude', 'projects', '-workspace-current');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'claude-context.jsonl'),
      [
        JSON.stringify({ type: 'user', sessionId: 'claude-context', cwd: '/workspace/current' }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-context',
          cwd: '/workspace/current',
          message: {
            model: 'claude-sonnet',
            content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }],
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 300,
              output_tokens: 9_999
            }
          }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-context',
          cwd: '/workspace/current',
          message: {
            model: '<synthetic>',
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0
            }
          }
        })
      ].join('\n')
    );
    await expect(
      readClaudeNativeContextUsage('/workspace/current', 'claude-context', {
        environment: { MAR_CLAUDE_CONTEXT_WINDOW_TOKENS: '250000' }
      })
    ).resolves.toEqual({ model: 'claude-sonnet', usedTokens: 400, maxTokens: 250_000 });
  });

  it('uses the Node environment first, then settings env, and falls back for invalid Claude window values', async () => {
    const home = join(tmpdir(), `mar-native-claude-settings-${crypto.randomUUID()}`);
    directories.push(home);
    const settingsPath = join(home, 'settings.json');
    await mkdir(home, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { MAR_CLAUDE_CONTEXT_WINDOW_TOKENS: '240000' } })
    );
    await expect(
      claudeContextWindowTokens({
        environment: { MAR_CLAUDE_CONTEXT_WINDOW_TOKENS: '300000' },
        settingsPath
      })
    ).resolves.toBe(300_000);
    await expect(claudeContextWindowTokens({ environment: {}, settingsPath })).resolves.toBe(
      240_000
    );
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { MAR_CLAUDE_CONTEXT_WINDOW_TOKENS: 'invalid' } })
    );
    await expect(claudeContextWindowTokens({ environment: {}, settingsPath })).resolves.toBe(
      200_000
    );
  });

  it('excludes Codex subagent transcripts from session discovery without overriding the parent thread message index', async () => {
    const home = join(tmpdir(), `mar-native-history-subagent-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.codex', 'sessions', '2026', '08');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'parent.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'parent', session_id: 'parent', cwd: '/workspace/current' }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [{ type: 'input_text', text: 'Parent question' }]
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Parent answer' }]
          }
        })
      ].join('\n')
    );
    await writeFile(
      join(directory, 'child.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'child',
            session_id: 'parent',
            parent_thread_id: 'parent',
            thread_source: 'subagent',
            source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
            cwd: '/workspace/current'
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [{ type: 'input_text', text: 'Child Agent question' }]
          }
        })
      ].join('\n')
    );
    await writeFile(
      join(directory, 'fork.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'fork',
            session_id: 'fork',
            parent_thread_id: 'parent',
            thread_source: 'cli',
            cwd: '/workspace/current'
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [{ type: 'input_text', text: 'Normal fork question' }]
          }
        })
      ].join('\n')
    );

    const discovered = await discoverNativeSessions('codex', '/workspace/current');
    expect(discovered.map((entry) => entry.externalSessionId).sort()).toEqual(['fork', 'parent']);
    await expect(readNativeSession('codex', '/workspace/current', 'parent')).resolves.toMatchObject(
      {
        items: [
          { role: 'USER', text: 'Parent question' },
          { role: 'ASSISTANT', text: 'Parent answer' }
        ]
      }
    );
  });

  it('excludes Claude sidechain Agent transcripts from session discovery', async () => {
    const home = join(tmpdir(), `mar-native-history-claude-subagent-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const project = join(home, '.claude', 'projects', 'workspace');
    await mkdir(join(project, 'subagents'), { recursive: true });
    await writeFile(
      join(project, 'subagents', 'agent-child.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'parent',
        cwd: '/workspace/current',
        isSidechain: true,
        agentId: 'child',
        message: { role: 'user', content: 'Child Agent question' }
      })
    );

    const discovered = await discoverNativeSessions('claude-code', '/workspace/current');

    expect(discovered).toEqual([]);
  });

  it('deletes one native JSONL only after runner, cwd, and native ID all match the discovered record', async () => {
    const home = join(tmpdir(), `mar-native-history-remove-${crypto.randomUUID()}`);
    directories.push(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const directory = join(home, '.claude', 'projects', 'workspace');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'claude-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-1',
          cwd: '/workspace/current',
          message: { role: 'user', content: 'Delete this session' }
        })
      ].join('\n')
    );
    await writeFile(
      join(directory, 'claude-2.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-2',
          cwd: '/workspace/current',
          message: { role: 'user', content: 'Keep this session' }
        })
      ].join('\n')
    );

    await expect(discoverNativeSessions('claude-code', '/workspace/current')).resolves.toHaveLength(
      2
    );
    await expect(
      removeNativeSession('claude-code', '/workspace/other', 'claude-1')
    ).rejects.toThrow('NATIVE_TRANSCRIPT_UNAVAILABLE');
    await removeNativeSession('claude-code', '/workspace/current', 'claude-1');
    await expect(
      readNativeSession('claude-code', '/workspace/current', 'claude-1')
    ).resolves.toBeUndefined();
    await expect(discoverNativeSessions('claude-code', '/workspace/current')).resolves.toEqual([
      expect.objectContaining({
        externalSessionId: 'claude-2',
        title: 'Keep this session'
      })
    ]);
  });
});
