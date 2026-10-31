import { describe, expect, it } from 'vitest';
import { NodeRuntimeState } from '../../mar-node/src/runtime-state.js';
import { runConversationItemId } from '../../mar-node/src/session/runtime/conversation-projection.js';
import type {
  NodeConversationItem,
  NodeConversationTurn
} from '../../mar-node/src/runtime-model.js';
import { marctlSessionProgress } from '../../mar-node/src/service/session-recent-activity.js';
import { projectWorkbenchPayload } from '../../mar-node/src/service/workbench-event-projection.js';
import { projectConversationWorkProcesses } from '../../mar-node/src/session/runtime/work-process.js';
import { conversationSegments } from '../../mar-node/src/service/conversation-segment-service.js';
import { CodexManagedRunController } from '../../mar-node/src/runner/codex/managed-run-controller.js';
import {
  codexOfficialItem,
  codexTranscriptSourceItemId
} from '../../mar-node/src/runner/codex/conversation-parser.js';
import type { PublicConversationItem } from '../../mar-node/src/native-transcript-model.js';
import { conversationWorkProcessBlocks } from '../../packages/web-core/src/util/conversation-work-process.js';

const sessionId = 'session-1';
const runId = 'run-1';

function item(
  id: string,
  kind: string,
  options: {
    readonly runId?: string | null;
    readonly parentItemId?: string | null;
    readonly status?: string;
    readonly payload?: unknown;
  } = {}
): NodeConversationItem {
  return {
    id,
    sessionId,
    turnId: 'turn-1',
    runId: options.runId === undefined ? runId : options.runId,
    parentItemId: options.parentItemId ?? null,
    sourceSequence: null,
    revision: 0,
    kind,
    status: options.status ?? 'COMPLETED',
    payload: options.payload ?? {},
    startedAt: 1,
    completedAt: 1
  };
}

function turn(
  items: readonly NodeConversationItem[],
  options: Partial<NodeConversationTurn> = {}
): NodeConversationTurn {
  return {
    id: 'turn-1',
    sessionId,
    runId,
    userItemId: 'user-1',
    status: 'RUNNING',
    model: null,
    effort: null,
    access: null,
    items,
    startedAt: 1,
    completedAt: null,
    ...options
  };
}

function byId(value: NodeConversationTurn, id: string): NodeConversationItem {
  const found = value.items.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing conversation item ${id}`);
  return found;
}

describe('Conversation work process projection', () => {
  it('splits at anchored compaction throughout its lifecycle in live and historical projections', () => {
    const before = item('before', 'reasoning', {
      payload: { representation: 'summary', sections: [{ text: 'Before compact' }] }
    });
    const after = item('after', 'reasoning', {
      status: 'IN_PROGRESS',
      payload: { representation: 'summary', sections: [{ text: 'After compact' }] }
    });
    let previousGroups: unknown;
    for (const [mode, status] of [
      ['BACKGROUND', 'IN_PROGRESS'],
      ['BLOCKING', 'IN_PROGRESS'],
      ['BACKGROUND', 'COMPLETED'],
      ['BACKGROUND', 'FAILED'],
      ['BACKGROUND', 'CANCELLED']
    ] as const) {
      const compact = item('compact', 'context_compaction', {
        status,
        payload: { mode, anchorItemId: before.id }
      });
      const projected = projectConversationWorkProcesses(turn([before, after, compact]));
      expect(projected.items.map(({ id }) => id)).toEqual(['before', 'compact', 'after']);
      expect(byId(projected, 'compact').processGroup).toBeUndefined();
      const beforeGroup = byId(projected, 'before').processGroup;
      const afterGroup = byId(projected, 'after').processGroup;
      expect(beforeGroup).toMatchObject({ isStart: true });
      expect(afterGroup).toMatchObject({ isStart: true });
      expect(beforeGroup?.id).not.toBe(afterGroup?.id);
      const groups = [beforeGroup, afterGroup];
      if (previousGroups !== undefined) expect(groups).toEqual(previousGroups);
      previousGroups = groups;
      expect(projectConversationWorkProcesses(projected)).toBe(projected);

      const history = projectConversationWorkProcesses(
        turn(
          [item('user-1', 'user_message'), before, after, compact].map((entry) => ({
            ...entry,
            runId: null
          })),
          { runId: null }
        )
      );
      expect([byId(history, 'before').processGroup, byId(history, 'after').processGroup]).toEqual(
        groups
      );

      const blocks = conversationWorkProcessBlocks(conversationSegments(projected), [
        { id: runId, status: 'RUNNING' }
      ]);
      expect(blocks.map(({ groupId }) => groupId)).toEqual([
        beforeGroup?.id,
        undefined,
        afterGroup?.id
      ]);
      expect(blocks[0]).toMatchObject({ sealed: true, active: false });
      expect(blocks[2]).toMatchObject({ sealed: false, active: true });
    }
  });

  it('keeps reasoning and tools together until visible Agent prose starts the next process', () => {
    const initial = turn([
      item('user-1', 'user_message', { payload: { text: 'Inspect this.' } }),
      item(`${runId}:thought-1`, 'reasoning', {
        payload: { sections: [{ index: 0, text: 'Check the source.' }] }
      }),
      item(`${runId}:tool-x`, 'tool_call', {
        status: 'IN_PROGRESS',
        payload: { name: 'read' }
      }),
      item(`${runId}:thought-2`, 'reasoning', {
        payload: { sections: [{ index: 0, text: 'The cause is clear.' }] }
      }),
      item(`${runId}:answer-a`, 'assistant_message', {
        payload: { text: 'I found the cause.' }
      }),
      item(`${runId}:tool-y`, 'tool_call', {
        status: 'IN_PROGRESS',
        payload: { name: 'apply_patch' }
      })
    ]);
    const projected = projectConversationWorkProcesses(initial);
    const firstGroup = byId(projected, `${runId}:thought-1`).processGroup;
    const secondGroup = byId(projected, `${runId}:tool-y`).processGroup;

    expect(firstGroup).toMatchObject({ isStart: true });
    expect(byId(projected, `${runId}:tool-x`).processGroup?.id).toBe(firstGroup?.id);
    expect(byId(projected, `${runId}:thought-2`).processGroup?.id).toBe(firstGroup?.id);
    expect(byId(projected, `${runId}:answer-a`).processGroup).toBeUndefined();
    expect(secondGroup).toMatchObject({ isStart: true });
    expect(secondGroup?.id).not.toBe(firstGroup?.id);

    const withLateToolResult = projectConversationWorkProcesses({
      ...projected,
      items: projected.items.map((candidate) =>
        candidate.id === `${runId}:tool-x`
          ? {
              ...candidate,
              revision: candidate.revision + 1,
              status: 'COMPLETED',
              payload: { name: 'read', outputSummary: 'The source was read.' }
            }
          : candidate
      )
    });
    expect(byId(withLateToolResult, `${runId}:tool-x`).processGroup?.id).toBe(firstGroup?.id);
    expect(byId(withLateToolResult, `${runId}:tool-y`).processGroup?.id).toBe(secondGroup?.id);
  });

  it('keeps a parent approval independent while assigning its derived file change to the parent process', () => {
    const projected = projectConversationWorkProcesses(
      turn([
        item('user-1', 'user_message'),
        item(`${runId}:tool-parent`, 'tool_call', {
          status: 'IN_PROGRESS',
          payload: { name: 'edit' }
        }),
        item(`${runId}:approval-1`, 'approval_request', {
          parentItemId: `${runId}:tool-parent`,
          status: 'PENDING',
          payload: { approvalId: 'approval-1' }
        }),
        item(`${runId}:file-1`, 'file_change', {
          parentItemId: `${runId}:tool-parent`,
          payload: { files: [{ path: 'src/example.ts' }] }
        }),
        item(`${runId}:tool-next`, 'tool_call', {
          status: 'IN_PROGRESS',
          payload: { name: 'test' }
        })
      ])
    );
    const parentGroup = byId(projected, `${runId}:tool-parent`).processGroup;
    expect(parentGroup).toMatchObject({ isStart: true });
    expect(byId(projected, `${runId}:approval-1`).processGroup).toBeUndefined();
    expect(byId(projected, `${runId}:file-1`).processGroup?.id).toBe(parentGroup?.id);
    expect(byId(projected, `${runId}:tool-next`).processGroup).toMatchObject({ isStart: true });
    expect(byId(projected, `${runId}:tool-next`).processGroup?.id).not.toBe(parentGroup?.id);
  });

  it('does not let empty prose or reasoning create or cut a process', () => {
    const projected = projectConversationWorkProcesses(
      turn([
        item('user-1', 'user_message'),
        item(`${runId}:empty-answer-before`, 'assistant_message', { payload: { text: ' \n ' } }),
        item(`${runId}:empty-reasoning-before`, 'reasoning', {
          payload: { sections: [{ index: 0, text: '\t ' }] }
        }),
        item(`${runId}:tool-first`, 'tool_call', { payload: { name: 'read' } }),
        item(`${runId}:empty-answer-after`, 'assistant_message', { payload: { text: '' } }),
        item(`${runId}:empty-reasoning-after`, 'reasoning', {
          payload: { sections: [{ index: 0, text: '' }] }
        }),
        item(`${runId}:tool-second`, 'command_execution', { payload: { command: 'test' } })
      ])
    );
    const group = byId(projected, `${runId}:tool-first`).processGroup;
    expect(group).toMatchObject({ isStart: true });
    expect(byId(projected, `${runId}:empty-answer-before`).processGroup).toBeUndefined();
    expect(byId(projected, `${runId}:empty-reasoning-before`).processGroup).toBeUndefined();
    expect(byId(projected, `${runId}:empty-answer-after`).processGroup).toBeUndefined();
    expect(byId(projected, `${runId}:empty-reasoning-after`).processGroup).toBeUndefined();
    expect(byId(projected, `${runId}:tool-second`).processGroup?.id).toBe(group?.id);
  });

  it('leaves an unknown truncated prefix flat and starts grouping only after a known prose boundary', () => {
    const projected = projectConversationWorkProcesses(
      turn(
        [
          item('prefix-unknown', 'unknown', {
            runId: null,
            payload: { summary: 'Unavailable prior record.' }
          }),
          item('prefix-tool', 'tool_call', { runId: null, payload: { name: 'read' } }),
          item('native-answer', 'assistant_message', {
            runId: null,
            payload: { text: 'Continuing from the available history.' }
          }),
          item('native-tool', 'tool_call', { runId: null, payload: { name: 'write' } })
        ],
        { runId: null, userItemId: null }
      )
    );

    expect(byId(projected, 'prefix-unknown').processGroup).toBeUndefined();
    expect(byId(projected, 'prefix-tool').processGroup).toBeUndefined();
    expect(byId(projected, 'native-answer').processGroup).toBeUndefined();
    expect(byId(projected, 'native-tool').processGroup).toMatchObject({ isStart: true });
  });

  it('uses the same identity for Runtime-prefixed and history items across pages', () => {
    const history = projectConversationWorkProcesses(
      turn(
        [
          item('user-1', 'user_message', { runId: null }),
          item('native-reasoning', 'reasoning', {
            runId: null,
            payload: { sections: [{ index: 0, text: 'Inspect.' }] }
          }),
          item('native-tool-1', 'tool_call', { runId: null, payload: { name: 'read' } }),
          item('native-tool-2', 'tool_call', { runId: null, payload: { name: 'search' } })
        ],
        { runId: null }
      )
    );
    const runtime = projectConversationWorkProcesses(
      turn([
        item('user-1', 'user_message'),
        item(`${runId}:native-reasoning`, 'reasoning', {
          payload: { sections: [{ index: 0, text: 'Inspect.' }] }
        }),
        item(`${runId}:native-tool-1`, 'tool_call', { payload: { name: 'read' } }),
        item(`${runId}:native-tool-2`, 'tool_call', { payload: { name: 'search' } })
      ])
    );
    const historyGroup = byId(history, 'native-reasoning').processGroup;
    expect(historyGroup).toMatchObject({ isStart: true });
    expect(byId(runtime, `${runId}:native-reasoning`).processGroup?.id).toBe(historyGroup?.id);

    const firstPage = history.items.slice(0, 2);
    const nextPage = history.items.slice(2);
    expect(firstPage.at(-1)?.processGroup?.id).toBe(historyGroup?.id);
    expect(nextPage[0]?.processGroup?.id).toBe(historyGroup?.id);
    expect(projectConversationWorkProcesses(history)).toBe(history);
  });

  it('preserves Codex group identity from live callbacks to official history and scopes reused item IDs by native Turn', () => {
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      (id) => ({ id, path: '/workspace', kind: 'DIRECTORY', gitSummary: null })
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      cwd: '/workspace'
    });
    const { run } = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'codex-process',
      content: 'Inspect.'
    });
    const execution = runtime.createExecution(run.id);
    let sequence = 0;
    const controller = new CodexManagedRunController(
      {
        execution: {
          runs: new Map([
            [execution.id, { sessionId: session.id, threadId: 'thread', turnId: 'native-turn' }]
          ])
        }
      } as never,
      {
        session: () => undefined,
        appendImages: () => [],
        emitItem: (id: string, payload: PublicConversationItem) =>
          runtime.appendRunEvent({
            runId: id,
            sequence: ++sequence,
            eventType: 'conversation.item',
            payload
          })
      } as never
    );
    const native = { id: 'item-0', type: 'reasoning', summary: ['Inspect the project.'] };
    controller.handleNotification({
      method: 'item/completed',
      params: { threadId: 'thread', turnId: 'native-turn', item: native }
    });
    const live = runtime.conversationTurnForRun(run.id)!;
    const liveGroup = live.items.find((entry) => entry.kind === 'reasoning')!.processGroup;
    const historical = (nativeTurnId: string) =>
      projectConversationWorkProcesses({
        ...live,
        runId: null,
        items: [
          live.items[0]!,
          codexOfficialItem(session as never, nativeTurnId, native, 0, 1, 1, 2)!
        ]
      });
    expect(liveGroup).toBeDefined();
    expect(
      codexTranscriptSourceItemId(
        { type: 'response_item', payload: { id: 'item-0', type: 'reasoning' } },
        'native-turn'
      )
    ).toBe(historical('native-turn').items[1]?.sourceItemId);
    expect(historical('native-turn').items[1]?.processGroup).toEqual(liveGroup);
    expect(historical('another-turn').items[1]?.processGroup?.id).not.toBe(liveGroup?.id);
    const segments = conversationSegments(historical('native-turn'));
    expect(
      segments.flatMap((segment) => segment.items).some((entry) => 'sourceItemId' in entry)
    ).toBe(false);
  });

  it('corrects process membership when a completed message supplies the first visible prose', () => {
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      (id) => ({ id, path: '/workspace', kind: 'DIRECTORY', gitSummary: null })
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      cwd: '/workspace'
    });
    const { run } = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'completion-boundary',
      content: 'Inspect.'
    });
    const execution = runtime.createExecution(run.id);
    let sequence = 0;
    const append = (itemId: string, kind: string, payload: unknown) =>
      runtime.appendRunEvent({
        runId: execution.id,
        sequence: ++sequence,
        eventType: 'conversation.item',
        payload: { itemId, kind, status: 'COMPLETED', payload }
      });
    append('tool-before', 'tool_call', { toolName: 'read' });
    append('message', 'assistant_message', { text: ' ' });
    append('tool-after', 'tool_call', { toolName: 'read' });
    const groups = () =>
      runtime
        .conversationTurnForRun(run.id)!
        .items.filter((entry) => entry.kind === 'tool_call')
        .map((entry) => entry.processGroup?.id);
    expect(groups()[0]).toBeDefined();
    expect(groups()[0]).toBe(groups()[1]);
    append('message', 'assistant_message', { text: 'Now verify the result.' });
    expect(groups()[1]).toBeDefined();
    expect(groups()[0]).not.toBe(groups()[1]);
  });

  it('stores the process on the Runtime item and carries it into the Workbench item projection', () => {
    let now = 1;
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      (id) => ({ id, path: '/workspace', kind: 'DIRECTORY', gitSummary: null }),
      () => now++
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      cwd: '/workspace'
    });
    const { run } = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'client-message-1',
      content: 'Inspect the source.'
    });
    const execution = runtime.createExecution(run.id);
    const payload = {
      itemId: 'reasoning-1',
      kind: 'reasoning',
      status: 'COMPLETED',
      payload: { representation: 'summary', sections: [{ index: 0, text: 'Inspect.' }] }
    };
    runtime.appendRunEvent({
      runId: execution.id,
      sequence: 1,
      eventType: 'conversation.item',
      payload
    });

    const projectedTurn = runtime.conversationTurnForRun(run.id)!;
    const runtimeItem = projectedTurn.items.find(
      (candidate) => candidate.id === runConversationItemId(run.id, payload.itemId, payload.kind)
    )!;
    expect(runtimeItem.processGroup).toMatchObject({ isStart: true });

    const workbenchItem = projectWorkbenchPayload(
      {
        getRun: (id) => runtime.getRun(id),
        conversationTurnForRun: (id) => runtime.conversationTurnForRun(id),
        progress: (id) => marctlSessionProgress(runtime, id)
      },
      'conversation',
      {
        event: {
          runId: run.id,
          sequence: 1,
          eventType: 'conversation.item',
          payload,
          createdAt: now
        }
      }
    );
    expect(workbenchItem).toMatchObject({
      item: {
        turnId: projectedTurn.id,
        itemId: runtimeItem.id,
        kind: 'reasoning',
        processGroup: runtimeItem.processGroup
      }
    });
  });
});
