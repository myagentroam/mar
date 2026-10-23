import { describe, expect, it } from 'vitest';
import { conversationItemSchema } from '@myagentroam/protocol';
import { normalizeCodexTool } from '../../src/runner/codex/tool-normalizer.js';
import { normalizeClaudeTool } from '../../src/runner/claude/tool-normalizer.js';
import { normalizeOpenCodeTool } from '../../src/runner/opencode/tool-normalizer.js';

describe('tool presentation runner compatibility', () => {
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
    expect(claude.payload.outputSummary).toBe('content');
    expect(opencode.payload.outputSummary).toBe('content');
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
      expect(parsed.payload).toMatchObject({ toolName: name, outputSummary: 'Original output' });
      expect(parsed.payload).not.toHaveProperty('toolPresentation');
    }
  );
});
