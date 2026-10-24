import { describe, expect, it } from 'vitest';
import type { ConversationItem, ConversationTurn } from '../../src/model/workbench.js';
import {
  conversationProcessLabel,
  conversationProcessDuration,
  conversationWorkProcessBlocks,
  nextConversationRenderItemCount
} from '../../src/util/conversation-work-process.js';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';

const sessionId = 'session-1';
const runId = 'run-1';

describe('Visible history render budget', () => {
  const commands = (group: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      item(`${group}-${index}`, 'command_execution', {
        processGroup: { id: group, ...(index === 0 ? { isStart: true } : {}) },
        payload: { command: 'echo test' }
      })
    );

  it('skips folded contents but budgets each newly mounted heading', () => {
    const turns = [
      turn(Array.from({ length: 20 }, (_, index) => commands(`g${index}`, 30)).flat())
    ];
    const blocks = conversationWorkProcessBlocks(turns);
    expect(nextConversationRenderItemCount(turns, 0, blocks, () => undefined, 8)).toBe(240);
    expect(
      nextConversationRenderItemCount(
        turns,
        40,
        blocks,
        (id) => (['session-1:g18', 'session-1:g19'].includes(id) ? false : undefined),
        8
      )
    ).toBe(300);
  });

  it.each(['summary', 'visible_thinking', 'unspecified'])(
    'budgets visible %s previews as well as process headings',
    (representation) => {
      const turns = [
        turn(
          Array.from({ length: 10 }, (_, index) => [
            item(`summary-${index}`, 'reasoning', {
              processGroup: { id: `g${index}`, isStart: true },
              payload: { representation, sections: [{ text: 'Visible preview' }] }
            }),
            ...commands(`g${index}`, 10)
          ]).flat()
        )
      ];
      expect(
        nextConversationRenderItemCount(
          turns,
          0,
          conversationWorkProcessBlocks(turns),
          () => undefined,
          8
        )
      ).toBe(44);
    }
  );

  it('uses actual manual/focus disclosure state instead of terminal status', () => {
    const turns = [turn(commands('group', 50))];
    const blocks = conversationWorkProcessBlocks(turns);
    expect(nextConversationRenderItemCount(turns, 10, blocks, () => true, 8)).toBe(18);
    expect(nextConversationRenderItemCount(turns, 10, blocks, () => false, 8)).toBe(50);
    const active = conversationWorkProcessBlocks(turns, [{ id: runId, status: 'RUNNING' }]);
    expect(nextConversationRenderItemCount(turns, 0, active, () => undefined, 8)).toBe(7);
    expect(nextConversationRenderItemCount(turns, 10, active, () => false, 8)).toBe(50);
  });

  it.each(['summary', 'visible_thinking', 'unspecified'])(
    'budgets newly backfilled %s previews of already mounted folded processes',
    (representation) => {
      const summaries = Array.from({ length: 10 }, (_, index) =>
        item(`summary-${index}`, 'reasoning', {
          processGroup: { id: `g${index}`, isStart: true },
          payload: { representation, sections: [{ text: 'Visible preview' }] }
        })
      );
      const turns = [
        turn([
          ...summaries,
          ...Array.from({ length: 10 }, (_, index) => commands(`g${index}`, 1)).flat()
        ])
      ];
      expect(
        nextConversationRenderItemCount(
          turns,
          10,
          conversationWorkProcessBlocks(turns),
          () => false,
          8
        )
      ).toBe(18);
    }
  );

  it('preserves the raw-item budget for ordinary visible records', () => {
    const turns = [
      turn(
        Array.from({ length: 40 }, (_, index) =>
          item(`reply-${index}`, 'assistant_message', { payload: { text: 'Reply' } })
        )
      )
    ];
    expect(
      nextConversationRenderItemCount(
        turns,
        10,
        conversationWorkProcessBlocks(turns),
        () => undefined,
        8
      )
    ).toBe(18);
    expect(
      nextConversationRenderItemCount(
        turns,
        38,
        conversationWorkProcessBlocks(turns),
        () => undefined,
        8
      )
    ).toBe(40);
  });

  it('limits large visible records by content size across progressive frames', () => {
    const turns = [
      turn(
        Array.from({ length: 3 }, (_, index) =>
          item(`reply-${index}`, 'assistant_message', { payload: { text: 'x'.repeat(96) } })
        )
      )
    ];
    const blocks = conversationWorkProcessBlocks(turns);

    expect(nextConversationRenderItemCount(turns, 0, blocks, () => undefined, 8, 128)).toBe(1);
    expect(nextConversationRenderItemCount(turns, 1, blocks, () => undefined, 8, 128)).toBe(2);
  });

  it.each([undefined, false])('does not charge folded payloads to the content budget', (open) => {
    const turns = [
      turn(
        Array.from({ length: 30 }, (_, index) =>
          item(`tool-${index}`, 'command_execution', {
            processGroup: { id: 'large-folded', ...(index === 0 ? { isStart: true } : {}) },
            payload: { output: 'x'.repeat(96) }
          })
        )
      )
    ];
    const blocks = conversationWorkProcessBlocks(turns);

    expect(nextConversationRenderItemCount(turns, 0, blocks, () => open, 8, 64)).toBe(30);
  });

  it('does not share group visibility across session identities', () => {
    const turns = [
      turn(commands('same', 20)),
      turn(commands('same', 20), { sessionId: 'session-2' })
    ];
    const blocks = conversationWorkProcessBlocks(turns);
    expect(
      nextConversationRenderItemCount(
        turns,
        20,
        blocks,
        (id) => (id === 'session-1:same' ? true : false),
        8
      )
    ).toBe(28);
  });
});

describe('Latest work process labels', () => {
  it.each([
    ['reasoning', { sections: [{ text: 'Think' }] }, '正在思考中'],
    ['command_execution', { command: 'echo done' }, '正在运行命令'],
    ['tool_call', { toolName: 'lookup' }, '正在调用工具：lookup'],
    ['tool_call', { toolPresentation: { kind: 'READ' } }, '正在读取文件'],
    ['tool_call', { toolPresentation: { kind: 'WEB_SEARCH' } }, '正在搜索网页'],
    ['tool_call', { toolPresentation: { kind: 'WEB_FETCH' } }, '正在读取网页'],
    ['tool_call', { toolPresentation: { kind: 'SKILL', name: 'Review' } }, '正在加载技能：Review'],
    ['tool_call', { toolPresentation: { kind: 'SKILL' } }, '正在加载技能'],
    ['tool_call', { toolPresentation: { kind: 'SLEEP' } }, '正在等待'],
    ['tool_call', { toolCategory: 'IMAGE_GENERATION' }, '正在生成图片'],
    ['tool_call', { subagentOperation: 'START' }, '正在协作'],
    ['file_change', { changes: [{ path: 'a.ts', change: 'MODIFIED' }] }, '正在修改文件'],
    ['context_compaction', { phase: 'STARTED' }, '正在整理上下文']
  ])(
    'labels the last %s record regardless of its completion state (%j)',
    (kind, payload, expected) => {
      localePreferenceService().setLocale('zh-CN');
      for (const status of ['COMPLETED', 'FAILED', 'IN_PROGRESS']) {
        const block = conversationWorkProcessBlocks(
          [
            turn([
              item('older-tool', 'tool_call', {
                processGroup: { id: 'latest', isStart: true },
                status: 'IN_PROGRESS',
                payload: { toolName: 'older' }
              }),
              item('middle', 'reasoning', {
                processGroup: { id: 'latest' },
                payload: { sections: [{ text: 'Earlier thought' }] }
              }),
              item('latest', kind as string, { processGroup: { id: 'latest' }, status, payload })
            ])
          ],
          [{ id: runId, status: 'RUNNING' }]
        )[0]!;
        expect(conversationProcessLabel(block, true)).toBe(expected);
        expect(conversationProcessLabel(block, false)).toBe('等待同步');
        expect(conversationProcessLabel({ ...block, status: 'stopping' }, true)).toBe('正在停止');
        expect(
          conversationProcessLabel({ ...block, active: false, status: 'completed' }, true)
        ).toBe('已完成');
      }
    }
  );

  it('keeps names unchanged in English and has a neutral fallback', () => {
    localePreferenceService().setLocale('en-US');
    const block = conversationWorkProcessBlocks(
      [
        turn([
          item('tool', 'tool_call', {
            processGroup: { id: 'named', isStart: true },
            payload: { toolName: '工具 Original' }
          })
        ])
      ],
      [{ id: runId, status: 'RUNNING' }]
    )[0]!;
    expect(conversationProcessLabel(block, true)).toBe('Calling tool: 工具 Original');
    expect(
      conversationProcessLabel({ ...block, latestWork: item('thought', 'reasoning') }, true)
    ).toBe('Reasoning');
    const { latestWork: _, ...withoutWork } = block;
    expect(conversationProcessLabel(withoutWork, true)).toBe('Processing');
    localePreferenceService().setLocale('zh-CN');
  });
});

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
  it('reuses reasoning projections across process grouping and keeps preview identity', () => {
    let sectionReads = 0;
    const reasoning = item('thinking', 'reasoning', {
      processGroup: { id: 'p', isStart: true },
      payload: { representation: 'visible_thinking' }
    });
    Object.defineProperty(reasoning.payload, 'sections', {
      get() {
        sectionReads++;
        return [{ text: 'Inspect the files, then verify' }];
      }
    });
    const blocks = conversationWorkProcessBlocks([turn([reasoning])]);
    const entry = blocks[0]!.entries[0]!.displayItem;
    expect(entry.type).toBe('reasoning_group');
    if (entry.type !== 'reasoning_group') throw new Error('Expected reasoning projection');
    expect(blocks[0]!.preview).toBe(entry.preview);
    expect(entry.preview?.text).toBe('Inspect the files');
    // reasoningSections checks the array and reads it once; grouping must not repeat it.
    expect(sectionReads).toBe(2);
  });

  it('prefers explicit summaries and falls back to thinking without changing representation', () => {
    const blocks = conversationWorkProcessBlocks(
      [
        turn([
          item('summary', 'reasoning', {
            processGroup: { id: 'p', isStart: true },
            payload: {
              representation: 'summary',
              sections: [{ text: '**Inspect files**\nDetails' }]
            }
          }),
          item('thinking', 'reasoning', {
            processGroup: { id: 'p' },
            payload: {
              representation: 'visible_thinking',
              sections: [{ text: 'Private-looking public thinking' }]
            }
          })
        ])
      ],
      [{ id: runId, status: 'RUNNING' }]
    );
    expect(blocks[0]?.preview).toEqual({
      id: 'summary',
      text: 'Inspect files',
      representation: 'summary'
    });
    expect(blocks[0]?.status).toBe('running');
    expect(blocks[0]?.entries).toHaveLength(2);
    const withoutSummary = conversationWorkProcessBlocks([
      turn([
        item('thinking', 'reasoning', {
          processGroup: { id: 'p', isStart: true },
          payload: {
            representation: 'visible_thinking',
            sections: [{ text: 'Visible thinking' }]
          }
        })
      ])
    ]);
    expect(withoutSummary[0]?.preview).toEqual({
      id: 'thinking',
      text: 'Visible thinking',
      representation: 'visible_thinking'
    });
  });

  it('selects the latest valid preview per process across segments without borrowing other summaries', () => {
    const thought = (
      id: string,
      groupId: string,
      text: string,
      representation = 'visible_thinking'
    ) =>
      item(id, 'reasoning', {
        processGroup: { id: groupId },
        payload: { representation, sections: [{ text }] }
      });
    const blocks = conversationWorkProcessBlocks([
      turn([
        thought('old', 'first', 'Old thought: details'),
        thought('other-summary', 'other', '**Other summary**', 'summary')
      ]),
      turn(
        [
          thought('latest', 'first', 'Latest thought: details\n\nLater paragraph'),
          thought('empty-summary', 'first', ' \n\t', 'summary'),
          thought('empty', 'empty', ' ')
        ],
        { id: 'segment-2' }
      )
    ]);
    expect(processBlock(blocks, 'first').preview).toEqual({
      id: 'latest',
      text: 'Latest thought',
      representation: 'visible_thinking'
    });
    expect(processBlock(blocks, 'other').preview).toEqual({
      id: 'other-summary',
      text: 'Other summary',
      representation: 'summary'
    });
    expect(blocks.some((block) => block.groupId === 'empty')).toBe(false);
    const entries = processBlock(blocks, 'first').entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.displayItem).toMatchObject({
      preview: { id: 'latest', text: 'Latest thought' },
      text: 'Old thought: details\n\nLatest thought: details\n\nLater paragraph'
    });
  });

  it.each([
    ['SUCCEEDED', 'completed'],
    ['FAILED', 'incomplete'],
    ['CANCELLED', 'stopped']
  ])(
    'uses the authoritative %s Run outcome for an unfinished final process',
    (status, expected) => {
      const blocks = conversationWorkProcessBlocks(
        [
          turn([
            item('failed', 'tool_call', {
              processGroup: { id: 'p', isStart: true },
              status: 'FAILED',
              payload: { toolName: 'read' }
            })
          ])
        ],
        [{ id: runId, status }]
      );
      expect(blocks[0]?.status).toBe(expected);
      expect(blocks[0]?.entries[0]?.displayItem).toMatchObject({ items: [{ status: 'FAILED' }] });
      expect(blocks[0]).not.toHaveProperty('warning');
    }
  );

  it('keeps a completed earlier process separate from a later cancelled process', () => {
    const blocks = conversationWorkProcessBlocks(
      [
        turn([
          item('first', 'tool_call', {
            processGroup: { id: 'first', isStart: true },
            payload: { toolName: 'read' }
          }),
          item('prose', 'assistant_message', { payload: { text: 'Continue with the next step.' } }),
          item('last', 'tool_call', {
            processGroup: { id: 'last', isStart: true },
            status: 'IN_PROGRESS',
            payload: { toolName: 'exec' }
          })
        ])
      ],
      [{ id: runId, status: 'CANCELLED' }]
    );
    expect(processBlock(blocks, 'first').status).toBe('completed');
    expect(processBlock(blocks, 'last').status).toBe('stopped');
  });

  it('shows stopping rather than executing while cancellation is pending', () => {
    const blocks = conversationWorkProcessBlocks(
      [
        turn([
          item('tool', 'tool_call', {
            processGroup: { id: 'p', isStart: true },
            status: 'IN_PROGRESS',
            payload: { toolName: 'exec' }
          })
        ])
      ],
      [{ id: runId, status: 'CANCELLING' }]
    );
    expect(blocks[0]).toMatchObject({ active: true, status: 'stopping' });
  });

  it('does not call a final failed process complete merely because an error seals it', () => {
    const blocks = conversationWorkProcessBlocks(
      [
        turn([
          item('failed', 'tool_call', {
            processGroup: { id: 'p', isStart: true },
            status: 'FAILED',
            payload: { toolName: 'exec' }
          }),
          item('error', 'error', { payload: { message: 'Execution failed' } })
        ])
      ],
      [{ id: runId, status: 'FAILED' }]
    );
    expect(blocks[0]).toMatchObject({ sealed: true, active: false, status: 'incomplete' });
    expect(blocks[1]?.groupId).toBeUndefined();
  });

  it('reprojects the same process across segments at category anchors without merging item types', () => {
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
        }),
        item('tool-2', 'tool_call', {
          processGroup: { id: groupId },
          payload: { toolName: 'write' }
        }),
        item('file-2', 'file_change', {
          processGroup: { id: groupId },
          payload: { changes: [{ path: 'src/other.ts', change: 'ADDED' }] }
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
      status: 'executing'
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
      process.entries.find(({ displayItem }) => displayItem.type === 'tool_group')?.displayItem
    ).toMatchObject({
      type: 'tool_group',
      id: 'tool-1',
      items: [{ id: 'tool-1' }, { id: 'tool-2' }]
    });
    expect(
      process.entries.find(({ displayItem }) => displayItem.type === 'file_change_group')
        ?.displayItem
    ).toMatchObject({
      type: 'file_change_group',
      id: 'file-1',
      items: [{ id: 'file-1' }, { id: 'file-2' }]
    });
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

  it('keeps failed tools in details without escalating a historical group', () => {
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

    expect(processBlock(blocks, groupId)).toMatchObject({ status: 'history', active: false });
  });

  it('retains the live Run association when an earlier native page joins the same process', () => {
    const prefix = turn(
      [
        item('first', 'reasoning', {
          processGroup: { id: 'joined', isStart: true },
          payload: { sections: [{ text: 'Earlier reasoning' }] }
        })
      ],
      { id: 'older', runId: null }
    );
    const latest = turn(
      [
        item('latest', 'tool_call', {
          processGroup: { id: 'joined' },
          status: 'IN_PROGRESS',
          payload: { toolName: 'read' }
        })
      ],
      { id: 'latest' }
    );
    expect(
      processBlock(
        conversationWorkProcessBlocks([prefix, latest], [{ id: runId, status: 'RUNNING' }]),
        'joined'
      )
    ).toMatchObject({ runId, active: true, status: 'executing' });
    expect(
      processBlock(
        conversationWorkProcessBlocks([prefix, latest], [{ id: runId, status: 'SUCCEEDED' }]),
        'joined'
      )
    ).toMatchObject({ runId, active: false, status: 'completed' });
  });

  it.each([
    [1000, 4500, 3500],
    [0, 0, 0],
    [5000, 1000, undefined],
    [null, 4500, undefined],
    [1000, null, undefined],
    [Number.NaN, 4500, undefined]
  ])(
    'measures process endpoint records without inventing missing time (%s, %s)',
    (start, end, expected) => {
      const first = {
        ...item('first', 'tool_call', { processGroup: { id: 'timed', isStart: true } }),
        startedAt: start
      };
      const last = {
        ...item('last', 'tool_call', { processGroup: { id: 'timed' } }),
        completedAt: end
      };
      const block = processBlock(
        conversationWorkProcessBlocks([turn([first, last], { status: 'SUCCEEDED' })]),
        'timed'
      );
      expect(block.durationMs).toBe(expected);
    }
  );

  it('uses the endpoint alternate timestamps, but not an incomplete historical prefix', () => {
    const first = {
      ...item('first', 'tool_call', { processGroup: { id: 'timed', isStart: true } }),
      completedAt: 1000
    };
    const last = {
      ...item('last', 'tool_call', { processGroup: { id: 'timed' } }),
      startedAt: 5000
    };
    expect(
      processBlock(conversationWorkProcessBlocks([turn([first, last])]), 'timed').durationMs
    ).toBe(4000);
    const partial = { ...first, processGroup: { id: 'timed' } };
    expect(
      processBlock(conversationWorkProcessBlocks([turn([partial, last])]), 'timed').durationMs
    ).toBeUndefined();
  });

  it('ticks active processes and recalculates from records when finished or unsynchronized', () => {
    const records = [
      {
        ...item('first', 'reasoning', {
          processGroup: { id: 'timed', isStart: true },
          payload: { sections: [{ text: 'Reviewing the change' }] }
        }),
        startedAt: 1000
      },
      {
        ...item('last', 'tool_call', { processGroup: { id: 'timed' } }),
        startedAt: 2000,
        completedAt: 3500
      }
    ];
    const block = {
      ...processBlock(conversationWorkProcessBlocks([turn(records)]), 'timed'),
      active: true
    };
    expect(conversationProcessDuration(block, 5000, true)).toBe(4000);
    expect(conversationProcessDuration(block, 6000, true)).toBe(5000);
    expect(conversationProcessDuration(block, 6000, false)).toBe(2500);
    expect(conversationProcessDuration({ ...block, active: false }, 6000, true)).toBe(2500);
    expect(conversationProcessDuration({ ...block, active: false }, 9000, true)).toBe(2500);
    const { durationMs: _duration, ...starting } = block;
    const { startedAt: _start, ...withoutOrigin } = starting;
    expect(conversationProcessDuration(withoutOrigin, 6000, true)).toBeUndefined();
    expect(conversationProcessDuration(block, 500, true)).toBe(2500);
    expect(conversationProcessDuration(starting, 2000, true)).toBe(1000);
  });

  it('retains source endpoints and the latest activity when category groups move', () => {
    const processGroup = { id: 'moving' };
    const block = processBlock(
      conversationWorkProcessBlocks([
        turn([
          {
            ...item('tool-first', 'tool_call', {
              processGroup: { ...processGroup, isStart: true }
            }),
            startedAt: 1000,
            completedAt: 1500
          },
          {
            ...item('command', 'command_execution', { processGroup }),
            startedAt: 2000,
            completedAt: 2500
          },
          {
            ...item('tool-last', 'tool_call', { processGroup }),
            startedAt: 3000,
            completedAt: 4000
          }
        ])
      ]),
      'moving'
    );
    expect(block.entries.map(({ displayItem }) => displayItem.id)).toEqual([
      'command',
      'tool-first'
    ]);
    expect(block.startedAt).toBe(1000);
    expect(block.durationMs).toBe(3000);
    expect(block.latestWork?.id).toBe('tool-last');
    expect(conversationProcessDuration({ ...block, active: true }, 6000, true)).toBe(5000);
  });

  it.each([
    ['SUCCEEDED', 'completed'],
    ['FAILED', 'incomplete'],
    ['CANCELLED', 'stopped'],
    ['RUNNING', 'history']
  ])('uses terminal history facts without reviving a missing Run: %s', (status, expected) => {
    const blocks = conversationWorkProcessBlocks([
      turn(
        [
          item('read', 'tool_call', {
            processGroup: { id: 'history', isStart: true },
            status: 'IN_PROGRESS',
            payload: { toolName: 'read' }
          })
        ],
        { runId: null, status }
      )
    ]);
    expect(processBlock(blocks, 'history')).toMatchObject({ status: expected, active: false });
  });
});
