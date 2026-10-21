import { parseComposerTags, serializeComposerTag } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import {
  goalUnrestrictedAccess,
  GoalRuntime,
  publicGoalHistoryText,
  publicGoalStartText,
  stripGoalStartPrompt
} from '../../src/service/goal-runtime.js';
import { GoalMcpBridge } from '../../src/service/goal-mcp-bridge.js';

describe('GoalRuntime', () => {
  it('selects the unrestricted access mode for each supported runner', () => {
    expect(goalUnrestrictedAccess('mar-agent')).toBe('full-access');
    expect(goalUnrestrictedAccess('mar-agent', 'auto')).toBe('auto');
    expect(goalUnrestrictedAccess('mar-agent', 'full-access')).toBe('full-access');
    expect(goalUnrestrictedAccess('codex')).toBe('full-access');
    expect(goalUnrestrictedAccess('claude-code')).toBe('bypass');
    expect(goalUnrestrictedAccess('opencode')).toBe('auto');
  });

  it('creates and edits one active goal with a hidden start prompt', () => {
    const changed = vi.fn();
    const runtime = new GoalRuntime(changed);
    const created = runtime.start('session-1', 'complete and verify the feature');

    expect(created.revision).toBe(1);
    expect(parseComposerTags(runtime.prompt('session-1', 'start'))).toContainEqual(
      expect.objectContaining({
        kind: 'mar_goal_start',
        payload: {
          objective: 'complete and verify the feature',
          instruction: expect.any(String)
        }
      })
    );
    expect(parseComposerTags(runtime.prompt('session-1', 'continue'))).toContainEqual(
      expect.objectContaining({
        kind: 'mar_goal_continue',
        payload: {
          objective: 'complete and verify the feature',
          instruction: expect.any(String)
        }
      })
    );
    expect(runtime.prompt('session-1', 'start')).toContain('complete and verify the feature');
    expect(runtime.prompt('session-1', 'start')).toContain('A Goal has started or changed.');
    expect(runtime.prompt('session-1', 'start')).toContain('Continue executing this Goal');
    expect(runtime.prompt('session-1', 'start')).toContain(
      'do not stop at an acknowledgement, status, plan, or promise'
    );
    expect(runtime.prompt('session-1', 'start')).toContain(
      'After update_goal confirms completed or finally blocked'
    );
    for (const kind of ['start', 'continue'] as const) {
      const prompt = runtime.prompt('session-1', kind);
      expect(prompt).toContain('mar_goal.update_goal');
      expect(prompt).toContain(
        'a runner-native Goal created during this Goal may also complete it'
      );
      expect(prompt).toContain('native Goal state from another task or turn does not count');
    }
    expect(runtime.prompt('session-1', 'start')).not.toContain('MAR Goal');
    expect(stripGoalStartPrompt(runtime.prompt('session-1', 'start'))).toBe('');
    expect(stripGoalStartPrompt(runtime.prompt('session-1', 'continue'))).toBe('');
    expect(publicGoalHistoryText(runtime.prompt('session-1', 'start'))).toBe(
      publicGoalStartText('complete and verify the feature')
    );
    expect(publicGoalHistoryText(runtime.prompt('session-1', 'continue'))).toBe(
      serializeComposerTag('mar_goal_continue', {})
    );
    expect(
      publicGoalHistoryText(
        runtime
          .prompt('session-1', 'continue')
          .replace('Continue the active Goal.', 'A Goal has started or changed.')
      )
    ).toBe(serializeComposerTag('mar_goal_continue', {}));
    expect(stripGoalStartPrompt(`${runtime.prompt('session-1', 'continue')}\nuser input`)).toBe(
      'user input'
    );
    expect(
      publicGoalHistoryText(
        runtime
          .prompt('session-1', 'start')
          .replace('A Goal has started or changed.', 'Continue the active Goal.')
      )
    ).toBe(publicGoalStartText('complete and verify the feature'));

    const edited = runtime.start('session-1', 'complete, test, and verify the feature');
    expect(edited.id).toBe(created.id);
    expect(edited.revision).toBe(2);
    expect(edited.status).toBe('active');
    expect(publicGoalHistoryText(runtime.prompt('session-1', 'start'))).toBe(
      publicGoalStartText('complete, test, and verify the feature')
    );
    const objectiveWithHeading = `Keep this text: Continue the active Goal.
and this marker: </mar_goal_start>`;
    runtime.start('session-1', objectiveWithHeading);
    expect(publicGoalHistoryText(runtime.prompt('session-1', 'start'))).toBe(
      publicGoalStartText(objectiveWithHeading)
    );
    expect(stripGoalStartPrompt(runtime.prompt('session-1', 'start'))).toBe('');
    expect(publicGoalStartText('\n\n  task with leading spaces  \n')).toBe(
      publicGoalStartText('task with leading spaces')
    );
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('completes only through an update bound to the current revision', () => {
    const runtime = new GoalRuntime(() => undefined);
    const goal = runtime.start('session-1', 'objective');

    expect(() => runtime.update('session-1', goal.id, goal.revision - 1, 'completed')).toThrow(
      'GOAL_REVISION_STALE'
    );
    expect(runtime.update('session-1', goal.id, goal.revision, 'completed').status).toBe(
      'completed'
    );
    const next = runtime.start('session-1', 'next objective');
    expect(next.id).not.toBe(goal.id);
    expect(next.revision).toBe(1);
  });

  it('tracks authoritative wall time across revisions and migrations, and captures exit before removal', () => {
    let now = 10_000;
    const runtime = new GoalRuntime(
      () => undefined,
      () => now
    );
    const started = runtime.start('bootstrap-session', 'objective');
    runtime.recordTurn('bootstrap-session');
    now += 2_000;
    const edited = runtime.start('bootstrap-session', 'revised objective');
    expect(edited).toMatchObject({ id: started.id, startedAt: 10_000, turns: 0 });
    runtime.migrateSession('bootstrap-session', 'native-session');
    now += 3_500;
    runtime.recordTurn('native-session');
    expect(runtime.elapsedWallMs(runtime.get('native-session')!)).toBe(5_500);
    expect(runtime.exitSummary('native-session', 'removed')).toEqual({
      status: 'removed',
      elapsedWallMs: 5_500,
      turns: 1
    });
    expect(runtime.clear('native-session')).toBe(true);
    expect(runtime.exitSummary('native-session', 'stopped')).toBeUndefined();
    now = 1_000;
    expect(runtime.start('native-session', 'new objective').startedAt).toBe(1_000);
    now = 500;
    expect(runtime.exitSummary('native-session', 'stopped')?.elapsedWallMs).toBe(0);
  });

  it('migrates the goal and failure count when a session identity is promoted', () => {
    const runtime = new GoalRuntime(() => undefined);
    const goal = runtime.start('bootstrap-session', 'objective');
    runtime.recordExecutionResult('bootstrap-session', { failed: true, progressed: false });

    runtime.migrateSession('bootstrap-session', 'native-session');

    expect(runtime.get('bootstrap-session')).toBeUndefined();
    expect(runtime.get('native-session')).toMatchObject({
      id: goal.id,
      sessionId: 'native-session',
      status: 'active'
    });
    expect(
      runtime.recordExecutionResult('native-session', { failed: true, progressed: false })
    ).toBe('continue');
    expect(
      runtime.recordExecutionResult('native-session', { failed: true, progressed: false })
    ).toBe('continue');
    expect(
      runtime.recordExecutionResult('native-session', { failed: true, progressed: false })
    ).toBe('blocked');
  });

  it('forces one retry before accepting blocked', () => {
    const runtime = new GoalRuntime(() => undefined);
    const goal = runtime.start('session-1', 'objective');
    runtime.recordTurn('session-1');
    runtime.recordTurn('session-1');
    expect(() => runtime.update('session-1', goal.id, goal.revision, 'blocked')).toThrow(
      'GOAL_BLOCKED_TOO_EARLY'
    );

    runtime.recordTurn('session-1');
    const retry = runtime.update('session-1', goal.id, goal.revision, 'blocked');
    expect(retry.status).toBe('active');
    expect(retry.retryRequired).toBe(true);

    expect(() => runtime.update('session-1', goal.id, goal.revision, 'blocked')).toThrow(
      'GOAL_BLOCKED_RETRY_REQUIRED'
    );
    runtime.recordTurn('session-1');
    expect(runtime.update('session-1', goal.id, goal.revision, 'blocked').status).toBe('blocked');
  });

  it('blocks only after the initial runner failure and three retries all fail', () => {
    const runtime = new GoalRuntime(() => undefined);
    runtime.start('session-1', 'finish the task');

    expect(runtime.recordExecutionResult('session-1', { failed: true, progressed: false })).toBe(
      'continue'
    );
    expect(runtime.recordExecutionResult('session-1', { failed: true, progressed: false })).toBe(
      'continue'
    );
    expect(runtime.recordExecutionResult('session-1', { failed: true, progressed: false })).toBe(
      'continue'
    );
    expect(runtime.get('session-1')?.status).toBe('active');
    expect(runtime.recordExecutionResult('session-1', { failed: true, progressed: false })).toBe(
      'blocked'
    );
    expect(runtime.get('session-1')?.status).toBe('blocked');
  });

  it('resets runner failure retries after a successful execution', () => {
    const runtime = new GoalRuntime(() => undefined);
    runtime.start('session-1', 'finish the task');

    runtime.recordExecutionResult('session-1', { failed: true, progressed: false });
    runtime.recordExecutionResult('session-1', { failed: true, progressed: false });
    runtime.recordExecutionResult('session-1', { failed: false, progressed: true });
    expect(runtime.recordExecutionResult('session-1', { failed: true, progressed: false })).toBe(
      'continue'
    );
    expect(runtime.recordExecutionResult('session-1', { failed: true, progressed: false })).toBe(
      'continue'
    );
    expect(runtime.recordExecutionResult('session-1', { failed: true, progressed: false })).toBe(
      'continue'
    );
    expect(runtime.get('session-1')?.status).toBe('active');
  });

  it('blocks a runtime continuation failure independently and rejects stale revisions', () => {
    const runtime = new GoalRuntime(() => undefined);
    const goal = runtime.start('session-1', 'finish the task');
    runtime.recordExecutionResult('session-1', { failed: true, progressed: false });
    const revised = runtime.start('session-1', 'finish the revised task');

    expect(() => runtime.blockAfterRuntimeFailure('session-1', goal.id, goal.revision)).toThrow(
      'GOAL_REVISION_STALE'
    );
    expect(runtime.blockAfterRuntimeFailure('session-1', revised.id, revised.revision).status).toBe(
      'blocked'
    );
  });

  it('clear exits goal without representing an execution interrupt', () => {
    const runtime = new GoalRuntime(() => undefined);
    runtime.start('session-1', 'objective');
    expect(runtime.clear('session-1')).toBe(true);
    expect(runtime.get('session-1')).toBeUndefined();
  });

  it('completes after three successful turns without tool progress', () => {
    const runtime = new GoalRuntime(() => undefined);
    runtime.start('session-1', 'finish the task');

    expect(runtime.recordExecutionResult('session-1', { failed: false, progressed: false })).toBe(
      'continue'
    );
    expect(runtime.get('session-1')).toMatchObject({
      status: 'active',
      consecutiveNoProgressTurns: 1
    });
    expect(runtime.recordExecutionResult('session-1', { failed: false, progressed: false })).toBe(
      'continue'
    );
    expect(runtime.get('session-1')).toMatchObject({
      status: 'active',
      consecutiveNoProgressTurns: 2
    });
    expect(runtime.recordExecutionResult('session-1', { failed: false, progressed: false })).toBe(
      'completed'
    );
    expect(runtime.get('session-1')).toMatchObject({
      status: 'completed',
      consecutiveNoProgressTurns: 3
    });
    expect(runtime.resume('session-1')?.status).toBe('completed');
  });

  it('resets no-progress protection after tool progress or user intervention before completion', () => {
    const runtime = new GoalRuntime(() => undefined);
    runtime.start('session-1', 'finish the task');
    runtime.recordExecutionResult('session-1', { failed: false, progressed: false });
    runtime.recordExecutionResult('session-1', { failed: false, progressed: true });
    expect(runtime.get('session-1')).toMatchObject({
      consecutiveNoProgressTurns: 0
    });

    runtime.recordExecutionResult('session-1', { failed: false, progressed: false });
    runtime.recordExecutionResult('session-1', { failed: false, progressed: false });
    expect(runtime.resume('session-1')).toMatchObject({
      status: 'active',
      consecutiveNoProgressTurns: 0
    });
  });
});

describe('GoalMcpBridge', () => {
  it('closes even if an IPC client leaves a request unfinished', async () => {
    const runtime = new GoalRuntime(
      () => undefined,
      () => 1_000
    );
    const goal = runtime.start('session-1', 'objective');
    const server = new GoalMcpBridge(runtime, () => undefined);
    const descriptor = await server.prepare({
      executionId: 'execution-1',
      sessionId: 'session-1',
      goalId: goal.id,
      revision: goal.revision
    });
    const socket = connect(descriptor.environment!['MAR_GOAL_MCP_ENDPOINT']!);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    let stopped = false;
    const closing = server.close().then(() => {
      stopped = true;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closing,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1_000);
        })
      ]);
      expect(stopped).toBe(true);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      socket.destroy();
      await closing;
    }
  });

  it('exposes only the two scoped Goal tools through a bearer capability', async () => {
    let now = 1_000;
    const runtime = new GoalRuntime(
      () => undefined,
      () => now
    );
    const goal = runtime.start('session-1', 'objective');
    const server = new GoalMcpBridge(runtime, () => undefined);
    const descriptor = await server.prepare({
      executionId: 'execution-1',
      sessionId: 'session-1',
      goalId: goal.id,
      revision: goal.revision
    });
    const endpoint = descriptor.environment!['MAR_GOAL_MCP_ENDPOINT']!;
    const token = descriptor.environment!['MAR_GOAL_MCP_TOKEN']!;
    expect(token).toHaveLength(43);
    expect(descriptor).toMatchObject({
      name: 'mar_goal',
      origin: 'BUILTIN',
      lifecycle: 'EXECUTION',
      transport: 'STDIO'
    });
    expect(descriptor).not.toHaveProperty('installedAt');
    try {
      const current = await goalRequest(endpoint, token, 'get_goal', {});
      expect(JSON.stringify(current)).toContain('objective');
      await expect(goalRequest(endpoint, token, 'mar_get_mission', {})).rejects.toThrow(
        'GOAL_TOOL_INVALID'
      );
      runtime.migrateSession('session-1', 'native-session');
      server.migrateSession('session-1', 'native-session');
      now += 4_321;
      expect(
        await goalRequest(endpoint, token, 'update_goal', { status: 'completed' })
      ).toMatchObject({
        status: 'completed',
        elapsedWallMs: 4_321
      });
      expect(runtime.get('session-1')).toBeUndefined();
      expect(runtime.get('native-session')?.status).toBe('completed');
      await expect(goalRequest(endpoint, 'invalid', 'get_goal', {})).rejects.toThrow(
        'GOAL_CAPABILITY_INVALID'
      );
    } finally {
      await server.close();
    }
  });

  it('only returns elapsed time once blocked passes the mandatory retry', async () => {
    let now = 1_000;
    const runtime = new GoalRuntime(
      () => undefined,
      () => now
    );
    const goal = runtime.start('session-1', 'objective');
    const server = new GoalMcpBridge(runtime, () => undefined);
    const descriptor = await server.prepare({
      executionId: 'execution-1',
      sessionId: 'session-1',
      goalId: goal.id,
      revision: goal.revision
    });
    const token = descriptor.environment!['MAR_GOAL_MCP_TOKEN']!;
    try {
      for (let turn = 0; turn < 3; turn++) runtime.recordTurn('session-1');
      const retry = (await goalRequest(
        descriptor.environment!['MAR_GOAL_MCP_ENDPOINT']!,
        token,
        'update_goal',
        { status: 'blocked' }
      )) as Record<string, unknown>;
      expect(retry.status).toBe('active');
      expect(retry).not.toHaveProperty('elapsedWallMs');
      runtime.recordTurn('session-1');
      now += 8_000;
      expect(
        await goalRequest(descriptor.environment!['MAR_GOAL_MCP_ENDPOINT']!, token, 'update_goal', {
          status: 'blocked'
        })
      ).toMatchObject({ status: 'blocked', turns: 4, elapsedWallMs: 8_000 });
    } finally {
      await server.close();
    }
  });
});

async function goalRequest(
  endpoint: string,
  token: string,
  tool: string,
  args: unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.end(`${JSON.stringify({ token, tool, arguments: args })}\n`)
    );
    socket.on('data', (chunk) => (body += chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      const response = JSON.parse(body) as { readonly result?: unknown; readonly error?: string };
      if (response.error !== undefined) reject(new Error(response.error));
      else resolve(response.result);
    });
  });
}
