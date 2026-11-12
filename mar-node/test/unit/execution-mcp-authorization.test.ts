import { describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { NodeDatabase } from '../../src/database.js';
import { GoalRuntime } from '../../src/service/goal-runtime.js';
import { GoalMcpBridge } from '../../src/service/goal-mcp-bridge.js';
import { ScheduleMcpBridge } from '../../src/service/schedule-mcp-bridge.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';
import {
  NotificationMcpBridge,
  resolveNotificationCapability
} from '../../src/service/notification-mcp-bridge.js';

function fixture() {
  const runtime = new NodeRuntimeState(
    () => 'node-1',
    (id) =>
      id === 'workspace-1'
        ? { id, path: '/workspace', kind: 'DIRECTORY', gitSummary: null }
        : undefined
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace-1',
    runner: 'mar-agent',
    cwd: '/workspace'
  });
  const run = runtime.createMessageRun({
    sessionId: session.id,
    clientMessageId: 'message-1',
    content: 'Work',
    initiatedByUserId: 7
  }).run;
  const execution = runtime.createExecution(run.id);
  const scope = {
    executionId: execution.id,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    userId: 7
  };
  return { runtime, session, run, execution, scope };
}

describe('Execution-owned MCP authorization', () => {
  it('resolves the current execution across Session promotion without changing claims', () => {
    const f = fixture();
    expect(f.runtime.resolveMcpExecution(f.scope)?.id).toBe(f.run.id);
    f.runtime.promoteSessionIdentity(f.session.id, 'native-session');
    expect(f.runtime.resolveMcpExecution(f.scope)?.sessionId).toBe('native-session');
    expect(f.scope.sessionId).toBe(f.session.id);
  });

  it.each([
    { executionId: 'unknown' },
    { executionId: 'run-not-execution' },
    { sessionId: 'other' },
    { workspaceId: 'other' },
    { userId: 8 }
  ])('rejects identity substitution (%j)', (change) => {
    const f = fixture();
    expect(f.runtime.resolveMcpExecution({ ...f.scope, ...change })).toBeUndefined();
  });

  it.each(['release', 'interrupt', 'cancelling', 'terminal'])(
    'rejects credentials immediately after %s without a token denylist',
    (action) => {
      const f = fixture();
      if (action === 'release') f.runtime.revokeExecutionMcps(f.execution.id);
      if (action === 'interrupt') f.runtime.requestExecutionInterrupt(f.execution.id);
      if (action === 'cancelling') f.runtime.transitionRun(f.run.id, 'CANCELLING');
      if (action === 'terminal') f.runtime.finishRun(f.run.id, 'SUCCEEDED');
      expect(f.runtime.resolveMcpExecution(f.scope)).toBeUndefined();
    }
  );
});

describe.each(['goal', 'schedule', 'notification'] as const)(
  '%s MCP live authorization',
  (domain) => {
    it.each(['release', 'interrupt', 'cancelling', 'terminal'])(
      'rejects an otherwise valid signed credential after %s',
      async (action) => {
        const f = fixture();
        const database = new NodeDatabase(':memory:', 'mcp-live-authorization');
        const goals = new GoalRuntime(() => undefined);
        const goal = goals.start(f.session.id, 'Check authorization');
        const bridge =
          domain === 'goal'
            ? new GoalMcpBridge(
                goals,
                () => undefined,
                (capability) => f.runtime.resolveMcpExecution(capability)?.sessionId
              )
            : domain === 'schedule'
              ? new ScheduleMcpBridge(
                  () => new ScheduledSessionStore(database.raw),
                  () => undefined,
                  () => undefined,
                  (capability) =>
                    f.runtime.resolveMcpExecution({ ...capability, userId: capability.actorUserId })
                      ?.sessionId
                )
              : new NotificationMcpBridge(
                  (capability) => resolveNotificationCapability(f.runtime, capability),
                  async () => undefined
                );
        try {
          const descriptor = await bridge.prepare({
            ...f.scope,
            actorUserId: 7,
            source: 'MANUAL',
            goalId: goal.id,
            revision: goal.revision
          });
          const prefix = `MAR_${domain.toUpperCase()}_MCP_`;
          const endpoint = descriptor.environment![`${prefix}ENDPOINT`]!;
          const token = descriptor.environment![`${prefix}TOKEN`]!;
          const tool =
            domain === 'goal'
              ? 'get_goal'
              : domain === 'schedule'
                ? 'get_scheduled_task'
                : 'send_email_notification';
          const invoke = (credential: string): Promise<Record<string, unknown>> =>
            new Promise((resolve, reject) => {
              const socket = connect(endpoint);
              let body = '';
              socket.setEncoding('utf8');
              socket.once('connect', () =>
                socket.write(
                  `${JSON.stringify({ token: credential, tool, arguments: { message: 'Fixture only', callId: randomUUID() } })}\n`
                )
              );
              socket.on('data', (chunk) => {
                body += chunk;
              });
              socket.once('error', reject);
              socket.once('end', () => {
                try {
                  resolve(JSON.parse(body));
                } catch (error) {
                  reject(error);
                }
              });
            });
          expect(await invoke(token)).toHaveProperty('result');
          expect(await invoke('invalid')).toEqual({
            error: `${domain === 'notification' ? 'MAIL' : domain.toUpperCase()}_CAPABILITY_INVALID`
          });
          if (action === 'release') f.runtime.revokeExecutionMcps(f.execution.id);
          if (action === 'interrupt') f.runtime.requestExecutionInterrupt(f.execution.id);
          if (action === 'cancelling') f.runtime.transitionRun(f.run.id, 'CANCELLING');
          if (action === 'terminal') f.runtime.finishRun(f.run.id, 'SUCCEEDED');
          expect(await invoke(token)).toEqual({
            error: `${domain === 'notification' ? 'MAIL' : domain.toUpperCase()}_CAPABILITY_STALE`
          });
        } finally {
          await bridge.close();
          database.close();
        }
      }
    );
  }
);
