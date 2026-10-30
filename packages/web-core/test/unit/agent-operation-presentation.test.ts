import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationItem } from '../../src/model/workbench.js';
import { agentOperationTargets } from '../../src/util/agent-operation-presentation.js';
import {
  conversationDisplayItems,
  conversationItemDetail,
  subagentGroupText,
  subagentOperationText
} from '../../src/util/conversation-presentation.js';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';

const locale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(locale));
function item(id: string, payload: object): ConversationItem {
  return { id, kind: 'tool_call', status: 'COMPLETED', payload, processGroup: { id: 'process' } };
}

describe('Agent operation presentation', () => {
  it('groups a single target, but keeps multi-target waits and discovery independent', () => {
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
    expect(groups.map((group) => group.type)).toEqual([
      'subagent_group',
      'subagent_group',
      'subagent_group'
    ]);
    expect(groups[0]).toMatchObject({ items: [{ id: 'start' }, { id: 'send' }] });
    expect(subagentGroupText(items.slice(0, 2))).toBe('Inspect changes');
    expect(groups[1]).toMatchObject({ items: [{ id: 'wait-many' }] });
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
      expect(subagentGroupText([entry])).toBe('Native task');
    }
    const entry = item('failed', {
      toolName: 'agent_send',
      agentOperation: { action: 'SEND', targets: [{ agentId: 'input-only' }] }
    });
    expect(agentOperationTargets(entry.payload)).toEqual([{ agentId: 'input-only' }]);
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
