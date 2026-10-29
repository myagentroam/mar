import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host/local-agent-host.js';
import { CodeCells } from '../../src/tools/code-mode/cells.js';
import { structuredToolEventData } from '../../src/tools/output-projection.js';
import { TOOL_EXECUTION_LIMITS as limits } from '../../src/tools/execution-limits.js';
import { execToolDefinition, execWaitToolDefinition } from '../../src/tools/local/exec.js';
import { applyPatchToolDefinition } from '../../src/tools/local/apply-patch.js';
import type { ToolExecutionContext, ToolExecutionResult } from '../../src/sdk/types.js';

const hosts: LocalAgentHost[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const context = (signal = new AbortController().signal): ToolExecutionContext => ({
  sessionId: 'session',
  executionId: 'first',
  mode: 'run',
  signal,
  codeMode: { tools: [], invoke: async () => ({ content: '' }) }
});
const data = (result: ToolExecutionResult) =>
  result.data as { cellId: string; status: string; output: string; cached: boolean };
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-code-exec-'));
  roots.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const host = new LocalAgentHost({ homeDirectory: home, workspace });
  hosts.push(host);
  return host;
}

describe('Code Exec retained cells', () => {
  it('keeps the public terminal and cached tail independent from the model capture budget', async () => {
    const host = await fixture();
    const result = await host.executeTool(
      {
        name: 'code_exec',
        arguments: `observe.text('model head-' + 'x'.repeat(${limits.codeMaxOutputBytes + 32}) + '😀public tail'); observe.text('after budget');`
      },
      context()
    );
    const expected = {
      truncated: true,
      outputHeadTruncated: true,
      observations: [
        { value: expect.stringMatching(/😀public tail$/u), truncated: true },
        { value: 'after budget' }
      ]
    };
    expect(structuredToolEventData('code_exec', result.eventData)).toMatchObject(expected);
    expect(JSON.stringify(result.observations)).toContain('model head-');
    expect(JSON.stringify(result.observations)).not.toContain('public tail');
    expect(JSON.stringify(result.observations)).not.toContain('after budget');
    expect(result.data).not.toHaveProperty('outputHeadTruncated');
    const replay = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(result).cellId } },
      { ...context(), executionId: 'later' }
    );
    expect(structuredToolEventData('code_exec_wait', replay.eventData)).toMatchObject({
      ...expected,
      cached: true
    });
    expect(replay.observations).toEqual(result.observations);
  });
  it('uses observed exec display tails without exposing their event metadata to the guest', async () => {
    const host = await fixture();
    const ctx = context();
    ctx.codeMode = {
      tools: [execToolDefinition],
      invoke: async () => ({
        content: 'model head',
        data: { stdout: 'model head', stderr: '', truncated: true },
        eventData: {
          displayOutput: {
            stdout: 'public tail',
            stderr: 'public error',
            stdoutDroppedBytes: 100,
            stderrDroppedBytes: 0
          }
        },
        truncated: true
      })
    };
    const result = await host.executeTool(
      {
        name: 'code_exec',
        arguments:
          'const r = await tools.exec({ command: "fixture" }); observe.text("eventData" in r); observe.result(r);'
      },
      ctx
    );
    expect(structuredToolEventData('code_exec', result.eventData)).toMatchObject({
      truncated: true,
      outputHeadTruncated: true,
      observations: [
        { type: 'value', value: 'false' },
        { type: 'tool_result', result: { data: { stdout: 'public tail', stderr: 'public error' } } }
      ]
    });
    expect(JSON.stringify(result.observations)).toContain('model head');
    expect(JSON.stringify(result.observations)).not.toContain('public tail');
  });
  it('does not infer a discarded display head from a source-only truncation', async () => {
    const host = await fixture();
    const ctx = context();
    ctx.codeMode = {
      tools: [execToolDefinition],
      invoke: async () => ({
        content: 'partial',
        data: { stdout: 'partial', stderr: '' },
        truncated: true
      })
    };
    const result = await host.executeTool(
      { name: 'code_exec', arguments: 'observe.result(await tools.exec({ command: "fixture" }));' },
      ctx
    );
    const event = structuredToolEventData('code_exec', result.eventData);
    expect(event).toMatchObject({ truncated: true });
    expect(event).not.toHaveProperty('outputHeadTruncated');
    const replay = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(result).cellId } },
      { ...context(), executionId: 'later' }
    );
    const cached = structuredToolEventData('code_exec_wait', replay.eventData);
    expect(cached).toMatchObject({ truncated: true, cached: true });
    expect(cached).not.toHaveProperty('outputHeadTruncated');
  });
  it('keeps a bounded source on failed cells and cached cancellation without exposing it to the model', async () => {
    const host = await fixture();
    const source = `//${'x'.repeat(10_020)}\nthrow new Error('fixture failure');`;
    const failure = await host
      .executeTool({ name: 'code_exec', arguments: source }, context())
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'MAR_AGENT_CODE_FAILED',
      result: {
        eventData: {
          executionSource: { kind: 'CODE', text: source.slice(0, 10_000), truncated: true }
        }
      }
    });
    const result = (failure as { result: ToolExecutionResult }).result;
    expect(result.data).not.toHaveProperty('executionSource');
    expect(result.content).not.toContain('executionSource');
    const replay = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(result).cellId, action: 'cancel' } },
      { ...context(), executionId: 'later' }
    );
    expect(replay.eventData).toMatchObject({
      executionSource: { kind: 'CODE', text: source.slice(0, 10_000), truncated: true }
    });
    expect(replay.data).not.toHaveProperty('executionSource');
    expect(replay.content).not.toContain('executionSource');
  });
  it('uses typed short handles and rejects cross-type controls without touching either resource', async () => {
    const host = await fixture();
    const ctx = context();
    const cell = await host.executeTool(
      { name: 'code_exec', arguments: 'observe.text("retained cell");' },
      ctx
    );
    const process = await host.executeTool(
      {
        name: 'exec',
        arguments: {
          command: `${JSON.stringify(globalThis.process.execPath)} -e "process.stdout.write('retained process')"`,
          yieldMs: 10000
        }
      },
      ctx
    );
    const cellId = data(cell).cellId;
    const processId = (process.data as { processId: string }).processId;
    expect(cellId).toMatch(/^c_[0-9a-f]{12}$/u);
    expect(processId).toMatch(/^p_[0-9a-f]{12}$/u);
    for (const action of ['poll', 'cancel']) {
      await expect(
        host.executeTool({ name: 'code_exec_wait', arguments: { cellId: processId, action } }, ctx)
      ).rejects.toMatchObject({
        code: 'MAR_AGENT_RESOURCE_HANDLE_TYPE_MISMATCH',
        publicMessage: expect.stringContaining('exec_wait')
      });
    }
    for (const action of ['poll', 'write', 'cancel']) {
      await expect(
        host.executeTool(
          {
            name: 'exec_wait',
            arguments: { processId: cellId, action, ...(action === 'write' ? { data: 'no' } : {}) }
          },
          ctx
        )
      ).rejects.toMatchObject({
        code: 'MAR_AGENT_RESOURCE_HANDLE_TYPE_MISMATCH',
        publicMessage: expect.stringContaining('code_exec_wait')
      });
    }
    const later = { ...ctx, executionId: 'later' };
    const replay = await host.executeTool({ name: 'code_exec_wait', arguments: { cellId } }, later);
    expect(replay.data).toMatchObject({ cellId, status: 'completed', cached: true });
    expect(replay.eventData).toMatchObject({
      executionSource: { kind: 'CODE', text: 'observe.text("retained cell");', truncated: false }
    });
    expect(replay.data).not.toHaveProperty('executionSource');
    expect(structuredToolEventData('code_exec_wait', replay.eventData)).toMatchObject({
      executionSource: { kind: 'CODE', text: 'observe.text("retained cell");' }
    });
    expect(replay.observations).toEqual(cell.observations);
    expect(
      (await host.executeTool({ name: 'exec_wait', arguments: { processId, yieldMs: 0 } }, later))
        .data
    ).toMatchObject({ processId, stdout: 'retained process', cached: true });
  });

  it('reuses direct exec formatting for original observations and terminal replay', async () => {
    const host = await fixture();
    const input = context();
    input.codeMode!.tools = [execToolDefinition];
    input.codeMode!.invoke = (call, signal) => host.executeTool(call, { ...input, signal });
    const args = {
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('example')"`,
      yieldMs: 10000
    };
    const direct = await host.executeTool({ name: 'exec', arguments: args }, input);
    const observed = await host.executeTool(
      {
        name: 'code_exec',
        arguments: `const result = await tools.exec(${JSON.stringify(args)});
          if (result.data.stdoutBytes !== 7 || result.data.stderrBytes !== 0 || result.data.truncated !== false)
            throw new Error("Programmatic exec data changed");
          observe.result(result);`
      },
      input
    );
    const first = observed.observations![0];
    if (first.type !== 'tool_result') throw new Error('Missing original exec observation');
    const { processId: _directId, ...directBody } = JSON.parse(direct.content);
    const { processId: _observedId, ...observedBody } = JSON.parse(first.result.content);
    expect(observedBody).toEqual(directBody);
    expect(directBody).toEqual({
      status: 'completed',
      stdout: 'example',
      exitCode: 0,
      waitOutcome: 'completion'
    });
    expect(direct.data).toMatchObject({ stdoutBytes: 7, stderrBytes: 0, truncated: false });
    expect(first.result.data).toMatchObject({
      stdout: 'example',
      stdoutBytes: 7,
      stderrBytes: 0,
      truncated: false
    });
    expect(observed.content).not.toContain('stdoutBytes');
    expect(observed.content).not.toContain('stderrBytes');
    const replay = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(observed).cellId } },
      input
    );
    expect(replay.observations).toEqual(observed.observations);
    expect(replay.data).toMatchObject({ cached: true });
    const terminal = await host.executeTool(
      { name: 'exec_wait', arguments: { processId: _directId, yieldMs: 0 } },
      input
    );
    expect(JSON.parse(terminal.content)).toEqual({
      ...JSON.parse(direct.content),
      cached: true,
      waitOutcome: 'snapshot'
    });
    expect(terminal.data).toMatchObject({ stdoutBytes: 7, stderrBytes: 0, cached: true });
  });

  it('keeps a cell and real process wait active beyond the former wall deadline', async () => {
    const host = await fixture();
    const ctx = context();
    const processResult = await host.executeTool(
      {
        name: 'exec',
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "process.stdin.resume();process.stdin.once('data',()=>{process.stdout.write('finished');process.exit(0)});"`,
          timeoutMs: 500_000,
          yieldMs: 0
        }
      },
      ctx
    );
    const processId = (processResult.data as { processId: string }).processId;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    ctx.codeMode = {
      tools: [execWaitToolDefinition],
      invoke: (call, signal) => {
        const result = host.executeTool(call, { ...ctx, signal });
        entered();
        return result;
      }
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const initial = host.executeTool(
        {
          name: 'code_exec',
          arguments: `observe.result(await tools.exec_wait({processId:${JSON.stringify(processId)},yieldMs:300000}));`
        },
        ctx
      );
      const settled = initial.then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      await ready;
      await vi.advanceTimersByTimeAsync(limits.codeTimeoutMs + 1);
      const started = await settled;
      expect(started).toMatchObject({ result: { data: { status: 'running' } } });
      if (!('result' in started)) throw new Error('Cell did not remain running.');
      const cellId = data(started.result).cellId;
      await host.executeTool(
        { name: 'exec_wait', arguments: { processId, action: 'write', data: 'finish\n' } },
        ctx
      );
      const final = await host.executeTool(
        { name: 'code_exec_wait', arguments: { cellId, yieldMs: 300000 } },
        ctx
      );
      expect(final).toMatchObject({ data: { status: 'completed' } });
      expect(final.observations).toContainEqual(
        expect.objectContaining({
          type: 'tool_result',
          source: expect.objectContaining({
            toolName: 'exec_wait',
            input: { processId, yieldMs: 300000 }
          })
        })
      );
      const observation = final.observations?.find(
        (value) => value.type === 'tool_result' && value.source.toolName === 'exec_wait'
      );
      if (observation?.type !== 'tool_result') throw new Error('Process wait was not observed.');
      expect(JSON.parse(observation.result.content)).toMatchObject({
        processId,
        stdout: 'finished'
      });
      const terminal = await host.executeTool(
        { name: 'exec_wait', arguments: { processId, yieldMs: 10000 } },
        ctx
      );
      expect(terminal).toMatchObject({ data: { status: 'completed', exitCode: 0 } });
    } finally {
      vi.useRealTimers();
      await host.dispose();
    }
  });
  it('keeps completed tool facts when delivering its result exceeds the bridge limit', async () => {
    const host = await fixture();
    let effects = 0;
    const ctx = context();
    ctx.codeMode = {
      tools: [
        {
          name: 'read_value',
          description: 'fixture',
          inputSchema: { type: 'object' },
          allowedCallers: ['programmatic']
        }
      ],
      invoke: async () => {
        effects++;
        return { content: 'completed', data: { value: 'x'.repeat(limits.codeMaxFrameBytes) } };
      }
    };
    try {
      await host.executeTool({ name: 'code_exec', arguments: 'await tools.read_value({});' }, ctx);
      throw new Error('Expected a bridge limit failure.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MAR_AGENT_TOOL_OUTPUT_LIMIT',
        result: {
          calls: [expect.objectContaining({ toolName: 'read_value', status: 'completed' })]
        }
      });
    }
    expect(effects).toBe(1);
  });
  it('preserves embedded error-code text when adding the outer failure prefix', async () => {
    const cells = new CodeCells();
    const message = 'Failed while decoding MAR_AGENT_CODE_FAILED: keep this text.';
    const original = new Error(message);
    try {
      const failure = await cells
        .start('1', context(), async () => {
          throw original;
        })
        .catch((error) => error);
      expect(failure).toMatchObject({
        code: 'MAR_AGENT_CODE_FAILED',
        message: `MAR_AGENT_CODE_FAILED: ${message}`,
        cause: original
      });
      expect(failure.result.data).toMatchObject({
        status: 'failed',
        error: { code: 'MAR_AGENT_CODE_FAILED', message }
      });
      const replay = await cells.wait({ cellId: data(failure.result).cellId }, context());
      expect(replay.data).toMatchObject({
        status: 'failed',
        cached: true,
        error: { code: 'MAR_AGENT_CODE_FAILED', message }
      });
      expect(structuredToolEventData('code_exec_wait', replay.data)).toMatchObject({
        status: 'failed',
        error: { code: 'MAR_AGENT_CODE_FAILED', message }
      });
    } finally {
      await cells.dispose();
    }
  });

  it('waits thirty seconds initially but only ten seconds on subsequent default waits', async () => {
    vi.useFakeTimers();
    const cells = new CodeCells();
    let finish!: () => void;
    try {
      let settled = false;
      const starting = cells
        .start('1', context(), async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { content: '' };
        })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(29999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const started = await starting;
      expect(data(started).status).toBe('running');
      settled = false;
      const waiting = cells.wait({ cellId: data(started).cellId }, context()).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(data(await waiting).status).toBe('running');
    } finally {
      finish?.();
      await cells.dispose();
      vi.useRealTimers();
    }
  });

  it('returns a nested ten-second wait result without an intermediate cell wait', async () => {
    vi.useFakeTimers();
    const cells = new CodeCells();
    try {
      const starting = cells.start('1', context(), async () => {
        await new Promise((resolve) => setTimeout(resolve, 10200));
        return { content: 'process-handle' };
      });
      await vi.advanceTimersByTimeAsync(10200);
      expect(data(await starting).status).toBe('completed');
    } finally {
      await cells.dispose();
      vi.useRealTimers();
    }
  });

  it('allows a five-minute subsequent wait while keeping the initial wait capped at thirty seconds', async () => {
    const cells = new CodeCells();
    let finish!: () => void;
    const input = context();
    try {
      await expect(
        cells.start('// @options: {"yieldMs":30001}\n1', input, async () => ({ content: '' }))
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
      const started = await cells.start('// @options: {"yieldMs":0}\n1', input, async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { content: '' };
      });
      const cellId = data(started).cellId;
      await expect(cells.wait({ cellId, yieldMs: 300001 }, input)).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID'
      });
      vi.useFakeTimers();
      let settled = false;
      const waiting = cells.wait({ cellId, yieldMs: 300000 }, input).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(299999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(data(await waiting).status).toBe('running');
      const completed = cells.wait({ cellId, yieldMs: 300000 }, input);
      finish();
      expect(data(await completed).status).toBe('completed');
    } finally {
      finish?.();
      await cells.dispose();
      vi.useRealTimers();
    }
  });

  it('bounds exec first, removes duplicate content and truncates cell output without stopping later tools or state commit', async () => {
    const host = await fixture();
    const input = context();
    const commitState = vi.fn();
    input.codeMode!.tools = [execToolDefinition, applyPatchToolDefinition];
    input.codeMode!.invoke = (call, signal) => host.executeTool(call, { ...input, signal });
    input.codeMode!.commitState = commitState;
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(1200000));process.stderr.write('y'.repeat(1200000));process.exitCode=7"`;
    const source = `const result = await tools.exec(${JSON.stringify({ command, yieldMs: 10000 })});
      if (result.content !== undefined || result.data.exitCode !== 7 || !result.data.truncated ||
          result.data.stdout.length !== 1000000 || result.data.stderr.length !== 1000000 ||
          result.data.stdoutBytes !== 1200000 || result.data.stdoutDroppedBytes !== 200000)
        throw new Error("Invalid exec truncation or programmatic projection");
      observe.text(result);
      await tools.apply_patch("*** Begin Patch\\n*** Add File: after.txt\\n+completed\\n*** End Patch");
      state.set("done",true);`;
    const result = await host.executeTool({ name: 'code_exec', arguments: source }, input);
    expect(result.truncated).toBe(true);
    expect(result.data).toMatchObject({
      status: 'completed',
      truncated: true,
      outputBytes: expect.any(Number),
      outputDroppedBytes: expect.any(Number)
    });
    expect(
      result.observations?.some((value) =>
        value.type === 'tool_result' ? value.result.truncated : value.truncated
      )
    ).toBe(true);
    expect(commitState).toHaveBeenCalledOnce();
    expect(await readFile(join(roots.at(-1)!, 'workspace', 'after.txt'), 'utf8')).toBe(
      'completed\n'
    );
    const replay = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(result).cellId } },
      input
    );
    expect(replay.truncated).toBe(true);
    expect(data(replay)).toMatchObject({
      status: 'completed',
      cached: true,
      output: data(result).output
    });
  });

  it('does not replenish the text budget across waits and retains truncation on failure', async () => {
    const host = await fixture();
    const input = context();
    const commitState = vi.fn();
    input.codeMode!.commitState = commitState;
    const first = await host.executeTool(
      {
        name: 'code_exec',
        arguments:
          'observe.text("x".repeat(1048570)); await cell.yield_control(); await cell.sleep(30); observe.text("😀".repeat(100)); state.set("uncommitted",true); throw new Error("later failure");'
      },
      input
    );
    expect(data(first).status).toBe('running');
    await expect
      .poll(async () => (await host.listSessionResources('session')).codeCells?.[0]?.status)
      .toBe('failed');
    const last = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(first).cellId } },
      input
    );
    expect(last.truncated).toBe(true);
    expect(last.data).toMatchObject({
      status: 'failed',
      outputBytes: 400,
      outputDroppedBytes: 396,
      error: { message: expect.stringContaining('later failure') }
    });
    expect(data(last).output).toContain('text bytes omitted');
    expect(data(last).output).not.toContain('\ufffd');
    expect(commitState).not.toHaveBeenCalled();
    const replay = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(first).cellId, maxOutputTokens: 1 } },
      input
    );
    expect(replay.truncated).toBe(true);
    expect(replay.data).toMatchObject({ status: 'failed', truncated: true, cached: true });
  });

  it('preserves prior truncation in an empty terminal result and its cached replay', async () => {
    const host = await fixture();
    const input = context();
    const first = await host.executeTool(
      {
        name: 'code_exec',
        arguments:
          'observe.text("x".repeat(2000000)); await cell.yield_control(); await cell.sleep(30);'
      },
      input
    );
    expect(first.truncated).toBe(true);
    await expect
      .poll(async () => (await host.listSessionResources('session')).codeCells?.[0]?.status)
      .toBe('completed');
    const terminal = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(first).cellId } },
      input
    );
    expect(terminal.truncated).toBe(true);
    expect(terminal.data).toMatchObject({ status: 'completed', truncated: true, output: '' });
    const cached = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(first).cellId } },
      input
    );
    expect(cached.truncated).toBe(true);
    expect(cached.data).toMatchObject({ cached: true, truncated: true });
  });

  it('preserves bounded output and images on initial failure without committing state', async () => {
    const host = await fixture();
    const input = context();
    const commitState = vi.fn();
    input.codeMode!.supportsImages = true;
    input.codeMode!.commitState = commitState;
    const image = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
    const failure = await host
      .executeTool(
        {
          name: 'code_exec',
          arguments: `state.set("uncommitted", true); observe.text("x".repeat(${limits.codeMaxOutputTokens * 8})); observe.image(${JSON.stringify(image)}); throw new Error("later failure");`
        },
        input
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      result: {
        truncated: true,
        images: [image],
        data: { status: 'failed', error: { message: expect.stringContaining('later failure') } }
      }
    });
    const result = (failure as { result: ToolExecutionResult }).result;
    expect(result.content).toContain('tokens of tool output omitted');
    expect(commitState).not.toHaveBeenCalled();
    const replay = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(result).cellId } },
      input
    );
    expect(data(replay)).toMatchObject({
      status: 'failed',
      cached: true,
      output: data(result).output
    });
    expect(replay.images).toEqual([image]);
  });

  it('retains original observations and cached failures after Promise-job heap growth', async () => {
    const host = await fixture();
    const input = context();
    const commitState = vi.fn();
    const image = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
    input.codeMode = {
      tools: [
        {
          name: 'read_value',
          description: 'fixture',
          inputSchema: { type: 'object' },
          allowedCallers: ['programmatic']
        }
      ],
      invoke: async () => ({ content: 'before-growth', images: [image] }),
      supportsImages: true,
      commitState
    };
    const failure = await host
      .executeTool(
        {
          name: 'code_exec',
          arguments: `
          observe.result(await tools.read_value({}));
          const items = [];
          for (let i = 0; i < 200000; i++) items.push({i});
          state.set('uncommitted', true);
          throw new Error('After heap growth.');
        `
        },
        input
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      result: {
        images: [image],
        observations: [
          { type: 'tool_result', outcome: 'completed', result: { content: 'before-growth' } }
        ],
        data: {
          status: 'failed',
          error: {
            code: 'MAR_AGENT_CODE_FAILED',
            message: expect.stringContaining('After heap growth.')
          }
        }
      }
    });
    expect(commitState).not.toHaveBeenCalled();
    const result = (failure as { result: ToolExecutionResult }).result;
    const replay = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(result).cellId } },
      input
    );
    expect(data(replay)).toMatchObject({ status: 'failed', cached: true });
    expect(replay.observations).toEqual(result.observations);
    expect(replay.images).toEqual(result.images);
  });

  it('yield ends the wait, not JavaScript execution, and later waits consume only new output', async () => {
    const host = await fixture();
    const first = await host.executeTool(
      {
        name: 'code_exec',
        arguments:
          'observe.text("first"); await cell.yield_control(); await cell.sleep(30); observe.text("background");'
      },
      context()
    );
    expect(data(first)).toMatchObject({ status: 'running', output: 'first' });
    // No wait call is needed to let the JavaScript cell finish.
    await expect
      .poll(async () => (await host.listSessionResources('session')).codeCells?.[0]?.status)
      .toBe('completed');
    const next = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(first).cellId } },
      { ...context(), executionId: 'second' }
    );
    expect(data(next)).toMatchObject({ status: 'completed', output: 'background', cached: false });
    expect(next.content).not.toContain('first');
    const cached = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(first).cellId } },
      context()
    );
    expect(data(cached)).toMatchObject({ status: 'completed', output: 'background', cached: true });
  });

  it('automatic yield and cancelled model waits retain the cell without consuming output', async () => {
    const host = await fixture();
    const started = await host.executeTool(
      {
        name: 'code_exec',
        arguments: '// @options: {"yieldMs":0}\nawait cell.sleep(200); observe.text("retained");'
      },
      context()
    );
    const controller = new AbortController();
    const waiting = host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(started).cellId } },
      context(controller.signal)
    );
    controller.abort(new Error('cancel wait'));
    await expect(waiting).rejects.toThrow('cancel wait');
    const result = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(started).cellId } },
      context()
    );
    expect(data(result)).toMatchObject({ status: 'completed', output: 'retained' });
  });

  it('explicit termination discards state and clears workers; Session cleanup invalidates ids', async () => {
    const host = await fixture();
    const commitState = vi.fn();
    const input = context();
    input.codeMode!.commitState = commitState;
    const started = await host.executeTool(
      {
        name: 'code_exec',
        arguments:
          'state.set("never", true); observe.text("ready"); cell.yield_control(); await cell.sleep(30000);'
      },
      input
    );
    const result = await host.executeTool(
      { name: 'code_exec_wait', arguments: { cellId: data(started).cellId, action: 'cancel' } },
      context()
    );
    expect(data(result).status).toBe('cancelled');
    expect(commitState).not.toHaveBeenCalled();
    await host.disposeSessionResources('session');
    expect((await host.listSessionResources('session')).codeCells).toEqual([]);
    await expect(
      host.executeTool(
        { name: 'code_exec_wait', arguments: { cellId: data(started).cellId } },
        context()
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_CELL_NOT_FOUND' });
  });

  it('enforces Session ownership, control-tool exclusion, failure status and bounded wait options', async () => {
    const host = await fixture();
    const started = await host.executeTool(
      {
        name: 'code_exec',
        arguments: 'cell.yield_control(); await cell.sleep(20); throw new Error("after yield");'
      },
      context()
    );
    const wait = {
      name: 'code_exec_wait',
      arguments: { cellId: data(started).cellId, action: 'poll' }
    };
    await expect(
      host.executeTool(wait, { ...context(), sessionId: 'other' })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_CELL_NOT_FOUND' });
    expect(data(await host.executeTool(wait, context())).status).toBe('failed');
    for (const arguments_ of [
      { cellId: data(started).cellId, yieldMs: -1 },
      { cellId: data(started).cellId, action: 'unknown' }
    ])
      await expect(
        host.executeTool({ name: 'code_exec_wait', arguments: arguments_ }, context())
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    await expect(
      host.executeTool({ name: 'code_exec', arguments: '// @options: invalid\n1;' }, context())
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    await expect(
      host.executeTool(
        { name: 'code_exec', arguments: 'await tools.code_exec_wait({});' },
        context()
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_NOT_AVAILABLE' });
  });

  it('ignores removed output options without clipping initial observations', async () => {
    const cells = new CodeCells();
    try {
      const initial = await cells.start(
        '// @options: {"maxOutputTokens":1}\n1',
        context(),
        async (_code, _context, output) => {
          output.text('preserved output');
          return { content: '' };
        }
      );
      expect(initial.truncated).toBe(false);
      expect((initial.data as { output: string }).output).toBe('preserved output');
    } finally {
      await cells.dispose();
    }
  });

  it('bounds running capacity and completed retention without model-adjustable replay budgets', async () => {
    const running = new CodeCells();
    const ctx = context();
    const finishers: (() => void)[] = [];
    try {
      for (let i = 0; i < limits.codeMaxConcurrentCells; i++)
        await running.start(
          '// @options: {"yieldMs":0}\n1',
          ctx,
          async (_code, _context, output) => {
            await new Promise<void>((resolve) => finishers.push(resolve));
            output.text('x'.repeat(1000));
            return { content: '' };
          }
        );
      await expect(running.start('1', ctx, async () => ({ content: '' }))).rejects.toMatchObject({
        code: 'MAR_AGENT_PROCESS_LIMIT'
      });
      finishers.forEach((finish) => finish());
      await expect
        .poll(() => running.snapshot('session').every((cell) => cell.status === 'completed'))
        .toBe(true);
      const cellId = running.snapshot('session')[0]!.cellId;
      await running.wait({ cellId }, ctx);
      const cached = await running.wait({ cellId, maxOutputTokens: 10 }, ctx);
      expect(cached.truncated).toBe(false);
      expect((cached.data as { output: string }).output).toBe('x'.repeat(1000));
      for (let i = 0; i < limits.codeMaxCompletedResults + 1; i++)
        await running.start('1', ctx, async () => ({ content: '' }));
      expect(running.snapshot('session')).toHaveLength(limits.codeMaxCompletedResults);
      await expect(running.wait({ cellId }, ctx)).rejects.toMatchObject({
        code: 'MAR_AGENT_CODE_CELL_NOT_FOUND'
      });
    } finally {
      finishers.forEach((finish) => finish());
      await running.dispose();
    }
  });

  it('shares a generous running limit across sessions and releases failed-cell capacity', async () => {
    const cells = new CodeCells();
    const finishers: (() => void)[] = [];
    const childContext = (index: number) => ({ ...context(), sessionId: `child-${index}` });
    const start = (ctx: ToolExecutionContext, fail = false) =>
      cells.start('// @options: {"yieldMs":0}\n1', ctx, async () => {
        await new Promise<void>((resolve) => finishers.push(resolve));
        if (fail) throw new Error('Expected cell failure.');
        return { content: '' };
      });
    try {
      expect(limits.codeMaxConcurrentCells).toBe(64);
      for (let index = 0; index < 4; index++) await start(childContext(index), index === 0);
      const parent = await start(context());
      expect(data(parent).status).toBe('running');
      for (let index = 5; index < limits.codeMaxConcurrentCells; index++)
        await start(childContext(index));
      await expect(start({ ...context(), sessionId: 'another-session' })).rejects.toMatchObject({
        code: 'MAR_AGENT_PROCESS_LIMIT',
        message: expect.stringContaining('shared running-cell limit (64)')
      });
      finishers[0]!();
      await expect.poll(() => cells.snapshot('child-0')[0]?.status).toBe('failed');
      const replacement = await start({ ...context(), sessionId: 'replacement' });
      expect(data(replacement).status).toBe('running');
      await expect(start(context())).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_LIMIT' });
    } finally {
      finishers.forEach((finish) => finish());
      await cells.dispose();
    }
  });

  it('retains the most recently completed cells rather than the most recently started cells', async () => {
    const cells = new CodeCells();
    let finish!: () => void;
    try {
      const slow = await cells.start(
        '// @options: {"yieldMs":0}\n1',
        context(),
        async (_source, _context, output) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          output.text('late completion');
          return { content: '' };
        }
      );
      const first = await cells.start('1', context(), async () => ({ content: '' }));
      for (let index = 1; index < limits.codeMaxCompletedResults; index++)
        await cells.start('1', context(), async () => ({ content: '' }));
      finish();
      await expect
        .poll(() => cells.snapshot('session').filter((cell) => cell.status === 'running').length)
        .toBe(0);
      expect(data(await cells.wait({ cellId: data(slow).cellId }, context())).output).toBe(
        'late completion'
      );
      await expect(cells.wait({ cellId: data(first).cellId }, context())).rejects.toMatchObject({
        code: 'MAR_AGENT_CODE_CELL_NOT_FOUND'
      });
      expect(cells.snapshot('session')).toHaveLength(limits.codeMaxCompletedResults);
    } finally {
      finish?.();
      await cells.dispose();
    }
  });

  it('expires terminal snapshots without read renewal and releases a cancelled initial wait', async () => {
    vi.useFakeTimers();
    const cells = new CodeCells();
    const controller = new AbortController();
    let finish!: () => void;
    const result = cells.start(
      '1;',
      context(controller.signal),
      async (_source, _context, output) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        output.text('kept');
        return { content: 'kept' };
      }
    );
    await Promise.resolve();
    controller.abort(new Error('initial wait cancelled'));
    await expect(result).rejects.toThrow('initial wait cancelled');
    const cellId = cells.snapshot('session')[0]!.cellId;
    await vi.advanceTimersByTimeAsync(limits.codeCompletedRetentionMs + 1);
    expect(cells.snapshot('session')[0]!.status).toBe('running');
    finish();
    const terminal = await cells.wait({ cellId }, context());
    expect(data(terminal).output).toBe('kept');
    const afterFormerDeadlineMs = 5 * 60_000 + 1;
    await vi.advanceTimersByTimeAsync(afterFormerDeadlineMs);
    expect(data(await cells.wait({ cellId }, context())).cached).toBe(true);
    await vi.advanceTimersByTimeAsync(limits.codeCompletedRetentionMs - afterFormerDeadlineMs - 1);
    expect(data(await cells.wait({ cellId }, context())).cached).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(cells.snapshot('session')).toEqual([]);
    await cells.dispose();
  });
});
