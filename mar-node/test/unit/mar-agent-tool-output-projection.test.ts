import { describe, expect, it } from 'vitest';
import { conversationItemSchema } from '@myagentroam/protocol';
import type { AgentEvent } from '@myagentroam/agent';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { formatReadEventOutput } from '../../../mar-agent/src/tools/local/read.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import {
  publicOutputTruncation,
  structuredToolEventData
} from '../../../mar-agent/src/tools/output-projection.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';

describe('MAR Agent live tool output projection', () => {
  it('keeps execution metadata outside the public output budget', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const stdout = '\u0001'.repeat(10_000);
    const stderr = '\u0002'.repeat(10_000);
    const source = { kind: 'SHELL', text: '"'.repeat(10_000), truncated: false };
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'metadata-budget',
        input: { processId: 'p' }
      })
    );
    const [item] = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec_wait',
        callId: 'metadata-budget',
        summary: '',
        data: { stdout, stderr, exitCode: 0, executionSource: source }
      })
    );
    expect(item?.payload.output).toEqual({
      blocks: [
        { channel: 'STDOUT', text: stdout },
        { channel: 'STDERR', text: stderr }
      ]
    });
    expect(item?.payload.toolPresentation).toMatchObject({ execution: { source } });
    expect(item?.payload.toolPresentation).not.toHaveProperty('execution.output');
    expectValidConversationItems(item ? [item] : []);
  });
  it('does not infer output truncation from an unrelated exec_wait event flag', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'wait',
        input: { processId: 'p' }
      })
    );
    const [item] = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec_wait',
        callId: 'wait',
        summary: 'clipped summary',
        truncated: true,
        data: { stdout: 'complete', stderr: '', exitCode: 0 }
      })
    );
    expect(item?.payload.output).toEqual({
      blocks: [
        { channel: 'STDOUT', text: 'complete' },
        { channel: 'STDERR', text: '' }
      ]
    });
    expectValidConversationItems(item ? [item] : []);
  });
  it('does not mark two complete Code output channels truncated merely because their combined preview exceeds 10K', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'code',
        input: { code: 'run()' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: 'child',
        parentCallId: 'code',
        input: { command: 'run' }
      })
    );
    const [item] = normalizer.normalize(
      toolEvent({
        type: 'tool.output',
        toolName: 'exec',
        callId: 'child',
        parentCallId: 'code',
        output: {
          processId: 'p',
          mode: 'snapshot',
          stdout: 'a'.repeat(6000),
          stderr: 'b'.repeat(6000),
          truncated: false,
          displayOutput: {
            stdout: 'a'.repeat(6000),
            stderr: 'b'.repeat(6000),
            stdoutDroppedBytes: 0,
            stderrDroppedBytes: 0
          }
        }
      })
    );
    expect(item?.payload.output).toEqual({
      blocks: [
        { channel: 'STDOUT', text: 'a'.repeat(6000) },
        { channel: 'STDERR', text: 'b'.repeat(6000) }
      ]
    });
    expectValidConversationItems(item ? [item] : []);
  });
  it('keeps a truncated ordinary-tool summary as an explicitly bounded summary, not output', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({ type: 'tool.started', toolName: 'custom', callId: 'summary-only', input: {} })
    );
    const [item] = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'custom',
        callId: 'summary-only',
        summary: 'truncated summary',
        summaryTruncated: true,
        truncated: true
      })
    );
    expect(item?.payload).toMatchObject({
      outputSummary: 'truncated summary',
      outputSummaryTruncated: true
    });
    expect(item?.payload).not.toHaveProperty('output');
    expectValidConversationItems(item ? [item] : []);
  });
  it('does not attribute a truncated event summary to complete public Code output', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'complete',
        input: { code: 'observe.text()' }
      })
    );
    const result = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'complete',
        summary: 'summary clipped',
        summaryTruncated: true,
        truncated: true,
        data: {
          cellId: 'cell',
          status: 'completed',
          truncated: true,
          observations: [{ type: 'value', id: 'value', format: 'text', value: 'a'.repeat(3608) }]
        }
      })
    );
    expect(result[0]?.payload.output).toEqual({
      blocks: [{ channel: 'TEXT', text: 'a'.repeat(3608) }]
    });
    expectValidConversationItems(result);
  });
  it('retains earlier child output across snapshots and non-adjacent process waits', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'code',
        input: { code: 'run()' }
      })
    );
    const child = (callId: string) =>
      normalizer.normalize(
        toolEvent({
          type: 'tool.started',
          toolName: 'exec',
          callId,
          parentCallId: 'code',
          input: { command: callId }
        })
      );
    const output = (callId: string, mode: 'delta' | 'snapshot', text: string) =>
      normalizer.normalize(
        toolEvent({
          type: 'tool.output',
          toolName: 'exec',
          callId,
          parentCallId: 'code',
          output: {
            processId: callId,
            mode,
            stdout: text,
            stderr: '',
            truncated: false,
            displayOutput: {
              stdout: text,
              stderr: '',
              stdoutDroppedBytes: 0,
              stderrDroppedBytes: 0
            }
          }
        })
      );
    child('one');
    output('one', 'delta', 'A');
    normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'one',
        parentCallId: 'code',
        summary: 'A'
      })
    );
    child('two');
    output('two', 'delta', 'B');
    const result = output('two', 'snapshot', 'BC');
    expect(result[0]?.payload.output).toMatchObject({
      blocks: [{ channel: 'STDOUT', text: expect.stringContaining('A') }]
    });
    expect(result[0]?.payload.output).toMatchObject({
      blocks: [{ channel: 'STDOUT', text: expect.stringContaining('BC') }]
    });
    expectValidConversationItems(result);
    normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'two',
        parentCallId: 'code',
        summary: 'BC'
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'poll',
        parentCallId: 'code',
        input: { processId: 'two' }
      })
    );
    const poll = normalizer.normalize(
      toolEvent({
        type: 'tool.output',
        toolName: 'exec_wait',
        callId: 'poll',
        parentCallId: 'code',
        output: {
          processId: 'two',
          mode: 'snapshot',
          stdout: 'BCD',
          stderr: '',
          truncated: false,
          displayOutput: { stdout: 'BCD', stderr: '', stdoutDroppedBytes: 0, stderrDroppedBytes: 0 }
        }
      })
    );
    expect(poll[0]?.payload.output).toEqual({ blocks: [{ channel: 'STDOUT', text: 'ABCD' }] });
    normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec_wait',
        callId: 'poll',
        parentCallId: 'code',
        summary: 'BCD'
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'revisit',
        parentCallId: 'code',
        input: { processId: 'one' }
      })
    );
    const revisited = normalizer.normalize(
      toolEvent({
        type: 'tool.output',
        toolName: 'exec_wait',
        callId: 'revisit',
        parentCallId: 'code',
        output: {
          processId: 'one',
          mode: 'snapshot',
          stdout: 'A',
          stderr: '',
          truncated: false,
          displayOutput: { stdout: 'A', stderr: '', stdoutDroppedBytes: 0, stderrDroppedBytes: 0 }
        }
      })
    );
    expect(revisited[0]?.payload.output).toEqual({ blocks: [{ channel: 'STDOUT', text: 'ABCD' }] });
    expectValidConversationItems(revisited);
  });
  it('bounds completed child output and marks discarded head when a later child resynchronizes', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'code',
        input: { code: 'run()' }
      })
    );
    for (let i = 0; i < 4; i++) {
      const callId = `child-${i}`;
      normalizer.normalize(
        toolEvent({
          type: 'tool.started',
          toolName: 'exec',
          callId,
          parentCallId: 'code',
          input: { command: callId }
        })
      );
      const text = `${String(i).repeat(5000)}🦊`;
      normalizer.normalize(
        toolEvent({
          type: 'tool.output',
          toolName: 'exec',
          callId,
          parentCallId: 'code',
          output: {
            processId: callId,
            mode: 'delta',
            stdout: text,
            stderr: '',
            truncated: false,
            displayOutput: {
              stdout: text,
              stderr: '',
              stdoutDroppedBytes: 0,
              stderrDroppedBytes: 0
            }
          }
        })
      );
      normalizer.normalize(
        toolEvent({
          type: 'tool.completed',
          toolName: 'exec',
          callId,
          parentCallId: 'code',
          summary: ''
        })
      );
    }
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: 'last',
        parentCallId: 'code',
        input: { command: 'last' }
      })
    );
    const result = normalizer.normalize(
      toolEvent({
        type: 'tool.output',
        toolName: 'exec',
        callId: 'last',
        parentCallId: 'code',
        output: {
          processId: 'last',
          mode: 'snapshot',
          stdout: 'TAIL',
          stderr: '',
          truncated: false,
          displayOutput: {
            stdout: 'TAIL',
            stderr: '',
            stdoutDroppedBytes: 0,
            stderrDroppedBytes: 0
          }
        }
      })
    );
    expect(result[0]?.payload.output).toMatchObject({
      blocks: [{ channel: 'STDOUT', text: expect.stringMatching(/TAIL$/) }],
      truncation: 'HEAD'
    });
    expectValidConversationItems(result);
  });
  it('routes a later-execution retained cell frame only to its current wait call', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const old = normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'old',
        executionId: 'old-execution',
        input: { code: 'run()' }
      })
    )[0];
    normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'old',
        executionId: 'old-execution',
        data: { cellId: 'cell', status: 'running' }
      })
    );
    normalizer.normalize(toolEvent({ type: 'execution.started', executionId: 'new-execution' }));
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec_wait',
        callId: 'wait',
        executionId: 'new-execution',
        input: { cellId: 'cell' }
      })
    );
    const items = normalizer.normalize(
      toolEvent({
        type: 'tool.output',
        toolName: 'code_exec_wait',
        callId: 'wait',
        executionId: 'new-execution',
        output: {
          processId: 'process',
          mode: 'delta',
          stdout: 'new',
          stderr: 'err',
          truncated: false
        }
      })
    );
    expect(items).toMatchObject([
      {
        itemId: 'mar-agent-tool:wait',
        append: 'output',
        payload: {
          output: {
            blocks: [
              { channel: 'STDOUT', text: 'new' },
              { channel: 'STDERR', text: 'err' }
            ]
          }
        }
      }
    ]);
    expect(old?.itemId).toBe('mar-agent-tool:old');
    expectValidConversationItems(items);
  });
  it('routes direct and nested true deltas to their actual call without merging process identities', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: 'direct',
        input: { command: 'run' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'wait',
        input: { processId: 'p1' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'code',
        input: { code: 'run()' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: 'inner',
        parentCallId: 'code',
        input: { command: 'run' }
      })
    );
    const delta = (callId: string, toolName: string, parentCallId?: string) =>
      normalizer.normalize(
        toolEvent({
          type: 'tool.output',
          callId,
          toolName,
          ...(parentCallId ? { parentCallId } : {}),
          output: {
            processId: 'p1',
            mode: 'delta',
            stdout: 'new',
            stderr: 'err',
            truncated: false,
            displayOutput: {
              stdout: 'oldernew',
              stderr: 'err',
              stdoutDroppedBytes: 0,
              stderrDroppedBytes: 0
            }
          }
        })
      );
    for (const [items, id] of [
      [delta('direct', 'exec'), 'direct'],
      [delta('wait', 'exec_wait'), 'wait'],
      [delta('inner', 'exec', 'code'), 'code']
    ] as const) {
      expect(items).toMatchObject([
        {
          itemId: `mar-agent-tool:${id}`,
          append: 'output',
          payload: {
            output: {
              blocks: [
                { channel: 'STDOUT', text: 'new' },
                { channel: 'STDERR', text: 'err' }
              ]
            }
          }
        }
      ]);
      expectValidConversationItems(items);
    }
  });
  it.each(['FETCH_FAILED', 'MAR_AGENT_CANCELLED'])(
    'keeps %s failure output and status independent',
    (code) => {
      const normalizer = new MarAgentConversationNormalizer();
      normalizer.normalize(
        toolEvent({
          type: 'tool.started',
          toolName: 'web_fetch',
          callId: 'failed-fetch',
          input: {}
        })
      );
      const items = normalizer.normalize(
        toolEvent({
          type: 'tool.failed',
          toolName: 'web_fetch',
          callId: 'failed-fetch',
          code,
          message: '  Request stopped.\n'
        })
      );
      expect(items[0]).toMatchObject({
        status: code === 'MAR_AGENT_CANCELLED' ? 'CANCELLED' : 'FAILED',
        payload: { errorMessage: '  Request stopped.\n', errorCode: code }
      });
      expect(items[0]?.payload).not.toHaveProperty('output');
      expectValidConversationItems(items);
    }
  );

  it.each(['read', 'web_fetch', 'web_search', 'skill', 'agent_wait'])(
    'publishes authoritative %s output with matching replay semantics',
    (toolName) => {
      const normalizer = new MarAgentConversationNormalizer();
      const started = toolEvent({
        type: 'tool.started',
        toolName,
        callId: 'public-output',
        input: {}
      });
      const text = `${'x'.repeat(10_100)}\nlast line\n`;
      const read = formatReadEventOutput([
        {
          path: 'sample.txt',
          text,
          content: text,
          encoding: 'utf-8',
          newline: 'lf',
          startLine: 1,
          endLine: 2,
          eof: true,
          truncated: false
        }
      ]);
      const completed = toolEvent({
        type: 'tool.completed',
        toolName,
        callId: 'public-output',
        summary: toolName === 'read' ? read.summary : 'bounded summary',
        ...(toolName === 'read' ? { summaryTruncated: read.truncated } : {}),
        data: toolName === 'read' ? structuredToolEventData('read', { ...read.data }) : text
      });
      expect(normalizer.normalize(started)[0]?.payload).not.toHaveProperty('output');
      const items = normalizer.normalize(completed);
      expect(items[0]?.payload).toMatchObject({
        output:
          toolName === 'read'
            ? { blocks: [{ channel: 'TEXT', text: read.summary }], truncation: 'SOURCE' }
            : { blocks: [{ channel: 'TEXT', text: text.slice(-10_000) }], truncation: 'HEAD' }
      });
      expectValidConversationItems(items);
      const replay = new MarAgentConversationNormalizer();
      replay.normalize(started);
      expect(replay.normalize(completed)).toEqual(items);
      const empty = normalizer.normalize(
        toolEvent({
          type: 'tool.completed',
          toolName,
          callId: 'public-output',
          summary: '',
          data:
            toolName === 'read'
              ? structuredToolEventData('read', { ...formatReadEventOutput([]).data })
              : ''
        })
      );
      expect(empty[0]?.payload).toMatchObject({ output: { blocks: [] } });
    }
  );

  it.each([
    ['without prior presentation', undefined, 'before failure', undefined],
    ['over stale presentation', 'stale observation', 'retained tail', 'HEAD'],
    ['with source truncation', undefined, 'partial observation', 'SOURCE'],
    ['with empty terminal observations', 'stale observation', '', undefined],
    ['without terminal data', 'stored observation', undefined, undefined]
  ] as const)(
    'keeps failed Code observations %s in live output and history',
    (_condition, priorText, terminalText, truncation) => {
      const normalizer = new MarAgentConversationNormalizer();
      const result = (text: string, direction?: 'HEAD' | 'SOURCE') =>
        structuredToolEventData('code_exec', {
          cellId: 'cell',
          status: 'failed',
          ...(direction === undefined ? {} : { truncated: true }),
          ...(direction === 'HEAD' ? { outputHeadTruncated: true } : {}),
          observations: text
            ? [
                {
                  type: 'value',
                  id: 'observation',
                  format: 'text',
                  value: text,
                  truncated: direction === 'SOURCE'
                }
              ]
            : [],
          error: { code: 'MAR_AGENT_CODE_FAILED', message: 'Cell failed.' }
        });
      const input = { code: 'observe.text("before failure");\nthrow new Error("Cell failed.");' };
      const started = toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'failed-code',
        input,
        ...(priorText === undefined ? {} : { data: result(priorText) })
      });
      const data = terminalText === undefined ? undefined : result(terminalText, truncation);
      const failed = toolEvent({
        type: 'tool.failed',
        toolName: 'code_exec',
        callId: 'failed-code',
        code: 'MAR_AGENT_CODE_FAILED',
        message: 'Cell failed.',
        ...(data === undefined
          ? {}
          : { data, outputTruncation: publicOutputTruncation('code_exec', data) })
      });
      const startItems = normalizer.normalize(started);
      const items = normalizer.normalize(failed);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        itemId: startItems[0]!.itemId,
        kind: 'command_execution',
        status: 'FAILED',
        payload: {
          command: input.code,
          cwd: null,
          exitCode: null,
          output: {
            blocks: [{ channel: 'TEXT', text: terminalText ?? priorText }],
            ...(truncation === undefined ? {} : { truncation })
          },
          toolPresentation: {
            execution: {
              kind: 'CODE',
              toolName: 'code_exec',
              error: { code: 'MAR_AGENT_CODE_FAILED', message: 'Cell failed.' }
            }
          }
        }
      });
      expect(items[0]).not.toHaveProperty('append');
      if (truncation === undefined)
        expect(items[0]?.payload.output).not.toHaveProperty('truncation');
      expectValidConversationItems([...startItems, ...items]);
      const history = projectMarAgentHistory(
        { id: 'session-1' } as NodeAgentSession,
        [started, failed].map((event) => ({
          kind: 'event' as const,
          sequence: event.sequence,
          event
        }))
      ).flatMap((turn) => turn.items);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        id: items[0]!.itemId,
        status: 'FAILED',
        payload: items[0]!.payload
      });
      expect(conversationItemSchema.parse(history[0])).toBeDefined();
    }
  );

  it.each([
    ['MAR_AGENT_CODE_FAILED', 'FAILED'],
    ['MAR_AGENT_CANCELLED', 'CANCELLED'],
    ['MAR_AGENT_EXECUTION_CANCELLED', 'CANCELLED']
  ] as const)('keeps a plain Code failure %s separate from output', (code, status) => {
    const normalizer = new MarAgentConversationNormalizer();
    const started = normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'plain-failure',
        input: 'run()'
      })
    );
    const items = normalizer.normalize(
      toolEvent({
        type: 'tool.failed',
        toolName: 'code_exec',
        callId: 'plain-failure',
        code,
        message: 'Stopped.'
      })
    );
    expect(items[0]).toMatchObject({
      itemId: started[0]!.itemId,
      status,
      payload: {
        command: 'run()',
        toolPresentation: { execution: { error: { code, message: 'Stopped.' } } }
      }
    });
    expect(items[0]?.payload).not.toHaveProperty('output');
    expectValidConversationItems(items);
  });

  it.each([
    ['code_exec', ''],
    ['code_exec_wait', ''],
    ['code_exec', 'before failure'],
    ['code_exec_wait', 'before failure']
  ] as const)(
    'shows %s result errors without replacing the call status (observation: %s)',
    (toolName, text) => {
      const normalizer = new MarAgentConversationNormalizer();
      const started = toolEvent({
        type: 'tool.started',
        toolName,
        callId: 'failed-cell',
        input: toolName === 'code_exec' ? { code: 'run()' } : { cellId: 'cell' }
      });
      const data = structuredToolEventData(toolName, {
        cellId: 'cell',
        status: 'failed',
        observations: text
          ? [{ type: 'value', id: 'partial', format: 'text', value: text, truncated: false }]
          : [],
        error: { code: 'MAR_AGENT_CODE_FAILED', message: 'The command failed.' }
      });
      const completed = toolEvent({
        type: 'tool.completed',
        toolName,
        callId: 'failed-cell',
        data
      });
      normalizer.normalize(started);
      const items = normalizer.normalize(completed);
      expect(items[0]).toMatchObject({
        itemId: 'mar-agent-tool:failed-cell',
        kind: 'command_execution',
        status: 'COMPLETED',
        payload: {
          output: { blocks: [{ channel: 'TEXT', text }] },
          toolPresentation: {
            execution: {
              error: { code: 'MAR_AGENT_CODE_FAILED', message: 'The command failed.' }
            }
          }
        }
      });
      if (toolName === 'code_exec_wait')
        expect(items[0]?.payload.toolPresentation).toMatchObject({
          execution: { kind: 'CONTROL', toolName, action: 'poll', targetId: 'cell' }
        });
      expectValidConversationItems(items);
      const history = projectMarAgentHistory(
        { id: 'session-1' } as NodeAgentSession,
        [started, completed].map((event) => ({
          kind: 'event' as const,
          sequence: event.sequence,
          event
        }))
      );
      expect(history.flatMap((turn) => turn.items)[0]?.payload).toMatchObject(items[0]!.payload);
    }
  );
  it.each(['code_exec', 'code_exec_wait'] as const)(
    'keeps explicit SDK head truncation for %s terminal output and history',
    (toolName) => {
      const normalizer = new MarAgentConversationNormalizer();
      const started = toolEvent({
        type: 'tool.started',
        toolName,
        callId: 'head-output',
        input: toolName === 'code_exec' ? { code: 'run()' } : { cellId: 'cell' }
      });
      normalizer.normalize(started);
      const data = structuredToolEventData(toolName, {
        cellId: 'cell',
        status: 'completed',
        truncated: true,
        outputHeadTruncated: true,
        observations: [
          {
            type: 'value',
            id: 'tail',
            format: 'text',
            value: 'retained tail',
            truncated: false
          }
        ]
      });
      const completed = toolEvent({
        type: 'tool.completed',
        toolName,
        callId: 'head-output',
        data,
        outputTruncation: publicOutputTruncation(toolName, data),
        truncated: true
      });
      const items = normalizer.normalize(completed);
      expect(items[0]?.payload.output).toEqual({
        blocks: [{ channel: 'TEXT', text: 'retained tail' }],
        truncation: 'HEAD'
      });
      expect(items[0]).not.toHaveProperty('append');
      expectValidConversationItems(items);
      const history = projectMarAgentHistory(
        { id: 'session-1' } as NodeAgentSession,
        [started, completed].map((event) => ({
          kind: 'event' as const,
          sequence: event.sequence,
          event
        }))
      );
      expect(history.flatMap((turn) => turn.items)[0]?.payload).toMatchObject(items[0]!.payload);
    }
  );
  it.each(['code_exec', 'code_exec_wait'] as const)(
    'does not infer a discarded head from generic %s source truncation',
    (toolName) => {
      const normalizer = new MarAgentConversationNormalizer();
      const started = toolEvent({
        type: 'tool.started',
        toolName,
        callId: 'source-truncation',
        input: toolName === 'code_exec' ? { code: 'run()' } : { cellId: 'cell' }
      });
      normalizer.normalize(started);
      const data = structuredToolEventData(toolName, {
        cellId: 'cell',
        status: 'completed',
        truncated: true,
        observations: [
          { type: 'value', id: 'partial', format: 'text', value: 'partial', truncated: true }
        ]
      });
      const completed = toolEvent({
        type: 'tool.completed',
        toolName,
        callId: 'source-truncation',
        data,
        outputTruncation: publicOutputTruncation(toolName, data),
        truncated: true
      });
      const items = normalizer.normalize(completed);
      expect(items[0]?.payload.output).toEqual({
        blocks: [{ channel: 'TEXT', text: 'partial' }],
        truncation: 'SOURCE'
      });
      expectValidConversationItems(items);
      const history = projectMarAgentHistory(
        { id: 'session-1' } as NodeAgentSession,
        [started, completed].map((event) => ({
          kind: 'event' as const,
          sequence: event.sequence,
          event
        }))
      );
      expect(history.flatMap((turn) => turn.items)[0]?.payload).toMatchObject(items[0]!.payload);
    }
  );
  it('retains the latest long SDK observations through terminal normalization', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'long-code',
        input: { code: 'run()' }
      })
    );
    const data = structuredToolEventData('code_exec', {
      cellId: 'cell',
      status: 'completed',
      observations: [
        {
          type: 'tool_result',
          id: 'one',
          source: { callId: 'inner', toolName: 'exec', input: {} },
          outcome: 'completed',
          result: {
            content: '{"stdout":"wrapped"}',
            data: { stdout: 'x'.repeat(10_100) + '😀TAIL', stderr: 'stderr' }
          }
        },
        { type: 'value', id: 'two', format: 'text', value: 'later observation' }
      ]
    });
    const terminal = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'long-code',
        data,
        outputTruncation: publicOutputTruncation('code_exec', data)
      })
    );
    expect(terminal[0]?.payload).toMatchObject({
      output: {
        truncation: 'HEAD',
        blocks: [
          { channel: 'STDOUT', text: expect.stringMatching(/😀TAIL$/u) },
          { channel: 'STDERR', text: 'stderr' },
          { channel: 'TEXT', text: 'later observation' }
        ]
      }
    });
    expectValidConversationItems(terminal);
  });

  it('uses the public tail snapshot for Code Mode live output, including JSON text', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'outer-live',
        input: { code: 'run()' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: 'inner-live',
        parentCallId: 'outer-live',
        input: { command: 'run' }
      })
    );
    const json = normalizer.normalize(
      toolOutput('inner-live', '{"valid":true}', 'process-1', 'outer-live')
    );
    expect(json[0]?.payload.output).toMatchObject({
      blocks: [{ channel: 'STDOUT', text: '{"valid":true}' }]
    });
    const long = normalizer.normalize(
      toolEvent({
        type: 'tool.output',
        toolName: 'exec',
        callId: 'inner-live',
        parentCallId: 'outer-live',
        output: {
          processId: 'process-1',
          stdout: 'old model buffer',
          stderr: '',
          truncated: true,
          displayOutput: {
            stdout: 'x'.repeat(10_100) + '😀tail',
            stderr: 'rg: error: unclosed group',
            stdoutDroppedBytes: 5,
            stderrDroppedBytes: 0
          }
        }
      })
    );
    expect(long[0]?.payload).toMatchObject({
      output: {
        truncation: 'HEAD',
        blocks: [
          { channel: 'STDOUT', text: expect.stringMatching(/😀tail$/u) },
          { channel: 'STDERR', text: 'rg: error: unclosed group' }
        ]
      }
    });
    expectValidConversationItems([...json, ...long]);
  });

  it.each(['code_exec', 'code_exec_wait'] as const)(
    'keeps stderr-only live %s snapshots separate and replaces them at completion',
    (toolName) => {
      const normalizer = new MarAgentConversationNormalizer();
      normalizer.normalize(
        toolEvent({ type: 'tool.started', toolName, callId: 'outer', input: {} })
      );
      normalizer.normalize(
        toolEvent({
          type: 'tool.started',
          toolName: 'exec',
          callId: 'inner',
          parentCallId: 'outer',
          input: {}
        })
      );
      const live = normalizer.normalize(
        toolEvent({
          type: 'tool.output',
          toolName: 'exec',
          callId: 'inner',
          parentCallId: 'outer',
          output: {
            processId: 'process',
            stdout: '',
            stderr: 'rg: unclosed group',
            truncated: false
          }
        })
      );
      expect(live[0]).toMatchObject({
        status: 'IN_PROGRESS',
        payload: {
          output: { blocks: [{ channel: 'STDERR', text: 'rg: unclosed group' }] }
        }
      });
      const completed = normalizer.normalize(
        toolEvent({ type: 'tool.completed', toolName, callId: 'outer', data: { observations: [] } })
      );
      expect(completed[0]?.payload.output).toEqual({ blocks: [{ channel: 'TEXT', text: '' }] });
      expectValidConversationItems([...live, ...completed]);
    }
  );

  it.each(['code_exec', 'code_exec_wait'] as const)(
    'renders %s exec observations without the SDK result wrapper',
    (toolName) => {
      const normalizer = new MarAgentConversationNormalizer();
      const input =
        toolName === 'code_exec'
          ? { code: 'observe.result(await tools.exec({command: "echo hi"}))' }
          : { cellId: 'cell-1' };
      const started = toolEvent({ type: 'tool.started', toolName, callId: 'outer', input });
      normalizer.normalize(started);
      const data = {
        observations: [
          {
            type: 'tool_result',
            id: 'one',
            source: { callId: 'inner', toolName: 'exec', input: {} },
            outcome: 'completed',
            result: {
              content: '{"stdout":"hello","exitCode":0}',
              data: { stdout: 'hello', stderr: 'warning', exitCode: 2 }
            }
          },
          {
            type: 'tool_result',
            id: 'two',
            source: { callId: 'inner-wait', toolName: 'exec_wait', input: {} },
            outcome: 'completed',
            result: {
              content: '{"stdout":"done","status":"completed"}',
              data: { stdout: 'done', stderr: '' }
            }
          },
          { type: 'value', id: 'three', format: 'json', value: '{"stdout":"user content"}' }
        ]
      };
      const completed = toolEvent({
        type: 'tool.completed',
        toolName,
        callId: 'outer',
        data,
        summary: JSON.stringify(data)
      });
      const result = normalizer.normalize(completed);
      expect(result[0]?.payload.output).toMatchObject({
        blocks: [
          { channel: 'STDOUT', text: 'hello\ndone' },
          { channel: 'STDERR', text: 'warning' },
          { channel: 'TEXT', text: '{"stdout":"user content"}' }
        ]
      });
      expect(result[0]).toMatchObject({ status: 'COMPLETED', payload: { exitCode: null } });
      expectValidConversationItems(result);
      const history = projectMarAgentHistory(
        { id: 'session-1' } as NodeAgentSession,
        [started, completed].map((event) => ({
          kind: 'event' as const,
          sequence: event.sequence,
          event
        }))
      );
      expect(history.flatMap((turn) => turn.items)[0]?.payload).toMatchObject(result[0]!.payload);
    }
  );

  it('retains stderr across multiple observed commands within the existing block limit', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'many',
        input: { code: 'run()' }
      })
    );
    const data = structuredToolEventData('code_exec', {
      cellId: 'cell',
      status: 'completed',
      observations: Array.from({ length: 6 }, (_, index) => ({
        type: 'tool_result',
        id: `result-${index}`,
        source: { callId: `exec-${index}`, toolName: 'exec', input: {} },
        outcome: 'completed',
        result: { content: '', data: { stdout: `out-${index}`, stderr: `err-${index}` } }
      }))
    });
    const items = normalizer.normalize(
      toolEvent({ type: 'tool.completed', toolName: 'code_exec', callId: 'many', data })
    );
    expect(items[0]?.payload.output).toMatchObject({
      blocks: [
        { channel: 'STDOUT', text: 'out-0\nout-1\nout-2\nout-3\nout-4\nout-5' },
        { channel: 'STDERR', text: 'err-0\nerr-1\nerr-2\nerr-3\nerr-4\nerr-5' }
      ]
    });
    expectValidConversationItems(items);
  });

  it('keeps each wait independent and never rewrites the exec item across turns', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const display = (stdout: string) => ({
      stdout,
      stderr: '',
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    });
    const all = [
      ...normalizer.normalize(
        toolEvent({
          type: 'tool.started',
          toolName: 'exec',
          callId: 'start',
          input: { command: 'run' }
        })
      )
    ];
    all.push(
      ...normalizer.normalize(
        toolEvent({
          type: 'tool.completed',
          toolName: 'exec',
          callId: 'start',
          data: {
            status: 'running',
            processId: 'p1',
            stdout: 'first',
            stderr: '',
            displayOutput: display('first')
          }
        })
      )
    );
    const original = all.at(-1);
    for (const [id, text] of [
      ['p1-call', 'first second'],
      ['p2-call', 'first second third']
    ] as const) {
      const turnId = `turn-${id}`;
      all.push(
        ...normalizer.normalize(
          toolEvent({
            type: 'tool.started',
            toolName: 'exec_wait',
            callId: id,
            turnId,
            input: { processId: 'p1' }
          })
        )
      );
      const progress = normalizer.normalize(
        toolEvent({
          type: 'tool.output',
          toolName: 'exec_wait',
          callId: id,
          turnId,
          output: {
            processId: 'p1',
            stdout: text,
            stderr: '',
            truncated: false,
            displayOutput: display(text)
          }
        })
      );
      expect(progress[0]?.payload.toolPresentation).toMatchObject({
        execution: { kind: 'CONTROL' }
      });
      expect(progress[0]?.payload.output).toMatchObject({
        blocks: [
          { channel: 'STDOUT', text },
          { channel: 'STDERR', text: '' }
        ]
      });
      all.push(...progress);
      all.push(
        ...normalizer.normalize(
          toolEvent({
            type: 'tool.completed',
            toolName: 'exec_wait',
            callId: id,
            turnId,
            data: {
              status: 'running',
              waitOutcome: 'timeout',
              processId: 'p1',
              stdout: text.split(' ').at(-1),
              stderr: '',
              displayOutput: display(text)
            }
          })
        )
      );
    }
    expect(new Set(all.map((item) => item.itemId)).size).toBe(3);
    expect(original?.payload.toolPresentation).toMatchObject({
      execution: { kind: 'SHELL' }
    });
    expect(outputText(original)).toBe('first');
    expect(all.at(-1)?.payload.toolPresentation).toMatchObject({
      kind: 'EXECUTION',
      execution: {
        kind: 'CONTROL'
      }
    });
    expect(outputText(all.at(-1))).toBe('first second third');
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'fail',
        input: { processId: 'p1' }
      })
    );
    const failed = normalizer.normalize(
      toolEvent({
        type: 'tool.failed',
        toolName: 'exec_wait',
        callId: 'fail',
        code: 'NOT_FOUND',
        message: 'Wait failed'
      })
    );
    expect(failed[0]?.status).toBe('FAILED');
    expect(failed[0]?.itemId).not.toBe(original?.itemId);
    expect(failed[0]?.payload.toolPresentation).toMatchObject({
      execution: { kind: 'CONTROL', error: { code: 'NOT_FOUND', message: 'Wait failed' } }
    });
    expectValidConversationItems([...all, ...failed]);
  });

  it.each([
    [undefined, 'tool.completed', undefined],
    ['poll', 'tool.completed', undefined],
    ['write', 'tool.completed', undefined],
    ['cancel', 'tool.completed', undefined],
    ['poll', 'tool.failed', 'PROCESS_NOT_FOUND'],
    ['poll', 'tool.failed', 'MAR_AGENT_CANCELLED']
  ])('projects unlinked exec_wait as a command (%s, %s, %s)', (action, terminalType, code) => {
    const normalizer = new MarAgentConversationNormalizer();
    const input = { processId: 'untracked-process', yieldMs: 1000, ...(action ? { action } : {}) };
    const events = [
      toolEvent({ type: 'tool.started', toolName: 'exec_wait', callId: 'wait', input }),
      toolEvent({
        type: terminalType,
        toolName: 'exec_wait',
        callId: 'wait',
        ...(terminalType === 'tool.completed'
          ? {
              summary: 'Command completed.',
              data: {
                status: 'completed',
                processId: input.processId,
                stdout: 'verified',
                exitCode: 0
              }
            }
          : { code, message: 'Wait failed.' })
      })
    ];
    const items = events.flatMap((event) => normalizer.normalize(event));
    const status =
      terminalType === 'tool.completed'
        ? 'COMPLETED'
        : code === 'MAR_AGENT_CANCELLED'
          ? 'CANCELLED'
          : 'FAILED';
    expect(items).toMatchObject([
      {
        itemId: 'mar-agent-tool:wait',
        kind: 'command_execution',
        status: 'IN_PROGRESS',
        payload: {
          command: '',
          toolPresentation: {
            kind: 'EXECUTION',
            execution: { kind: 'CONTROL', toolName: 'exec_wait' }
          }
        }
      },
      { itemId: 'mar-agent-tool:wait', kind: 'command_execution', status }
    ]);
    expect(items[1]!.payload.toolPresentation).toMatchObject({ execution: { kind: 'CONTROL' } });
    expect(items[0]!.payload.toolPresentation).toMatchObject({
      execution: { action: action ?? 'poll' }
    });
    if (terminalType === 'tool.completed') expect(outputText(items[1])).toContain('verified');
    else
      expect(items[1]!.payload.toolPresentation).toMatchObject({ execution: { error: { code } } });
    expectValidConversationItems(items);

    const history = projectMarAgentHistory(
      { id: 'session-1' } as NodeAgentSession,
      events.map((event) => ({ kind: 'event' as const, sequence: event.sequence, event }))
    );
    expect(history.flatMap((turn) => turn.items)).toMatchObject([
      { id: 'mar-agent-tool:wait', kind: 'command_execution', status, payload: items[1]!.payload }
    ]);
    expect(history.flatMap((turn) => turn.items)[0]?.payload).toMatchObject({
      toolPresentation: { execution: { kind: 'CONTROL' } }
    });
  });

  it('updates unlinked exec_wait progress and replaces it with the formal result', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const started = toolEvent({
      type: 'tool.started',
      toolName: 'exec_wait',
      callId: 'unlinked-wait',
      input: { processId: 'process-1', action: 'poll' }
    });
    normalizer.normalize(started);
    const output = (text: string, processId = 'process-1') =>
      toolOutput('unlinked-wait', text, processId, undefined, 'exec_wait');
    const first = normalizer.normalize(output('first snapshot'));
    const second = normalizer.normalize(output('latest snapshot'));
    expect(second).toMatchObject([
      {
        itemId: 'mar-agent-tool:unlinked-wait',
        kind: 'command_execution',
        status: 'IN_PROGRESS',
        payload: {
          command: '',
          toolPresentation: {
            kind: 'EXECUTION',
            execution: { kind: 'CONTROL', toolName: 'exec_wait' }
          },
          output: {
            blocks: [
              { channel: 'STDOUT', text: 'latest snapshot' },
              { channel: 'STDERR', text: '' }
            ]
          }
        }
      }
    ]);
    expect(outputText(second[0])).not.toContain('first snapshot');
    expect(normalizer.normalize(output('wrong process', 'process-2'))).toEqual([]);
    expect(
      normalizer.normalize({ ...output('wrong execution'), executionId: 'execution-2' })
    ).toEqual([]);
    expect(normalizer.normalize({ ...output('wrong turn'), turnId: 'turn-2' })).toEqual([]);
    const completed = toolEvent({
      type: 'tool.completed',
      toolName: 'exec_wait',
      callId: 'unlinked-wait',
      data: { status: 'completed', processId: 'process-1', stdout: 'formal output', exitCode: 0 }
    });
    const final = normalizer.normalize(completed);
    expect(final).toMatchObject([
      {
        itemId: 'mar-agent-tool:unlinked-wait',
        kind: 'command_execution',
        status: 'COMPLETED',
        payload: { output: { blocks: [{ channel: 'STDOUT', text: 'formal output' }] } }
      }
    ]);
    expect(outputText(final[0])).not.toContain('latest snapshot');
    expect(normalizer.normalize(output('late output'))).toEqual([]);
    expectValidConversationItems([...first, ...second, ...final]);
    const history = projectMarAgentHistory(
      { id: 'session-1' } as NodeAgentSession,
      [started, completed].map((event) => ({
        kind: 'event' as const,
        sequence: event.sequence,
        event
      }))
    );
    expect(history.flatMap((turn) => turn.items)).toMatchObject([
      { id: final[0]!.itemId, status: 'COMPLETED', payload: final[0]!.payload }
    ]);
  });

  it('replaces repeated Direct snapshots and converges to the formal exec result once', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const started = toolEvent({
      type: 'tool.started',
      toolName: 'exec',
      callId: 'exec-call',
      input: { command: 'printf progress' }
    });

    expect(normalizer.normalize(started)).toMatchObject([
      { itemId: 'mar-agent-tool:exec-call', kind: 'command_execution', status: 'IN_PROGRESS' }
    ]);

    const first = normalizer.normalize(toolOutput('exec-call', 'first snapshot'));
    const second = normalizer.normalize(toolOutput('exec-call', 'final snapshot'));
    expect(outputText(second[0])).toBe('final snapshot');
    expect(outputText(second[0])).not.toContain('first snapshot');
    expect(second[0]?.status).toBe('IN_PROGRESS');
    expectValidConversationItems([...first, ...second]);

    const completed = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'exec-call',
        data: {
          status: 'completed',
          stdout: 'final snapshot',
          stderr: '',
          exitCode: 0
        }
      })
    );

    expect(completed[0]).toMatchObject({
      itemId: 'mar-agent-tool:exec-call',
      kind: 'command_execution',
      status: 'COMPLETED',
      payload: {
        output: { blocks: [{ channel: 'COMBINED', text: 'final snapshot' }] },
        exitCode: 0
      }
    });
    expect(outputText(completed[0])).not.toContain('final snapshot\nfinal snapshot');
    expect(normalizer.normalize(toolOutput('exec-call', 'late background output'))).toEqual([]);
    expectValidConversationItems(completed);
  });

  it('bounds live previews without carrying their truncation into the formal result', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: 'bounded',
        input: { command: 'fixture' }
      })
    );
    const progress = normalizer.normalize(toolOutput('bounded', '🙂'.repeat(10_000)));
    expect(progress[0]?.payload.output).toMatchObject({ truncation: 'HEAD' });
    expect(String(outputText(progress[0])).length).toBeLessThanOrEqual(10_000);
    expect(String(outputText(progress[0]))).not.toContain('�');
    const completed = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'bounded',
        data: {
          status: 'completed',
          stdout: 'formal result',
          stderr: '',
          exitCode: 0,
          truncated: false
        }
      })
    );
    expect(completed[0]?.payload).toMatchObject({
      output: { blocks: [{ channel: 'COMBINED', text: 'formal result' }] }
    });
    expectValidConversationItems([...progress, ...completed]);
  });

  it('keeps later poll snapshots separate from cached formal output', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const base = normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: 'exec-call',
        input: { command: 'long-running command' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'exec-call',
        data: { status: 'running', processId: 'process-1', stdout: 'initial output' }
      })
    );

    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'poll-1',
        input: { action: 'poll', processId: 'process-1' }
      })
    );
    const cachedSnapshot = normalizer.normalize(
      toolOutput('poll-1', 'stale cached snapshot', 'process-1', undefined, 'exec_wait')
    );
    expect(outputText(cachedSnapshot[0])).toContain('stale cached snapshot');
    const cachedResult = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec_wait',
        callId: 'poll-1',
        data: {
          status: 'running',
          processId: 'process-1',
          stdout: 'cached formal output',
          stderr: '',
          cached: true
        }
      })
    );
    expect(outputText(cachedResult[0])).toBe('cached formal output');

    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'poll-2',
        input: { action: 'poll', processId: 'process-1' }
      })
    );
    const nextSnapshot = normalizer.normalize(
      toolOutput('poll-2', 'second poll progress', 'process-1', undefined, 'exec_wait')
    );
    expect(outputText(nextSnapshot[0])).toBe('second poll progress');
    expect(nextSnapshot[0]?.itemId).not.toBe(cachedResult[0]?.itemId);
    const nextResult = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec_wait',
        callId: 'poll-2',
        data: {
          status: 'running',
          processId: 'process-1',
          stdout: 'cached formal output\nsecond poll result',
          stderr: '',
          cached: true
        }
      })
    );

    expect(outputText(nextResult[0])).toBe('cached formal output\nsecond poll result');
    expect(outputText(nextResult[0])).not.toContain('second poll progress');
    expect(
      normalizer.normalize(
        toolOutput('poll-2', 'late poll output', 'process-1', undefined, 'exec_wait')
      )
    ).toEqual([]);
    expectValidConversationItems([
      ...base,
      ...cachedSnapshot,
      ...cachedResult,
      ...nextSnapshot,
      ...nextResult
    ]);
  });

  it('isolates a later-turn poll from output events belonging to a completed call', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: 'old-exec',
        input: { command: 'long-running command' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec',
        callId: 'old-exec',
        data: { status: 'running', processId: 'process-1', stdout: 'old output' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'new-turn-poll',
        input: { action: 'poll', processId: 'process-1' },
        executionId: 'execution-2',
        turnId: 'turn-2'
      })
    );

    expect(normalizer.normalize(toolOutput('old-exec', 'late old output'))).toEqual([]);
    const current = normalizer.normalize(
      toolEvent({
        type: 'tool.output',
        toolName: 'exec_wait',
        callId: 'new-turn-poll',
        executionId: 'execution-2',
        turnId: 'turn-2',
        output: {
          processId: 'process-1',
          stdout: 'new turn progress',
          stderr: '',
          truncated: false
        }
      })
    );
    expect(current[0]).toMatchObject({
      itemId: 'mar-agent-tool:new-turn-poll',
      status: 'IN_PROGRESS',
      payload: {
        output: {
          blocks: [
            { channel: 'STDOUT', text: 'new turn progress' },
            { channel: 'STDERR', text: '' }
          ]
        }
      }
    });
    expect(outputText(current[0])).not.toContain('old output');
    expectValidConversationItems(current);
  });

  it('clears Direct progress on failure and ignores output already in flight', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: 'failed-exec',
        input: { command: 'long-running command' }
      })
    );
    normalizer.normalize(toolOutput('failed-exec', 'temporary output'));

    const failed = normalizer.normalize(
      toolEvent({
        type: 'tool.failed',
        toolName: 'exec',
        callId: 'failed-exec',
        code: 'MAR_AGENT_CANCELLED',
        message: 'Command cancelled.'
      })
    );
    expect(failed[0]).toMatchObject({
      itemId: 'mar-agent-tool:failed-exec',
      status: 'FAILED',
      payload: { toolPresentation: { execution: { error: { code: 'MAR_AGENT_CANCELLED' } } } }
    });
    expect(normalizer.normalize(toolOutput('failed-exec', 'late output'))).toEqual([]);
    expectValidConversationItems(failed);
  });

  it('replaces concurrent Code Mode snapshots by internal callId and lets the outer result win', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const outerStart = normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: 'outer-call',
        input: { code: 'await Promise.all([first(), second()]);' }
      })
    );
    for (const callId of ['inner-1', 'inner-2'])
      normalizer.normalize(
        toolEvent({
          type: 'tool.started',
          toolName: 'exec',
          callId,
          parentCallId: 'outer-call',
          input: { command: callId }
        })
      );

    const first = normalizer.normalize(
      toolOutput('inner-1', 'first snapshot', 'process-1', 'outer-call')
    );
    const second = normalizer.normalize(
      toolOutput('inner-2', 'second snapshot', 'process-2', 'outer-call')
    );
    const replaced = normalizer.normalize(
      toolOutput('inner-1', 'first replacement', 'process-1', 'outer-call')
    );
    expect(outputText(first[0])).toBe('first snapshot');
    expect(outputText(second[0])).toBe('first snapshotsecond snapshot');
    expect(replaced[0]).toMatchObject({
      itemId: 'mar-agent-tool:outer-call',
      kind: 'command_execution',
      status: 'IN_PROGRESS'
    });
    expect(outputText(replaced[0])).toContain('first replacement');
    expect(outputText(replaced[0])).toContain('second snapshot');
    expect(replaced[0]?.payload.toolPresentation).toMatchObject({ execution: { kind: 'CODE' } });
    expect(outputText(replaced[0])).not.toContain('first snapshot');
    expectValidConversationItems([...outerStart, ...replaced]);

    const completed = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: 'outer-call',
        summary: 'authoritative outer result'
      })
    );
    expect(completed[0]).toMatchObject({
      itemId: 'mar-agent-tool:outer-call',
      status: 'COMPLETED',
      payload: { outputSummary: 'authoritative outer result' }
    });
    expect(outputText(completed[0])).not.toContain('first replacement');
    expect(
      normalizer.normalize(toolOutput('inner-1', 'late child output', 'process-1', 'outer-call'))
    ).toEqual([]);
    expectValidConversationItems(completed);
  });

  it('routes retained running-cell output to the active same-execution wait card only', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const sourceCallId = 'long-cell-source';
    const sourceStart = normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: sourceCallId,
        input: { code: 'await tools.exec_wait({ processId, yieldMs: 300000 });' }
      })
    );
    const childCallId = 'long-cell-exec-wait';
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: childCallId,
        parentCallId: sourceCallId,
        input: { action: 'poll', processId: 'process-long' }
      })
    );
    const sourceProgress = normalizer.normalize(
      toolOutput(childCallId, 'before yield', 'process-long', sourceCallId, 'exec_wait')
    );
    const yielded = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: sourceCallId,
        summary: 'Cell yielded while still running.',
        data: { cellId: 'cell-long', status: 'running' }
      })
    );
    expect(yielded[0]).toMatchObject({
      itemId: `mar-agent-tool:${sourceCallId}`,
      status: 'COMPLETED'
    });

    const firstWaitStart = normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec_wait',
        callId: 'outer-wait-1',
        input: { cellId: 'cell-long', yieldMs: 30_000 },
        turnId: 'turn-2'
      })
    );
    const firstWaitProgress = normalizer.normalize(
      toolOutput(childCallId, 'first resumed snapshot', 'process-long', sourceCallId, 'exec_wait')
    );
    expect(firstWaitProgress[0]).toMatchObject({
      itemId: 'mar-agent-tool:outer-wait-1',
      kind: 'command_execution',
      status: 'IN_PROGRESS'
    });
    expect(outputText(firstWaitProgress[0])).toContain('first resumed snapshot');
    expect(firstWaitProgress[0]?.itemId).not.toBe(`mar-agent-tool:${sourceCallId}`);

    const firstWaitYield = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'code_exec_wait',
        callId: 'outer-wait-1',
        summary: 'Cell still running.',
        data: { cellId: 'cell-long', status: 'running' },
        turnId: 'turn-2'
      })
    );
    expect(
      normalizer.normalize(
        toolOutput(childCallId, 'between waits', 'process-long', sourceCallId, 'exec_wait')
      )
    ).toEqual([]);

    normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'exec_wait',
        callId: childCallId,
        parentCallId: sourceCallId
      })
    );
    const nextChildCallId = 'next-command-between-waits';
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec',
        callId: nextChildCallId,
        parentCallId: sourceCallId,
        input: { command: 'next command' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec_wait',
        callId: 'outer-wait-2',
        input: { cellId: 'cell-long', yieldMs: 30_000 },
        turnId: 'turn-3'
      })
    );
    const secondWaitProgress = normalizer.normalize(
      toolOutput(nextChildCallId, 'second resumed snapshot', 'process-next', sourceCallId)
    );
    expect(secondWaitProgress[0]).toMatchObject({
      itemId: 'mar-agent-tool:outer-wait-2',
      status: 'IN_PROGRESS'
    });

    const finished = normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'code_exec_wait',
        callId: 'outer-wait-2',
        summary: 'Cell completed.',
        data: { cellId: 'cell-long', status: 'completed' },
        turnId: 'turn-3'
      })
    );
    expect(finished[0]).toMatchObject({
      itemId: 'mar-agent-tool:outer-wait-2',
      status: 'COMPLETED'
    });
    expect(
      normalizer.normalize(
        toolOutput(
          childCallId,
          'late after terminal cell',
          'process-long',
          sourceCallId,
          'exec_wait'
        )
      )
    ).toEqual([]);
    expectValidConversationItems([
      ...sourceStart,
      ...sourceProgress,
      ...yielded,
      ...firstWaitStart,
      ...firstWaitProgress,
      ...firstWaitYield,
      ...secondWaitProgress,
      ...finished
    ]);
  });

  it('drops retained-cell output after a new Execution starts', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const sourceCallId = 'previous-execution-cell';
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec',
        callId: sourceCallId,
        input: { code: 'await tools.exec_wait({ processId, yieldMs: 300000 });' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'exec_wait',
        callId: 'previous-execution-child',
        parentCallId: sourceCallId,
        input: { action: 'poll', processId: 'process-long' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.completed',
        toolName: 'code_exec',
        callId: sourceCallId,
        data: { cellId: 'cell-previous', status: 'running' }
      })
    );
    normalizer.normalize(
      toolEvent({
        type: 'tool.started',
        toolName: 'code_exec_wait',
        callId: 'previous-execution-wait',
        input: { cellId: 'cell-previous', yieldMs: 30_000 },
        turnId: 'turn-2'
      })
    );
    normalizer.normalize(
      toolEvent({ type: 'execution.started', executionId: 'execution-2', turnId: 'turn-3' })
    );

    expect(
      normalizer.normalize(
        toolEvent({
          type: 'tool.output',
          toolName: 'exec_wait',
          callId: 'previous-execution-child',
          parentCallId: sourceCallId,
          output: {
            processId: 'process-long',
            stdout: 'must not cross execution boundary',
            stderr: '',
            truncated: false
          }
        })
      )
    ).toEqual([]);
  });

  it('ignores output for an unknown Code Mode parent', () => {
    const normalizer = new MarAgentConversationNormalizer();
    expect(
      normalizer.normalize(
        toolOutput('unknown-child', 'must not project', 'process-1', 'unknown-parent')
      )
    ).toEqual([]);
  });
});

let sequence = 0;

function outputText(
  item: ReturnType<MarAgentConversationNormalizer['normalize']>[number] | undefined
): string {
  const output = item?.payload.output as { blocks?: Array<{ text: string }> } | undefined;
  return (output?.blocks ?? [])
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n');
}

describe('retained wait source updates', () => {
  it.each([
    { toolName: 'exec_wait', mode: 'snapshot', cancelled: false },
    { toolName: 'exec_wait', mode: 'delta', cancelled: true },
    { toolName: 'code_exec_wait', mode: 'delta', cancelled: false },
    { toolName: 'code_exec_wait', mode: 'snapshot', cancelled: true }
  ])(
    'keeps $toolName sources through $mode output and terminal events (cancelled=$cancelled)',
    ({ toolName, mode, cancelled }) => {
      const normalizer = new MarAgentConversationNormalizer();
      const source =
        toolName === 'exec_wait'
          ? { kind: 'SHELL', text: 'original command', cwd: '/workspace', truncated: false }
          : { kind: 'CODE', text: 'await tools.read({reads:[]});', truncated: false };
      const input =
        toolName === 'exec_wait' ? { processId: 'p_123456789abc' } : { cellId: 'c_123456789abc' };
      const callId = 'retained-wait';
      const events = [
        toolEvent({ type: 'tool.started', toolName, callId, input }),
        toolEvent({ type: 'tool.updated', toolName, callId, data: { executionSource: source } }),
        toolEvent({
          type: 'tool.output',
          toolName,
          callId,
          output: {
            mode,
            processId: 'p_123456789abc',
            stdout: 'live output',
            stderr: '',
            truncated: false
          }
        }),
        toolEvent(
          cancelled
            ? {
                type: 'tool.failed',
                toolName,
                callId,
                code: 'MAR_AGENT_EXECUTION_CANCELLED',
                message: 'Stopped',
                data: {}
              }
            : { type: 'tool.completed', toolName, callId, summary: 'Done', data: {} }
        )
      ];
      normalizer.normalize(events[0]!);
      const running = normalizer.normalize(events[1]!);
      expect(running).toHaveLength(1);
      expect(running[0]).toMatchObject({
        status: 'IN_PROGRESS',
        payload: {
          toolPresentation: { execution: { kind: 'CONTROL', source } }
        }
      });
      const output = normalizer.normalize(events[2]!);
      expect(output[0]?.payload).toMatchObject({ toolPresentation: { execution: { source } } });
      const terminal = normalizer.normalize(events[3]!);
      expect(terminal[0]).toMatchObject({
        status: cancelled ? 'CANCELLED' : 'COMPLETED',
        payload: {
          toolPresentation: { execution: { source } }
        }
      });
      const history = projectMarAgentHistory(
        { id: 'session-1' } as NodeAgentSession,
        events.map((event) => ({ kind: 'event' as const, sequence: event.sequence, event }))
      ).flatMap((turn) => turn.items);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        id: terminal[0]!.itemId,
        status: terminal[0]!.status,
        payload: terminal[0]!.payload
      });
      expectValidConversationItems([...running, ...output, ...terminal]);
    }
  );

  it('ignores unknown, stale, malformed and late source updates', () => {
    const normalizer = new MarAgentConversationNormalizer();
    const toolName = 'code_exec_wait';
    const callId = 'source-identity';
    const data = { executionSource: { kind: 'CODE', text: 'original code', truncated: false } };
    const update = { type: 'tool.updated', toolName, callId, data };
    expect(normalizer.normalize(toolEvent(update))).toEqual([]);
    normalizer.normalize(
      toolEvent({ type: 'tool.started', toolName, callId, input: { cellId: 'c_123456789abc' } })
    );
    for (const changes of [
      { executionId: 'stale' },
      { turnId: 'stale' },
      { toolName: 'exec_wait' },
      { data: { executionSource: { kind: 'OTHER', text: 'invalid' } } }
    ])
      expect(normalizer.normalize(toolEvent({ ...update, ...changes }))).toEqual([]);
    expect(normalizer.normalize(toolEvent(update))).toHaveLength(1);
    normalizer.normalize(toolEvent({ type: 'tool.completed', toolName, callId, summary: 'Done' }));
    expect(normalizer.normalize(toolEvent(update))).toEqual([]);
  });
});

function toolEvent(fields: Record<string, unknown>): AgentEvent {
  sequence += 1;
  return {
    eventId: `output-event-${sequence}`,
    sequence,
    timestamp: '2026-10-26T00:00:00.000Z',
    sessionId: 'session-1',
    executionId: 'execution-1',
    turnId: 'turn-1',
    ...fields
  } as unknown as AgentEvent;
}

function toolOutput(
  callId: string,
  stdout: string,
  processId = 'process-1',
  parentCallId?: string,
  toolName: 'exec' | 'exec_wait' = 'exec'
): AgentEvent {
  return toolEvent({
    type: 'tool.output',
    toolName,
    callId,
    ...(parentCallId === undefined ? {} : { parentCallId }),
    output: { processId, stdout, stderr: '', truncated: false }
  });
}

function expectValidConversationItems(
  items: readonly ReturnType<MarAgentConversationNormalizer['normalize']>[number][]
): void {
  for (const [index, item] of items.entries())
    expect(
      conversationItemSchema.parse({
        id: item.itemId,
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        parentItemId: null,
        sourceSequence: index + 1,
        revision: 0,
        status: item.status,
        startedAt: 0,
        completedAt: item.status === 'IN_PROGRESS' ? null : 1,
        kind: item.kind,
        payload: item.payload,
        ...(item.permissionStop === undefined ? {} : { permissionStop: item.permissionStop })
      })
    ).toBeDefined();
}
