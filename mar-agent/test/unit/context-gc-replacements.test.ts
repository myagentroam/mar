import { describe, expect, it } from 'vitest';
import {
  contextGcCodeModeInputReplacement,
  contextGcCodeModeOutputReplacement,
  contextGcExecInputReplacement,
  contextGcExecOutputReplacement,
  contextGcStaleReadReplacement,
  contextGcToolOutputReplacement,
  contextGcWebOutputReplacement,
  type ContextGcExecResult
} from '../../src/session/context-gc-replacements.js';
import {
  contextGcSubagentOutputReplacement,
  type ContextGcSubagentSnapshot
} from '../../src/session/context-gc-subagent.js';

const text = 'preview <message> & "quoted"';
const exec: ContextGcExecResult = {
  source: 'STRUCTURED',
  status: 'completed',
  exitCode: null,
  truncated: false,
  stdoutBytes: Buffer.byteLength(text),
  stderrBytes: 0,
  stdoutDroppedBytes: 0,
  stderrDroppedBytes: 0,
  stdout: text,
  stderr: ''
};

describe('context GC structured records and message placeholders', () => {
  it('uses a shared 768 Unicode character preview for generic output and values', () => {
    const original = '😀'.repeat(768) + 'MIDDLE' + '界'.repeat(768);
    for (const rendered of [
      contextGcToolOutputReplacement('extension', original, false),
      contextGcCodeModeOutputReplacement(original, false, true)
    ]) {
      const value = JSON.parse(rendered);
      expect(value.preview).toBe(
        '😀'.repeat(768) + '\n...[context GC omitted middle]...\n' + '界'.repeat(768)
      );
      expect(value.previewComplete).toBe(false);
    }
  });

  it('constructs the current stale-read format without consulting a format selector', () => {
    const input = {
      path: 'src/a.ts',
      content: text,
      evidenceSequence: 17,
      supersededByCallId: 'patch',
      operation: 'modified' as const
    };
    Object.defineProperty(input, 'formatVersion', {
      get() {
        throw new Error('Replacement generation must not select an obsolete format.');
      }
    });
    const value = contextGcStaleReadReplacement(input);
    expect(value).toContain('formatVersion="2"');
    expect(value).not.toContain('Sha256');
  });

  it.each([
    { name: 'Code Mode', render: () => contextGcCodeModeOutputReplacement(text, false) },
    { name: 'Web', render: () => contextGcWebOutputReplacement('web_fetch', text, false) }
  ])('keeps the complete $name replacement as JSON without escaping its preview', ({ render }) => {
    const value = JSON.parse(render());
    expect(value).toMatchObject({
      originalBytes: Buffer.byteLength(text),
      preview: text,
      previewComplete: true,
      contextGc: expect.any(String)
    });
  });

  it('keeps current exec input metadata as an object', () => {
    const input = { command: text, cwd: '/workspace', yieldMs: 12 };
    const value = contextGcExecInputReplacement(input);
    expect(value).toMatchObject({
      action: 'start',
      cwd: input.cwd,
      yieldMs: 12,
      contextGc: {
        kind: 'terminal_exec_input',
        originalBytes: expect.any(Number)
      }
    });
    expect(value).toHaveProperty('command', text);
    expect(value).not.toHaveProperty('contextGc.originalSha256');
  });

  it('preserves null exit codes and exec evidence in current JSON', () => {
    const value = JSON.parse(contextGcExecOutputReplacement(exec));
    expect(value).toMatchObject({
      status: 'completed',
      exitCode: null,
      stdoutBytes: Buffer.byteLength(text),
      stdoutPreview: text,
      stderrPreview: '',
      contextGc: expect.any(String)
    });
    expect(value.contextGcFormatVersion).toBe(3);
    expect(value).not.toHaveProperty('stdoutSha256');
    expect(value).not.toHaveProperty('stderrSha256');
  });

  it('keeps a model-truncated exec replacement as a complete JSON record', () => {
    const value = JSON.parse(
      contextGcExecOutputReplacement({
        source: 'MODEL_CONTEXT_TRUNCATED',
        status: 'completed',
        exitCode: 0,
        truncated: true,
        stdoutBytes: 100,
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0,
        modelContextContent: text
      })
    );
    expect(value).toMatchObject({
      modelContextTruncated: true,
      modelContextBytes: Buffer.byteLength(text),
      modelContextPreview: text,
      contextGcFormatVersion: 3
    });
  });

  it('keeps nested Subagent receipt fields in current JSON', () => {
    const source: ContextGcSubagentSnapshot = {
      agentId: 'child',
      description: text,
      status: 'running',
      latestMessage: {
        itemId: 'message',
        turnId: 'turn',
        phase: 'commentary',
        text,
        timestamp: '2026-10-18T00:00:00.000Z',
        truncated: false
      },
      latestActivity: {
        kind: 'tool',
        toolName: 'read',
        status: 'completed',
        timestamp: '2026-10-18T00:00:01.000Z'
      }
    };
    const value = JSON.parse(
      contextGcSubagentOutputReplacement({
        sourceContent: JSON.stringify(source),
        source,
        terminal: { ...source, status: 'completed', turnId: 'turn' }
      })
    );
    expect(value).toMatchObject({
      agentId: 'child',
      description: text,
      status: 'running',
      latestMessage: { textBytes: Buffer.byteLength(text), truncated: false },
      latestActivity: source.latestActivity,
      contextGc: { kind: 'superseded_subagent_snapshot', terminalStatus: 'completed' }
    });
    expect(value.contextGc.formatVersion).toBe(2);
    expect(value.contextGc).not.toHaveProperty('originalSha256');
    expect(value.latestMessage).not.toHaveProperty('textSha256');
    expect(value.latestMessage).not.toHaveProperty('text');
  });

  it('retains escaped mar_ placeholders in free-text inputs, not in structured metadata', () => {
    const value = contextGcCodeModeInputReplacement(
      { inputMode: 'json', code: 'observe.text("done");' },
      [{ command: text }]
    );
    expect(value).toMatchObject({
      code: expect.stringContaining('<mar_context_gc kind="completed_code_mode_input"')
    });
    expect((value as { code: string }).code).toContain('&lt;message&gt; &amp;');
    expect(contextGcExecInputReplacement('opaque input')).toContain(
      '<mar_context_gc kind="terminal_exec_input"'
    );
  });
});
