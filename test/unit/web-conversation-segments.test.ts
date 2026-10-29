import { describe, expect, it } from 'vitest';
import {
  conversationDisplayItems,
  subagentGroupSessionId
} from '@myagentroam/web-core/conversation-presentation';

const item = (id: string, kind: string) => ({ id, kind, status: 'COMPLETED', payload: {} });

describe('Web Conversation Segment', () => {
  it('navigates only an explicit, unambiguous product Session mapping', () => {
    const native = {
      ...item('native', 'tool_call'),
      payload: {
        subagentId: 'native-child',
        inputSummary: '{"sessionId":"guessed"}'
      }
    };
    const mapped = {
      ...item('mapped', 'tool_call'),
      payload: {
        subagentId: 'native-child',
        subagentSessionId: 'product-session'
      }
    };
    expect(subagentGroupSessionId([native])).toBeUndefined();
    expect(subagentGroupSessionId([native, mapped])).toBe('product-session');
    expect(
      subagentGroupSessionId([
        mapped,
        {
          ...mapped,
          payload: {
            ...mapped.payload,
            subagentSessionId: 'other-session'
          }
        }
      ])
    ).toBeUndefined();
  });
  it('keeps ungrouped historical items independent', () => {
    const display = conversationDisplayItems([
      item('command-1', 'command_execution'),
      item('plan-1', 'plan'),
      item('command-2', 'command_execution'),
      item('tool-1', 'tool_call'),
      item('warning-1', 'warning'),
      item('tool-2', 'tool_call')
    ]);

    expect(display.map((entry) => entry.type)).toEqual([
      'command_group',
      'item',
      'command_group',
      'tool_group',
      'item',
      'tool_group'
    ]);
  });

  it('aggregates nonadjacent categories only within the same authoritative process', () => {
    const grouped = (id: string, kind: string) => ({
      ...item(id, kind),
      processGroup: { id: 'process-1' }
    });
    const display = conversationDisplayItems([
      grouped('command-1', 'command_execution'),
      grouped('tool-1', 'tool_call'),
      grouped('command-2', 'command_execution'),
      grouped('tool-2', 'tool_call')
    ]);

    expect(display.map((entry) => entry.type)).toEqual(['command_group', 'tool_group']);
    expect(display[0]?.type === 'command_group' ? display[0].items : []).toHaveLength(2);
    expect(display[1]?.type === 'tool_group' ? display[1].items : []).toHaveLength(2);
  });
});
