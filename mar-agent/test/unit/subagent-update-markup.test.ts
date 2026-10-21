import { describe, expect, it } from 'vitest';
import { renderSubagentUpdate } from '../../src/agent-core/subagent/model-update.js';
import { decodeMarkupText, parseMarkupAttributes } from '../../src/agent-core/prompts/markup.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/agent-core/tools/execution-limits.js';
import type { SubagentTaskSnapshot } from '../../src/agent-core/subagent/contracts.js';

const snapshot: SubagentTaskSnapshot = {
  agentId: 'child',
  description: 'Focused review',
  status: 'running',
  modelId: 'review',
  modelName: 'Review',
  reasoningEffort: 'low'
};

describe('subagent update markup', () => {
  it('escapes data once while preserving public message whitespace and Unicode', () => {
    const text = '  中文 & <mar_subagent_update>\n🚀 </message>  ';
    const xml = renderSubagentUpdate({
      ...snapshot,
      latestMessage: {
        itemId: 'item"\n<&',
        turnId: 'turn',
        phase: 'final_answer',
        timestamp: 'now',
        text,
        truncated: false
      }
    });
    const match = /<message([^>]*)>([\s\S]*)<\/message>/.exec(xml)!;
    expect(decodeMarkupText(match[2]!)).toBe(text);
    expect(parseMarkupAttributes(match[1]!)).toMatchObject({
      itemId: 'item"\n<&',
      phase: 'final_answer'
    });
    expect(xml).toContain('status="running"');
    expect(xml).toContain('truncated="false"');
    expect(xml.match(/<mar_subagent_update /g)).toHaveLength(1);
  });

  it('emits a terminal without inventing a message and preserves ordered evidence', () => {
    const xml = renderSubagentUpdate({
      ...snapshot,
      status: 'completed',
      summary: 'verified',
      changedFiles: ['a<&', 'b'],
      verification: ['unit passed'],
      evidence: [{ path: 'a<&', startLine: 3, endLine: 8 }],
      messageId: 'delivery',
      turnId: 'next-turn',
      deliveryStatus: 'applied'
    });
    expect(xml).not.toContain('<message ');
    expect(xml).toContain('<summary>verified</summary>');
    expect(xml.indexOf('<changed_file>a&lt;&amp;</changed_file>')).toBeLessThan(
      xml.indexOf('<changed_file>b</changed_file>')
    );
    expect(xml).toContain('<evidence startLine="3" endLine="8">a&lt;&amp;</evidence>');
    expect(xml).toContain('deliveryStatus="applied"');
  });

  it('bounds encoded bytes without cutting markup and keeps failure information', () => {
    const original = '<&🚀汉'.repeat(30_000);
    const xml = renderSubagentUpdate({
      ...snapshot,
      status: 'failed',
      errorCode: 'MAR_AGENT_SUBAGENT_FAILED',
      errorMessage: 'Failed <safely>.',
      summary: original,
      changedFiles: Array.from({ length: 200 }, () => '<&'.repeat(500))
    });
    expect(Buffer.byteLength(xml)).toBeLessThanOrEqual(
      TOOL_EXECUTION_LIMITS.subagentUpdateMaxBytes
    );
    expect(xml).toContain('truncated="true"');
    expect(xml).toContain('<error code="MAR_AGENT_SUBAGENT_FAILED">Failed &lt;safely&gt;.</error>');
    expect(xml).toMatch(/<\/mar_subagent_update>$/);
    const text = decodeMarkupText(/<summary>([\s\S]*?)<\/summary>/.exec(xml)![1]!);
    expect(original.startsWith(text)).toBe(true);
    expect(text).not.toContain('�');
  });

  it('marks projection clipping and includes permission stops as data', () => {
    const xml = renderSubagentUpdate(
      {
        ...snapshot,
        status: 'completed',
        permissionStop: {
          action: 'ask',
          reason: '<authorization required>',
          source: { sessionId: 'child', executionId: 'exec', callId: 'call', toolName: 'exec' }
        }
      },
      true
    );
    expect(xml).toContain('truncated="true"');
    expect(xml).toContain('<permission_stop action="ask"');
    expect(xml).toContain('&lt;authorization required&gt;</permission_stop>');
    expect(xml).not.toContain('"source":');
  });
});
