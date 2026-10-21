import { describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { MarAgentEvent } from '@myagentroam/agent';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import {
  marctlSessionDetail,
  marctlSessionProgress,
  marctlSessionSummary
} from '../../src/service/session-recent-activity.js';
import type { NodeRunEventBridge } from '../../src/service/node-run-event-bridge.js';
import type { ConversationHistoryService } from '../../src/service/conversation-history-service.js';

function fixture() {
  let now = 1_000;
  let sequence = 0;
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => ({
      id,
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null,
      createdAt: 1,
      updatedAt: 1
    }),
    () => now
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace',
    runner: 'mar-agent',
    cwd: '/workspace'
  });
  const { run } = runtime.createMessageRun({
    sessionId: session.id,
    clientMessageId: 'input',
    content: 'Private user input'
  });
  runtime.transitionRun(run.id, 'RUNNING');
  const emit = (itemId: string, kind: string, status: string, payload: unknown, extra = {}) => {
    now += 100;
    return runtime.appendRunEvent({
      runId: run.id,
      sequence: ++sequence,
      eventType: 'conversation.item',
      payload: { itemId, kind, status, payload, ...extra }
    });
  };
  return {
    runtime,
    session,
    run,
    emit,
    detail: () => marctlSessionDetail(runtime, session, 0),
    summary: () => marctlSessionSummary(runtime, session)
  };
}

describe('bounded marctl Session views', () => {
  it('keeps a strict whitelist and bounded Unicode messages and tools without raw bodies', () => {
    const { runtime, run, emit, detail, summary } = fixture();
    expect(detail()).toMatchObject({
      latestMessage: null,
      recentTools: [],
      status: 'RUNNING',
      runId: run.id
    });
    expect(marctlSessionProgress(runtime, 'not-loaded')).toMatchObject({
      status: 'IDLE',
      observedAt: null
    });
    emit('message', 'assistant_message', 'COMPLETED', { text: '😀'.repeat(320) });
    for (let i = 0; i < 4; i += 1)
      emit('read-' + i, 'tool_call', 'IN_PROGRESS', {
        toolName: i === 3 ? '😀'.repeat(129) : 'read',
        title: 'Read source '.repeat(30),
        inputSummary: 'DO_NOT_INCLUDE_INPUT_SUMMARY',
        outputSummary: 'DO_NOT_INCLUDE_OUTPUT_SUMMARY',
        rawInput: 'DO_NOT_INCLUDE_RAW_INPUT'
      });
    emit('reasoning', 'reasoning_summary', 'COMPLETED', {
      sections: [{ text: 'DO_NOT_INCLUDE_REASONING' }]
    });
    const value = detail();
    expect(Object.keys(value).sort()).toEqual(
      [
        'id',
        'title',
        'runner',
        'status',
        'runId',
        'model',
        'effort',
        'queuedCount',
        'latestMessage',
        'recentTools'
      ].sort()
    );
    expect(Object.keys(summary()).sort()).toEqual(
      ['id', 'title', 'runner', 'status', 'runId', 'latestActivity'].sort()
    );
    expect(value.latestMessage).toMatchObject({ runId: run.id, truncated: true, at: 1_100 });
    expect([...value.latestMessage!.text]).toHaveLength(300);
    expect(value.recentTools).toHaveLength(3);
    expect([...value.recentTools[0]!.name]).toHaveLength(128);
    expect(
      value.recentTools.every((tool) => [...tool.summary].length <= 100 && tool.truncated)
    ).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(/DO_NOT_INCLUDE|Private user input|rawInput/);
  });

  it('selects the latest observed activity but keeps tools in call order and preserves message text', () => {
    const { emit, detail, summary } = fixture();
    emit('first', 'tool_call', 'IN_PROGRESS', { toolName: 'first', inputSummary: 'start' });
    emit('second', 'tool_call', 'COMPLETED', { toolName: 'second', inputSummary: 'done' });
    emit('note', 'assistant_message', 'COMPLETED', { text: 'Done.\n  Check tests.' });
    expect(summary().latestActivity).toMatchObject({
      kind: 'message',
      summary: 'Done.\n  Check tests.'
    });
    expect(detail().latestMessage!.text).toBe('Done.\n  Check tests.');
    expect(Object.keys(summary().latestActivity!).sort()).toEqual(
      ['kind', 'name', 'state', 'summary', 'at', 'truncated'].sort()
    );
    emit('first', 'tool_call', 'COMPLETED', { toolName: 'first', outputSummary: 'Finished' });
    expect(summary().latestActivity).toMatchObject({
      kind: 'tool',
      name: 'first',
      state: 'COMPLETED',
      at: 1_400
    });
    expect(detail().recentTools.map((tool) => tool.name)).toEqual(['second', 'first']);
  });

  it('uses actual foreground sleep facts, not names or a three-tool window, and preserves tool states', () => {
    const { emit, detail } = fixture();
    const sleep = { toolName: 'sleep', toolPresentation: { kind: 'SLEEP', durationMs: 10_000 } };
    emit('sleep', 'tool_call', 'IN_PROGRESS', sleep);
    expect(detail().status).toBe('RUNNING');
    const started = {
      ...sleep,
      toolPresentation: { ...sleep.toolPresentation, startedAt: '2026-10-20T01:00:00.000Z' }
    };
    emit('sleep', 'tool_call', 'IN_PROGRESS', started);
    expect(detail()).toMatchObject({
      status: 'SLEEPING',
      recentTools: [{ name: 'sleep', state: 'IN_PROGRESS', summary: 'Sleep for up to 10000 ms' }]
    });
    for (let i = 0; i < 4; i += 1)
      emit('read-' + i, 'tool_call', 'COMPLETED', { toolName: 'read' });
    expect(detail().status).toBe('SLEEPING');
    expect(detail().recentTools).toHaveLength(3);
    expect(detail().recentTools.some((tool) => tool.name === 'sleep')).toBe(false);
    emit('sleep', 'tool_call', 'COMPLETED', {
      ...started,
      toolPresentation: { ...started.toolPresentation, elapsedMs: 500, wakeReason: 'steer' }
    });
    expect(detail().status).toBe('RUNNING');
  });

  it('formats only displayed content while still finding late updates outside the three-tool window', () => {
    const { runtime, session, emit, detail, summary } = fixture();
    emit('old-message', 'assistant_message', 'COMPLETED', { text: 'Old message' });
    emit('old-command', 'command_execution', 'IN_PROGRESS', { command: 'old command' });
    emit('new-message', 'assistant_message', 'COMPLETED', { text: 'Latest message' });
    for (let i = 0; i < 4; i += 1)
      emit('new-' + i, 'tool_call', 'COMPLETED', { toolName: 'new-' + i });
    const items = runtime.conversationTail(session.id)[0]!.items;
    const oldText = vi.fn(() => 'Old message');
    const oldCommand = vi.fn(() => 'old command');
    Object.defineProperty(
      items.find((item) => item.kind === 'assistant_message')!.payload,
      'text',
      { get: oldText }
    );
    Object.defineProperty(
      items.find((item) => item.kind === 'command_execution')!.payload,
      'command',
      { get: oldCommand }
    );
    expect(detail().latestMessage!.text).toBe('Latest message');
    expect(detail().recentTools.map((tool) => tool.name)).toEqual(['new-3', 'new-2', 'new-1']);
    expect(summary().latestActivity).toMatchObject({ name: 'new-3' });
    expect(marctlSessionProgress(runtime, session.id).recentTools).toHaveLength(3);
    expect(oldText).not.toHaveBeenCalled();
    expect(oldCommand).not.toHaveBeenCalled();
    emit('old-command', 'command_execution', 'COMPLETED', { command: 'old command', exitCode: 0 });
    expect(summary().latestActivity).toMatchObject({
      name: 'command_execution',
      summary: 'old command; exit code 0'
    });
    expect(detail().recentTools.map((tool) => tool.name)).toEqual(['new-3', 'new-2', 'new-1']);
  });

  it.each(['COMPLETED', 'FAILED', 'INTERRUPTED'])(
    'leaves sleeping after a tool becomes %s',
    (state) => {
      const { emit, detail } = fixture();
      const payload = {
        toolName: 'sleep',
        toolPresentation: {
          kind: 'SLEEP',
          startedAt: '2026-10-20T01:00:00.000Z',
          durationMs: 1_000
        }
      };
      emit('sleep', 'tool_call', 'IN_PROGRESS', payload);
      expect(detail().status).toBe('SLEEPING');
      emit('sleep', 'tool_call', state, payload);
      expect(detail()).toMatchObject({ status: 'RUNNING', recentTools: [{ state }] });
    }
  );

  it('clears sleeping on cancellation and completion, and never borrows a previous Run for new work', () => {
    const { runtime, session, run, emit, detail } = fixture();
    emit('sleep', 'tool_call', 'IN_PROGRESS', {
      toolName: 'sleep',
      toolPresentation: { kind: 'SLEEP', startedAt: '2026-10-20T01:00:00.000Z' }
    });
    runtime.transitionRun(run.id, 'CANCELLING');
    expect(detail().status).toBe('RUNNING');
    runtime.finishRun(run.id, 'INTERRUPTED');
    expect(detail()).toMatchObject({
      status: 'IDLE',
      runId: null,
      recentTools: [{ state: 'INTERRUPTED' }]
    });
    const { run: next } = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'next',
      content: 'Next'
    });
    expect(detail()).toMatchObject({
      status: 'RUNNING',
      runId: next.id,
      latestMessage: null,
      recentTools: []
    });
    expect(marctlSessionSummary(runtime, session).latestActivity).toBeNull();
  });

  it('does not expose command output, file diffs or code cell source', () => {
    const { emit, detail } = fixture();
    emit('command', 'command_execution', 'COMPLETED', {
      command: 'pnpm test',
      exitCode: 0,
      outputPreview: 'DO_NOT_INCLUDE_STDOUT'
    });
    emit('files', 'file_change', 'COMPLETED', {
      changes: [{ path: 'src/example.ts', diff: 'DO_NOT_INCLUDE_DIFF' }]
    });
    emit('cell', 'tool_call', 'COMPLETED', {
      toolName: 'code_exec',
      inputSummary: 'DO_NOT_INCLUDE_CODE'
    });
    expect(detail().recentTools.map((tool) => tool.summary)).toEqual([
      'code_exec',
      'src/example.ts',
      'pnpm test; exit code 0'
    ]);
    expect(JSON.stringify(detail())).not.toContain('DO_NOT_INCLUDE');
  });

  it.each(['code_exec', 'code_exec_wait'] as const)(
    'uses normalized titles for real %s items without copying code or results',
    (toolName) => {
      const { runtime, session, emit, detail, summary } = fixture();
      const normalizer = new MarAgentConversationNormalizer();
      const base = {
        eventId: 'start',
        sequence: 1,
        timestamp: '2026-10-20T01:00:00.000Z',
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn',
        callId: 'cell',
        toolName
      };
      const events: MarAgentEvent[] = [
        {
          ...base,
          type: 'tool.started',
          input:
            toolName === 'code_exec' ? 'DO_NOT_INCLUDE_CODE' : { cellId: 'DO_NOT_INCLUDE_CELL_ID' }
        },
        {
          ...base,
          eventId: 'done',
          sequence: 2,
          type: 'tool.completed',
          summary: 'DO_NOT_INCLUDE_RESULT'
        }
      ];
      for (const event of events) {
        for (const item of normalizer.normalize(event))
          emit(item.itemId, item.kind, item.status, item.payload);
        expect(detail().recentTools[0]).toMatchObject({
          name: 'command_execution',
          summary: toolName === 'code_exec' ? 'Code execution' : 'Code execution wait'
        });
        for (const value of [detail(), summary(), marctlSessionProgress(runtime, session.id)])
          expect(JSON.stringify(value)).not.toContain('DO_NOT_INCLUDE');
      }
    }
  );

  it('ignores nested sleep and does not revive sleep after process-local observations are lost', () => {
    const { runtime, session, emit, detail } = fixture();
    emit('sleep', 'tool_call', 'IN_PROGRESS', {
      toolName: 'sleep',
      toolPresentation: { kind: 'SLEEP', startedAt: '2026-10-20T01:00:00.000Z' }
    });
    const turns = runtime.conversationTail(session.id);
    const tail = vi.spyOn(runtime, 'conversationTail').mockReturnValue(
      turns.map((turn) => ({
        ...turn,
        items: turn.items.map((item) =>
          item.kind === 'tool_call' ? { ...item, parentItemId: 'child-agent' } : item
        )
      }))
    );
    expect(detail()).toMatchObject({ status: 'RUNNING', recentTools: [] });
    tail.mockRestore();
    const restarted = new NodeRuntimeState(
      () => 'node',
      () => undefined
    );
    expect(marctlSessionDetail(restarted, session, 0)).toMatchObject({
      status: 'IDLE',
      runId: null,
      latestMessage: null,
      recentTools: []
    });
  });

  it('integrates lean views and Watch progress without changing generic Sessions or opening history', async () => {
    const database = new NodeDatabase(':memory:', 'recent-activity');
    const workspace = database.saveWorkspace({
      path: '/workspace/recent-activity',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      runEventBridge: NodeRunEventBridge;
      conversationHistoryService: ConversationHistoryService;
      executeNodeOperation(operation: string, data: unknown): Promise<Record<string, unknown>>;
    };
    const history = vi.spyOn(internals.conversationHistoryService, 'read');
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });
    const { run } = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'observe',
      content: 'Observe activity'
    });
    internals.runtime.transitionRun(run.id, 'RUNNING');
    const input = { workspaceId: workspace.id, registeredOnly: true, view: 'marctl' };
    try {
      internals.runtime.createQueueItem({
        sessionId: session.id,
        clientMessageId: 'ordinary',
        content: 'DO_NOT_INCLUDE_QUEUE_BODY'
      });
      internals.runtime.createQueueItem({
        sessionId: session.id,
        clientMessageId: 'goal:internal',
        content: 'Internal continuation'
      });
      const event = internals.runtime.appendRunEvent({
        runId: run.id,
        sequence: 1,
        eventType: 'conversation.item',
        payload: {
          itemId: 'sleep',
          kind: 'tool_call',
          status: 'IN_PROGRESS',
          payload: {
            toolName: 'sleep',
            toolPresentation: {
              kind: 'SLEEP',
              durationMs: 10_000,
              startedAt: '2026-10-20T01:00:00.000Z'
            }
          }
        }
      });
      const list = await internals.executeNodeOperation('session.list', input);
      expect(list).toMatchObject({
        view: 'marctl',
        sessions: [
          {
            id: session.id,
            status: 'SLEEPING',
            latestActivity: { name: 'sleep', state: 'IN_PROGRESS' }
          }
        ]
      });
      const show = await internals.executeNodeOperation('session.get', {
        ...input,
        sessionId: session.id
      });
      expect(show).toMatchObject({
        view: 'marctl',
        workspaceId: workspace.id,
        session: { status: 'SLEEPING', queuedCount: 1 }
      });
      expect(show.session).not.toHaveProperty('control');
      const generic = await internals.executeNodeOperation('session.get', {
        sessionId: session.id,
        workspaceId: workspace.id
      });
      expect(generic.session).toHaveProperty('activity', 'MANAGED_ACTIVE');
      expect(generic.session).not.toHaveProperty('recentActivity');
      const watch = internals.runEventBridge.projectWorkbenchPayload('conversation', { event });
      expect(watch).toMatchObject({
        progress: {
          status: 'SLEEPING',
          runId: run.id,
          recentTools: [expect.objectContaining({ state: 'IN_PROGRESS' })]
        }
      });
      const delta = internals.runtime.appendRunEvent({
        runId: run.id,
        sequence: 2,
        eventType: 'text.delta',
        payload: { itemId: 'note', text: 'Still waiting' }
      });
      expect(
        internals.runEventBridge.projectWorkbenchPayload('conversation', { event: delta })
      ).not.toHaveProperty('progress');
      const chunk = internals.runtime.appendRunEvent({
        runId: run.id,
        sequence: 3,
        eventType: 'conversation.item',
        payload: {
          itemId: 'command',
          kind: 'command_execution',
          status: 'IN_PROGRESS',
          payload: { command: 'pnpm test', outputPreview: 'Streaming stdout' },
          merge: true,
          append: 'outputPreview'
        }
      });
      expect(
        internals.runEventBridge.projectWorkbenchPayload('conversation', { event: chunk })
      ).not.toHaveProperty('progress');
      const completed = internals.runtime.appendRunEvent({
        runId: run.id,
        sequence: 4,
        eventType: 'conversation.item',
        payload: {
          itemId: 'command',
          kind: 'command_execution',
          status: 'COMPLETED',
          payload: { outputPreview: 'Finished', exitCode: 0 },
          merge: true,
          append: 'outputPreview'
        }
      });
      expect(
        internals.runEventBridge.projectWorkbenchPayload('conversation', { event: completed })
      ).toMatchObject({
        progress: {
          recentTools: [
            expect.objectContaining({
              name: 'command_execution',
              state: 'COMPLETED',
              summary: 'pnpm test; exit code 0'
            }),
            expect.objectContaining({ name: 'sleep', state: 'IN_PROGRESS' })
          ]
        }
      });
      for (const title of ['fixer#page one', 'fixer#page two'])
        internals.runtime.createAgentSession({
          workspaceId: workspace.id,
          runner: 'codex',
          cwd: workspace.path,
          customTitle: title
        });
      const tail = vi.spyOn(internals.runtime, 'conversationTail');
      const page = await internals.executeNodeOperation('session.list', {
        ...input,
        query: 'fixer#page',
        limit: 1
      });
      expect(page.sessions).toHaveLength(1);
      expect(page.nextCursor).toEqual(expect.any(String));
      expect(tail).toHaveBeenCalledTimes(1);
      tail.mockRestore();
      expect(history).not.toHaveBeenCalled();
      await expect(
        internals.executeNodeOperation('session.get', {
          ...input,
          sessionId: session.id,
          workspaceId: 'foreign'
        })
      ).rejects.toThrow();
    } finally {
      await connector.stop();
    }
  });
});
