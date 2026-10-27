import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecTool } from '../../src/host/local-exec-tool.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/tools/execution-limits.js';
import { WorkspacePathResolver } from '../../src/tools/shared/path-resolver.js';

const fixtures: Array<{ tool: ExecTool; root: string; close: () => void }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { tool, root, close } of fixtures.splice(0)) {
    close();
    await tool.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(maxProcesses = 2) {
  const root = await mkdtemp(join(tmpdir(), 'mar-exec-retention-'));
  const children: Array<ReturnType<typeof child>> = [];
  function child() {
    const state = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const close = (code = 0) => {
      state.exitCode = code;
      state.emit('close', code, null);
    };
    return { state, close };
  }
  const tool = new ExecTool(new WorkspacePathResolver(root), 16, maxProcesses, {}, undefined, {
    async spawn() {
      const next = child();
      children.push(next);
      return next.state as unknown as ChildProcessWithoutNullStreams;
    }
  });
  fixtures.push({
    tool,
    root,
    close: () => {
      for (const current of children) {
        if (current.state.exitCode === null) current.close();
        current.state.stdin.destroy();
        current.state.stdout.destroy();
        current.state.stderr.destroy();
      }
    }
  });
  const owner = { sessionId: 'parent', executionId: 'first' };
  const start = async (sessionId = owner.sessionId) => {
    const result = await tool.execute({ command: 'fixture', yieldMs: 0 }, undefined, {
      ...owner,
      sessionId
    });
    return { result, ...children.at(-1)! };
  };
  return { tool, owner, start };
}

describe('uncollected exec terminal results', () => {
  it('keeps the first terminal result beyond replay TTL, then expires replay without renewal', async () => {
    const { tool, owner, start } = await fixture();
    const running = await start();
    running.state.stdout.write('early');
    expect(
      await tool.execute(
        { action: 'poll', processId: running.result.processId, yieldMs: 0 },
        undefined,
        owner
      )
    ).toMatchObject({ status: 'running', stdout: 'early' });
    vi.useFakeTimers();
    running.state.stdout.write('late');
    running.state.stderr.write('failure');
    running.close(3);
    await vi.advanceTimersByTimeAsync(TOOL_EXECUTION_LIMITS.execCompletedRetentionMs + 1);
    expect(tool.listSessionResources(owner.sessionId)).toEqual([
      expect.objectContaining({ processId: running.result.processId, status: 'completed' })
    ]);
    const poll = (sessionId = owner.sessionId) =>
      tool.execute({ action: 'poll', processId: running.result.processId }, undefined, {
        sessionId,
        executionId: 'later'
      });
    await expect(poll('other')).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    await expect(
      tool.execute(
        { action: 'write', processId: running.result.processId, data: 'not accepted' },
        undefined,
        owner
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    expect(await poll()).toMatchObject({
      status: 'completed',
      stdout: 'late',
      stderr: 'failure',
      exitCode: 3
    });
    await vi.advanceTimersByTimeAsync(TOOL_EXECUTION_LIMITS.execCompletedRetentionMs - 1);
    expect(await poll()).toMatchObject({ stdout: 'earlylate', exitCode: 3, cached: true });
    await vi.advanceTimersByTimeAsync(1);
    await expect(poll()).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
  });

  it('does not evict an uncollected result for already-returned results from shared child sessions', async () => {
    const { tool, owner, start } = await fixture();
    const pending = await start();
    pending.state.stdout.write('must survive');
    pending.close();
    for (let i = 0; i <= TOOL_EXECUTION_LIMITS.execMaxCompletedResults; i++) {
      const other = await start('child');
      other.close();
      await tool.execute({ action: 'poll', processId: other.result.processId }, undefined, {
        sessionId: 'child',
        executionId: 'child-execution'
      });
    }
    expect(
      await tool.execute({ action: 'poll', processId: pending.result.processId }, undefined, owner)
    ).toMatchObject({ status: 'completed', stdout: 'must survive', exitCode: 0 });
  });

  it('bounds running and uncollected results together and releases them on collection or cleanup', async () => {
    const { tool, owner, start } = await fixture(1);
    const pending = await start();
    pending.close();
    await expect(start()).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_LIMIT' });
    await tool.execute({ action: 'poll', processId: pending.result.processId }, undefined, owner);
    const cancelled = await start();
    cancelled.close();
    await tool.execute(
      { action: 'cancel', processId: cancelled.result.processId },
      undefined,
      owner
    );
    await expect(
      tool.execute({ action: 'poll', processId: cancelled.result.processId }, undefined, owner)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    const disposed = await start();
    disposed.close();
    await tool.disposeSession(owner.sessionId);
    expect(tool.listSessionResources(owner.sessionId)).toEqual([]);
    await expect(
      tool.execute({ action: 'poll', processId: disposed.result.processId }, undefined, owner)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
  });
});
