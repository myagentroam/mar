import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost, MarAgentError, SecretValue } from '../../src/index.js';
import type { MarAgentModelConfiguration } from '../../src/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import type { ModelAdapter, ModelRequest } from '../../src/agent-core/model/contracts.js';
import { LocalWorkspaceTools } from '../../src/agent-core/tools/local/workspace-tools.js';
import { applyPatchToolInput } from '../../src/agent-core/tools/local/apply-patch.js';
import { describeMarAgentError } from '../../src/agent-core/error.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/agent-core/tools/execution-limits.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-patch-parser-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  return { home, workspace, tools: new LocalWorkspaceTools(workspace) };
}

async function failure(tools: LocalWorkspaceTools, patch: string) {
  try {
    await tools.applyPatch(patch);
  } catch (error) {
    expect(error).toBeInstanceOf(MarAgentError);
    return error as MarAgentError;
  }
  throw new Error('Expected an invalid patch to fail.');
}

describe('freeform apply_patch parsing', () => {
  it.each([
    ['*** Begin Patch', '*** End Patch'],
    ['*** Begin Patch ***', '*** End Patch ***'],
    ['*** Begin Patch ***', '*** End Patch'],
    ['*** Begin Patch', '*** End Patch ***'],
    ['\t *** Begin Patch *** \t', ' *** End Patch ***\t']
  ])('accepts complete envelope markers %j and %j without changing content', async (begin, end) => {
    const { workspace, tools } = await fixture();
    const patch = `${begin}\r\n*** Add File: output.txt\r\n+*** Begin Patch ***\r\n+*** End Patch ***\r\n+\r\n${end}\r\n`;
    const result = await tools.applyPatch(patch);
    expect(result.totals).toEqual({ files: 1, addedLines: 3, deletedLines: 0 });
    expect(await readFile(join(workspace, 'output.txt'), 'utf8')).toBe(
      '*** Begin Patch ***\n*** End Patch ***\n\n'
    );
  });

  it.each([
    ['*** Begin', '*** End Patch', 1],
    ['*** Begin Patches', '*** End Patch', 1],
    ['*** Begin Patch unexpected', '*** End Patch', 1],
    ['*** Begin Patch ****', '*** End Patch', 1],
    ['*** Begin Patch', '*** End', 4],
    ['*** Begin Patch', '*** End Patch unexpected', 4],
    ['*** Begin Patch', '*** End Patch\ntrailing content', 5]
  ])(
    'rejects incomplete or ambiguous markers %j and %j before writing',
    async (begin, end, line) => {
      const { workspace, tools } = await fixture();
      const patch = `${begin}\n*** Add File: output.txt\n+value\n${end}`;
      const error = await failure(tools, patch);
      expect(error).toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID',
        details: { line }
      });
      expect(error.message).toContain(`line ${line}, column `);
      expect(error.message).toContain('***');
      expect(error.message).toContain('^');
      expect(await readdir(workspace)).toEqual([]);
    }
  );

  it.each([
    {
      body: '*** Add File: output.txt\n?private-body',
      line: 3,
      column: 1,
      expected: 'Added file lines must start with +.'
    },
    {
      body: '*** Update File: output.txt\n@@\n?private-body',
      line: 4,
      column: 1,
      expected: 'Patch hunk lines must start with space, +, or -.'
    },
    {
      body: '*** Update File: output.txt\n@@bad',
      line: 3,
      column: 3,
      expected: 'Patch change context headers must use @@ or @@ <context>.'
    },
    {
      body: '*** Update File: output.txt\n@@ ',
      line: 3,
      column: 4,
      expected: 'Patch change context must be non-empty.'
    },
    {
      body: '*** Update File: output.txt\n@@\n+private-body',
      line: 3,
      column: 1,
      expected: 'Insertion hunks require context.'
    },
    {
      body: '*** Update File: output.txt',
      line: 2,
      column: 1,
      expected: 'Update operations must contain hunks or move a file.'
    },
    {
      body: '*** Unknown: private-body',
      line: 2,
      column: 6,
      expected:
        "Expected an operation header: '*** Add File: <path>', '*** Update File: <path>', or '*** Delete File: <path>'."
    },
    {
      body: '*** Add File:  private-path',
      line: 2,
      column: 15,
      expected: 'Patch paths must be non-empty and unpadded.'
    },
    {
      body: '*** Add File: private-path\n+value\n*** Delete File: private-path',
      line: 4,
      column: 18,
      expected: 'Patch contains duplicate or overlapping paths.'
    }
  ])(
    'locates $expected without exposing file content or paths',
    async ({ body, line, column, expected }) => {
      const { workspace, tools } = await fixture();
      const patch = `*** Begin Patch\n${body}\n*** End Patch`;
      const error = await failure(tools, patch);
      const offset =
        patch
          .split('\n')
          .slice(0, line - 1)
          .join('\n').length +
        1 +
        column -
        1;
      expect(error).toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID',
        details: { line, column, offset }
      });
      expect(error.message).toContain(`line ${line}, column ${column}`);
      expect(error.message).toContain(expected);
      expect(error.message).toContain(`${line} | `);
      expect(error.message).toContain('^');
      expect(error.message).not.toContain('private-body');
      expect(error.message).not.toContain('private-path');
      expect(await readdir(workspace)).toEqual([]);
    }
  );

  it('pinpoints bare carriage returns with CRLF and Unicode before the error', async () => {
    const { tools } = await fixture();
    const patch =
      '*** Begin Patch\r\n*** Add File: output.txt\r\n+🙂中\rprivate-body\r\n*** End Patch';
    const error = await failure(tools, patch);
    expect(error.details).toEqual({ line: 3, column: 4, offset: patch.indexOf('\rprivate-body') });
    expect(error.message).toContain('unsupported bare carriage returns');
    expect(error.message).toContain('^');
    expect(error.message).not.toContain('private-body');
    expect(error.message).not.toContain('🙂中');
    const lines = error.message.split('\n');
    expect(lines[1]).toContain('\\r');
    expect(lines[2]!.indexOf('^')).toBe(lines[1]!.indexOf('\\r'));
  });

  it('aligns caret diagnostics with escaped tabs and exact missing marker characters', async () => {
    const { tools } = await fixture();
    const error = await failure(tools, '\t*** Begin Patches\n*** End Patch');
    expect(error.details).toEqual({ line: 1, column: 17, offset: 16 });
    const lines = error.message.split('\n');
    expect(lines[1]).toBe('1 |     *** Begin Patche<content omitted>');
    expect(lines[2]!.indexOf('^')).toBe(lines[1]!.indexOf('e<content omitted>'));
  });

  it('pinpoints a missing operation-header separator without echoing a path', async () => {
    const { tools } = await fixture();
    const error = await failure(tools, '*** Begin Patch\n*** Add File:private-path\n*** End Patch');
    expect(error.details).toMatchObject({ line: 2, column: 14 });
    expect(error.message).not.toContain('private-path');
    expect(error.message).toContain('2 | *** Add File:p<content omitted>');
    expect(error.message).toContain('^');
  });

  it('escapes control characters and bounds long whitespace before the offending character', async () => {
    const { tools } = await fixture();
    for (const prefix of ['', ' '.repeat(20000)]) {
      const patch = `${prefix}\r*** Begin Patch\n*** End Patch`;
      const error = await failure(tools, patch);
      expect(error.details).toEqual({ line: 1, column: prefix.length + 1, offset: prefix.length });
      const lines = error.message.split('\n');
      expect(lines[1]).toContain('\\r');
      expect(lines[2]!.indexOf('^')).toBe(lines[1]!.indexOf('\\r'));
      expect(error.message.length).toBeLessThan(800);
      expect(error.message).not.toContain('\r');
    }
    const error = await failure(
      tools,
      '*** Begin Patch\n*** Add File: output.txt\n\u2028private-body\n*** End Patch'
    );
    expect(error.message).toContain('\\u{2028}');
    expect(error.message).not.toContain('\u2028');
    expect(error.message).not.toContain('private-body');
  });

  it('keeps diagnostics bounded and retains the arrow after error projection', async () => {
    const { tools } = await fixture();
    const patch = `*** Begin Patch\n*** Add File: ${'private'.repeat(20000)} \n+value\n*** End Patch`;
    const error = await failure(tools, patch);
    expect(error.details).toMatchObject({ line: 2, column: 140015 });
    expect(error.message.length).toBeLessThan(800);
    expect(error.message).not.toContain('private');
    expect(describeMarAgentError(error, 'MAR_AGENT_TOOL_FAILED').message).toContain('^');
  });

  it('rejects empty and context-only patches with source locations before preflight', async () => {
    const { workspace, tools } = await fixture();
    for (const patch of [
      '*** Begin Patch\n*** End Patch',
      '*** Begin Patch\n*** Update File: missing.txt\n@@\n unchanged\n*** End Patch'
    ]) {
      const error = await failure(tools, patch);
      expect(error).toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID', details: { line: 2 } });
      expect(error.message).toContain('^');
    }
    expect(await readdir(workspace)).toEqual([]);
  });

  it('retains input type and byte-limit errors without fabricated locations', async () => {
    expect(() => applyPatchToolInput({ patch: 42 })).toThrow('Patch is required.');
    const { tools } = await fixture();
    const error = await failure(tools, 'x'.repeat(TOOL_EXECUTION_LIMITS.patchMaxBytes + 1));
    expect(error.code).toBe('MAR_AGENT_TOOL_OUTPUT_LIMIT');
    expect(error.details).toBeUndefined();
  });

  it('explains context-only patches without writing or pretending they succeeded', async () => {
    const { workspace, tools } = await fixture();
    const error = await failure(
      tools,
      '*** Begin Patch\n*** Update File: missing.txt\n@@\n unchanged\n*** End Patch'
    );
    expect(error.code).toBe('MAR_AGENT_TOOL_INPUT_INVALID');
    expect(error.message).toContain('No additions, deletions, or moves');
    expect(error.message).toContain('Use read');
    expect(error.message).toContain('-old/+new');
    expect(error.message).toContain('^');
    expect(await readdir(workspace)).toEqual([]);
  });

  it.each(
    [false, true].flatMap((codeMode) =>
      ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'].map((protocol) => ({
        codeMode,
        protocol: protocol as 'OPENAI_RESPONSES' | 'ANTHROPIC_MESSAGES'
      }))
    )
  )(
    'preserves diagnostics and allows correction with codeMode=$codeMode and protocol=$protocol',
    async ({ codeMode, protocol }) => {
      const { home, workspace } = await fixture();
      const configuration: MarAgentModelConfiguration = {
        id: 'coding',
        name: 'Coding',
        modelId: 'test',
        protocol,
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test-key'),
        contextWindowTokens: 200000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        codeMode,
        enabled: true
      };
      const patches = [
        '*** Begin Patch ***\n*** Add File: output.txt\n?private-body\n*** End Patch ***',
        '*** Begin Patch ***\n*** Add File: output.txt\n+corrected\n*** End Patch ***'
      ];
      const requests: ModelRequest[] = [];
      const adapter: ModelAdapter = {
        configuration,
        async *start(request) {
          requests.push(request);
          if (requests.length <= patches.length) {
            const patch = patches[requests.length - 1]!;
            const input = protocol === 'ANTHROPIC_MESSAGES' ? { patch } : patch;
            const code = `observe.result(await tools.apply_patch(${JSON.stringify(input)}));`;
            yield {
              type: 'client_tool.call',
              callId: `patch-${requests.length}`,
              name: codeMode ? 'code_exec' : 'apply_patch',
              arguments: codeMode ? (protocol === 'ANTHROPIC_MESSAGES' ? { code } : code) : input
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'done', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const agent = await createMarAgentWithAdapter({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [configuration],
        adapterFactory: () => adapter
      });
      try {
        const session = await agent.createSession({ workspace, title: 'Patch diagnostics' });
        const run = session.run({ prompt: 'Apply and correct the patch.' });
        const events = [];
        for await (const event of run) events.push(event);
        expect((await run.result()).status).toBe('completed');
        const error = events.find(
          (event) => event.type === 'tool.failed' && event.toolName === 'apply_patch'
        );
        expect(error).toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
        if (error?.type !== 'tool.failed') throw new Error('Expected a patch failure.');
        expect(error.message).toContain('line 3, column 1');
        expect(error.message).toContain('^');
        expect(error.message).not.toContain('private-body');
        const output = requests[1]!.messages.find(
          (message) => message.role === 'tool' && message.callId === 'patch-1'
        )!;
        expect(output.content).toContain('line 3, column 1');
        expect(output.content).toContain('^');
        expect(output.content).not.toContain('private-body');
        expect(await readFile(join(workspace, 'output.txt'), 'utf8')).toBe('corrected\n');
      } finally {
        await agent.dispose();
      }
    }
  );
});
