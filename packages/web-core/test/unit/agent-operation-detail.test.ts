import { describe, expect, it } from 'vitest';
import { agentOperationDetail } from '../../src/util/agent-operation-presentation';
import { mergeConversationPayload } from '../../src/util/conversation-history';

describe('Agent operation card projection', () => {
  it('renders native call facts without interpreting legacy summaries or inventing targets', () => {
    expect(
      agentOperationDetail(
        { subagentOperation: 'START', title: 'Review', subagentCallDetail: { message: 'Inspect' } },
        'COMPLETED'
      )
    ).toMatchObject({ action: 'START', title: 'Review', message: 'Inspect', targets: [] });
    expect(
      agentOperationDetail(
        {
          subagentOperation: 'MESSAGE',
          title: 'send_input',
          subagentCallDetail: { message: 'Continue', messageTruncated: true }
        },
        'COMPLETED'
      )
    ).toMatchObject({ action: 'SEND', message: 'Continue', messageTruncated: true, targets: [] });
    expect(
      agentOperationDetail(
        {
          subagentOperation: 'MESSAGE',
          toolName: 'SendMessage',
          title: 'Review',
          subagentCallDetail: { message: 'Continue' }
        },
        'COMPLETED'
      )
    ).toMatchObject({ action: 'SEND', targets: [{ title: 'Review' }] });
    expect(
      agentOperationDetail(
        { subagentOperation: 'START', inputSummary: '{"message":"legacy"}' },
        'COMPLETED'
      )
    ).toBeUndefined();
  });
  it('keeps current message, real delivery and target result without exposing other fields', () => {
    const card = agentOperationDetail(
      {
        agentOperation: {
          action: 'SEND',
          targets: [{ agentId: 'x', title: 'Task' }],
          detail: { message: 'Hello\nworld', delivery: 'QUEUE' }
        },
        inputSummary: 'SECRET',
        outputSummary: 'SECRET'
      },
      'COMPLETED'
    );
    expect(card).toMatchObject({
      action: 'SEND',
      message: 'Hello\nworld',
      delivery: 'QUEUE',
      targets: [{ title: 'Task' }]
    });
    expect(JSON.stringify(card)).not.toContain('SECRET');
  });
  it('shows stop output verbatim and falls back for legacy and failures', () => {
    const output = '{"message":"Not yet stopped"}\n';
    const payload = {
      agentOperation: { action: 'STOP', targets: [{ agentId: 'x', title: 'Task' }], detail: {} },
      output: { blocks: [{ channel: 'TEXT', text: output }] }
    };
    expect(agentOperationDetail(payload, 'COMPLETED')?.output).toBe(output);
    for (const status of ['FAILED', 'DECLINED', 'CANCELLED', 'INTERRUPTED'])
      expect(agentOperationDetail(payload, status)).toBeUndefined();
    expect(
      agentOperationDetail({ agentOperation: { action: 'STOP', targets: [] } }, 'COMPLETED')
    ).toBeUndefined();
  });
  it('does not treat a truncated raw input record as truncated card content', () => {
    for (const action of ['START', 'SEND', 'STOP'] as const) {
      const payload = {
        inputTruncated: true,
        agentOperation: {
          action,
          targets: [{ agentId: 'a', title: 'Task' }],
          detail: action === 'STOP' ? {} : { message: 'Complete message' }
        },
        output: { blocks: [{ channel: 'TEXT', text: 'Complete result' }] }
      };
      expect(agentOperationDetail(payload, 'COMPLETED')).not.toHaveProperty('messageTruncated');
      expect(
        agentOperationDetail(
          {
            ...payload,
            agentOperation: {
              ...payload.agentOperation,
              detail: { message: 'Partial message', messageTruncated: true }
            }
          },
          'COMPLETED'
        )
      ).toHaveProperty('messageTruncated', true);
    }
  });
  it('preserves source truncation and partial failure codes without displaying hidden input', () => {
    const stop = agentOperationDetail(
      {
        agentOperation: { action: 'STOP', targets: [{ agentId: 'a', title: 'Task' }], detail: {} },
        output: { blocks: [{ channel: 'TEXT', text: 'partial' }], truncation: 'SOURCE' }
      },
      'COMPLETED'
    );
    expect(stop).toMatchObject({ output: 'partial', outputTruncation: 'SOURCE' });
    const failed = agentOperationDetail(
      {
        agentOperation: {
          action: 'SEND',
          targets: [{ agentId: 'a', title: 'Task' }],
          detail: { message: 'hello', failed: true, error: 'AGENT_SEND_FAILED' }
        },
        inputSummary: '{"goal":"secret"}'
      },
      'COMPLETED'
    );
    expect(failed).toMatchObject({ message: 'hello', error: 'AGENT_SEND_FAILED' });
    expect(JSON.stringify(failed)).not.toContain('goal');
  });
  it('replaces current WAIT facts atomically instead of retaining a prior message', () => {
    const before = {
      agentOperation: {
        action: 'WAIT',
        detail: {},
        targets: [{ agentId: 'a', title: 'Task', status: 'RUNNING', message: 'old progress' }]
      }
    };
    const after = {
      agentOperation: {
        action: 'WAIT',
        detail: {},
        targets: [{ agentId: 'a', title: 'Task', status: 'SUCCEEDED', message: 'final result' }]
      }
    };
    const merged = mergeConversationPayload(before, after, undefined);
    expect(agentOperationDetail(merged, 'COMPLETED')).toMatchObject({
      targets: [{ title: 'Task', status: 'SUCCEEDED', message: 'final result' }]
    });
    expect(JSON.stringify(merged)).not.toContain('old progress');
  });
});
