import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service';
import AgentOperationDetail from '../../src/view/conversation/tool-detail/AgentOperationDetail.vue';
import { agentOperationDetail } from '../../src/util/agent-operation-presentation';
import { mergeConversationPayload } from '../../src/util/conversation-history';
import { conversationItemText } from '../../src/util/conversation-presentation';

describe('Agent operation card projection', () => {
  it('renders LIST as semantic rows without inventing statuses or session navigation', async () => {
    const html = await renderToString(
      createSSRApp(AgentOperationDetail, {
        agentDetail: {
          action: 'LIST',
          targets: [
            { title: 'Active review', status: 'RUNNING' },
            { title: 'Review <layout>', status: 'IDLE' },
            { title: 'Unknown status' }
          ]
        }
      })
    );
    expect(html).toContain('<ul');
    expect(html.match(/<li\b/gu)).toHaveLength(3);
    expect(html).toContain('Review &lt;layout&gt;');
    expect(html).toContain('Unknown status');
    expect(html).not.toContain('<a');
    expect(html.match(/conversation-list-marker/gu)).toHaveLength(2);
    expect(html.match(/agent-list-status--running/gu)).toHaveLength(1);
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'formats WAIT durations with the shared duration units in %s',
    async (locale) => {
      const previousLocale = i18n.global.locale.value;
      const preference = localePreferenceService();
      preference.setLocale(locale);
      try {
        for (const [waitMs, english, chinese] of [
          [0, '0 sec', '0 秒'],
          [250, '250 ms', '250 毫秒'],
          [1000, '1 sec', '1 秒'],
          [61000, '1 min 1 sec', '1 分钟 1 秒'],
          [300000, '5 min', '5 分钟']
        ] as const) {
          const expected = locale === 'zh-CN' ? chinese : english;
          for (const targetCount of [1, 2]) {
            const html = await renderToString(
              createSSRApp(AgentOperationDetail, {
                agentDetail: {
                  action: 'WAIT',
                  targets: Array.from({ length: targetCount }, (_, index) => ({
                    title: `Task ${index + 1}`
                  })),
                  wait: { waitFor: 'message', mode: 'all', waitMs }
                }
              })
            );
            expect(html).toContain(`message · all · ${expected}`);
            expect(html.split(expected)).toHaveLength(2);
            expect(html).not.toContain(`${waitMs}ms`);
          }
        }
      } finally {
        preference.setLocale(previousLocale);
      }
    }
  );

  it('consumes the public Goal message marker without interpreting raw inputs', () => {
    const payload = {
      agentOperation: {
        action: 'SEND',
        targets: [{ agentId: 'peer', title: 'Review' }],
        detail: { message: 'Inspect\n继续验证', messageIsGoal: true }
      },
      inputSummary: '{"goal":{"objective":"NOT_A_SOURCE"}}'
    };
    expect(agentOperationDetail(payload, 'COMPLETED')).toMatchObject({
      action: 'SEND',
      message: 'Inspect\n继续验证',
      messageIsGoal: true
    });
    expect(
      agentOperationDetail(
        {
          ...payload,
          agentOperation: {
            ...payload.agentOperation,
            detail: { message: 'Ordinary message' }
          }
        },
        'COMPLETED'
      )
    ).not.toHaveProperty('messageIsGoal');
    expect(
      agentOperationDetail(
        {
          ...payload,
          agentOperation: {
            action: 'SEND',
            targets: []
          }
        },
        'COMPLETED'
      )
    ).toBeUndefined();
    expect(agentOperationDetail(payload, 'FAILED')).toBeUndefined();
  });

  it.each(['tree', 'active'])('shows the LIST query scope %s even with no results', (scope) => {
    for (const targets of [[], [{ agentId: 'child', title: 'Task' }]])
      expect(
        conversationItemText('tool_call', {
          toolName: 'agent_list',
          inputSummary: '{"scope":"not-a-source"}',
          agentOperation: { action: 'LIST', scope, targets }
        })
      ).toBe(`list ${scope}`);
    expect(
      conversationItemText('tool_call', {
        toolName: 'agent_list',
        inputSummary: `{"scope":"${scope}"}`,
        agentOperation: { action: 'LIST', targets: [] }
      })
    ).toBe('list');
  });

  it('uses semantic short actions instead of native command names', () => {
    for (const action of ['START', 'SEND', 'WAIT', 'VIEW', 'LIST', 'STOP'] as const)
      expect(
        conversationItemText('tool_call', {
          toolName: 'unrelated_native_name',
          agentOperation: { action, targets: [{ agentId: 'x', title: 'Task' }] }
        })
      ).toBe(`${action.toLowerCase()} Task`);
    for (const [operation, label] of [
      ['MESSAGE', 'send'],
      ['CANCEL', 'stop'],
      ['STATUS', 'view'],
      ['RESUME', 'resume']
    ] as const)
      expect(
        conversationItemText('tool_call', {
          toolName: 'native',
          subagentOperation: operation,
          title: 'Task'
        })
      ).toBe(`${label} Task`);
    expect(
      conversationItemText('tool_call', {
        toolName: 'native',
        subagentOperation: 'STATUS',
        subagentWait: true,
        title: 'Task'
      })
    ).toBe('wait Task');
  });
  it('keeps wait facts from the producer and does not infer them from raw summaries', () => {
    const payload = {
      agentOperation: {
        action: 'WAIT',
        targets: [{ agentId: 'x', title: 'Task' }],
        detail: { wait: { waitFor: 'message', waitMs: 0 } }
      }
    };
    expect(agentOperationDetail(payload, 'IN_PROGRESS')).toMatchObject({
      wait: { waitFor: 'message', waitMs: 0 }
    });
    expect(
      agentOperationDetail(
        {
          agentOperation: { action: 'WAIT', targets: [], detail: {} },
          inputSummary: '{"waitFor":"message","waitMs":50}'
        },
        'COMPLETED'
      )
    ).not.toHaveProperty('wait');
  });
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
