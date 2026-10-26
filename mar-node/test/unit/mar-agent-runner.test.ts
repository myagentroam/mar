import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalAgentHost,
  SecretValue,
  type MarAgentEvent,
  type MarAgentModelConfiguration
} from '../../../mar-agent/src/index.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../../mar-agent/src/agent-core/sdk/agent.js';
import type {
  ModelAdapter,
  ModelEvent
} from '../../../mar-agent/src/agent-core/model/contracts.js';
import { openMarAgentSessionCatalog } from '../../../mar-agent/src/agent-core/session/catalog.js';
import { JsonlSessionStore } from '../../../mar-agent/src/agent-core/session/store/index.js';
import { describe, expect, it, vi } from 'vitest';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { unavailableCapabilities } from '../../src/capabilities.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase, type NodeAgentSession } from '../../src/database.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import { projectConversationWorkProcesses } from '../../src/service/conversation-work-process.js';
import { NativeSessionProjectionService } from '../../src/service/native-session-projection-service.js';
import { RunAttachmentService } from '../../src/service/run-attachment-service.js';
import { RunnerService } from '../../src/service/runner-service.js';
import { SessionLifecycleService } from '../../src/service/session-lifecycle-service.js';
import {
  composerVisibleText,
  parseComposerTags,
  serializeComposerTag
} from '@myagentroam/protocol';

describe('MAR Agent attachment instructions', () => {
  it.each([false, true])('keeps image guidance inside attachment tags (mixed=%s)', (mixed) => {
    const files = [
      { name: 'shot.png', mime: 'image/png', path: '.mar/temp-files/input/shot.png' },
      ...(mixed
        ? [{ name: 'notes.txt', mime: 'text/plain', path: '.mar/temp-files/input/notes.txt' }]
        : [])
    ];
    const runner = new MarAgentRunner();
    const input = `Please inspect\n${serializeComposerTag('mar_attachments', { files })}`;
    const prepared = runner.prepareMessageInput(input, 'default');
    const parts = parseComposerTags(prepared);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({
      kind: 'mar_attachments',
      payload: {
        files,
        instruction: 'Images are included. Use view_image only to revisit them.'
      }
    });
    expect(composerVisibleText(prepared)).toBe('Please inspect');
    expect(runner.prepareMessageInput(prepared, 'default')).toBe(prepared);
  });

  it('leaves ordinary file attachment prompts unchanged', () => {
    const input = `Read this\n${serializeComposerTag('mar_attachments', {
      files: [{ name: 'notes.txt', mime: 'text/plain', path: '.mar/temp-files/input/notes.txt' }]
    })}`;
    expect(new MarAgentRunner().prepareMessageInput(input, 'default')).toBe(input);
  });
});

function codeModeEvents(
  toolName: 'code_exec' | 'code_exec_wait',
  callId: string,
  status: 'completed' | 'failed',
  observations: readonly unknown[],
  options: {
    cached?: boolean;
    executionId?: string;
    input?: unknown;
    calls?: readonly unknown[];
    omitObservations?: boolean;
  } = {}
): MarAgentEvent[] {
  const common = {
    timestamp: '2026-10-02T00:00:00.000Z',
    sessionId: 'observation-session',
    executionId: options.executionId ?? `execution-${callId}`,
    turnId: `turn-${callId}`
  };
  const started: MarAgentEvent = {
    ...common,
    eventId: `${callId}-started`,
    sequence: 1,
    type: 'tool.started',
    toolName,
    callId,
    input:
      options.input ??
      (toolName === 'code_exec'
        ? { code: 'await tools.exec({ command: "verify" });' }
        : { cellId: 'code-cell' })
  };
  const terminalBase = {
    ...common,
    eventId: `${callId}-terminal`,
    sequence: 2
  };
  let terminal: MarAgentEvent;
  if (status === 'completed') {
    const data = {
      cellId: 'code-cell',
      status: 'completed' as const,
      ...(options.cached === true ? { cached: true } : {})
    };
    if (options.calls !== undefined) Object.assign(data, { calls: options.calls });
    if (options.omitObservations !== true) Object.assign(data, { observations });
    terminal = {
      ...terminalBase,
      type: 'tool.completed',
      toolName,
      callId,
      summary: 'Code cell completed.',
      truncated: false,
      data
    };
  } else {
    terminal = {
      ...terminalBase,
      type: 'tool.failed',
      toolName,
      callId,
      code: 'MAR_AGENT_CODE_EXEC_FAILED',
      message: 'Code cell failed.'
    };
    const data = {
      cellId: 'code-cell',
      status: 'failed',
      ...(options.cached === true ? { cached: true } : {})
    };
    if (options.calls !== undefined) Object.assign(data, { calls: options.calls });
    if (options.omitObservations !== true) Object.assign(data, { observations });
    Object.assign(terminal, { data });
  }
  return [started, terminal];
}

describe('MAR Agent Node Runner', () => {
  it('replays a real completed exec across SDK executions without duplicating Node command output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-exec-replay-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const model: MarAgentModelConfiguration = {
      id: 'exec-replay',
      name: 'Exec replay',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('test'),
      modelId: 'exec-replay',
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      titleGeneration: false,
      codeMode: false,
      enabled: true
    };
    let round = 0;
    let processId: string | undefined;
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(): AsyncIterable<ModelEvent> {
        const current = round++;
        if (current === 0 || current === 2) {
          yield {
            type: 'client_tool.call',
            callId: current === 0 ? 'start-command' : 'poll-command',
            name: current === 0 ? 'exec' : 'exec_wait',
            arguments:
              current === 0
                ? {
                    command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('RETAINED')"`,
                    yieldMs: 5_000
                  }
                : { processId }
          };
          yield { type: 'completed', reason: 'tool_use' };
        } else {
          yield { type: 'text.completed', itemId: `answer-${current}`, text: 'done' };
          yield { type: 'completed', reason: 'completed' };
        }
      }
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    try {
      const session = await agent.createSession({ workspace, title: 'Retained exec' });
      const normalizer = new MarAgentConversationNormalizer();
      const first = session.run({ prompt: 'Run a command.' });
      const firstEvents: MarAgentEvent[] = [];
      for await (const event of first) firstEvents.push(event);
      await expect(first.result()).resolves.toMatchObject({ status: 'completed' });
      const started = firstEvents.find(
        (event) => event.type === 'tool.completed' && event.callId === 'start-command'
      );
      expect(started).toMatchObject({
        data: {
          status: 'completed',
          stdout: 'RETAINED',
          exitCode: 0,
          processId: expect.any(String)
        }
      });
      processId = (
        (started as Extract<MarAgentEvent, { type: 'tool.completed' }>).data as {
          processId?: string;
        }
      ).processId;
      const firstItems = firstEvents.flatMap((event) => normalizer.normalize(event));
      expect(
        firstItems.filter((item) => item.itemId === 'mar-agent-tool:start-command').at(-1)
      ).toMatchObject({
        kind: 'command_execution',
        payload: { outputPreview: 'RETAINED' }
      });

      const resumed = session.run({ prompt: 'Check the previous command.' });
      const resumedEvents: MarAgentEvent[] = [];
      for await (const event of resumed) resumedEvents.push(event);
      await expect(resumed.result()).resolves.toMatchObject({ status: 'completed' });
      const replayed = resumedEvents.find(
        (event) => event.type === 'tool.completed' && event.callId === 'poll-command'
      );
      expect(replayed).toMatchObject({
        data: { status: 'completed', cached: true, stdout: 'RETAINED', exitCode: 0, processId }
      });
      const resumedItems = resumedEvents
        .flatMap((event) => normalizer.normalize(event))
        .filter((item) => item.kind === 'command_execution');
      expect(resumedItems).toHaveLength(1);
      expect(resumedItems.map((item) => item.itemId)).toEqual(['mar-agent-tool:poll-command']);
      expect(resumedItems.at(-1)).toMatchObject({
        itemId: 'mar-agent-tool:poll-command',
        status: 'COMPLETED',
        payload: expect.objectContaining({ outputPreview: 'RETAINED', exitCode: 0 })
      });

      const catalog = await openMarAgentSessionCatalog({ homeDirectory: join(root, 'home') });
      try {
        const history = await catalog.history(session.id, { limit: 200 });
        const turns = projectMarAgentHistory(
          { id: 'node-session', runner: 'mar-agent' } as NodeAgentSession,
          history.entries
        );
        const commands = turns.flatMap((turn) =>
          turn.items
            .filter((item) => item.kind === 'command_execution')
            .map((item) => ({ turnId: turn.id, item }))
        );
        expect(commands).toHaveLength(2);
        expect(commands.map(({ item }) => item.id)).toEqual([
          'mar-agent-tool:start-command',
          'mar-agent-tool:poll-command'
        ]);
        expect(commands[0]?.turnId).not.toBe(commands[1]?.turnId);
        expect(commands.map(({ item }) => item.payload)).toEqual([
          expect.objectContaining({ outputPreview: 'RETAINED' }),
          expect.objectContaining({ outputPreview: 'RETAINED' })
        ]);
      } finally {
        await catalog.close();
      }
    } finally {
      await agent.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a completed command successful when a later poll finds its cache expired', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const base = {
      eventId: 'event',
      sequence: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 'session',
      executionId: 'first',
      turnId: 'first-turn'
    };
    normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'exec',
      callId: 'start',
      input: { command: 'verify' }
    });
    const [completed] = normalizer.normalize({
      ...base,
      type: 'tool.completed',
      toolName: 'exec',
      callId: 'start',
      summary: 'finished',
      truncated: false,
      data: {
        status: 'completed',
        processId: 'finished-process',
        stdout: 'passed',
        stderr: '',
        exitCode: 0,
        truncated: false,
        stdoutBytes: 6,
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0
      }
    });
    const resumed = { ...base, executionId: 'second', turnId: 'second-turn' };
    expect(
      normalizer.normalize({
        ...resumed,
        type: 'tool.started',
        toolName: 'exec',
        callId: 'expired-poll',
        input: { action: 'poll', processId: 'finished-process' }
      })
    ).toEqual([]);
    const [failed] = normalizer.normalize({
      ...resumed,
      type: 'tool.failed',
      toolName: 'exec',
      callId: 'expired-poll',
      code: 'MAR_AGENT_PROCESS_NOT_FOUND',
      message: 'Managed process was not found.'
    });
    expect(completed).toMatchObject({
      itemId: 'mar-agent-tool:start',
      status: 'COMPLETED',
      payload: { outputPreview: 'passed' }
    });
    expect(failed).toMatchObject({
      itemId: 'mar-agent-tool:expired-poll',
      kind: 'tool_call',
      status: 'FAILED'
    });
    const failedStart = new MarAgentConversationNormalizer();
    failedStart.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'exec',
      callId: 'failed-start',
      input: { command: 'missing-executable' }
    });
    expect(
      failedStart.normalize({
        ...base,
        type: 'tool.failed',
        toolName: 'exec',
        callId: 'failed-start',
        code: 'MAR_AGENT_PROCESS_FAILED',
        message: 'Process could not be started.'
      })[0]
    ).toMatchObject({
      itemId: 'mar-agent-tool:failed-start',
      kind: 'command_execution',
      status: 'FAILED'
    });
  });

  it('projects only personalized Code Mode tool results through the MAR Agent handlers', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const patchInput = { patch: '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch' };
    const patchData = {
      files: [{ path: 'note.txt', operation: 'added' as const, addedLines: 1, deletedLines: 0 }],
      totals: { files: 1, addedLines: 1, deletedLines: 0 }
    };
    const patchObservation = {
      type: 'tool_result',
      id: 'observation-patch',
      source: { callId: 'source-patch', toolName: 'apply_patch', input: patchInput },
      outcome: 'completed',
      result: { content: 'Patch applied.', data: patchData }
    };
    const todoObservation = {
      type: 'tool_result',
      id: 'observation-todo',
      source: {
        callId: 'source-todo-read',
        toolName: 'todo_read',
        input: {}
      },
      outcome: 'completed',
      result: {
        content: 'Todo read.',
        data: {
          revision: 0,
          items: [{ id: 'todo-existing', step: 'Existing', status: 'completed' }]
        }
      }
    };
    const todoWriteObservation = {
      type: 'tool_result',
      id: 'observation-todo-write',
      source: {
        callId: 'source-todo-write',
        toolName: 'todo_write',
        input: { expectedRevision: 0, items: [{ id: 'todo-1', step: 'Verify', status: 'pending' }] }
      },
      outcome: 'completed',
      result: {
        content: 'Todo updated.',
        data: { revision: 1, items: [{ id: 'todo-1', step: 'Verify', status: 'pending' }] }
      }
    };
    const todoReadWithoutData = {
      type: 'tool_result',
      id: 'observation-todo-read-no-data',
      source: { callId: 'source-todo-read-no-data', toolName: 'todo_read', input: {} },
      outcome: 'completed',
      result: { content: '{"revision":1,"items":[]}' }
    };
    const subagentObservation = {
      type: 'tool_result',
      id: 'observation-subagent',
      source: {
        callId: 'source-agent-start',
        toolName: 'agent_start',
        input: { description: 'Inspect parser', prompt: 'Inspect the parser.', role: 'explore' }
      },
      outcome: 'completed',
      result: {
        content: 'Subagent started.',
        data: {
          agentId: 'agent-1',
          description: 'Inspect parser',
          status: 'running',
          modelName: 'Explore model'
        }
      }
    };
    const observations = [
      patchObservation,
      todoObservation,
      todoWriteObservation,
      todoReadWithoutData,
      subagentObservation,
      {
        type: 'tool_result',
        id: 'observation-command',
        source: { callId: 'source-exec', toolName: 'exec', input: { command: 'echo ignored' } },
        outcome: 'completed',
        result: { content: 'ignored', data: { stdout: 'ignored' } }
      },
      {
        type: 'tool_result',
        id: 'observation-generic',
        source: { callId: 'source-generic', toolName: 'custom_tool', input: {} },
        outcome: 'completed',
        result: { content: 'ignored', data: { value: 'ignored' } }
      },
      {
        type: 'value',
        id: 'observation-value',
        source: patchObservation.source,
        outcome: 'completed',
        result: patchObservation.result
      }
    ];
    const nestedBase = {
      timestamp: '2026-10-02T00:00:00.000Z',
      sessionId: 'observation-session',
      executionId: 'execution-observations',
      turnId: 'turn-observations'
    };
    expect(
      normalizer.normalize({
        ...nestedBase,
        eventId: 'nested-patch-start',
        sequence: 1,
        type: 'tool.started',
        toolName: 'apply_patch',
        callId: 'source-patch',
        parentCallId: 'outer-code-exec',
        input: patchInput
      })
    ).toEqual([]);
    expect(
      normalizer.normalize({
        ...nestedBase,
        eventId: 'nested-patch-completed',
        sequence: 2,
        type: 'tool.completed',
        toolName: 'apply_patch',
        callId: 'source-patch',
        parentCallId: 'outer-code-exec',
        summary: 'Patch applied.',
        data: patchData
      })
    ).toEqual([]);

    const items = codeModeEvents('code_exec', 'outer-code-exec', 'completed', observations).flatMap(
      (event) => normalizer.normalize(event)
    );
    expect(items.find((item) => item.itemId === 'mar-agent-tool:source-patch')).toMatchObject({
      kind: 'file_change',
      status: 'COMPLETED',
      payload: { changes: [{ path: 'note.txt', change: 'ADDED', additions: 1, deletions: 0 }] }
    });
    expect(items.some((item) => item.kind === 'todo_list')).toBe(false);
    expect(items.some((item) => item.itemId === 'mar-agent-todo-list:source-todo-write')).toBe(
      false
    );
    expect(
      items.some((item) => item.itemId === 'mar-agent-todo-list:source-todo-read-no-data')
    ).toBe(false);
    expect(items.find((item) => item.itemId === 'mar-agent-tool:source-agent-start')).toMatchObject(
      {
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: {
          subagentOperation: 'START',
          subagentId: 'agent-1',
          title: 'Inspect parser',
          subagentModelName: 'Explore model'
        }
      }
    );
    expect(items.find((item) => item.itemId === 'mar-agent-tool:outer-code-exec')).toMatchObject({
      kind: 'command_execution'
    });
    expect(items.some((item) => item.itemId === 'mar-agent-tool:source-exec')).toBe(false);
    expect(items.some((item) => item.itemId === 'mar-agent-tool:source-generic')).toBe(false);
    expect(items.filter((item) => item.kind === 'file_change')).toHaveLength(1);
    expect(
      normalizer.normalize({
        ...nestedBase,
        eventId: 'native-todo-update',
        sequence: 3,
        type: 'todo.updated',
        revision: 1,
        items: [{ id: 'todo-1', step: 'Verify', status: 'pending' }]
      })
    ).toMatchObject([
      {
        itemId: 'mar-agent-todo-list:native-todo-update',
        kind: 'todo_list',
        payload: { items: [{ id: 'todo-1', text: 'Verify', status: 'PENDING' }] }
      }
    ]);
  });

  it('projects Code Exec waits as individual command items with their real invocation details', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const poll = codeModeEvents('code_exec_wait', 'wait-poll', 'completed', [], {
      input: { action: 'poll', cellId: 'cell-1', yieldMs: 0 }
    });
    const cancel = codeModeEvents('code_exec_wait', 'wait-cancel', 'completed', [], {
      input: { action: 'cancel', cellId: 'cell-2' }
    });
    const failed = codeModeEvents('code_exec_wait', 'wait-failed', 'failed', [], {
      input: { action: 'poll', cellId: 'cell-3', yieldMs: 100 }
    });
    const failedCancel = codeModeEvents('code_exec_wait', 'cancel-failed', 'failed', [], {
      input: { action: 'cancel', cellId: 'cell-4' }
    });
    const events = [...poll, ...cancel, ...failed, ...failedCancel];
    const items = events.flatMap((event) => normalizer.normalize(event));

    expect(items.map((item) => [item.itemId, item.kind, item.status])).toEqual([
      ['mar-agent-tool:wait-poll', 'command_execution', 'IN_PROGRESS'],
      ['mar-agent-tool:wait-poll', 'command_execution', 'COMPLETED'],
      ['mar-agent-tool:wait-cancel', 'command_execution', 'IN_PROGRESS'],
      ['mar-agent-tool:wait-cancel', 'command_execution', 'COMPLETED'],
      ['mar-agent-tool:wait-failed', 'command_execution', 'IN_PROGRESS'],
      ['mar-agent-tool:wait-failed', 'command_execution', 'FAILED'],
      ['mar-agent-tool:cancel-failed', 'command_execution', 'IN_PROGRESS'],
      ['mar-agent-tool:cancel-failed', 'command_execution', 'FAILED']
    ]);
    expect(items).toMatchObject([
      { payload: { command: 'code_exec_wait', outputPreview: expect.stringContaining('poll') } },
      {
        payload: {
          command: 'code_exec_wait',
          outputPreview: expect.stringContaining('Code cell completed.')
        }
      },
      { payload: { command: 'code_exec_wait', outputPreview: expect.stringContaining('cancel') } },
      {
        payload: {
          command: 'code_exec_wait',
          outputPreview: expect.stringContaining('Code cell completed.')
        }
      },
      { payload: { command: 'code_exec_wait', outputPreview: expect.stringContaining('poll') } },
      {
        payload: {
          command: 'code_exec_wait',
          outputPreview: expect.stringContaining('Code cell failed.')
        }
      },
      { payload: { command: 'code_exec_wait', outputPreview: expect.stringContaining('cancel') } },
      {
        payload: {
          command: 'code_exec_wait',
          outputPreview: expect.stringContaining('Code cell failed.')
        }
      }
    ]);
    expect(items[1]?.payload.outputPreview).toMatch(/Action: poll\nInput: /);

    const historical = projectMarAgentHistory(
      { id: 'node-session', runner: 'mar-agent' } as NodeAgentSession,
      events.map((event) => ({ kind: 'event' as const, sequence: event.sequence, event }))
    );
    const latestById = new Map(items.map((item) => [item.itemId, item]));
    for (const item of latestById.values()) {
      const historicalItem = historical
        .flatMap((turn) => turn.items)
        .find((candidate) => candidate.id === item.itemId);
      expect(historicalItem).toMatchObject({
        kind: item.kind,
        status: item.status,
        payload: item.payload
      });
    }

    const ordinaryTool = normalizer.normalize({
      eventId: 'skill-started',
      sequence: 1,
      timestamp: '2026-10-02T00:00:00.000Z',
      sessionId: 'skill-session',
      executionId: 'skill-execution',
      turnId: 'skill-turn',
      type: 'tool.started',
      toolName: 'skill',
      callId: 'skill-call',
      input: { name: 'playwright-cli' }
    });
    expect(ordinaryTool).toMatchObject([{ kind: 'tool_call', payload: { toolName: 'skill' } }]);

    const code = codeModeEvents('code_exec', 'code-run', 'completed', [])[0];
    expect(normalizer.normalize(code!)).toMatchObject([
      {
        kind: 'command_execution',
        payload: { command: 'await tools.exec({ command: "verify" });' }
      }
    ]);
  });

  it('skips malformed observations, projects failed patch results, and deduplicates cached replays', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const patchInput = {
      patch: '*** Begin Patch\n*** Update File: note.txt\n@@\n-old\n+new\n*** End Patch'
    };
    const malformed = [
      {
        type: 'tool_result',
        id: '',
        source: { callId: 'replayed-patch', toolName: 'apply_patch', input: patchInput },
        outcome: 'completed',
        result: {
          content: 'ignored',
          data: { files: [], totals: { files: 0, addedLines: 0, deletedLines: 0 } }
        }
      },
      {
        type: 'tool_result',
        id: 'missing-input',
        source: { callId: 'missing-input-call', toolName: 'apply_patch' },
        outcome: 'completed',
        result: {
          content: 'ignored',
          data: { files: [], totals: { files: 0, addedLines: 0, deletedLines: 0 } }
        }
      },
      {
        type: 'tool_result',
        id: 'malformed-data',
        source: { callId: 'malformed-data-call', toolName: 'apply_patch', input: patchInput },
        outcome: 'completed',
        result: { content: 'ignored', data: { files: [{ path: 7 }], totals: {} } }
      },
      {
        type: 'tool_result',
        id: 'malformed-content',
        source: { callId: 'malformed-content-call', toolName: 'apply_patch', input: patchInput },
        outcome: 'completed',
        result: {
          content: 7,
          data: { files: [], totals: { files: 0, addedLines: 0, deletedLines: 0 } }
        }
      }
    ];
    const malformedItems = codeModeEvents(
      'code_exec',
      'outer-malformed',
      'completed',
      malformed
    ).flatMap((event) => normalizer.normalize(event));
    expect(malformedItems.some((item) => item.kind === 'file_change')).toBe(false);

    const partial = {
      type: 'tool_result',
      id: 'observation-partial-patch',
      source: { callId: 'replayed-patch', toolName: 'apply_patch', input: patchInput },
      outcome: 'failed',
      result: {
        content: 'Patch failed after changing the file.',
        data: {
          files: [{ path: 'note.txt', operation: 'modified', addedLines: 1, deletedLines: 1 }],
          totals: { files: 1, addedLines: 1, deletedLines: 1 }
        }
      }
    };
    const partialItems = codeModeEvents('code_exec', 'outer-failed', 'failed', [partial]).flatMap(
      (event) => normalizer.normalize(event)
    );
    expect(
      partialItems.find((item) => item.itemId === 'mar-agent-tool:replayed-patch')
    ).toMatchObject({
      kind: 'file_change',
      status: 'FAILED',
      payload: { changes: [{ path: 'note.txt', change: 'MODIFIED', additions: 1, deletions: 1 }] }
    });

    const cachedItems = codeModeEvents(
      'code_exec_wait',
      'outer-cached',
      'completed',
      [
        { ...partial, id: 'observation-new-id-same-call' },
        {
          ...partial,
          id: 'observation-partial-patch',
          source: { ...partial.source, callId: 'new-source-call' }
        }
      ],
      { cached: true }
    ).flatMap((event) => normalizer.normalize(event));
    expect(cachedItems.some((item) => item.kind === 'file_change')).toBe(false);
  });

  it('projects a native MAR plan event as a plan card', () => {
    const normalizer = new MarAgentConversationNormalizer();

    expect(
      normalizer.normalize({
        type: 'plan.completed',
        eventId: 'event-plan',
        sequence: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn',
        itemId: 'answer',
        text: '1. Inspect\n2. Implement\n3. Verify'
      })
    ).toEqual([
      {
        itemId: 'mar-agent-message:answer',
        kind: 'plan',
        status: 'COMPLETED',
        payload: { explanation: '1. Inspect\n2. Implement\n3. Verify', steps: [] }
      }
    ]);
  });

  it.each(['calls', 'observations'] as const)(
    'keeps Code Mode file changes independent of outer cells in live and historical %s',
    (source) => {
      const events = [1, 2]
        .flatMap((index) => {
          const call = {
            callId: `patch-${index}`,
            toolName: 'apply_patch',
            input:
              '*** Begin Patch\n*** Update File: shared.ts\n@@\n-before\n+after\n*** End Patch',
            status: 'completed',
            result: {
              content: 'Patch applied.',
              data: {
                files: [
                  { path: 'shared.ts', operation: 'modified', addedLines: 1, deletedLines: 1 }
                ],
                totals: { files: 1, addedLines: 1, deletedLines: 1 }
              }
            }
          };
          const observation = {
            type: 'tool_result',
            id: `observation-${index}`,
            source: { callId: call.callId, toolName: call.toolName, input: call.input },
            outcome: 'completed',
            result: call.result
          };
          return codeModeEvents(
            index === 1 ? 'code_exec' : 'code_exec_wait',
            `outer-${index}`,
            'completed',
            source === 'observations' ? [observation] : [],
            { executionId: 'execution', ...(source === 'calls' ? { calls: [call] } : {}) }
          );
        })
        .map((event, index) => ({ ...event, turnId: 'turn', sequence: index + 1 }));
      const normalizer = new MarAgentConversationNormalizer();
      const live = events
        .flatMap((event) => normalizer.normalize(event))
        .filter((item) => item.kind === 'file_change');
      expect(live.map((item) => item.itemId)).toEqual([
        'mar-agent-tool:patch-1',
        'mar-agent-tool:patch-2'
      ]);
      for (const item of live) {
        expect(item).not.toHaveProperty('parentItemId');
        expect(item.payload).toMatchObject({
          changes: [{ path: 'shared.ts', change: 'MODIFIED' }]
        });
      }
      const project = (projectionEvents: readonly MarAgentEvent[]) =>
        projectMarAgentHistory({ id: 'node-session', runner: 'mar-agent' } as NodeAgentSession, [
          {
            kind: 'user',
            sequence: 0,
            timestamp: events[0]!.timestamp,
            sessionId: 'session',
            executionId: 'execution',
            turnId: 'turn',
            text: 'Update shared.ts twice.'
          },
          ...projectionEvents.map((event) => ({
            kind: 'event' as const,
            sequence: event.sequence,
            event
          }))
        ]).map(projectConversationWorkProcesses);
      const historical = project(events)
        .flatMap((turn) => turn.items)
        .filter((item) => item.kind === 'file_change');
      expect(historical.map((item) => item.id)).toEqual(live.map((item) => item.itemId));
      expect(historical.map((item) => item.parentItemId)).toEqual([null, null]);
      expect(historical.map((item) => item.payload)).toEqual(live.map((item) => item.payload));
      expect(historical[0]!.processGroup?.id).toBeDefined();
      expect(historical[1]!.processGroup?.id).toBe(historical[0]!.processGroup?.id);

      const boundary: MarAgentEvent = {
        type: 'message.completed',
        eventId: 'public-boundary',
        sequence: 4,
        timestamp: events[0]!.timestamp,
        sessionId: 'session',
        executionId: 'execution',
        turnId: 'turn',
        itemId: 'public-boundary',
        phase: 'commentary',
        modelId: 'test-model',
        modelName: 'Test Model',
        text: 'Continue with the next edit.'
      };
      const acrossBoundary = project(
        [...events.slice(0, 3), boundary, ...events.slice(3)].map((event, index) => ({
          ...event,
          sequence: index + 1
        }))
      )
        .flatMap((turn) => turn.items)
        .filter((item) => item.kind === 'file_change');
      expect(acrossBoundary.map((item) => item.id)).toEqual(historical.map((item) => item.id));
      expect(acrossBoundary[0]!.processGroup?.id).toBe(historical[0]!.processGroup?.id);
      expect(acrossBoundary[1]!.processGroup?.id).toBeDefined();
      expect(acrossBoundary[1]!.processGroup?.id).not.toBe(acrossBoundary[0]!.processGroup?.id);
    }
  );

  it('prefers personalized Code Mode calls and deduplicates them against observations', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const patchInput = '*** Begin Patch\n*** Add File: ledger.txt\n+ledger\n*** End Patch';
    const patchData = {
      files: [{ path: 'ledger.txt', operation: 'added', addedLines: 1, deletedLines: 0 }],
      totals: { files: 1, addedLines: 1, deletedLines: 0 }
    };
    const patchCall = {
      callId: 'ledger-patch',
      toolName: 'apply_patch',
      input: patchInput,
      status: 'completed',
      result: { content: 'Patch applied.', data: patchData }
    };
    const todoCall = {
      callId: 'ledger-todo-read',
      toolName: 'todo_read',
      input: {},
      status: 'completed',
      result: {
        content: 'Todo read.',
        data: {
          revision: 3,
          items: [{ id: 'ledger-todo', step: 'Verify ledger path', status: 'pending' }]
        }
      }
    };
    const subagentCall = {
      callId: 'ledger-subagent',
      toolName: 'agent_start',
      input: { description: 'Review ledger', prompt: 'Review the call ledger.', role: 'review' },
      status: 'completed',
      result: {
        content: 'Subagent started.',
        data: {
          agentId: 'ledger-agent',
          description: 'Review ledger',
          status: 'running'
        }
      }
    };
    const calls = [
      patchCall,
      todoCall,
      subagentCall,
      {
        callId: 'ledger-running',
        toolName: 'apply_patch',
        input: patchInput,
        status: 'running',
        result: { content: 'Still running.', data: patchData }
      },
      {
        callId: 'ledger-malformed',
        toolName: 'apply_patch',
        input: patchInput,
        status: 'completed',
        result: { data: patchData }
      },
      {
        callId: 'ledger-exec',
        toolName: 'exec',
        input: { command: 'echo ignored' },
        status: 'completed',
        result: { content: 'ignored', data: { stdout: 'ignored' } }
      },
      {
        callId: 'ledger-generic',
        toolName: 'custom_tool',
        input: {},
        status: 'completed',
        result: { content: 'ignored', data: { value: 'ignored' } }
      }
    ];
    const items = codeModeEvents('code_exec', 'outer-ledger', 'completed', [], {
      calls,
      omitObservations: true
    }).flatMap((event) => normalizer.normalize(event));

    expect(items.find((item) => item.itemId === 'mar-agent-tool:ledger-patch')).toMatchObject({
      kind: 'file_change',
      status: 'COMPLETED',
      payload: { changes: [{ path: 'ledger.txt', change: 'ADDED', additions: 1, deletions: 0 }] }
    });
    expect(items.some((item) => item.kind === 'todo_list')).toBe(false);
    expect(items.find((item) => item.itemId === 'mar-agent-tool:ledger-subagent')).toMatchObject({
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: { subagentOperation: 'START', subagentId: 'ledger-agent' }
    });
    for (const item of items.filter((item) =>
      ['mar-agent-tool:ledger-patch', 'mar-agent-tool:ledger-subagent'].includes(item.itemId)
    ))
      expect(item).not.toHaveProperty('parentItemId');
    expect(
      items.some((item) =>
        [
          'mar-agent-tool:ledger-running',
          'mar-agent-tool:ledger-malformed',
          'mar-agent-tool:ledger-exec',
          'mar-agent-tool:ledger-generic'
        ].includes(item.itemId)
      )
    ).toBe(false);
    expect(items.filter((item) => item.kind === 'file_change')).toHaveLength(1);

    const duplicateObservation = {
      type: 'tool_result',
      id: 'ledger-observation',
      source: { callId: 'ledger-patch', toolName: 'apply_patch', input: patchInput },
      outcome: 'completed',
      result: {
        content: 'Different projection must not replace the ledger call.',
        data: {
          files: [{ path: 'observation.txt', operation: 'added', addedLines: 1, deletedLines: 0 }],
          totals: { files: 1, addedLines: 1, deletedLines: 0 }
        }
      }
    };
    const replayItems = codeModeEvents(
      'code_exec_wait',
      'outer-ledger-replay',
      'completed',
      [duplicateObservation],
      { cached: true }
    ).flatMap((event) => normalizer.normalize(event));
    expect(replayItems.some((item) => item.kind === 'file_change')).toBe(false);

    const precedenceNormalizer = new MarAgentConversationNormalizer();
    const precedenceObservation = {
      ...duplicateObservation,
      id: 'precedence-observation',
      source: { ...duplicateObservation.source, callId: 'precedence-call' }
    };
    const precedenceCall = {
      ...patchCall,
      callId: 'precedence-call',
      result: {
        content: 'Ledger source wins.',
        data: {
          files: [{ path: 'calls-ledger.txt', operation: 'added', addedLines: 1, deletedLines: 0 }],
          totals: { files: 1, addedLines: 1, deletedLines: 0 }
        }
      }
    };
    const precedenceItems = codeModeEvents(
      'code_exec',
      'outer-precedence',
      'completed',
      [precedenceObservation],
      { calls: [precedenceCall] }
    ).flatMap((event) => precedenceNormalizer.normalize(event));
    expect(precedenceItems.find((item) => item.kind === 'file_change')).toMatchObject({
      payload: { changes: [{ path: 'calls-ledger.txt' }] }
    });

    const malformedNormalizer = new MarAgentConversationNormalizer();
    const malformedCallsItems = codeModeEvents(
      'code_exec',
      'outer-malformed-calls',
      'completed',
      [precedenceObservation],
      { calls: [null] }
    ).flatMap((event) => malformedNormalizer.normalize(event));
    expect(malformedCallsItems.some((item) => item.kind === 'file_change')).toBe(false);

    const failedCall = {
      ...patchCall,
      callId: 'ledger-partial-failure',
      status: 'failed',
      result: {
        content: 'Patch failed after changing a file.',
        data: {
          files: [{ path: 'partial.txt', operation: 'modified', addedLines: 1, deletedLines: 1 }],
          totals: { files: 1, addedLines: 1, deletedLines: 1 }
        }
      }
    };
    const failedItems = codeModeEvents('code_exec', 'outer-ledger-failed', 'failed', [], {
      calls: [failedCall],
      omitObservations: true
    }).flatMap((event) => normalizer.normalize(event));
    expect(
      failedItems.find((item) => item.itemId === 'mar-agent-tool:ledger-partial-failure')
    ).toMatchObject({
      kind: 'file_change',
      status: 'FAILED',
      payload: { changes: [{ path: 'partial.txt', change: 'MODIFIED' }] }
    });
  });

  it('classifies SDK Catalog history as the Runner official source', async () => {
    const runner = new MarAgentRunner();
    await expect(
      runner.readConversationHistory({
        official: async () => ({ turns: [], nextCursor: null })
      })
    ).resolves.toEqual({ turns: [], nextCursor: null, source: 'official' });
  });

  it('isolates corrupt legacy title previews without hiding healthy discovered Sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-title-corrupt-'));
    try {
      const store = await JsonlSessionStore.open(home);
      const corrupt = await store.createSession({ workspace: '/workspace' });
      const healthy = await store.createSession({ workspace: '/workspace' });
      try {
        for (const session of [corrupt, healthy]) {
          await store.append(session.id, {
            type: 'execution.header',
            executionId: 'execution',
            turnId: 'turn',
            payload: { modelId: 'model', reasoningEffort: 'low' }
          });
          await store.append(session.id, {
            type: 'turn.user',
            executionId: 'execution',
            turnId: 'turn',
            payload: { prompt: 'First user message' }
          });
        }
      } finally {
        await store.close();
      }
      const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      for (const meta of index.sessions) {
        delete meta.resume.firstUserMessageIndexed;
        delete meta.resume.firstUserMessagePreview;
      }
      await writeFile(indexPath, JSON.stringify(index));
      const corruptPath = join(
        home,
        '.mar',
        'agent',
        'sessions',
        corrupt.id,
        'events-000001.jsonl'
      );
      await writeFile(corruptPath, '{invalid}\n' + (await readFile(corruptPath, 'utf8')));
      const runner = new MarAgentRunner(home);
      const discovered = await runner.discoverSessions(
        {
          workspaces: [],
          createProjection: (input) =>
            ({
              id: input.externalSessionId,
              runnerTitle: input.title
            }) as NodeAgentSession
        },
        { id: 'workspace', path: '/workspace', kind: 'DIRECTORY', gitSummary: null }
      );
      expect(discovered).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: healthy.id, runnerTitle: 'First user message' }),
          expect.objectContaining({ id: corrupt.id, runnerTitle: 'New session' })
        ])
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('clears a native MAR Agent session after releasing its warm resources', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-clear-home-'));
    try {
      const store = await JsonlSessionStore.open(home);
      const native = await store.createSession({ title: 'Kept', workspace: '/workspace' });
      await store.append(native.id, {
        type: 'turn.user',
        payload: { prompt: 'clear this' },
        executionId: 'execution',
        turnId: 'turn'
      });
      await store.close();
      const runner = new MarAgentRunner(home);
      const releaseSessionResources = vi.fn(async () => undefined);
      runner.setSessionResourceReleaser(releaseSessionResources);

      await expect(
        runner.clearNative({
          id: 'projection',
          runner: 'mar-agent',
          externalSessionId: native.id
        } as NodeAgentSession)
      ).resolves.toBeTypeOf('number');
      expect(releaseSessionResources).toHaveBeenCalledWith(native.id);

      const reopened = await JsonlSessionStore.open(home);
      await expect(reopened.read(native.id)).resolves.toHaveLength(1);
      await reopened.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('projects persisted user images as controlled references and reads pixels on demand', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-input-image-home-'));
    const attachments = new RunAttachmentService(() => []);
    try {
      const imageBase64 = Buffer.from('runner-image').toString('base64');
      const store = await JsonlSessionStore.open(home);
      const native = await store.createSession({ title: 'Image', workspace: '/workspace' });
      const images = await store.persistInputImages(native.id, [
        { name: 'diagram.png', mimeType: 'image/png', dataBase64: imageBase64 }
      ]);
      await store.append(native.id, {
        type: 'turn.user',
        payload: {
          prompt: 'inspect',
          images: [{ name: 'legacy.png', mimeType: 'image/png', byteSize: 3 }, ...images]
        },
        executionId: 'execution',
        turnId: 'turn'
      });
      await store.close();
      const session = {
        id: native.id,
        runner: 'mar-agent',
        externalSessionId: native.id,
        cwd: '/workspace',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession;
      const runner = new MarAgentRunner(home);
      runner.setGeneratedImageRegistrar((registeredSession, input) =>
        attachments.registerNative(registeredSession, input)
      );

      const page = await runner.readOfficialConversation(session, {});

      expect(page?.turns[0]?.items[0]?.payload).toMatchObject({
        text: 'inspect',
        attachments: [
          {
            name: 'legacy.png',
            mime: 'image/png',
            byteSize: 3
          },
          {
            name: 'diagram.png',
            mime: 'image/png',
            byteSize: 12,
            runId: `native-history:${native.id}`,
            imageRef: expect.stringMatching(/^reader:/u)
          }
        ]
      });
      expect(page?.turns[0]?.items[0]?.payload).not.toHaveProperty('readable');
      expect(JSON.stringify(page)).not.toContain(imageBase64);
      const registered = (
        page!.turns[0]!.items[0]!.payload as { attachments: { imageRef?: string }[] }
      ).attachments;
      await expect(
        attachments.readNative(`native-history:${native.id}`, registered[1]!.imageRef!)
      ).resolves.toEqual({
        name: 'diagram.png',
        mime: 'image/png',
        dataBase64: imageBase64
      });
    } finally {
      attachments.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves a user title when an external session resumes as managed', async () => {
    const workspacePath = await realpath(await mkdtemp(join(tmpdir(), 'mar-title-workspace-')));
    const database = new NodeDatabase(':memory:', 'node-mar-agent-title');
    try {
      const workspace = database.saveWorkspace({
        path: workspacePath,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false },
          marAgent: { available: true, version: '0.9.16' }
        }
      });
      const external: NodeAgentSession = {
        id: 'mar-agent-session',
        nodeId: 'node-mar-agent-title',
        workspaceId: workspace.id,
        runner: 'mar-agent',
        externalSessionId: 'mar-agent-session',
        nativeControl: 'EXTERNAL',
        channelToken: null,
        cwd: workspace.path,
        model: 'coding',
        effort: 'high',
        access: 'full-access',
        customTitle: 'User-edited title',
        runnerTitle: 'Later generated title',
        pinnedAt: null,
        titleSource: 'CUSTOM',
        lastActivityAt: 1,
        createdAt: 1
      };
      const internals = connector as unknown as {
        externalSessionResumeService: {
          resume(session: NodeAgentSession, force?: boolean): Promise<NodeAgentSession | undefined>;
        };
        runtime: {
          setRunnerTitleFromNative(sessionId: string, title: string): NodeAgentSession;
        };
      };

      const resumed = await internals.externalSessionResumeService.resume(external, true);

      expect(resumed).toMatchObject({
        customTitle: 'User-edited title',
        runnerTitle: 'Later generated title',
        titleSource: 'CUSTOM'
      });
      expect(
        internals.runtime.setRunnerTitleFromNative(external.id, 'Another generated title')
      ).toMatchObject({
        customTitle: 'User-edited title',
        runnerTitle: 'Later generated title',
        titleSource: 'CUSTOM'
      });
    } finally {
      database.close();
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('preserves a user title when a metadata projection is promoted as managed', async () => {
    const workspacePath = await realpath(await mkdtemp(join(tmpdir(), 'mar-metadata-workspace-')));
    const database = new NodeDatabase(':memory:', 'node-mar-agent-metadata-title');
    try {
      const workspace = database.saveWorkspace({
        path: workspacePath,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: 'mar-agent-metadata-session',
        workspaceId: workspace.id,
        customTitle: 'Persisted user title',
        runnerTitle: 'Persisted generated title',
        model: 'coding',
        effort: 'high',
        access: 'full-access'
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false },
          marAgent: { available: true, version: '0.9.16' }
        }
      });
      const internals = connector as unknown as {
        nativeSessionProjectionService: {
          createMetadataProjection(sessionId: string): Promise<NodeAgentSession | undefined>;
        };
        externalSessionResumeService: {
          resume(session: NodeAgentSession, force?: boolean): Promise<NodeAgentSession | undefined>;
        };
      };
      const external: NodeAgentSession = {
        id: 'mar-agent-metadata-session',
        nodeId: 'node-mar-agent-metadata-title',
        workspaceId: workspace.id,
        runner: 'mar-agent',
        externalSessionId: 'mar-agent-metadata-session',
        nativeControl: 'EXTERNAL',
        channelToken: null,
        cwd: workspace.path,
        model: 'coding',
        effort: 'high',
        access: 'full-access',
        customTitle: 'Persisted user title',
        runnerTitle: 'Persisted generated title',
        pinnedAt: null,
        titleSource: 'CUSTOM',
        lastActivityAt: 1,
        createdAt: 1
      };

      const projected = await internals.nativeSessionProjectionService.createMetadataProjection(
        external.id
      );
      expect(projected).toMatchObject({
        model: 'coding',
        effort: 'high',
        access: 'full-access'
      });
      const resumed = await internals.externalSessionResumeService.resume(external, true);

      expect(resumed).toMatchObject({
        customTitle: 'Persisted user title',
        runnerTitle: 'Persisted generated title',
        titleSource: 'CUSTOM'
      });
    } finally {
      database.close();
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('reads the generated native title for managed-session synchronization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-title-home-'));
    try {
      const store = await JsonlSessionStore.open(home);
      const native = await store.createSession({ workspace: '/workspace' });
      await store.updateTitle(native.id, 'Generated project title');
      await store.close();
      const runner = new MarAgentRunner(home);

      await expect(
        runner.readManagedRunnerTitle(
          {
            id: native.id,
            runner: 'mar-agent',
            externalSessionId: native.id,
            cwd: '/workspace'
          } as NodeAgentSession,
          native.id
        )
      ).resolves.toBe('Generated project title');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns unknown when the persisted session catalog cannot be opened', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-invalid-home-'));
    const invalidHome = join(home, 'not-a-directory');
    try {
      await writeFile(invalidHome, 'file');
      const runner = new MarAgentRunner(invalidHome);
      runner.configureModels([
        {
          id: 'coding',
          name: 'Coding',
          protocol: 'OPENAI_RESPONSES',
          baseUrl: 'https://gateway.example.test',
          modelId: 'provider-coding',
          contextWindowTokens: 200000,
          maxOutputTokens: 16384,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: ['high'],
          hostedWebSearch: false,
          enabled: true,
          sortOrder: 0,
          apiKeyConfigured: true
        }
      ]);

      await expect(
        runner.readContextUsage({
          id: 'session',
          nodeId: 'node',
          workspaceId: 'workspace',
          runner: 'mar-agent',
          externalSessionId: 'session',
          nativeControl: 'EXTERNAL',
          channelToken: null,
          cwd: '/workspace',
          model: 'coding',
          effort: 'high',
          access: 'full-access',
          customTitle: null,
          runnerTitle: null,
          pinnedAt: null,
          titleSource: 'RUNNER',
          lastActivityAt: 0,
          createdAt: 0
        })
      ).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('excludes Compact usage and keeps context usage unknown when compaction retains a tail', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-usage-home-'));
    try {
      const store = await JsonlSessionStore.open(home);
      const native = await store.createSession({ workspace: '/workspace' });
      await store.append(native.id, {
        type: 'usage.updated',
        payload: {
          type: 'usage.updated',
          eventId: 'usage',
          sequence: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: native.id,
          executionId: 'execution',
          turnId: 'turn',
          inputTokens: 2500,
          contextInputTokens: 12500
        },
        executionId: 'execution',
        turnId: 'turn'
      });
      await store.append(native.id, {
        type: 'usage.updated',
        payload: {
          type: 'usage.updated',
          purpose: 'compact',
          eventId: 'compact-usage',
          sequence: 2,
          timestamp: '2026-01-01T00:00:00.500Z',
          sessionId: native.id,
          executionId: 'execution',
          turnId: 'turn',
          inputTokens: 75_000,
          contextInputTokens: 75_000
        },
        executionId: 'execution',
        turnId: 'turn'
      });
      await store.close();
      const runner = new MarAgentRunner(home);
      runner.configureModels([
        {
          id: 'coding',
          name: 'Coding',
          protocol: 'OPENAI_RESPONSES',
          baseUrl: 'https://gateway.example.test',
          modelId: 'provider-coding',
          contextWindowTokens: 200000,
          maxOutputTokens: 16384,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: ['high'],
          hostedWebSearch: false,
          enabled: true,
          sortOrder: 0,
          apiKeyConfigured: true
        }
      ]);
      const session = {
        id: native.id,
        nodeId: 'node',
        workspaceId: 'workspace',
        runner: 'mar-agent',
        externalSessionId: native.id,
        nativeControl: 'EXTERNAL',
        channelToken: null,
        cwd: '/workspace',
        model: 'coding',
        effort: 'high',
        access: 'full-access',
        customTitle: null,
        runnerTitle: null,
        pinnedAt: null,
        titleSource: 'RUNNER',
        lastActivityAt: 0,
        createdAt: 0
      } as const;

      await expect(runner.readContextUsage(session)).resolves.toEqual({
        model: 'provider-coding',
        usedTokens: 12500,
        maxTokens: 200000
      });

      const compacted = await JsonlSessionStore.open(home);
      await compacted.append(native.id, {
        type: 'context.compacted',
        payload: {
          type: 'context.compacted',
          compactionId: 'compact',
          eventId: 'compact',
          sequence: 3,
          timestamp: '2026-01-01T00:00:01.000Z',
          sessionId: native.id,
          executionId: 'execution',
          turnId: 'turn',
          retainedContext: false
        },
        executionId: 'execution',
        turnId: 'turn'
      });
      await compacted.append(native.id, {
        type: 'usage.updated',
        payload: {
          type: 'usage.updated',
          purpose: 'compact',
          eventId: 'compact-usage-after-install',
          sequence: 4,
          timestamp: '2026-01-01T00:00:02.000Z',
          sessionId: native.id,
          executionId: 'execution',
          turnId: 'turn',
          inputTokens: 75_000,
          contextInputTokens: 75_000
        },
        executionId: 'execution',
        turnId: 'turn'
      });
      await compacted.close();

      await expect(runner.readContextUsage(session)).resolves.toEqual({
        model: 'provider-coding',
        usedTokens: 0,
        maxTokens: 200000
      });

      const retained = await JsonlSessionStore.open(home);
      await retained.append(native.id, {
        type: 'context.compacted',
        payload: {
          type: 'context.compacted',
          compactionId: 'compact-with-tail',
          eventId: 'compact-with-tail',
          sequence: 5,
          timestamp: '2026-01-01T00:00:03.000Z',
          sessionId: native.id,
          executionId: 'execution',
          turnId: 'turn',
          retainedContext: true
        },
        executionId: 'execution',
        turnId: 'turn'
      });
      await retained.close();
      await expect(runner.readContextUsage(session)).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('publishes only enabled conversation model configurations with direct tool execution', () => {
    const runner = new MarAgentRunner();
    runner.configureModels([
      {
        id: 'coding',
        name: 'Coding',
        protocol: 'ANTHROPIC_MESSAGES',
        baseUrl: 'https://gateway.example.test',
        modelId: 'coding',
        contextWindowTokens: 200000,
        maxOutputTokens: 16384,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        hostedWebSearch: false,
        enabled: true,
        sortOrder: 0,
        apiKeyConfigured: true
      },
      {
        id: 'without-reasoning',
        name: 'Without reasoning',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://gateway.example.test',
        modelId: 'without-reasoning',
        contextWindowTokens: 128000,
        maxOutputTokens: 8192,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        defaultReasoningEffort: 'medium',
        hostedWebSearch: false,
        enabled: true,
        sortOrder: 1,
        apiKeyConfigured: true
      },
      {
        id: 'auxiliary',
        name: 'Auxiliary',
        conversationModel: false,
        protocol: 'ANTHROPIC_MESSAGES',
        baseUrl: 'https://gateway.example.test',
        modelId: 'auxiliary',
        contextWindowTokens: 200000,
        maxOutputTokens: 16384,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        defaultReasoningEffort: 'medium',
        hostedWebSearch: false,
        enabled: true,
        sortOrder: 2
      },
      {
        id: 'malformed',
        name: 'Malformed',
        protocol: 'OPENAI_RESPONSES'
      }
    ]);
    const capabilities = unavailableCapabilities();
    const profile = runner.profile(capabilities);
    expect(profile?.models.map((model) => model.id)).toEqual(['coding', 'without-reasoning']);
    expect(profile?.models[1]?.supportedEfforts).toEqual([]);
    expect(profile?.models.map((model) => model.defaultEffort)).toEqual(['high', 'medium']);
    expect(
      runner.supportsConfiguration({
        runner: 'mar-agent',
        model: 'without-reasoning',
        effort: '',
        access: 'full-access'
      })
    ).toBe(false);
    expect(
      runner.supportsConfiguration({
        runner: 'mar-agent',
        model: 'without-reasoning',
        effort: 'high',
        access: 'full-access'
      })
    ).toBe(false);
    expect(profile?.capabilities).toContain('turn.start');
    expect(profile?.capabilities).not.toContain('goal');
    expect(profile?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'goal',
          runner: 'mar-agent',
          label: '/goal',
          stateLabel: 'Goal',
          description: 'Enter persistent Goal mode.',
          inputHint: '/goal',
          source: 'MAR_RUNTIME',
          interaction: 'TOGGLE',
          available: true,
          reasonCode: null
        })
      ])
    );
    expect(profile?.accessOptions.map((access) => access.id)).toEqual(['auto', 'full-access']);
    expect(runner.defaultConfiguration()).toMatchObject({
      model: 'coding',
      effort: 'high',
      access: 'auto'
    });
    expect(
      runner.supportsConfiguration({
        runner: 'mar-agent',
        model: 'coding',
        effort: 'high',
        access: 'auto'
      })
    ).toBe(true);
    expect(
      profile?.accessOptions.find((access) => access.id === 'full-access')?.description
    ).toContain('without per-call Agent approval');
    expect(profile?.capabilities).not.toContain('approval');
    expect(() =>
      runner.presentSession(
        {
          id: 'bootstrap',
          nodeId: 'node',
          workspaceId: 'workspace',
          runner: 'mar-agent',
          externalSessionId: null,
          nativeControl: 'MAR_MANAGED',
          channelToken: null,
          cwd: '/workspace',
          model: 'coding',
          effort: 'high',
          access: 'full-access',
          customTitle: null,
          runnerTitle: null,
          pinnedAt: null,
          titleSource: 'AUTO',
          lastActivityAt: 0,
          createdAt: 0
        },
        capabilities,
        { managedActive: false, commandStates: [] }
      )
    ).not.toThrow();
    expect(
      runner.presentSession(
        {
          id: 'bootstrap',
          nodeId: 'node',
          workspaceId: 'workspace',
          runner: 'mar-agent',
          externalSessionId: null,
          nativeControl: 'MAR_MANAGED',
          channelToken: null,
          cwd: '/workspace',
          model: 'coding',
          effort: 'high',
          access: 'full-access',
          customTitle: null,
          runnerTitle: null,
          pinnedAt: null,
          titleSource: 'AUTO',
          lastActivityAt: 0,
          createdAt: 0
        },
        capabilities,
        { managedActive: false, commandStates: [] }
      ).runtime.capabilities
    ).toEqual(expect.arrayContaining(['turn.start', 'user-input.respond']));
  });

  it('keeps models with unknown catalog hints but rejects sensitive or invalid model entries', () => {
    const runner = new MarAgentRunner();
    const model = {
      id: 'coding',
      name: 'Coding',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://gateway.example.test',
      modelId: 'coding',
      contextWindowTokens: 200000,
      maxOutputTokens: 16384,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      hostedWebSearch: false,
      enabled: true,
      sortOrder: 0
    };
    runner.configureModels([
      { ...model, futureDisplayHint: 'preview' },
      { ...model, id: 'invalid', fastMode: 'yes' },
      { ...model, id: 'sensitive', credential: { type: 'INLINE_API_KEY', value: 'secret' } }
    ]);

    expect(runner.profile(unavailableCapabilities())?.models.map((entry) => entry.id)).toEqual([
      'coding'
    ]);
  });

  it('normalizes unsupported legacy metadata and rejects unsupported access for new sessions', async () => {
    const workspacePath = await realpath(await mkdtemp(join(tmpdir(), 'mar-access-workspace-')));
    const runner = new MarAgentRunner();
    runner.configureModels([
      {
        id: 'coding',
        name: 'Coding',
        protocol: 'ANTHROPIC_MESSAGES',
        baseUrl: 'https://gateway.example.test',
        modelId: 'coding',
        contextWindowTokens: 200000,
        maxOutputTokens: 16384,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        hostedWebSearch: false,
        enabled: true,
        sortOrder: 0,
        apiKeyConfigured: true
      }
    ]);
    const updateAgentSessionConfiguration = vi.fn((input) => input);
    const session = {
      id: 'session',
      workspaceId: 'workspace',
      runner: 'mar-agent',
      model: 'coding',
      effort: 'high',
      access: 'on-request'
    } as NodeAgentSession;
    const projection = new NativeSessionProjectionService({
      database: () =>
        ({
          getWorkspace: () => ({ id: 'workspace', path: workspacePath }),
          getRunnerDefaults: () => []
        }) as never,
      nodeId: () => 'node',
      runtime: { updateAgentSessionConfiguration } as never,
      runners: { require: () => runner } as never,
      capabilities: () => unavailableCapabilities(),
      state: {} as never,
      commands: {} as never,
      releaseResumeState: vi.fn(),
      present: (value) => value as never
    });

    expect(projection.resumedConfiguration(session).access).toBe('full-access');
    projection.ensureResumedConfiguration(session);
    expect(updateAgentSessionConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session', access: 'full-access' })
    );

    const lifecycle = new SessionLifecycleService({
      database: () =>
        ({
          getWorkspace: () => ({ id: 'workspace', path: workspacePath }),
          getRunnerDefaults: () => [],
          saveRunnerDefaults: vi.fn()
        }) as never,
      runtime: { createAgentSession: vi.fn() } as never,
      runners: { product: () => runner } as never,
      projection,
      identity: { markBootstrap: vi.fn() } as never,
      present: (value) => value,
      emitSession: vi.fn(),
      invalidateWorkspaceSessions: vi.fn(),
      execute: vi.fn(),
      interceptedSessionId: () => undefined
    });

    for (const access of ['on-request']) {
      await expect(
        lifecycle.operations()['session.create']?.({
          workspaceId: 'workspace',
          runner: 'mar-agent',
          cwd: workspacePath,
          model: 'coding',
          effort: 'high',
          access
        })
      ).rejects.toThrow('SESSION_INVALID');
    }
    await rm(workspacePath, { recursive: true, force: true });
  });

  it.each(['auto', 'full-access'])(
    'preserves and round-trips MAR Agent %s defaults',
    async (access) => {
      const database = new NodeDatabase(':memory:', 'node-mar-agent-defaults');
      try {
        const configuration = {
          runner: 'mar-agent' as const,
          model: 'coding',
          effort: 'medium',
          access
        };
        const other = { runner: 'codex' as const, model: 'codex', effort: '', access: 'read-only' };
        database.saveRunnerDefaults(other);
        database.saveRunnerDefaults(configuration);
        const saveRunnerDefaults = vi.spyOn(database, 'saveRunnerDefaults');
        const service = new RunnerService(
          () => database,
          unavailableCapabilities,
          {
            optional: (name: string) => (name === 'mar-agent' ? new MarAgentRunner() : undefined),
            profiles: () => [],
            refreshProfiles: vi.fn(async () => [])
          } as never,
          {} as never
        );

        for (const waitForRefresh of [true, false]) {
          await expect(
            service.operations()['runner.profiles.list']?.({ waitForRefresh })
          ).resolves.toMatchObject({ defaults: [other, configuration] });
          expect(database.getRunnerDefaults()).toEqual([other, configuration]);
        }
        expect(saveRunnerDefaults).not.toHaveBeenCalled();

        const updated = { ...configuration, model: 'updated-model', effort: 'high' };
        expect(service.operations()['runner.defaults.save']?.(updated)).toEqual({
          defaults: updated
        });
        await expect(service.operations()['runner.profiles.list']?.({})).resolves.toMatchObject({
          defaults: [other, updated]
        });
        expect(database.getRunnerDefaults()).toEqual([other, updated]);
        expect(saveRunnerDefaults).toHaveBeenCalledExactlyOnceWith(updated);
      } finally {
        database.close();
      }
    }
  );

  it('normalizes saved defaults and rejects writing unsupported MAR Agent access', async () => {
    const runner = new MarAgentRunner();
    const saved = {
      runner: 'mar-agent' as const,
      model: 'coding',
      effort: 'high',
      access: 'on-request'
    };
    const saveRunnerDefaults = vi.fn((configuration) => [configuration]);
    const service = new RunnerService(
      () =>
        ({
          getRunnerDefaults: () => [saved],
          saveRunnerDefaults
        }) as never,
      unavailableCapabilities,
      {
        optional: () => runner,
        profiles: () => [],
        refreshProfiles: vi.fn(async () => [])
      } as never,
      {} as never
    );

    await expect(service.operations()['runner.profiles.list']?.({})).resolves.toMatchObject({
      defaults: [{ runner: 'mar-agent', access: 'full-access' }]
    });
    expect(saveRunnerDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ runner: 'mar-agent', access: 'full-access' })
    );
    for (const access of ['on-request', 'read-only', 'unknown', '']) {
      expect(() => service.operations()['runner.defaults.save']?.({ ...saved, access })).toThrow(
        'RUNNER_DEFAULT_INVALID'
      );
    }
    expect(saveRunnerDefaults).toHaveBeenCalledTimes(1);
  });

  it('returns the cached Runner Profiles without waiting for the background refresh', async () => {
    const refreshProfiles = vi.fn(() => new Promise<never>(() => undefined));
    const profiles = vi.fn(() => [
      {
        runner: 'mar-agent',
        models: [],
        accessOptions: [],
        commands: [],
        capabilities: []
      }
    ]);
    const service = new RunnerService(
      () =>
        ({
          getRunnerDefaults: () => []
        }) as never,
      unavailableCapabilities,
      {
        optional: () => undefined,
        profiles,
        refreshProfiles
      } as never,
      {} as never
    );

    await expect(
      service.operations()['runner.profiles.list']?.({ waitForRefresh: false })
    ).resolves.toMatchObject({
      profiles: [expect.objectContaining({ runner: 'mar-agent' })]
    });
    expect(refreshProfiles).toHaveBeenCalledOnce();
    expect(profiles).toHaveBeenCalledOnce();
  });

  it('advertises Rewind and Rollback for a persisted MAR Agent session', () => {
    const runner = new MarAgentRunner();
    const capabilities = {
      ...unavailableCapabilities(),
      marAgent: { available: true, version: '0.9.23' }
    };

    expect(
      runner.presentSession(
        {
          id: 'native-session',
          nodeId: 'node',
          workspaceId: 'workspace',
          runner: 'mar-agent',
          externalSessionId: 'native-session',
          nativeControl: 'MAR_MANAGED',
          channelToken: null,
          cwd: '/workspace',
          model: 'coding',
          effort: 'high',
          access: 'full-access',
          customTitle: null,
          runnerTitle: 'Native',
          pinnedAt: null,
          titleSource: 'RUNNER',
          lastActivityAt: 0,
          createdAt: 0
        },
        capabilities,
        { managedActive: false, commandStates: [] }
      ).runtime.capabilities
    ).toEqual(expect.arrayContaining(['session.rewind', 'session.rollback']));
  });

  it('releases warm resources before rolling back persisted history in place', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-rollback-home-'));
    try {
      const store = await JsonlSessionStore.open(home);
      const native = await store.createSession({ title: 'Rollback', workspace: '/workspace' });
      await store.append(native.id, {
        type: 'turn.user',
        payload: { prompt: 'keep' },
        executionId: 'execution-1',
        turnId: 'turn-1'
      });
      await store.append(native.id, {
        type: 'message.completed',
        payload: {
          type: 'message.completed',
          eventId: 'message-1',
          sequence: 1,
          timestamp: '2026-09-09T00:00:00.000Z',
          sessionId: native.id,
          executionId: 'execution-1',
          turnId: 'turn-1',
          phase: 'final_answer',
          text: 'kept'
        },
        executionId: 'execution-1',
        turnId: 'turn-1'
      });
      await store.append(native.id, {
        type: 'turn.user',
        payload: { prompt: 'remove' },
        executionId: 'execution-2',
        turnId: 'turn-2'
      });
      await store.close();
      const runner = new MarAgentRunner(home);
      const releaseSessionResources = vi.fn(async () => undefined);
      runner.setSessionResourceReleaser(releaseSessionResources);
      const session = {
        id: native.id,
        nodeId: 'node',
        workspaceId: 'workspace',
        runner: 'mar-agent',
        externalSessionId: native.id,
        nativeControl: 'EXTERNAL',
        channelToken: null,
        cwd: '/workspace',
        model: null,
        effort: null,
        access: null,
        customTitle: null,
        runnerTitle: 'Rollback',
        pinnedAt: null,
        titleSource: 'RUNNER',
        lastActivityAt: 0,
        createdAt: 0
      } as const;

      await expect(runner.rollbackNative(session, 'turn-1')).resolves.toEqual(expect.any(Number));
      expect(releaseSessionResources).toHaveBeenCalledWith(native.id);
      await expect(runner.readOfficialConversation(session, {})).resolves.toMatchObject({
        turns: [
          {
            id: 'turn-1',
            items: expect.arrayContaining([expect.objectContaining({ kind: 'user_message' })])
          }
        ]
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('enters Goal without changing the fixed MAR Agent access configuration', async () => {
    const database = new NodeDatabase(':memory:', 'node-mar-agent-goal');
    const workspace = database.saveWorkspace({
      path: '/workspace/mar-agent-goal',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        marAgent: { available: true, version: '0.9.20' }
      }
    });
    try {
      const session = (
        connector as unknown as {
          runtime: {
            createAgentSession(input: Record<string, unknown>): { id: string };
          };
        }
      ).runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'mar-agent',
        cwd: workspace.path,
        nativeControl: 'MAR_MANAGED',
        access: 'full-access'
      });

      const opened = (await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal'
      })) as {
        goalAccessChanged: boolean;
        session: {
          runner: string;
          access: string;
          commandStates: readonly { commandId: string; active: boolean; goal?: unknown }[];
        };
      };
      expect(opened).toMatchObject({
        goalAccessChanged: false,
        session: {
          runner: 'mar-agent',
          access: 'full-access',
          commandStates: [expect.objectContaining({ commandId: 'goal', active: true })]
        }
      });
      expect(
        opened.session.commandStates.find((state) => state.commandId === 'goal')?.goal
      ).toBeUndefined();
    } finally {
      connector.stop();
    }
  });

  it('discovers persisted native sessions after restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-home-'));
    try {
      const store = await JsonlSessionStore.open(home);
      const native = await store.createSession({ title: 'Persisted', workspace: '/workspace' });
      await store.append(native.id, {
        type: 'execution.header',
        payload: {
          modelId: 'shared-model',
          modelName: 'Shared Model',
          reasoningEffort: 'high'
        },
        executionId: 'execution',
        turnId: 'turn'
      });
      await store.append(native.id, {
        type: 'turn.user',
        payload: { prompt: 'hello', clientMessageId: 'client-message' },
        executionId: 'execution',
        turnId: 'turn'
      });
      await store.append(native.id, {
        type: 'message.completed',
        payload: {
          type: 'message.completed',
          eventId: 'message',
          sequence: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: native.id,
          executionId: 'execution',
          turnId: 'turn',
          phase: 'final_answer',
          text: 'world'
        },
        executionId: 'execution',
        turnId: 'turn'
      });
      await store.close();
      const workspace = {
        id: 'workspace',
        path: '/workspace',
        kind: 'DIRECTORY' as const,
        gitSummary: null
      };
      const runner = new MarAgentRunner(home);
      const releaseSessionResources = vi.fn(async () => undefined);
      runner.setSessionResourceReleaser(releaseSessionResources);
      const sessions = await runner.discoverSessions(
        {
          workspaces: [workspace],
          createProjection: (input) => ({
            id: input.externalSessionId,
            nodeId: 'node',
            workspaceId: input.workspace.id,
            runner: input.runner,
            externalSessionId: input.externalSessionId,
            nativeControl: 'EXTERNAL',
            channelToken: null,
            cwd: input.cwd,
            model: null,
            effort: null,
            access: null,
            customTitle: null,
            runnerTitle: input.title ?? null,
            pinnedAt: null,
            titleSource: 'RUNNER',
            lastActivityAt: input.lastActivityAt ?? 0,
            createdAt: 0
          })
        },
        workspace
      );
      expect(sessions).toEqual([
        expect.objectContaining({
          externalSessionId: native.id,
          runnerTitle: 'Persisted',
          model: 'shared-model',
          effort: 'high'
        })
      ]);
      await expect(runner.readOfficialConversation(sessions[0]!, {})).resolves.toMatchObject({
        turns: [
          {
            id: 'turn',
            rewind: { before: null, after: 'turn' },
            items: [
              {
                kind: 'user_message',
                payload: { text: 'hello', clientMessageId: 'client-message' }
              },
              { kind: 'assistant_message', payload: { text: 'world' } }
            ]
          }
        ]
      });
      const writer = await JsonlSessionStore.open(home);
      const release = await writer.acquireSessionLease(native.id);
      await expect(
        runner.forkNative(sessions[0]!, 'turn', 'Persisted (Busy Copy)')
      ).rejects.toMatchObject({ message: 'MAR_AGENT_SESSION_LOCKED' });
      await release();
      await writer.close();
      const forkedId = await runner.forkNative(sessions[0]!, 'turn', 'Persisted (Copy 1)');
      const forkedSession = {
        ...sessions[0]!,
        id: forkedId,
        externalSessionId: forkedId,
        runnerTitle: 'Persisted (Copy 1)'
      };
      await expect(runner.readOfficialConversation(forkedSession, {})).resolves.toMatchObject({
        turns: [{ id: 'turn', rewind: { before: null, after: 'turn' } }]
      });
      expect(await runner.removeNative(sessions[0]!, native.id)).toBe(true);
      expect(await runner.removeNative(forkedSession, forkedId)).toBe(true);
      expect(releaseSessionResources).toHaveBeenCalledWith(native.id);
      await expect(
        runner.discoverSessions(
          {
            workspaces: [workspace],
            createProjection: (input) => ({
              ...sessions[0]!,
              id: input.externalSessionId,
              externalSessionId: input.externalSessionId
            })
          },
          workspace
        )
      ).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('cleans a stale MAR Agent catalog entry without reporting a native deletion', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-stale-session-home-'));
    try {
      const store = await JsonlSessionStore.open(home);
      const native = await store.createSession({ title: 'Stale', workspace: '/workspace' });
      await store.close();
      await rm(join(home, '.mar', 'agent', 'sessions', native.id), {
        recursive: true,
        force: true
      });
      const runner = new MarAgentRunner(home);
      const session = {
        id: native.id,
        runner: 'mar-agent',
        externalSessionId: native.id
      } as NodeAgentSession;

      await expect(runner.removeNative(session, native.id)).resolves.toBe('MISSING');
      await expect(
        runner.discoverSessions(
          {
            workspaces: [
              { id: 'workspace', path: '/workspace', kind: 'DIRECTORY', gitSummary: null }
            ],
            createProjection: (input) =>
              ({
                id: input.externalSessionId,
                externalSessionId: input.externalSessionId
              }) as NodeAgentSession
          },
          { id: 'workspace', path: '/workspace', kind: 'DIRECTORY', gitSummary: null }
        )
      ).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('pages native history without skipping turns trimmed from the latest page', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-runner-history-home-'));
    try {
      const store = await JsonlSessionStore.open(home);
      const native = await store.createSession({ title: 'History', workspace: '/workspace' });
      for (let index = 1; index <= 12; index++) {
        const executionId = `execution-${index}`;
        const turnId = `turn-${index}`;
        await store.append(native.id, {
          type: 'turn.user',
          payload: { prompt: `question-${index}` },
          executionId,
          turnId
        });
        await store.append(native.id, {
          type: 'message.completed',
          payload: {
            type: 'message.completed',
            eventId: `message-${index}`,
            sequence: index,
            timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
            sessionId: native.id,
            executionId,
            turnId,
            phase: 'final_answer',
            text: `answer-${index}`
          },
          executionId,
          turnId
        });
      }
      await store.close();
      const session = {
        id: native.id,
        nodeId: 'node',
        workspaceId: 'workspace',
        runner: 'mar-agent' as const,
        externalSessionId: native.id,
        nativeControl: 'EXTERNAL' as const,
        channelToken: null,
        cwd: '/workspace',
        model: null,
        effort: null,
        access: null,
        customTitle: null,
        runnerTitle: 'History',
        pinnedAt: null,
        titleSource: 'RUNNER' as const,
        lastActivityAt: 0,
        createdAt: 0
      };
      const runner = new MarAgentRunner(home);
      const latest = await runner.readOfficialConversation(session, { limit: 10 });
      expect(latest?.turns.map((turn) => turn.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `turn-${index + 3}`)
      );
      expect(latest?.turns[0]?.rewind).toEqual({ before: 'turn-2', after: 'turn-3' });
      const nextCursor = latest?.nextCursor;
      expect(nextCursor).toEqual(expect.any(String));
      if (nextCursor === null || nextCursor === undefined)
        throw new Error('Expected history cursor.');
      const older = await runner.readOfficialConversation(session, {
        cursor: nextCursor,
        limit: 10
      });
      expect(older?.turns.map((turn) => turn.id)).toEqual(['turn-1', 'turn-2']);
      expect(older?.turns.map((turn) => turn.rewind)).toEqual([
        { before: null, after: 'turn-1' },
        { before: 'turn-1', after: 'turn-2' }
      ]);
      expect(older?.nextCursor).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function operation(
  connector: NodeConnector,
  operationName: string,
  data: unknown
): Promise<unknown> {
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(operationName, data);
}
