import { describe, expect, it } from 'vitest';
import { conversationItemSchema } from '@myagentroam/protocol';
import { normalizeCodexTool } from '../../src/runner/codex/tool-normalizer.js';
import {
  extractClaudeToolResults,
  normalizeClaudeTool
} from '../../src/runner/claude/tool-normalizer.js';
import { normalizeOpenCodeTool } from '../../src/runner/opencode/tool-normalizer.js';
import {
  codexLiveConversationItem,
  mergeCodexCustomToolItems
} from '../../src/runner/codex/conversation-parser.js';
import type { NodeConversationItem } from '../../src/runtime-model.js';

describe('tool presentation runner compatibility', () => {
  it('retains Claude locally clipped output as HEAD, and unknown source truncation as SOURCE', () => {
    const [result] = extractClaudeToolResults({
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call',
            content: `${'x'.repeat(11_000)}TAIL`
          }
        ]
      }
    });
    expect(result).toMatchObject({ truncated: true });
    const live = normalizeClaudeTool(
      'Read',
      {},
      result!.output,
      false,
      true,
      new Map(),
      undefined,
      result!.truncated,
      false,
      'HEAD'
    );
    expect(live.payload.output).toEqual({
      blocks: [{ channel: 'TEXT', text: `${'x'.repeat(9_996)}TAIL` }],
      truncation: 'HEAD'
    });
    const source = normalizeClaudeTool('Read', {}, 'partial', false, true);
    expect(source.payload.output).toEqual({
      blocks: [{ channel: 'TEXT', text: 'partial' }],
      truncation: 'SOURCE'
    });
  });
  it.each(['read', 'web_search', 'web_fetch', 'skill', 'task', 'inspect'])(
    'normalizes %s output before summary clipping',
    (name) => {
      const text = `  ${'x'.repeat(10_100)}\nlatest output\n`;
      const values = [
        normalizeCodexTool({ name, outputSummary: text }),
        normalizeClaudeTool(name, {}, text, false, false),
        normalizeOpenCodeTool(name, { status: 'completed', input: {}, output: text })
      ];
      for (const normalized of values) {
        const item = conversationItemSchema.parse({
          id: 'call',
          sessionId: 'session',
          turnId: 'turn',
          runId: null,
          parentItemId: null,
          sourceSequence: null,
          revision: 1,
          startedAt: null,
          completedAt: null,
          status: 'COMPLETED',
          kind: normalized.kind,
          payload: normalized.payload
        });
        expect(item.payload).toMatchObject({
          output: { blocks: [{ channel: 'TEXT', text: text.slice(-10_000) }], truncation: 'HEAD' }
        });
      }
    }
  );

  it('keeps input truncation separate from an explicitly complete or empty output', () => {
    for (const started of [
      normalizeClaudeTool('Bash', { command: 'verify' }, null, false, true),
      normalizeCodexTool({
        name: 'exec_command',
        rawInput: { cmd: 'verify' },
        inputTruncated: true
      })
    ]) {
      expect(started.payload).not.toHaveProperty('output');
      expect(started.payload).not.toHaveProperty('toolPresentation.execution.truncation.output');
      expect(started.payload.toolPresentation).toMatchObject({
        execution: { truncation: { input: true } }
      });
    }
    for (const text of ['  complete\n', '']) {
      const values = [
        normalizeCodexTool({
          name: 'read',
          outputSummary: text,
          truncated: true,
          outputTruncated: false
        }),
        normalizeCodexTool({
          name: 'exec_command',
          rawInput: { cmd: 'verify' },
          outputSummary: text,
          truncated: true,
          outputTruncated: false
        }),
        normalizeClaudeTool('Read', {}, text, false, true, undefined, undefined, false),
        normalizeClaudeTool(
          'Bash',
          { command: 'verify' },
          text,
          false,
          true,
          undefined,
          undefined,
          false
        ),
        normalizeOpenCodeTool('read', { input: { path: 'x'.repeat(10_100) }, output: text })
      ];
      for (const value of values) {
        expect(value.payload.output).toEqual({
          blocks: text
            ? [{ channel: value.kind === 'command_execution' ? 'COMBINED' : 'TEXT', text }]
            : []
        });
        expect(value.payload).not.toHaveProperty('toolPresentation.execution.truncation.output');
      }
    }
    expect(normalizeCodexTool({ name: 'read' }).payload).not.toHaveProperty('output');
    expect(normalizeClaudeTool('Read', {}, null, false, false).payload).not.toHaveProperty(
      'output'
    );
    expect(normalizeOpenCodeTool('read', { input: {} }).payload).not.toHaveProperty('output');
  });

  it('preserves native Claude text blocks and Codex dynamic output before bounding', () => {
    const text = `${'prefix'.repeat(2_000)}\nlast line\n`;
    const [result] = extractClaudeToolResults({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text }] }]
      }
    });
    expect(result).toMatchObject({ output: text.slice(-10_000), truncated: true });
    const claude = normalizeClaudeTool(
      'Read',
      {},
      result!.output,
      false,
      false,
      undefined,
      undefined,
      result!.truncated,
      false,
      result!.truncated ? 'HEAD' : undefined
    );
    const codex = codexLiveConversationItem(
      {
        type: 'dynamicToolCall',
        id: 'call',
        tool: 'read',
        contentItems: [{ type: 'text', text }]
      },
      true
    );
    expect(claude.payload.output).toEqual({
      blocks: [{ channel: 'TEXT', text: text.slice(-10_000) }],
      truncation: 'HEAD'
    });
    expect(codex?.payload).toMatchObject({
      output: { blocks: [{ channel: 'TEXT', text: text.slice(-10_000) }], truncation: 'HEAD' }
    });
  });

  it('unwraps OpenCode task results only in the owning task adapter', () => {
    const output = '<task id="child"><task_result>Child result</task_result></task>';
    const task = normalizeOpenCodeTool('task', { status: 'completed', input: {}, output });
    expect(task.payload).toMatchObject({
      subagentId: 'child',
      output: { blocks: [{ channel: 'TEXT', text: 'Child result' }] }
    });
    expect(normalizeOpenCodeTool('read', { input: {}, output }).payload.output).toEqual({
      blocks: [{ channel: 'TEXT', text: output }]
    });
  });

  it.each(['read', 'exec_command'])(
    'keeps authoritative %s output when pairing history records',
    (name) => {
      const base: NodeConversationItem = {
        id: 'invocation',
        sessionId: 'session',
        turnId: 'turn',
        runId: null,
        parentItemId: null,
        sourceSequence: null,
        revision: 0,
        startedAt: null,
        completedAt: null,
        status: 'IN_PROGRESS',
        kind: 'tool_call',
        payload: {}
      };
      const invocation = { ...base, ...normalizeCodexTool({ name, rawInput: { cmd: 'verify' } }) };
      for (const text of ['', `${'x'.repeat(10_100)}\nlatest\n`]) {
        const result = {
          ...base,
          id: 'result',
          status: 'COMPLETED',
          completedAt: 1,
          ...normalizeCodexTool({ name: 'tool', outputOnly: true, outputSummary: text })
        };
        const merged = mergeCodexCustomToolItems(invocation, result);
        expect(merged).toMatchObject({
          id: invocation.id,
          kind: invocation.kind,
          status: 'COMPLETED',
          payload: {
            output: {
              blocks: text ? [{ channel: 'TEXT', text: text.slice(-10_000) }] : [],
              ...(text.length > 10_000 ? { truncation: 'HEAD' } : {})
            }
          }
        });
        expect(() => conversationItemSchema.parse(merged)).not.toThrow();
      }
    }
  );

  it('preserves the original command tool name through public schema validation', () => {
    const commands = [
      ['exec_command', normalizeCodexTool({ name: 'exec_command', rawInput: { cmd: 'verify' } })],
      ['Bash', normalizeClaudeTool('Bash', { command: 'verify' }, '', false, false)],
      ['bash', normalizeOpenCodeTool('bash', { input: { command: 'verify' }, status: 'completed' })]
    ] as const;
    for (const [toolName, normalized] of commands) {
      const parsed = conversationItemSchema.parse({
        id: 'call',
        kind: normalized.kind,
        status: 'COMPLETED',
        payload: normalized.payload,
        sessionId: 'session',
        turnId: 'turn',
        runId: null,
        parentItemId: null,
        sourceSequence: null,
        revision: 1,
        startedAt: null,
        completedAt: null
      });
      expect(parsed.payload).toHaveProperty('toolName', toolName);
    }
  });
  it('projects native reads but never guesses read semantics from a command or MCP tool name', () => {
    const claude = normalizeClaudeTool(
      'Read',
      { file_path: 'src/a.ts', offset: 2 },
      'content',
      false,
      false
    );
    const opencode = normalizeOpenCodeTool('read', {
      status: 'completed',
      input: { filePath: 'src/b.ts' },
      output: 'content'
    });
    expect(claude.payload.toolPresentation).toEqual({ kind: 'READ', paths: ['src/a.ts'] });
    expect(opencode.payload.toolPresentation).toEqual({ kind: 'READ', paths: ['src/b.ts'] });
    expect(claude.payload.output).toEqual({ blocks: [{ channel: 'TEXT', text: 'content' }] });
    expect(opencode.payload.output).toEqual({ blocks: [{ channel: 'TEXT', text: 'content' }] });
    expect(
      normalizeCodexTool({ name: 'exec_command', rawInput: { cmd: 'cat src/a.ts' } }).kind
    ).toBe('command_execution');
    expect(
      normalizeCodexTool({ name: 'read', namespace: 'mcp', rawInput: { path: 'a' } }).payload
    ).not.toHaveProperty('toolPresentation');
    expect(
      normalizeClaudeTool('mcp__custom__Read', {}, '', false, false).payload
    ).not.toHaveProperty('toolPresentation');
  });
  it.each([
    {
      runner: 'codex',
      name: 'web_fetch',
      normalize: () =>
        normalizeCodexTool({
          name: 'web_fetch',
          namespace: 'mcp',
          rawInput: { url: 'https://example.test/' },
          inputSummary: 'Original input',
          outputSummary: 'Original output'
        })
    },
    {
      runner: 'claude-code',
      name: 'WebFetch',
      normalize: () =>
        normalizeClaudeTool(
          'WebFetch',
          { url: 'https://example.test/' },
          'Original output',
          false,
          false
        )
    },
    {
      runner: 'opencode',
      name: 'webfetch',
      normalize: () =>
        normalizeOpenCodeTool('webfetch', {
          status: 'completed',
          input: { url: 'https://example.test/' },
          output: 'Original output'
        })
    }
  ])(
    'preserves $runner native tool payloads without inferring MAR metadata',
    ({ normalize, name }) => {
      const normalized = normalize();
      expect(normalized.kind).toBe('tool_call');
      expect(normalized.payload).not.toHaveProperty('toolPresentation');
      const parsed = conversationItemSchema.parse({
        id: 'tool',
        sessionId: 'session',
        turnId: 'turn',
        runId: null,
        parentItemId: null,
        sourceSequence: null,
        revision: 1,
        startedAt: null,
        completedAt: null,
        kind: normalized.kind,
        status: 'COMPLETED',
        payload: normalized.payload
      });
      expect(parsed.kind).toBe('tool_call');
      expect(parsed.payload).toMatchObject({
        toolName: name,
        output: { blocks: [{ channel: 'TEXT', text: 'Original output' }] }
      });
      expect(parsed.payload).not.toHaveProperty('toolPresentation');
    }
  );
});
