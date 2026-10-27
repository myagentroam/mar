import { describe, expect, it } from 'vitest';
import { conversationItemSchema } from '@myagentroam/protocol';
import type { AgentEvent } from '@myagentroam/agent';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';

describe('MAR Agent live tool output projection', () => {
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
    expect(nextSnapshot[0]?.payload.outputPreview).toBe(
      'cached formal output\nsecond poll progress'
    );
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
    expect(second[0]?.payload.outputPreview).toBe('first snapshot\nsecond snapshot');
    expect(replaced[0]).toMatchObject({
      itemId: 'mar-agent-tool:outer-call',
      kind: 'command_execution',
      status: 'IN_PROGRESS'
    });
    expect(replaced[0]?.payload.outputPreview).toContain('first replacement');
    expect(replaced[0]?.payload.outputPreview).toContain('second snapshot');
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
