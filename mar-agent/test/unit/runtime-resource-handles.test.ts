import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '../../src/tools/contracts.js';
import { CodeCells } from '../../src/tools/code-mode/cells.js';
import { ExecTool } from '../../src/host/local-exec-tool.js';
import { WorkspacePathResolver } from '../../src/tools/shared/path-resolver.js';
import { RuntimeResourceHandles } from '../../src/tools/runtime-resource-handles.js';

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomBytes: vi.fn()
}));

beforeEach(() => {
  vi.mocked(randomBytes).mockReset();
});

describe('typed runtime resource handles', () => {
  it('does not overwrite running cells or their retained terminal results on collision', async () => {
    const cells = new CodeCells();
    const context: ToolExecutionContext = {
      sessionId: 'session',
      executionId: 'first',
      mode: 'run',
      signal: new AbortController().signal
    };
    for (const suffix of [
      '111111111111',
      '222222222222',
      '111111111111',
      '222222222222',
      '333333333333'
    ])
      vi.mocked(randomBytes).mockReturnValueOnce(Buffer.from(suffix, 'hex'));
    try {
      const running = await cells.start('running', context, async (_code, ctx, output) => {
        output.yield();
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => resolve(), { once: true })
        );
        return { content: '' };
      });
      const completed = await cells.start('completed', context, async () => ({ content: '' }));
      const next = await cells.start('next', context, async () => ({ content: '' }));
      expect(running.data).toMatchObject({ cellId: 'c_111111111111', status: 'running' });
      expect(completed.data).toMatchObject({ cellId: 'c_222222222222', status: 'completed' });
      expect(next.data).toMatchObject({ cellId: 'c_333333333333' });
      expect(
        (await cells.wait({ cellId: 'c_111111111111', yieldMs: 0 }, context)).data
      ).toMatchObject({ status: 'running' });
      expect((await cells.wait({ cellId: 'c_222222222222' }, context)).data).toMatchObject({
        status: 'completed',
        cached: true
      });
    } finally {
      await cells.dispose();
    }
  });

  it('does not overwrite concurrent processes or cached results on collision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-resource-handles-'));
    const children: Array<ReturnType<typeof child>> = [];
    function child() {
      return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null
      });
    }
    const tool = new ExecTool(new WorkspacePathResolver(root), 16, 4, {}, undefined, {
      async spawn() {
        const current = child();
        children.push(current);
        return current as unknown as ChildProcessWithoutNullStreams;
      }
    });
    for (const suffix of [
      '111111111111',
      '111111111111',
      '222222222222',
      '111111111111',
      '222222222222',
      '333333333333'
    ])
      vi.mocked(randomBytes).mockReturnValueOnce(Buffer.from(suffix, 'hex'));
    const owner = { sessionId: 'session', executionId: 'first' };
    const start = () => tool.execute({ command: 'fixture', yieldMs: 0 }, undefined, owner);
    try {
      const results = await Promise.all([start(), start()]);
      expect(results.map((result) => result.processId)).toEqual([
        'p_111111111111',
        'p_222222222222'
      ]);
      children[0]!.stdout.write('retained');
      children[0]!.exitCode = 0;
      children[0]!.emit('close', 0, null);
      await tool.execute(
        { processId: results[0]!.processId, action: 'poll', yieldMs: 0 },
        undefined,
        owner
      );
      expect(await start()).toMatchObject({ processId: 'p_333333333333', status: 'running' });
      expect(
        await tool.execute(
          { processId: results[0]!.processId, action: 'poll', yieldMs: 0 },
          undefined,
          owner
        )
      ).toMatchObject({ cached: true, stdout: 'retained' });
      expect(
        await tool.execute(
          { processId: results[1]!.processId, action: 'poll', yieldMs: 0 },
          undefined,
          owner
        )
      ).toMatchObject({ status: 'running' });
    } finally {
      for (const current of children) {
        if (current.exitCode === null) {
          current.exitCode = 0;
          current.emit('close', 0, null);
        }
        current.stdin.destroy();
        current.stdout.destroy();
        current.stderr.destroy();
      }
      await tool.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['cell', 'c_'],
    ['process', 'p_']
  ] as const)('generates short %s handles and retries reserved identifiers', (kind, prefix) => {
    vi.mocked(randomBytes)
      .mockReturnValueOnce(Buffer.from('0123456789ab', 'hex'))
      .mockReturnValueOnce(Buffer.from('fedcba987654', 'hex'));
    const reserved = new Set([`${prefix}0123456789ab`]);
    const handles = new RuntimeResourceHandles(kind, (id) => reserved.has(id));
    expect(handles.create()).toBe(`${prefix}fedcba987654`);
    expect(randomBytes).toHaveBeenCalledTimes(2);
    expect(randomBytes).toHaveBeenCalledWith(6);
  });

  it.each([
    ['cell', 'p_0123456789ab', 'cellId', 'processId', 'exec_wait'],
    ['process', 'c_0123456789ab', 'processId', 'cellId', 'code_exec_wait']
  ] as const)(
    'rejects wrong-type %s input without inspecting resource existence',
    (kind, id, expected, received, tool) => {
      const lookup = vi.fn(() => false);
      const handles = new RuntimeResourceHandles(kind, lookup);
      expect(() => handles.assertType(id)).toThrowError(
        expect.objectContaining({
          code: 'MAR_AGENT_RESOURCE_HANDLE_TYPE_MISMATCH',
          details: { expected, received, tool },
          publicMessage: expect.stringContaining(tool)
        })
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(randomBytes).not.toHaveBeenCalled();
    }
  );

  it.each(['cell', 'process'] as const)(
    'leaves unknown and own-type %s identifiers to the resource owner',
    (kind) => {
      const handles = new RuntimeResourceHandles(kind, () => false);
      const ownPrefix = kind === 'cell' ? 'c_' : 'p_';
      for (const id of [
        `${ownPrefix}0123456789ab`,
        'unknown',
        '17488cee-33fe-41dc-a963-0f48b5ef70d6'
      ])
        expect(() => handles.assertType(id)).not.toThrow();
    }
  );
});
