import { describe, expect, it } from 'vitest';
import { conversationItemSchema } from '@myagentroam/protocol';
import { normalizeCodexTool } from '../../src/runner/codex/tool-normalizer.js';
import { normalizeClaudeTool } from '../../src/runner/claude/tool-normalizer.js';
import { normalizeOpenCodeTool } from '../../src/runner/opencode/tool-normalizer.js';

describe('tool presentation runner compatibility', () => {
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
