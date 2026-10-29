import { describe, expect, it } from 'vitest';
import { conversationItemSchema } from '@myagentroam/protocol';
import type { AgentEvent } from '@myagentroam/agent';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import { structuredToolEventData } from '../../../mar-agent/src/tools/output-projection.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';

describe('MAR Agent live tool output projection', () => {
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
      text: expect.stringContaining('A'),
      truncated: false
    });
    expect(result[0]?.payload.output).toMatchObject({ text: expect.stringContaining('BC') });
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
    expect(poll[0]?.payload.output).toMatchObject({ text: 'ABCD', truncated: false });
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
    expect(revisited[0]?.payload.output).toMatchObject({ text: 'ABCD', truncated: false });
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
      text: expect.stringMatching(/TAIL$/),
      truncated: true
    });
    expect(result[0]?.payload.toolPresentation).toMatchObject({
      execution: { truncation: { output: 'HEAD' } }
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
          toolPresentation: {
            execution: {
              output: [
                { channel: 'STDOUT', text: 'new' },
                { channel: 'STDERR', text: 'err' }
              ]
            }
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
            output: { text: 'new\nerr' },
            toolPresentation: {
              execution: {
                output: [
                  { channel: 'STDOUT', text: 'new' },
                  { channel: 'STDERR', text: 'err' }
                ]
              }
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
        payload: { output: { text: '  Request stopped.\n', truncated: false }, errorCode: code }
      });
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
      const completed = toolEvent({
        type: 'tool.completed',
        toolName,
        callId: 'public-output',
        summary: text
      });
      expect(normalizer.normalize(started)[0]?.payload).not.toHaveProperty('output');
      const items = normalizer.normalize(completed);
      expect(items[0]?.payload).toMatchObject({
        output: { text: text.slice(-10_000), truncated: true }
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
          summary: ''
        })
      );
      expect(empty[0]?.payload).toMatchObject({ output: { text: '', truncated: false } });
    }
  );

  it.each(['code_exec', 'code_exec_wait'] as const)(
    'shows %s result errors without replacing the call status',
    (toolName) => {
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
        observations: [],
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
        status: 'COMPLETED',
        payload: {
          toolPresentation: {
            execution: {
              error: { code: 'MAR_AGENT_CODE_FAILED', message: 'The command failed.' },
              output: [{ channel: 'TEXT', text: '' }]
            }
          }
        }
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
    'keeps SDK source truncation at the head for %s terminal output and history',
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
        observations: [
          {
            type: 'value',
            id: 'tail',
            format: 'text',
            value: 'retained tail',
            truncated: true
          }
        ]
      });
      const completed = toolEvent({
        type: 'tool.completed',
        toolName,
        callId: 'head-output',
        data,
        truncated: true
      });
      const items = normalizer.normalize(completed);
      expect(items[0]?.payload.toolPresentation).toMatchObject({
        execution: {
          truncation: { output: 'HEAD' },
          output: [{ channel: 'TEXT', text: 'retained tail' }]
        }
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
      toolEvent({ type: 'tool.completed', toolName: 'code_exec', callId: 'long-code', data })
    );
    expect(terminal[0]?.payload).toMatchObject({
      truncated: true,
      toolPresentation: {
        execution: {
          truncation: { output: 'HEAD' },
          output: [
            { channel: 'STDOUT', text: expect.stringMatching(/😀TAIL$/u) },
            { channel: 'STDERR', text: 'stderr' },
            { channel: 'TEXT', text: 'later observation' }
          ]
        }
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
    expect(json[0]?.payload.toolPresentation).toMatchObject({
      execution: { output: [{ channel: 'STDOUT', text: '{"valid":true}' }] }
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
      truncated: true,
      outputPreview: expect.stringMatching(/😀tail\nrg: error: unclosed group$/u),
      toolPresentation: {
        execution: {
          truncation: { output: 'HEAD' },
          output: [
            { channel: 'STDOUT', text: expect.stringMatching(/😀tail$/u) },
            { channel: 'STDERR', text: 'rg: error: unclosed group' }
          ]
        }
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
          toolPresentation: {
            execution: { output: [{ channel: 'STDERR', text: 'rg: unclosed group' }] }
          }
        }
      });
      const completed = normalizer.normalize(
        toolEvent({ type: 'tool.completed', toolName, callId: 'outer', data: { observations: [] } })
      );
      expect(completed[0]?.payload.toolPresentation).toMatchObject({
        execution: { output: [{ channel: 'TEXT', text: '' }] }
      });
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
      expect(result[0]?.payload.toolPresentation).toMatchObject({
        execution: {
          output: [
            { channel: 'STDOUT', text: 'hello\ndone' },
            { channel: 'STDERR', text: 'warning' },
            { channel: 'TEXT', text: '{"stdout":"user content"}' }
          ]
        }
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
    expect(items[0]?.payload.toolPresentation).toMatchObject({
      execution: {
        output: [
          { channel: 'STDOUT', text: 'out-0\nout-1\nout-2\nout-3\nout-4\nout-5' },
          { channel: 'STDERR', text: 'err-0\nerr-1\nerr-2\nerr-3\nerr-4\nerr-5' }
        ]
      }
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
        execution: {
          kind: 'CONTROL',
          output: [
            { channel: 'STDOUT', text },
            { channel: 'STDERR', text: '' }
          ]
        }
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
      execution: {
        kind: 'SHELL',
        output: [
          { channel: 'STDOUT', text: 'first' },
          { channel: 'STDERR', text: '' }
        ]
      }
    });
    expect(all.at(-1)?.payload.toolPresentation).toMatchObject({
      kind: 'EXECUTION',
      execution: {
        kind: 'CONTROL',
        output: [
          { channel: 'STDOUT', text: 'first second third' },
          { channel: 'STDERR', text: '' }
        ]
      }
    });
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
          },
          outputPreview: expect.stringContaining(`Action: ${action ?? 'poll'}`)
        }
      },
      { itemId: 'mar-agent-tool:wait', kind: 'command_execution', status }
    ]);
    expect(items[1]!.payload.toolPresentation).toMatchObject({ execution: { kind: 'CONTROL' } });
    expect(items[1]!.payload.outputPreview).toContain(
      terminalType === 'tool.completed' ? 'verified' : code!
    );
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
          outputPreview: expect.stringContaining('latest snapshot')
        }
      }
    ]);
    expect(second[0]!.payload.outputPreview).not.toContain('first snapshot');
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
        payload: { outputPreview: expect.stringContaining('formal output') }
      }
    ]);
    expect(final[0]!.payload.outputPreview).not.toContain('latest snapshot');
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
    expect(second[0]?.payload.outputPreview).toBe('final snapshot');
    expect(second[0]?.payload.outputPreview).not.toContain('first snapshot');
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
      payload: { outputPreview: 'final snapshot', exitCode: 0 }
    });
    expect(completed[0]?.payload.outputPreview).not.toContain('final snapshot\nfinal snapshot');
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
    expect(progress[0]?.payload.truncated).toBe(true);
    expect(String(progress[0]?.payload.outputPreview).length).toBeLessThanOrEqual(10_000);
    expect(String(progress[0]?.payload.outputPreview)).not.toContain('�');
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
      outputPreview: 'formal result',
      truncated: false
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
    expect(cachedSnapshot[0]?.payload.outputPreview).toContain('stale cached snapshot');
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
    expect(cachedResult[0]?.payload.outputPreview).toBe('cached formal output');

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
    expect(nextSnapshot[0]?.payload.outputPreview).toBe('second poll progress');
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

    expect(nextResult[0]?.payload.outputPreview).toBe('cached formal output\nsecond poll result');
    expect(nextResult[0]?.payload.outputPreview).not.toContain('second poll progress');
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
      payload: { outputPreview: 'new turn progress' }
    });
    expect(current[0]?.payload.outputPreview).not.toContain('old output');
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
      payload: { outputPreview: '' }
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
    expect(first[0]?.payload.outputPreview).toBe('first snapshot');
    expect(second[0]?.payload.outputPreview).toBe('first snapshotsecond snapshot');
    expect(replaced[0]).toMatchObject({
      itemId: 'mar-agent-tool:outer-call',
      kind: 'command_execution',
      status: 'IN_PROGRESS'
    });
    expect(replaced[0]?.payload.outputPreview).toContain('first replacement');
    expect(replaced[0]?.payload.outputPreview).toContain('second snapshot');
    expect(replaced[0]?.payload.toolPresentation).toMatchObject({ execution: { kind: 'CODE' } });
    expect(replaced[0]?.payload.outputPreview).not.toContain('first snapshot');
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
      payload: { outputPreview: 'authoritative outer result' }
    });
    expect(completed[0]?.payload.outputPreview).not.toContain('first replacement');
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
    expect(firstWaitProgress[0]?.payload.outputPreview).toContain('first resumed snapshot');
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
