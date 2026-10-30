import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationItem } from '../../src/model/workbench.js';
import { agentOperationTargets } from '../../src/util/agent-operation-presentation.js';
import {
  conversationDisplayItems,
  conversationItemDetail,
  conversationItemText,
  subagentOperationText
} from '../../src/util/conversation-presentation.js';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';

const locale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(locale));
function item(id: string, payload: object): ConversationItem {
  return { id, kind: 'tool_call', status: 'COMPLETED', payload, processGroup: { id: 'process' } };
}

describe('Agent operation presentation', () => {
  it('groups all operations in one process regardless of targets and discovery', () => {
    const items = [
      item('start', {
        toolName: 'agent_start',
        agentOperation: {
          action: 'START',
          targets: [{ agentId: 'peer', sessionId: 'peer', title: 'Inspect changes' }]
        }
      }),
      item('send', {
        toolName: 'agent_send',
        agentOperation: { action: 'SEND', targets: [{ agentId: 'peer', sessionId: 'peer' }] }
      }),
      item('wait-many', {
        agentOperation: {
          action: 'WAIT',
          targets: [
            { agentId: 'peer', sessionId: 'peer' },
            { agentId: 'other', sessionId: 'other' }
          ]
        }
      }),
      item('list', {
        agentOperation: {
          action: 'LIST',
          scope: 'workspace',
          targets: [{ agentId: 'peer', sessionId: 'peer' }]
        }
      })
    ];
    const groups = conversationDisplayItems(items);
    expect(groups).toMatchObject([{ type: 'subagent_group', id: 'start', items }]);
    expect(conversationItemText('tool_call', items[0]!.payload)).toBe(
      'agent_start Inspect changes'
    );
    expect(conversationItemText('tool_call', items[1]!.payload)).toBe('agent_send');
    expect(agentOperationTargets(items[2]!.payload)).toEqual([
      { agentId: 'peer', sessionId: 'peer' },
      { agentId: 'other', sessionId: 'other' }
    ]);
  });

  it('uses explicit public fields for all Runners and never tool names for grouping', () => {
    for (const toolName of ['agent_start', 'spawn_agent', 'Agent', 'task']) {
      expect(conversationDisplayItems([item(toolName, { toolName })])[0]?.type).toBe('tool_group');
    }
    for (const toolName of ['spawn_agent', 'Agent', 'task']) {
      const entry = item(toolName, {
        toolName,
        subagentOperation: 'START',
        subagentId: 'native-id',
        title: 'Native task'
      });
      expect(conversationDisplayItems([entry])[0]?.type).toBe('subagent_group');
      expect(agentOperationTargets(entry.payload)).toEqual([{ agentId: 'native-id' }]);
      expect(conversationItemText('tool_call', entry.payload)).toBe(`${toolName} Native task`);
    }
    const entry = item('failed', {
      toolName: 'agent_send',
      agentOperation: { action: 'SEND', targets: [{ agentId: 'input-only' }] }
    });
    expect(agentOperationTargets(entry.payload)).toEqual([{ agentId: 'input-only' }]);
  });

  it('preserves independent calls and boundaries across processes and segments', () => {
    const calls = [
      item('first', { toolName: 'agent_start', agentOperation: { action: 'START', targets: [] } }),
      {
        ...item('failed', {
          toolName: 'agent_send',
          agentOperation: { action: 'SEND', targets: [{ agentId: 'unknown' }] }
        }),
        status: 'FAILED' as const
      },
      item('truncated', {
        toolName: 'agent_wait',
        agentOperation: {
          action: 'WAIT',
          targetsTruncated: true,
          targets: [
            { agentId: 'a', title: 'First' },
            { agentId: 'b', title: 'Second' }
          ]
        }
      }),
      item('legacy', { toolName: 'Task', subagentOperation: 'STATUS', title: 'Task' }),
      item('list', {
        toolName: 'agent_list',
        agentOperation: { action: 'LIST', scope: 'profile', targets: [] }
      })
    ];
    const next = {
      ...item('next', { toolName: 'agent_wait', subagentOperation: 'STATUS' }),
      processGroup: { id: 'next-process' }
    };
    const groups = conversationDisplayItems([...calls, next]);
    expect(groups).toMatchObject([
      { type: 'subagent_group', id: 'first', items: calls },
      { type: 'subagent_group', id: 'next', items: [next] }
    ]);
    expect(conversationItemText('tool_call', calls[1]!.payload)).toBe('agent_send');
    expect(conversationItemText('tool_call', calls[2]!.payload)).toBe('agent_wait First, Second');
    expect(conversationItemText('tool_call', calls[3]!.payload)).toBe('Task');
    expect(conversationItemText('tool_call', calls[4]!.payload)).toBe('agent_list');
    expect(calls.map((call) => call.status)).toEqual([
      'COMPLETED',
      'FAILED',
      'COMPLETED',
      'COMPLETED',
      'COMPLETED'
    ]);
    localePreferenceService().setLocale('zh-CN');
    expect(
      conversationItemText('tool_call', {
        toolName: 'task',
        subagentOperation: 'START',
        title: 'Image generated'
      })
    ).toBe('task Image generated');
  });

  it('renders original Tool, identities, output and error in the shared detail surface', () => {
    localePreferenceService().setLocale('en-US');
    const entry = item('wait', {
      toolName: 'agent_wait',
      inputSummary: '{"agentIds":["a","b"]}',
      agentOperation: {
        action: 'WAIT',
        targets: [{ agentId: 'a' }, { agentId: 'b' }],
        targetsTruncated: true
      },
      output: { blocks: [{ channel: 'TEXT', text: 'timeout, target still running' }] },
      errorCode: 'AGENT_ERROR',
      errorMessage: 'Target unavailable',
      inputTruncated: true
    });
    expect(subagentOperationText(entry.payload)).toBe('Wait');
    const detail = conversationItemDetail(entry.kind, entry.payload);
    expect(detail).toContain('Tool: agent_wait');
    expect(detail).toContain('Agent ID: a');
    expect(detail).toContain('Agent ID: b');
    expect(detail).toContain('AGENT_ERROR');
    expect(detail).toContain('Target unavailable');
    expect(detail).toContain('Truncated');
    expect(detail).toContain('timeout, target still running');
  });
});
