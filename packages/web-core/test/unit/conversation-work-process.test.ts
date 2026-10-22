import { describe, expect, it } from 'vitest';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
import { conversationWorkProcessBlocks } from '../../src/util/conversation-work-process.js';

const sessionId = 'session-1';
const runId = 'run-1';

function item(
  id: string,
  kind: string,
  options: {
    readonly processGroup?: ConversationItem['processGroup'];
    readonly parentItemId?: string | null;
    readonly status?: string;
    readonly payload?: unknown;
  } = {}
): ConversationItem {
  const payload = options.payload ?? {};
  return {
    id,
    kind,
    status: options.status ?? 'COMPLETED',
    payload:
      kind === 'reasoning' &&
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload)
        ? { representation: 'unspecified', ...payload }
        : payload,
    ...(options.processGroup === undefined ? {} : { processGroup: options.processGroup }),
    ...(options.parentItemId === undefined ? {} : { parentItemId: options.parentItemId })
  };
}

function turn(
  items: readonly ConversationItem[],
  options: Partial<ConversationTurn> = {}
): ConversationTurn {
  return {
    id: 'segment-1',
    sessionId,
    runId,
    status: 'RUNNING',
    items,
    ...options
  };
}

function processBlock(blocks: ReturnType<typeof conversationWorkProcessBlocks>, groupId: string) {
  const block = blocks.find((candidate) => candidate.groupId === groupId);
  if (block === undefined) throw new Error(`Missing process group ${groupId}`);
  return block;
}

describe('Conversation work process blocks', () => {
  it('merges the same process ID across segments in source order without merging item types', () => {
    const groupId = 'process-1';
    const firstSegment = turn([
      item('reasoning-1', 'reasoning', {
        processGroup: { id: groupId, isStart: true },
        payload: { representation: 'summary', sections: [{ text: 'Inspect the source.' }] }
      }),
      item('reasoning-2', 'reasoning', {
        processGroup: { id: groupId },
        payload: { representation: 'visible_thinking', sections: [{ text: 'Check the result.' }] }
      }),
      item('tool-1', 'tool_call', {
        processGroup: { id: groupId },
        status: 'IN_PROGRESS',
        payload: { toolName: 'read' }
      })
    ]);
    const nextPage = turn(
      [
        item('file-1', 'file_change', {
          processGroup: { id: groupId },
          payload: { changes: [{ path: 'src/example.ts', change: 'MODIFIED' }] }
        })
      ],
      { id: 'segment-2', segmentIndex: 1, status: 'SUCCEEDED' }
    );

    const blocks = conversationWorkProcessBlocks(
      [firstSegment, nextPage],
      [{ id: runId, status: 'RUNNING' }]
    );
    const process = processBlock(blocks, groupId);

    expect(blocks).toHaveLength(1);
    expect(process).toMatchObject({
      id: `${sessionId}:${groupId}`,
      partial: false,
      sealed: false,
      active: true,
      warning: false
    });
    expect(process.entries.map(({ displayItem }) => displayItem.id)).toEqual([
      'reasoning-1',
      'reasoning-2',
      'tool-1',
      'file-1'
    ]);
    expect(process.entries.map(({ displayItem }) => displayItem.type)).toEqual([
      'reasoning_group',
      'reasoning_group',
      'tool_group',
      'file_change_group'
    ]);
    expect(
      process.entries.every(
        ({ displayItem }) => 'items' in displayItem && displayItem.items.length === 1
      )
    ).toBe(true);
  });

  it('keeps an unknown prefix without process metadata flat instead of inferring membership', () => {
    const blocks = conversationWorkProcessBlocks([
      turn([
        item('unknown-prefix', 'unknown', { payload: { summary: 'Older record unavailable.' } }),
        item('unassigned-tool', 'tool_call', { payload: { toolName: 'read' } })
      ])
    ]);

    expect(
      blocks.map(({ groupId, entries }) => [
        groupId,
        entries.map(({ displayItem }) => displayItem.id)
      ])
    ).toEqual([
      [undefined, ['unknown-prefix']],
      [undefined, ['unassigned-tool']]
    ]);
    expect(blocks.every((block) => block.partial === false && block.sealed)).toBe(true);
  });

  it('keeps approvals outside the parent process and starts a new process afterward', () => {
    const parentId = 'process-parent';
    const nextId = 'process-next';
    const blocks = conversationWorkProcessBlocks([
      turn([
        item('tool-parent', 'tool_call', {
          processGroup: { id: parentId, isStart: true },
          status: 'IN_PROGRESS',
          payload: { toolName: 'edit' }
        }),
        item('approval-1', 'approval_request', {
          parentItemId: 'tool-parent',
          status: 'PENDING',
          payload: { approvalId: 'approval-1' }
        }),
        item('tool-next', 'tool_call', {
          processGroup: { id: nextId, isStart: true },
          status: 'IN_PROGRESS',
          payload: { toolName: 'test' }
        })
      ])
    ]);

    expect(
      blocks.map(({ groupId, entries }) => [
        groupId,
        entries.map(({ displayItem }) => displayItem.id)
      ])
    ).toEqual([
      [parentId, ['tool-parent']],
      [undefined, ['approval-1']],
      [nextId, ['tool-next']]
    ]);
    expect(processBlock(blocks, parentId).sealed).toBe(true);
  });

  it('seals at later prose but keeps an in-progress tool active from its authoritative Run', () => {
    const groupId = 'process-active';
    const segment = turn(
      [
        item('tool-running', 'tool_call', {
          processGroup: { id: groupId, isStart: true },
          status: 'IN_PROGRESS',
          payload: { toolName: 'read' }
        }),
        item('assistant-reply', 'assistant_message', {
          payload: { text: 'The first result is ready.' }
        })
      ],
      { status: 'SUCCEEDED' }
    );

    const active = processBlock(
      conversationWorkProcessBlocks([segment], [{ id: runId, status: 'RUNNING' }]),
      groupId
    );
    expect(active).toMatchObject({ sealed: true, active: true });
    expect(active.entries.map(({ displayItem }) => displayItem.id)).toEqual(['tool-running']);

    const ended = processBlock(
      conversationWorkProcessBlocks([segment], [{ id: runId, status: 'SUCCEEDED' }]),
      groupId
    );
    expect(ended).toMatchObject({ sealed: true, active: false });
  });

  it('clears partial when the group start arrives without changing its identity', () => {
    const groupId = 'process-partial';
    const suffix = item('tool-later', 'tool_call', {
      processGroup: { id: groupId },
      payload: { toolName: 'write' }
    });
    const partial = processBlock(
      conversationWorkProcessBlocks([turn([suffix], { runId: null })]),
      groupId
    );
    expect(partial).toMatchObject({ partial: true, id: `${sessionId}:${groupId}` });

    const complete = processBlock(
      conversationWorkProcessBlocks([
        turn(
          [
            item('reasoning-first', 'reasoning', {
              processGroup: { id: groupId, isStart: true },
              payload: {
                representation: 'visible_thinking',
                sections: [{ text: 'Earlier history arrived.' }]
              }
            }),
            suffix
          ],
          { runId: null }
        )
      ]),
      groupId
    );
    expect(complete).toMatchObject({ partial: false, id: partial.id });
    expect(complete.entries.map(({ displayItem }) => displayItem.id)).toEqual([
      'reasoning-first',
      'tool-later'
    ]);
  });

  it('keeps warnings visible on their authoritative process group', () => {
    const groupId = 'process-warning';
    const blocks = conversationWorkProcessBlocks([
      turn([
        item('tool-failed', 'tool_call', {
          processGroup: { id: groupId, isStart: true },
          status: 'FAILED',
          payload: { toolName: 'write' }
        })
      ])
    ]);

    expect(processBlock(blocks, groupId)).toMatchObject({ warning: true, active: false });
  });
});
