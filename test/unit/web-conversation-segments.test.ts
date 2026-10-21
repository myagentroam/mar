import { describe, expect, it } from 'vitest';
import { conversationDisplayItems } from '../../ee/web/src/util/conversation-presentation.js';

const item = (id: string, kind: string) => ({ id, kind, status: 'COMPLETED', payload: {} });

describe('Web Conversation Segment', () => {
  it('Aggregates nonadjacent same-type Items at the last member position within a Segment', () => {
    const display = conversationDisplayItems([
      item('command-1', 'command_execution'),
      item('plan-1', 'plan'),
      item('command-2', 'command_execution'),
      item('tool-1', 'tool_call'),
      item('warning-1', 'warning'),
      item('tool-2', 'tool_call')
    ]);

    expect(display.map((entry) => entry.type)).toEqual([
      'item',
      'command_group',
      'item',
      'tool_group'
    ]);
    expect(display[1]?.type === 'command_group' ? display[1].items : []).toHaveLength(2);
    expect(display[3]?.type === 'tool_group' ? display[3].items : []).toHaveLength(2);
  });
});
