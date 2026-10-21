import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalAgentHost,
  MarAgentError,
  type ToolExecutionContext,
  type ToolExecutionResult
} from '../../src/index.js';
import {
  CodeModeTool,
  codeModeToolDefinition,
  codeExecWaitToolDefinition,
  projectCodeModeTools,
  projectCodeModeSearchResult
} from '../../src/agent-core/tools/code-mode/index.js';
import { applyPatchToolDefinition } from '../../src/agent-core/tools/local/apply-patch.js';
import { allowsToolCaller, toolCallers } from '../../src/agent-core/tools/callers.js';
import { BUILTIN_TOOL_DEFINITIONS } from '../../src/agent-core/tools/registry.js';
import { execToolDefinition } from '../../src/agent-core/tools/local/exec.js';
import { readToolDefinition } from '../../src/agent-core/tools/local/read.js';
import { WorkspacePathResolver } from '../../src/agent-core/tools/shared/path-resolver.js';
import { directLocalProcessExecutor } from '../../src/agent-core/host/local-process-executor.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/agent-core/tools/execution-limits.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-code-mode-'));
  roots.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  return { home, workspace };
}
function context(signal = new AbortController().signal): ToolExecutionContext {
  return {
    mode: 'run',
    signal,
    sessionId: 'session',
    executionId: 'execution',
    codeMode: {
      tools: [
        {
          name: 'read_value',
          description: 'Read a value.',
          allowedCallers: ['direct', 'programmatic'],
          parallelSafety: 'safe',
          inputSchema: { type: 'object' }
        }
      ],
      invoke: async (call) => ({ content: String((call.arguments as { value: number }).value) })
    }
  };
}

function observedValues(result: Pick<ToolExecutionResult, 'observations'>): string[] {
  return (result.observations ?? []).flatMap((observation) =>
    observation.type === 'value' && observation.format !== 'image' ? [observation.value] : []
  );
}

function observedText(result: Pick<ToolExecutionResult, 'observations'>): string {
  return observedValues(result).join('\n');
}

function expectCellEnvelope(result: ToolExecutionResult, status: 'completed') {
  expect(JSON.parse(result.content)).toMatchObject({
    cellId: expect.any(String),
    status,
    observations: expect.any(Array)
  });
  expect(result.data).toMatchObject({ cellId: expect.any(String), status });
}

describe('QuickJS Code Mode', () => {
  it('omits undefined object properties from tool inputs while keeping state and non-text bridges strict', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace));
    const input = context();
    const invoke = vi.fn(async () => ({ content: 'original' }));
    input.codeMode!.invoke = invoke;
    try {
      const result = await runner.execute(
        'observe.result(await tools.read_value({ value: 1, optional: undefined, "": undefined, nested: { omitted: undefined }, items: [{ omitted: undefined, value: 2 }] }));',
        input
      );
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: { value: 1, nested: {}, items: [{ value: 2 }] } }),
        expect.anything()
      );
      expect(result.observations?.[0]).toMatchObject({
        type: 'tool_result',
        result: { content: 'original' }
      });
      invoke.mockClear();
      input.codeMode!.supportsImages = true;
      for (const source of [
        'await tools.read_value(undefined);',
        'await tools.read_value({ values: [undefined] });',
        'state.set("invalid", { omitted: undefined });',
        'observe.image({ mimeType: "image/png", dataBase64: "iVBORw0KGgo=", omitted: undefined });'
      ])
        await expect(runner.execute(source, input)).rejects.toMatchObject({
          code: 'MAR_AGENT_TOOL_INPUT_INVALID'
        });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await runner.dispose();
    }
  });

  it('observes optional derived fields after a tool call without replaying it or changing its original result', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace));
    const input = context();
    const original = { content: 'running', data: { status: 'running', stdout: 'progress' } };
    const invoke = vi.fn(async () => original);
    input.codeMode!.invoke = invoke;
    try {
      const result = await runner.execute(
        `
        const r = await tools.read_value({ value: 1 });
        observe.result(r);
        observe.text({ ...r.data, exitCode: r.data.exitCode, stderr: r.data.stderr });
      `,
        input
      );
      expect(result.data).toMatchObject({ toolCalls: 1, outputDroppedBytes: 0 });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(result.observations).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          source: expect.objectContaining({ toolName: 'read_value', input: { value: 1 } }),
          result: expect.objectContaining({ content: original.content })
        }),
        expect.objectContaining({
          type: 'value',
          format: 'json',
          value: '{"status":"running","stdout":"progress"}'
        })
      ]);
      expect(original.data).toEqual({ status: 'running', stdout: 'progress' });
    } finally {
      await runner.dispose();
    }
  });

  it('does not terminate an awaited Host tool after the former cell wall deadline', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace));
    const input = context();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    let toolSignal!: AbortSignal;
    input.codeMode!.invoke = async (_call, signal) => {
      toolSignal = signal;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        release = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        signal.addEventListener('abort', abort, { once: true });
        entered();
      });
      return { content: 'completed after a long wait' };
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const execution = runner.execute('observe.result(await tools.read_value({}));', input).then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    try {
      await ready;
      await vi.advanceTimersByTimeAsync(TOOL_EXECUTION_LIMITS.codeTimeoutMs + 1);
      expect(toolSignal.aborted).toBe(false);
      release();
      expect(await execution).toMatchObject({
        result: {
          observations: [
            {
              type: 'tool_result',
              outcome: 'completed',
              result: { content: 'completed after a long wait' }
            }
          ]
        }
      });
    } finally {
      release?.();
      await runner.dispose();
      await execution;
    }
  });
  it.each([
    {
      result: { content: '{"value":7}', data: { value: 7 }, truncated: true }
    },
    {
      result: { content: 'Independent instructions', data: { path: 'skill.md' } }
    },
    { result: { content: 'Text only' } }
  ])(
    'observes the complete original programmatic result without duplicating its envelope: $result.content',
    async ({ result }) => {
      const { workspace } = await fixture();
      const runner = new CodeModeTool(new WorkspacePathResolver(workspace));
      const input = context();
      input.codeMode!.invoke = async () => result;
      try {
        const output = await runner.execute('observe.text(await tools.read_value({}));', input);
        expect(output.observations).toHaveLength(1);
        expect(output.observations?.[0]).toMatchObject({
          type: 'tool_result',
          source: { toolName: 'read_value' },
          outcome: 'completed',
          result: { content: result.content, truncated: result.truncated === true }
        });
        expect(output.content).not.toContain('program source');
      } finally {
        await runner.dispose();
      }
    }
  );

  it('describes raw source, helper bindings and MAR envelopes without unsupported Codex helpers', () => {
    const description = codeModeToolDefinition.description;
    expect(description).toContain('including single-tool operations');
    expect(description).toContain('Run independent calls concurrently with Promise.all');
    expect(description).toContain(
      'await sequentially when data, side effects, or failure handling require ordering'
    );
    expect(description).toContain(
      'Complete known, bounded steps and deterministic result processing'
    );
    expect(description).toContain(
      'Return to the model when interpretation or a new decision is needed'
    );
    expect(description).toContain('do not invent extra work to fill a cell');
    expect(description).toContain(
      'Observe only evidence needed for the next decision or verification'
    );
    expect(description).toContain('Preserve source and failure details needed for reasoning');
    expect(description).toContain('keep other intermediate data in the cell');
    expect(description).toContain('Single-tool cells are valid');
    expect(description).toContain('Keep loops and retries bounded');
    expect(description).toContain('do not blindly replay operations with side effects');
    expect(description).not.toContain(
      'A good Code Mode cell should perform meaningful computation'
    );
    expect(description).toContain('When exposed as a freeform tool, send the source directly');
    expect(description).toContain('when exposed with a JSON input schema');
    expect(description).toContain('Do not add another JSON wrapper');
    expect(description).toContain('code field');
    expect(description).toContain('restricted ECMAScript runtime');
    expect(description).toContain('not Node.js or a browser');
    expect(description).toContain('standard ECMAScript built-ins');
    expect(description).toContain('Do not use Node.js, browser or Web APIs');
    expect(description).not.toContain('restricted QuickJS runtime');
    expect(description).toContain('Do not shadow');
    expect(description).toContain('observe.result(patched)');
    expect(description).toContain('Prefer observe.result for inspecting tool results.');
    expect(description).toContain('result.data.results[0].text');
    expect(description).toContain('Tool errors reject');
    expect(description).toContain('completed tool effects are not rolled back');
    expect(description).not.toContain('maxOutputTokens');
    expect(codeExecWaitToolDefinition.inputSchema.properties).not.toHaveProperty('maxOutputTokens');
    expect(description).toContain('yieldMs');
    expect(description).toContain('cancellable delay');
    for (const internal of [
      '1 MiB',
      '128 calls',
      '120 seconds',
      'memory',
      'execution budget',
      'deadline'
    ])
      expect(description).not.toContain(internal);
    expect(description).not.toContain('observe.image(result.content[0])');
    for (const unsupported of ['ALL_TOOLS', 'generatedImage(', 'store(', 'load('])
      expect(description).not.toContain(unsupported);
    expect(applyPatchToolDefinition.description).toContain('data.files');
    expect(applyPatchToolDefinition.description).toContain('data.totals');
    expect(applyPatchToolDefinition.description).toContain('resolves on success');
  });

  it('executes its documented parallel-read and read-then-patch examples unchanged', async () => {
    const examples = Array.from(
      codeModeToolDefinition.description.matchAll(/```js\n([\s\S]*?)\n```/gu),
      (match) => match[1]!
    );
    expect(examples).toHaveLength(2);
    const { home, workspace } = await fixture();
    await writeFile(join(workspace, 'a.txt'), 'a-evidence\n');
    await writeFile(join(workspace, 'b.txt'), 'b-evidence\n');
    await writeFile(join(workspace, 'source.txt'), 'original=1\n');
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const input = context();
    input.codeMode = {
      tools: [readToolDefinition, applyPatchToolDefinition],
      invoke: (call, signal) => host.executeTool(call, { ...input, signal })
    };
    try {
      const parallel = await host.executeTool(
        { name: 'code_exec', arguments: examples[0]! },
        input
      );
      expectCellEnvelope(parallel, 'completed');
      const reads = parallel.observations?.filter(
        (observation) => observation.type === 'tool_result'
      );
      expect(reads).toHaveLength(2);
      expect(
        reads?.map(
          (observation) => observation.type === 'tool_result' && observation.source.toolName
        )
      ).toEqual(['read', 'read']);
      expect(reads?.[0]?.type === 'tool_result' && reads[0].result.content).toContain('a-evidence');
      expect(reads?.[1]?.type === 'tool_result' && reads[1].result.content).toContain('b-evidence');
      const sequential = await host.executeTool(
        { name: 'code_exec', arguments: examples[1]! },
        input
      );
      expectCellEnvelope(sequential, 'completed');
      expect(sequential.observations).toMatchObject([
        {
          type: 'tool_result',
          source: { toolName: 'apply_patch' },
          outcome: 'completed',
          result: { data: { totals: { files: 1 } } }
        }
      ]);
      expect(await readFile(join(workspace, 'source.txt'), 'utf8')).toBe('original=1\nupdated=2\n');
    } finally {
      await host.dispose();
    }
  });

  it('does not expose console, Node, network, binary or shared-memory globals', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    const globals = [
      'console',
      'global',
      'process',
      'require',
      'module',
      'Buffer',
      'fetch',
      'WebSocket',
      'WebAssembly',
      'SharedArrayBuffer',
      'Atomics'
    ];
    try {
      const result = await runner.execute(
        `observe.text(Object.fromEntries(${JSON.stringify(globals)}.map(name => [name, typeof globalThis[name]])));`,
        context()
      );
      expect(JSON.parse(observedText(result))).toEqual(
        Object.fromEntries(globals.map((name) => [name, 'undefined']))
      );
    } finally {
      await runner.dispose();
    }
  });

  it('uses text as the only text output and accepts only supported scalar and JSON values', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    try {
      const output = await runner.execute(
        `observe.text({ ok: true, count: 2 }); observe.text(null); observe.text(17); observe.text(true); observe.text("raw");`,
        context()
      );
      expect(observedText(output)).toBe('{"ok":true,"count":2}\nnull\n17\ntrue\nraw');
      await expect(
        runner.execute(`observe.text({ unsupported: () => 1 });`, context())
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
      await expect(
        runner.execute(
          `const circular = {}; circular.self = circular; observe.text(circular);`,
          context()
        )
      ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_FAILED' });
    } finally {
      await runner.dispose();
    }
  });

  it('commits state only after a successful cell and surfaces commit failures', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    const commits: unknown[] = [];
    const input = context();
    input.codeMode = {
      ...input.codeMode!,
      state: [{ key: 'count', value: 1 }],
      commitState: async (mutations) => {
        commits.push(mutations);
        return [{ key: 'count', value: 2 }];
      }
    };
    try {
      const incremented = await runner.execute(
        'state.set("count", state.get("count") + 1); observe.text(state.get("count"));',
        input
      );
      expect(observedText(incremented)).toBe('2');
      expect(commits).toEqual([[{ operation: 'set', key: 'count', value: 2 }]]);

      await expect(
        runner.execute('state.set("count", 3); throw new Error("discard");', input)
      ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_FAILED' });
      expect(commits).toHaveLength(1);

      input.codeMode!.commitState = async () => {
        throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Commit failed.');
      };
      await expect(runner.execute('state.set("count", 4);', input)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_CORRUPT'
      });
    } finally {
      await runner.dispose();
    }
  });

  it.each([
    { source: 'one\r\ntwo', offset: 1, limit: 2, expected: 'one\r\ntwo', utf16: false },
    { source: 'one\ntwo\n', offset: 2, limit: 1, expected: 'two\n', utf16: false },
    { source: '\n', offset: 1, limit: 2, expected: '\n', utf16: false },
    { source: '', offset: 1, limit: 2, expected: '', utf16: false },
    {
      source: '\u3042\r\n\u3044\n',
      offset: 1,
      limit: 2,
      expected: '\u3042\r\n\u3044\n',
      utf16: true
    }
  ])(
    'provides source text without parsing display prefixes: $offset/$limit $utf16 $source',
    async (sample) => {
      const { home, workspace } = await fixture();
      await writeFile(
        join(workspace, 'source.txt'),
        sample.utf16
          ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sample.source, 'utf16le')])
          : sample.source
      );
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      const input = context();
      input.codeMode = {
        tools: [readToolDefinition],
        invoke: (call, signal) => host.executeTool(call, { ...input, signal })
      };
      try {
        const output = await host.executeTool(
          {
            name: 'code_exec',
            arguments: `
          const result = await tools.read({ reads: [{ path: 'source.txt', offset: ${sample.offset}, limit: ${sample.limit} }] });
          observe.text({ source: result.data.results[0].text, display: result.data.results[0].content });
        `
          },
          input
        );
        expectCellEnvelope(output, 'completed');
        const result = JSON.parse(observedText(output));
        expect(result.source).toBe(sample.expected);
        if (sample.expected) expect(result.display).toMatch(/^\d+\t/);
      } finally {
        await host.dispose();
      }
    }
  );

  it('projects only direct-only tools and the full bounded programmatic input directory', () => {
    const controls = new Set([
      'code_exec',
      'code_exec_wait',
      'tool_search',
      'question',
      'skill',
      'sleep',
      'agent_start',
      'agent_wait',
      'agent_message',
      'agent_cancel'
    ]);
    for (const tool of BUILTIN_TOOL_DEFINITIONS)
      expect(tool.allowedCallers, tool.name).toEqual(
        controls.has(tool.name) ? ['direct'] : ['direct', 'programmatic']
      );

    const defaultsToDirect = {
      name: 'default_direct',
      description: 'Unmarked tools remain direct-only.',
      inputSchema: { type: 'object' }
    };
    const programmaticOnly = {
      name: 'programmatic_only',
      description: 'Accepts a record name.',
      inputSchema: {
        type: 'object',
        properties: { record: { type: 'string' } },
        required: ['record']
      },
      allowedCallers: ['programmatic'] as const,
      outputSchema: {
        type: 'object',
        properties: { secretOutputContract: { type: 'string' } }
      }
    };
    const widenedControls = BUILTIN_TOOL_DEFINITIONS.map((tool) =>
      controls.has(tool.name)
        ? { ...tool, allowedCallers: ['direct', 'programmatic'] as const }
        : tool
    );
    const definitions = projectCodeModeTools([
      ...widenedControls,
      defaultsToDirect,
      programmaticOnly
    ]);
    const names = definitions.map((tool) => tool.name);
    const description = definitions.find((tool) => tool.name === 'code_exec')!.description;
    const directoryMarker = 'Programmatic tools (call only inside code_exec): ';
    const directory = JSON.parse(
      description.slice(description.lastIndexOf(directoryMarker) + directoryMarker.length)
    ) as { callableNames: string[]; programmaticOnly: Array<{ name: string }> };

    expect(toolCallers(defaultsToDirect)).toEqual(['direct']);
    expect(allowsToolCaller(defaultsToDirect, 'programmatic')).toBe(false);
    const defaultMcp = { ...defaultsToDirect, name: 'mcp__fixture__lookup' };
    expect(toolCallers(defaultMcp)).toEqual(['direct', 'programmatic']);
    expect(allowsToolCaller(defaultMcp, 'programmatic')).toBe(true);
    expect(allowsToolCaller({ ...defaultMcp, allowedCallers: ['direct'] }, 'programmatic')).toBe(
      false
    );
    expect(
      toolCallers({ ...programmaticOnly, allowedCallers: ['programmatic', 'direct', 'direct'] })
    ).toEqual(['direct', 'programmatic']);
    expect(names).toContain('default_direct');
    expect(names).not.toContain('programmatic_only');
    expect(names).not.toContain('exec');
    expect(names).not.toContain('read');
    expect(names).not.toContain('apply_patch');
    expect(names).toEqual([
      'skill',
      'tool_search',
      'code_exec',
      'code_exec_wait',
      'question',
      'agent_start',
      'agent_wait',
      'agent_message',
      'agent_cancel',
      'sleep',
      'default_direct'
    ]);
    expect(description).toContain('callableNames');
    expect(description).toContain('"programmatic_only"');
    expect(description).toContain('"inputSchema"');
    expect(description).not.toContain('secretOutputContract');
    expect(description).not.toContain('outputSchema');
    expect(description).not.toContain('ToolResults');
    expect(directory.callableNames).toContain('programmatic_only');
    for (const name of controls) {
      expect(names).toContain(name);
      expect(directory.callableNames).not.toContain(name);
      expect(
        allowsToolCaller(
          widenedControls.find((tool) => tool.name === name)!,
          'programmatic'
        )
      ).toBe(false);
    }
    expect(directory.programmaticOnly.map((tool) => tool.name)).toEqual(
      widenedControls
        .filter((tool) => allowsToolCaller(tool, 'programmatic'))
        .map((tool) => tool.name)
        .concat('programmatic_only')
        .sort()
    );
    expect(directory.programmaticOnly).toContainEqual(
      expect.objectContaining({ name: 'read', inputSchema: expect.any(Object) })
    );
    expect(description).toContain('including single-tool operations');
    expect(description).not.toContain('A single direct tool call is preferable');
    const withoutCodeMode = projectCodeModeTools(
      widenedControls.filter((tool) => tool.name !== 'code_exec')
    );
    expect(withoutCodeMode.some((tool) => tool.name === 'code_exec')).toBe(false);
    expect(withoutCodeMode.some((tool) => tool.name === 'programmatic_only')).toBe(false);
    expect(withoutCodeMode.some((tool) => tool.name === 'read')).toBe(true);
    expect(withoutCodeMode.some((tool) => tool.name === 'exec')).toBe(true);
  });

  it('hides transport input modes only in programmatic tool declarations', () => {
    const raw = { ...applyPatchToolDefinition, name: 'mcp__fixture__raw' };
    const direct = { ...raw, name: 'direct_raw', allowedCallers: ['direct'] as const };
    const tools = [codeModeToolDefinition, raw, direct, readToolDefinition];
    const original = structuredClone(tools);
    const definitions = projectCodeModeTools(tools);
    const outer = definitions.find((tool) => tool.name === 'code_exec')!;
    const marker = 'Programmatic tools (call only inside code_exec): ';
    const directory = JSON.parse(
      outer.description.slice(outer.description.lastIndexOf(marker) + marker.length)
    );
    expect(outer.inputMode).toBe(codeModeToolDefinition.inputMode);
    expect(definitions.find((tool) => tool.name === direct.name)).toEqual(direct);
    for (const tool of directory.programmaticOnly) expect(tool).not.toHaveProperty('inputMode');
    const visible = directory.programmaticOnly.find(
      (tool: { name: string }) => tool.name === raw.name
    );
    expect(visible.inputSchema).toEqual(raw.inputSchema);
    expect(visible.description).toContain(`Call only as tools.${raw.name} inside code_exec`);
    const message = {
      role: 'tool' as const,
      name: 'tool_search',
      callId: 'search',
      content: '',
      toolSearchTools: [raw, direct, readToolDefinition]
    };
    const searched = projectCodeModeSearchResult(message, true);
    expect(searched.toolSearchTools!.find((tool) => tool.name === raw.name)).toEqual(visible);
    expect(
      JSON.parse(searched.content).tools.find((tool: { name: string }) => tool.name === raw.name)
    ).toEqual({ ...visible, caller: 'programmatic' });
    expect(searched.toolSearchTools!.find((tool) => tool.name === direct.name)).toMatchObject({
      name: direct.name,
      description: direct.description,
      inputSchema: direct.inputSchema,
      inputMode: direct.inputMode
    });
    expect(projectCodeModeSearchResult(message, false).toolSearchTools).toEqual(
      message.toolSearchTools
    );
    expect(projectCodeModeTools(tools.filter((tool) => tool.name !== 'code_exec'))).toEqual(
      original.slice(1)
    );
    expect(tools).toEqual(original);
  });

  it('hides cell catalog transport modes without changing tool arguments', async () => {
    const { home, workspace } = await fixture();
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const input = context();
    const raw = { ...applyPatchToolDefinition, name: 'raw_text' };
    const invoke = vi.fn(async (_call: { arguments: unknown }) => ({ content: 'unchanged' }));
    input.codeMode = { tools: [raw, readToolDefinition], invoke };
    const text = String.fromCharCode(34, 96, 92, 10) + '${literal}中文😀';
    const payload = { patch: text };
    try {
      const result = await host.executeTool(
        {
          name: 'code_exec',
          arguments: [
            `await tools.raw_text(${JSON.stringify(payload)});`,
            `await tools.raw_text(${JSON.stringify(text)});`,
            'observe.text(catalog.tools());'
          ].join(String.fromCharCode(10))
        },
        input
      );
      expectCellEnvelope(result, 'completed');
      const catalog = JSON.parse(observedText(result));
      for (const tool of catalog) expect(tool).not.toHaveProperty('inputMode');
      const outer = projectCodeModeTools([codeModeToolDefinition, raw, readToolDefinition]).find(
        (tool) => tool.name === 'code_exec'
      )!;
      const marker = 'Programmatic tools (call only inside code_exec): ';
      const directory = JSON.parse(
        outer.description.slice(outer.description.lastIndexOf(marker) + marker.length)
      );
      expect(catalog).toEqual(directory.programmaticOnly);
      expect(catalog.find((tool: { name: string }) => tool.name === raw.name).inputSchema).toEqual(
        raw.inputSchema
      );
      expect(invoke.mock.calls.map(([call]) => call.arguments)).toEqual([payload, text]);
    } finally {
      await host.dispose();
    }
  });

  it('rejects a programmatic input directory beyond its byte budget', () => {
    const oversized = {
      name: 'oversized_programmatic_tool',
      description: 'x'.repeat(33 * 1024),
      inputSchema: { type: 'object' },
      allowedCallers: ['programmatic'] as const
    };
    let failure: unknown;
    try {
      projectCodeModeTools([...BUILTIN_TOOL_DEFINITIONS, oversized]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'MAR_AGENT_TOOL_EXPOSURE_LIMIT' });
  });

  it('returns exec status and exitCode inside data, without adding top-level aliases', async () => {
    const { home, workspace } = await fixture();
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const input = context();
    input.codeMode = {
      tools: [execToolDefinition],
      invoke: (call, signal) => host.executeTool(call, { ...input, signal })
    };
    try {
      const result = await host.executeTool(
        {
          name: 'code_exec',
          arguments: `
          const result = await tools.exec({ command: 'echo ENVELOPE_OK', yieldMs: 10000 });
          observe.text({
            status: result.data.status, exitCode: result.data.exitCode,
            stdout: result.data.stdout.trim(), topLevelAlias: Object.hasOwn(result, 'exitCode')
          });
        `
        },
        input
      );
      expectCellEnvelope(result, 'completed');
      expect(JSON.parse(observedText(result))).toEqual({
        status: 'completed',
        exitCode: 0,
        stdout: 'ENVELOPE_OK',
        topLevelAlias: false
      });
    } finally {
      await host.dispose();
    }
  });

  it('validates image capability, base64 and byte signatures before returning pixels', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    const png = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
    expect(TOOL_EXECUTION_LIMITS.codeMaxFrameBytes).toBeGreaterThan(
      Math.ceil(TOOL_EXECUTION_LIMITS.viewImageMaxBytes / 3) * 4 + 1024
    );
    const input = context();
    input.codeMode!.supportsImages = true;
    const imageOnly = await runner.execute(`observe.image(${JSON.stringify(png)})`, input);
    expect(imageOnly.images).toEqual([png]);
    expect(imageOnly.observations).toMatchObject([
      { type: 'value', format: 'image', value: '', imageIndices: [0] }
    ]);
    await expect(
      runner.execute(`observe.image(${JSON.stringify(png)})`, context())
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED'
    });
    for (const image of [
      { ...png, mimeType: 'image/jpeg' },
      { ...png, dataBase64: 'bm90LWFuLWltYWdl' },
      { ...png, dataBase64: '===' },
      { ...png, extra: 'must-not-leak' }
    ])
      await expect(
        runner.execute(`observe.image(${JSON.stringify(image)})`, input)
      ).rejects.toBeDefined();
    await runner.dispose();
  });

  it.each(['result', 'text', 'image', 'value', 'engine'])(
    'observes seven images through %s without a fixed image-count cap',
    async (method) => {
      const { workspace } = await fixture();
      const png = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
      const engineModule = join(workspace, 'image-engine.mjs');
      if (method === 'engine')
        await writeFile(
          engineModule,
          `export async function createCodeModeEngine(options) {
            return {
              async execute(input) {
                for (let index = 0; index < 7; index++) input.onImage(options.image);
                return { stateMutations: [] };
              },
              async dispose() {}
            };
          }\n`
        );
      const runner = new CodeModeTool(
        new WorkspacePathResolver(workspace),
        {},
        directLocalProcessExecutor,
        method === 'engine'
          ? {
              moduleUrl: pathToFileURL(engineModule).href,
              runtimeDirectories: [workspace],
              options: { image: png }
            }
          : undefined
      );
      const input = context();
      input.codeMode!.supportsImages = true;
      input.codeMode!.invoke = async () => ({
        content: 'Seven images.',
        images: Array(7).fill(png)
      });
      try {
        const code =
          method === 'value' || method === 'engine'
            ? `for (let index = 0; index < 7; index++) observe.image(${JSON.stringify(png)});`
            : `observe.${method}(await tools.read_value({}));`;
        const result = await runner.execute(code, input);
        const imageValues = method === 'value' || method === 'engine';
        expect(JSON.parse(result.content)).toHaveLength(imageValues ? 7 : 1);
        expect(result.images).toEqual(Array(7).fill(png));
        expect(
          result.observations?.flatMap((observation) =>
            observation.type === 'tool_result'
              ? (observation.result.imageIndices ?? [])
              : (observation.imageIndices ?? [])
          )
        ).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(result.observations?.map((observation) => observation.type)).toEqual(
          imageValues ? Array(7).fill('value') : ['tool_result']
        );
      } finally {
        await runner.dispose();
      }
    }
  );

  it('omits structured image payloads from text without changing explicit image output', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    const png = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
    const input = context();
    input.codeMode!.supportsImages = true;
    try {
      const result = await runner.execute(
        `
        const image = ${JSON.stringify(png)};
        const envelope = { content: 'Viewed image.', data: { bytes: 8 }, images: [image] };
        observe.text(envelope);
        observe.text(image);
        observe.text([image]);
        observe.image(image);
        observe.text({ unchanged: image.dataBase64 === ${JSON.stringify(png.dataBase64)} });
      `,
        input
      );
      expect(result.content).not.toContain(png.dataBase64);
      const lines = observedValues(result);
      const summary = {
        mimeType: 'image/png',
        dataBase64: '[image payload omitted; use observe.image]'
      };
      expect(JSON.parse(lines[0]!)).toEqual({
        content: 'Viewed image.',
        data: { bytes: 8 },
        images: [summary]
      });
      expect(JSON.parse(lines[1]!)).toEqual(summary);
      expect(JSON.parse(lines[2]!)).toEqual([summary]);
      expect(JSON.parse(lines[3]!)).toEqual({ unchanged: true });
      expect(result.images).toEqual([png]);
      expect(result.truncated).toBe(false);
    } finally {
      await runner.dispose();
    }
  });

  it('summarizes large image payloads before text budgeting without guessing at ordinary data', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    try {
      const result = await runner.execute(
        `
        const image = { mimeType: 'image/png', dataBase64: 'A'.repeat(1100000) };
        observe.text({ nested: { images: [image] } });
        observe.text({ mimeType: 'application/octet-stream', dataBase64: 'ordinary' });
        observe.text({ dataBase64: 'no-image-type' });
        observe.text({ mimeType: 'image/png', dataBase64: 123 });
        observe.text('explicit string remains unchanged');
      `,
        context()
      );
      const text = observedText(result);
      expect(text).toContain('[image payload omitted; use observe.image]');
      expect(text).toContain('ordinary');
      expect(text).toContain('no-image-type');
      expect(text).toContain('"dataBase64":123');
      expect(text).toContain('explicit string remains unchanged');
      expect(text).not.toContain('truncated output');
      expect(result.images).toBeUndefined();
      expect(result.truncated).toBe(false);
    } finally {
      await runner.dispose();
    }
  });

  it('summarizes native MCP image objects but leaves strings and ordinary data unchanged', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    try {
      const result = await runner.execute(
        `
        const image = { type: 'image', mimeType: 'image/png', data: 'MCP_PIXELS' };
        observe.text({ nested: [image] });
        observe.text({ unchanged: image.data === 'MCP_PIXELS' });
        observe.text(JSON.stringify(image));
        observe.text(image.data);
        observe.text({ mimeType: 'image/png', data: 'ordinary' });
        observe.text({ type: 'image', mimeType: 'application/octet-stream', data: 'binary' });
        observe.text({ type: 'image', mimeType: 'image/png', data: 123 });
        observe.text({ type: 'image', mimeType: 'image/png', data: 'A'.repeat(1100000) });
      `,
        context()
      );
      const lines = observedValues(result);
      expect(JSON.parse(lines[0]!)).toEqual({
        nested: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: '[image payload omitted; use observe.image]'
          }
        ]
      });
      expect(JSON.parse(lines[1]!)).toEqual({ unchanged: true });
      expect(lines[2]).toBe('{"type":"image","mimeType":"image/png","data":"MCP_PIXELS"}');
      expect(lines[3]).toBe('MCP_PIXELS');
      expect(JSON.parse(lines[4]!)).toEqual({ mimeType: 'image/png', data: 'ordinary' });
      expect(JSON.parse(lines[5]!)).toEqual({
        type: 'image',
        mimeType: 'application/octet-stream',
        data: 'binary'
      });
      expect(JSON.parse(lines[6]!)).toEqual({ type: 'image', mimeType: 'image/png', data: 123 });
      expect(JSON.parse(lines[7]!).data).toBe('[image payload omitted; use observe.image]');
      expect(result.images).toBeUndefined();
      expect(result.truncated).toBe(false);
    } finally {
      await runner.dispose();
    }
  });

  it('uses a LocalAgentHost-injected engine in its managed worker', async () => {
    const { home, workspace } = await fixture();
    const engineModule = join(workspace, 'fixture-engine.mjs');
    await writeFile(
      engineModule,
      `export async function createCodeModeEngine(options) {
        if (options.fixture !== 'injected') throw new Error('Engine options were not forwarded.');
        return {
          async execute(input) {
            if (input.code !== 'throw new Error("Node fallback must not run")')
              throw new Error('Unexpected source passed to the engine.');
            input.onObserve?.({
              type: 'value',
              format: 'text',
              value: 'INJECTED_ENGINE_OK',
              originalBytes: Buffer.byteLength('INJECTED_ENGINE_OK')
            });
            return { stateMutations: [] };
          },
          async dispose() {}
        };
      }\n`
    );
    const pids: number[] = [];
    const host = new LocalAgentHost({
      homeDirectory: home,
      workspace,
      processExecutor: {
        spawn: async (request) => {
          expect(request.shell).toBe(false);
          expect(request.owner).toEqual({ sessionId: 'session', executionId: 'execution' });
          const child = await directLocalProcessExecutor.spawn(request);
          pids.push(child.pid!);
          return child;
        }
      },
      codeModeEngineFactory: {
        moduleUrl: pathToFileURL(engineModule).href,
        runtimeDirectories: [workspace],
        options: { fixture: 'injected' }
      }
    });
    try {
      const result = await host.executeTool(
        { name: 'code_exec', arguments: 'throw new Error("Node fallback must not run")' },
        context()
      );
      expect(observedText(result)).toBe('INJECTED_ENGINE_OK');
      expect(result.data).toMatchObject({ toolCalls: 0, status: 'completed' });
      expect(pids).toHaveLength(1);
      expect(() => process.kill(pids[0]!, 0)).toThrow();
    } finally {
      await host.dispose();
    }
  });

  it('does not fall back when the Host-injected engine fails', async () => {
    const { home, workspace } = await fixture();
    const engineModule = join(workspace, 'failing-engine.mjs');
    await writeFile(
      engineModule,
      `export async function createCodeModeEngine(options) {
        if (options.fixture !== 'failure') throw new Error('Engine options were not forwarded.');
        throw Object.assign(new Error('Expected fixture engine failure.'), {
          code: 'TEST_CODE_MODE_ENGINE_FAILED'
        });
      }\n`
    );
    const host = new LocalAgentHost({
      homeDirectory: home,
      workspace,
      codeModeEngineFactory: {
        moduleUrl: pathToFileURL(engineModule).href,
        runtimeDirectories: [workspace],
        options: { fixture: 'failure' }
      }
    });
    try {
      await expect(
        host.executeTool(
          { name: 'code_exec', arguments: `observe.text('UNSAFE_FALLBACK')` },
          context()
        )
      ).rejects.toMatchObject({ code: 'TEST_CODE_MODE_ENGINE_FAILED' });
    } finally {
      await host.dispose();
    }
  });

  it('runs safe calls concurrently and allows JavaScript to catch one tool failure', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    const pending: Array<() => void> = [];
    const input = context();
    input.codeMode!.invoke = async (call) => {
      const value = (call.arguments as { value: number }).value;
      if (value === 0) throw new MarAgentError('TEST_TOOL_FAILED', 'Expected failure');
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        if (pending.length === 2) pending.forEach((done) => done());
      });
      return { content: String(value) };
    };
    const output = await runner.execute(
      `
      const values = await Promise.all([1, 2].map(value => tools.read_value({ value })));
      observe.text(values.map(value => value.content));
      try { await tools.read_value({ value: 0 }); } catch (error) { observe.text(error.code); }
    `,
      input
    );
    expect(observedText(output)).toBe('["1","2"]\nTEST_TOOL_FAILED');
  });

  it('rejects unknown tools, recursion and invalid input without falling back', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    await expect(
      runner.execute({ code: 'observe.text(1)', extra: true }, context())
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    for (const name of ['unknown', 'code_exec'])
      await expect(runner.execute(`await tools.${name}({})`, context())).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
      });
    const withoutAdmission = { ...context(), codeMode: undefined };
    await expect(runner.execute('observe.text("blocked")', withoutAdmission)).rejects.toMatchObject(
      {
        code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
      }
    );
  });

  it('rejects direct-only and reserved control tools from programmatic cells', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    const invoked: string[] = [];
    const input = context();
    input.codeMode = {
      tools: [
        {
          name: 'direct_only',
          description: 'Direct callers only.',
          allowedCallers: ['direct'],
          inputSchema: { type: 'object' }
        },
        ...[
          'code_exec',
          'code_exec_wait',
          'tool_search',
          'question',
          'skill',
          'sleep',
          'agent_start',
          'agent_wait',
          'agent_message',
          'agent_cancel'
        ].map((name) => ({
          name,
          description: 'Control tools remain direct-only.',
          allowedCallers: ['direct', 'programmatic'] as const,
          inputSchema: { type: 'object' }
        }))
      ],
      invoke: async (call) => {
        invoked.push(call.name);
        return { content: 'unexpected invocation' };
      }
    };
    try {
      for (const name of input.codeMode.tools.map((tool) => tool.name))
        await expect(runner.execute(`await tools.${name}({})`, input)).rejects.toMatchObject({
          code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
        });
      expect(invoked).toEqual([]);
    } finally {
      await runner.dispose();
    }
  });

  it.each([
    { syntax: 'await import("node:fs")', code: 'MAR_AGENT_CODE_IMPORT_DENIED' },
    { syntax: 'import * as fs from "node:fs";', code: 'MAR_AGENT_CODE_SYNTAX_ERROR' }
  ])('rejects dynamic and static module import: $syntax', async ({ syntax, code }) => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    try {
      await expect(runner.execute(syntax, context())).rejects.toMatchObject({ code });
    } finally {
      await runner.dispose();
    }
  });

  it('retains source-relative syntax diagnostics without executing or exposing the worker stack', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace));
    const input = context();
    let invoked = 0;
    input.codeMode!.invoke = async () => {
      invoked++;
      return { content: 'must not execute' };
    };
    try {
      const failure = await runner
        .start(
          'observe.text("must not observe");\nawait tools.read_value({});\nconst broken = {offset: 1, 230};',
          input
        )
        .catch((error) => error);
      const message = failure.message;
      expect(failure).toMatchObject({ code: 'MAR_AGENT_CODE_SYNTAX_ERROR' });
      expect(message).toContain('before tool execution');
      expect(message).toContain('line 3, column 31');
      expect(message).toContain('^');
      expect(message).not.toContain('const broken');
      expect(message).not.toContain('at code-mode');
      expect(invoked).toBe(0);
      expect(failure.result.observations).toEqual([]);
      expect(failure.result.calls).toEqual([]);
      expect(failure.result.data).toMatchObject({ status: 'failed' });
      const replay = await runner.wait({ cellId: failure.result.data.cellId }, input);
      expect(replay.data).toMatchObject({
        status: 'failed',
        error: { code: 'MAR_AGENT_CODE_SYNTAX_ERROR', message }
      });
    } finally {
      await runner.dispose();
    }
  });

  it.each([
    {
      error: new MarAgentError('TEST_TOOL_FAILED', 'Expected tool failure.'),
      message: 'TEST_TOOL_FAILED: Expected tool failure.'
    },
    {
      error: Object.assign(new Error('Expected tool failure.'), { code: 'TEST_TOOL_FAILED' }),
      message: 'TEST_TOOL_FAILED: Expected tool failure.'
    },
    {
      error: new MarAgentError('TEST_TOOL_FAILED', 'Expected tool failure.', {
        cause: Object.assign(new Error('Underlying access denied.'), { code: 'EACCES' })
      }),
      message:
        'TEST_TOOL_FAILED: Expected tool failure. Caused by: EACCES: Underlying access denied.'
    }
  ])('does not duplicate the nested tool error prefix: $message', async ({ error, message }) => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace));
    const input = context();
    input.codeMode!.invoke = async () => {
      throw error;
    };
    try {
      const failure = await runner
        .start('observe.text("earlier evidence"); await tools.read_value({});', input)
        .catch((error) => error);
      expect(failure).toMatchObject({ code: 'TEST_TOOL_FAILED', message });
      expect(observedText(failure.result)).toBe('earlier evidence');
      expect(failure.result.data).toMatchObject({
        status: 'failed',
        error: { code: 'TEST_TOOL_FAILED', message }
      });
      const replay = await runner.wait({ cellId: failure.result.data.cellId }, input);
      expect(replay.data).toMatchObject({
        status: 'failed',
        error: { code: 'TEST_TOOL_FAILED', message }
      });
      const caught = await runner.execute(
        'try { await tools.read_value({}); } catch (error) { observe.result(error); }',
        input
      );
      expect(caught.observations?.[0]).toMatchObject({
        type: 'tool_result',
        outcome: 'failed',
        result: { content: JSON.stringify({ error: 'TEST_TOOL_FAILED', message }) }
      });
    } finally {
      await runner.dispose();
    }
  });

  it('preserves guest exception codes and starts a clean engine for the next cell', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    try {
      await expect(
        runner.execute(
          `throw Object.assign(new Error("Expected guest failure."), { code: "TEST_GUEST_FAILURE" });`,
          context()
        )
      ).rejects.toMatchObject({ code: 'TEST_GUEST_FAILURE' });
      const clean = await runner.execute('observe.text("CLEAN_CELL_OK")', context());
      expect(observedText(clean)).toBe('CLEAN_CELL_OK');
      expect(clean.data).toMatchObject({ toolCalls: 0 });
    } finally {
      await runner.dispose();
    }
  });

  it('honors the whole-cell Host policy hook and does not bypass executor failure', async () => {
    const { home, workspace } = await fixture();
    let spawned = 0;
    let blocked = true;
    const host = new LocalAgentHost({
      homeDirectory: home,
      workspace,
      beforeToolExecute: async () => {
        if (blocked) throw new MarAgentError('TEST_POLICY_DENIED', 'Host policy denied this cell');
      },
      processExecutor: {
        spawn: async () => {
          spawned++;
          throw new MarAgentError('TEST_EXECUTOR_DENIED', 'Host executor denied this cell');
        }
      }
    });
    try {
      expect((await host.describe()).capabilities).toContain('code.execute');
      await expect(
        host.executeTool(
          { name: 'code_exec', arguments: 'observe.text(1)' },
          {
            ...context()
          }
        )
      ).rejects.toMatchObject({ code: 'TEST_POLICY_DENIED' });
      expect(spawned).toBe(0);
      blocked = false;
      await expect(
        host.executeTool({ name: 'code_exec', arguments: 'observe.text(1)' }, context())
      ).rejects.toMatchObject({ code: 'TEST_EXECUTOR_DENIED' });
      expect(spawned).toBe(1);
    } finally {
      await host.dispose();
    }
  });

  it('aborts pending tools and the cell but truncates excessive ordinary output', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    const abort = new AbortController();
    const input = context(abort.signal);
    let observedAbort = false;
    input.codeMode!.invoke = async (_call, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            observedAbort = true;
            reject(signal.reason);
          },
          { once: true }
        );
        abort.abort(new Error('Stop cell'));
      });
    await expect(runner.execute('await tools.read_value({ value: 1 })', input)).rejects.toThrow(
      'Stop cell'
    );
    expect(observedAbort).toBe(true);
    const result = await runner.execute('observe.text("x".repeat(2_000_000))', context());
    expect(result.truncated).toBe(true);
    expect(result.observations).toMatchObject([{ type: 'value', truncated: true }]);
    expect(observedValues(result)[0]).toHaveLength(TOOL_EXECUTION_LIMITS.codeMaxOutputBytes);
    expect(result.data).toMatchObject({
      outputBytes: 2_000_000,
      outputDroppedBytes: 2_000_000 - TOOL_EXECUTION_LIMITS.codeMaxOutputBytes
    });
  });

  it('terminates a busy JavaScript loop without blocking the Agent event loop', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    const abort = new AbortController();
    const input = context(abort.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    input.codeMode!.invoke = async () => {
      timer = setTimeout(() => abort.abort(new Error('Stop busy loop')), 50);
      return { content: 'ready' };
    };
    try {
      await expect(
        runner.execute('await tools.read_value({}); while (true) {}', input)
      ).rejects.toThrow('Stop busy loop');
    } finally {
      if (timer) clearTimeout(timer);
      await runner.dispose();
    }
  });

  it('does not report completion when tool promises were left unawaited', async () => {
    const { workspace } = await fixture();
    const runner = new CodeModeTool(new WorkspacePathResolver(workspace), {});
    const input = context();
    input.codeMode!.invoke = async (_call, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
    await expect(
      runner.execute('tools.read_value({ value: 1 }); observe.text("done");', input)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_INCOMPLETE' });
    await runner.dispose();
  });
});
