import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { SessionIdentityService } from '../../src/service/session-identity-service.js';
import type { RunnerInteractionService } from '../../src/service/runner-interaction-service.js';
import type { CodexManagedRunController } from '../../src/runner/codex/managed-run-controller.js';
import type { OpenCodeManagedRunController } from '../../src/runner/opencode/managed-run-controller.js';
import type { CodexRunner } from '../../src/runner/codex-runner.js';
import type { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import type { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { CodexAppServerClient } from '../../src/codex-app-server.js';
import type { ClaudeChannelRunHandle } from '../../src/claude-agent-sdk.js';
import type { OpenCodeServerClient } from '../../src/opencode-server.js';
import { ClaudeChannelGate } from '../../src/claude-channel.js';
import { capabilities } from './support/codex-connector.js';

async function fixture(runner: 'codex' | 'claude-code' | 'opencode') {
  const root = await mkdtemp(join(tmpdir(), 'mar-runner-identity-'));
  const database = new NodeDatabase(':memory:', 'node-identity');
  const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
  const interrupt = vi.fn(async () => undefined);
  const respond = vi.fn();
  const connector = new NodeConnector({
    database,
    capabilities: capabilities(),
    reconnect: false,
    codexClient: {
      onNotification: () => () => undefined,
      interruptTurn: interrupt,
      respond,
      stop: () => undefined
    } as unknown as CodexAppServerClient
  });
  onTestFinished(async () => {
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  });
  const node = connector as unknown as {
    runtime: NodeRuntimeState;
    sessionIdentityService: SessionIdentityService;
    runnerInteractionService: RunnerInteractionService;
    runners: RunnerRegistry;
    codexClient: CodexRunner;
    claudeClient: ClaudeCodeRunner;
    openCodeClient: OpenCodeRunner;
    codexRunController: CodexManagedRunController<never>;
    openCodeRunController: OpenCodeManagedRunController;
    runState: { active: Set<string> };
  };
  const session = node.runtime.createAgentSession({
    workspaceId: workspace.id,
    runner,
    cwd: root
  });
  const run = node.runtime.createMessageRun({
    sessionId: session.id,
    clientMessageId: 'first',
    content: 'Inspect the workspace'
  }).run;
  const execution = node.runtime.createExecution(run.id);
  node.runtime.transitionRun(run.id, 'STARTING');
  node.runtime.transitionRun(run.id, 'RUNNING');
  node.runState.active.add(execution.id);
  return { node, session, run, execution, root, interrupt, respond };
}

describe('Runner-owned active execution identity migration', () => {
  it.each(['complete', 'stop'] as const)(
    'keeps Codex Turn routing, approval and %s bound to the original execution',
    async (terminal) => {
      const { node, session, run, execution, root, interrupt, respond } = await fixture('codex');
      const state = node.codexClient.execution;
      const record = {
        sessionId: session.id,
        threadId: 'native-codex',
        turnId: 'turn-1',
        cwd: root,
        refreshTitle: false,
        generationKeys: ['generation-1']
      };
      state.runs.set(execution.id, record);
      const turnKey = 'turn-1';
      state.managedTurns.set(turnKey, { sessionId: session.id, runId: execution.id });
      const unrelated = { ...record, sessionId: 'other', threadId: 'other-native' };
      state.runs.set('other-execution', unrelated);
      const otherTurn = { sessionId: 'other', runId: 'other-execution' };
      state.managedTurns.set('other-turn', otherTurn);
      node.codexRunController.handleNotification({
        method: 'item/commandExecution/requestApproval',
        requestId: 'request-1',
        params: { threadId: 'native-codex', turnId: 'turn-1' }
      });
      const approvalId = [...state.approvals.keys()][0]!;
      const approval = state.approvals.get(approvalId);

      node.sessionIdentityService.promote(session.id, 'native-codex');
      expect(state.runs.get(execution.id)).toEqual({ ...record, sessionId: 'native-codex' });
      const migrated = state.runs.get(execution.id);
      node.codexClient.migrateSessionIdentity(session.id, 'native-codex');
      expect(state.runs.get(execution.id)).toBe(migrated);
      expect(state.runs.get(execution.id)?.generationKeys).toBe(record.generationKeys);
      expect(state.runs.get('other-execution')).toBe(unrelated);
      expect(state.managedTurns.get('other-turn')).toBe(otherTurn);
      expect(state.approvals.get(approvalId)).toBe(approval);
      expect(node.codexClient.managedRunForNativeTurn('turn-1')).toBe(execution.id);
      expect(node.runtime.conversationTurnForRun(run.id)?.sessionId).toBe('native-codex');
      expect(
        node.runners.decideApproval({ runId: execution.id, approvalId, decision: 'APPROVED' })
      ).toBe(true);
      expect(respond).toHaveBeenCalledExactlyOnceWith('request-1', { decision: 'accept' });
      if (terminal === 'complete') {
        node.codexRunController.handleNotification({
          method: 'turn/completed',
          params: { threadId: 'native-codex', turn: { id: 'turn-1', status: 'completed' } }
        });
      } else {
        expect(node.runners.cancelManagedRun(execution.id, 'INTERRUPT')).toBe(true);
        await vi.waitFor(() =>
          expect(interrupt).toHaveBeenCalledExactlyOnceWith('native-codex', 'turn-1')
        );
      }
      await vi.waitFor(() =>
        expect(node.runtime.findMessageSubmission('native-codex', 'first')).toMatchObject({
          run: { id: run.id, status: terminal === 'complete' ? 'SUCCEEDED' : 'INTERRUPTED' }
        })
      );
      expect(state.runs.has(execution.id)).toBe(false);
      expect(state.managedTurns.get(turnKey)).toEqual({
        sessionId: 'native-codex',
        runId: execution.id
      });
    }
  );

  it('keeps Claude handle, gate, native ID, approval and stop on the original execution', async () => {
    const { node, session, run, execution, root } = await fixture('claude-code');
    const interrupt = vi.fn(async () => undefined);
    const handle = { interrupt, cancel: vi.fn() } as unknown as ClaudeChannelRunHandle;
    const gate = new ClaudeChannelGate(session.id);
    const record = {
      marSessionId: session.id,
      nativeSessionId: 'native-claude',
      cwd: root,
      handle,
      gate
    };
    const state = node.claudeClient.execution;
    state.runs.set(execution.id, record);
    const unrelated = { ...record, marSessionId: 'other' };
    state.runs.set('other-execution', unrelated);
    const permission = node.runnerInteractionService.requestClaudeApproval(execution.id, 'Bash', {
      command: 'pwd'
    });
    const approvalId = [...state.approvals.keys()][0]!;
    const approval = state.approvals.get(approvalId);

    node.sessionIdentityService.promote(session.id, 'native-claude');
    const migrated = state.runs.get(execution.id);
    expect(migrated).toEqual({ ...record, marSessionId: 'native-claude' });
    node.claudeClient.migrateSessionIdentity(session.id, 'native-claude');
    expect(state.runs.get(execution.id)).toBe(migrated);
    expect(migrated?.handle).toBe(handle);
    expect(migrated?.gate).toBe(gate);
    expect(state.runs.get('other-execution')).toBe(unrelated);
    expect(state.approvals.get(approvalId)).toBe(approval);
    expect(node.runtime.conversationTurnForRun(run.id)?.sessionId).toBe('native-claude');
    expect(
      node.runners.decideApproval({ runId: execution.id, approvalId, decision: 'APPROVED' })
    ).toBe(true);
    await expect(permission).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'pwd' }
    });
    expect(node.runners.cancelManagedRun(execution.id, 'INTERRUPT')).toBe(true);
    await vi.waitFor(() =>
      expect(node.runtime.findMessageSubmission('native-claude', 'first')).toMatchObject({
        run: { id: run.id, status: 'INTERRUPTED' }
      })
    );
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('keeps OpenCode client, native ID, abort signal, approval and stop on the original execution', async () => {
    const { node, session, run, execution, root } = await fixture('opencode');
    const abort = new AbortController();
    const client = {
      abort: vi.fn(async () => undefined),
      replyPermission: vi.fn(async () => undefined)
    };
    const record = {
      runId: execution.id,
      sessionId: session.id,
      nativeSessionId: 'native-opencode',
      cwd: root,
      client: client as unknown as OpenCodeServerClient,
      abort,
      access: 'default',
      agent: 'build' as const
    };
    const state = node.openCodeClient.execution;
    state.set(execution.id, record);
    const unrelated = { ...record, sessionId: 'other' };
    state.set('other-execution', unrelated);
    const controller = node.openCodeRunController as unknown as {
      event(runId: string, sessionId: string, event: unknown): void;
    };
    controller.event(execution.id, 'native-opencode', {
      type: 'permission.asked',
      properties: { id: 'request-1', sessionID: 'native-opencode', permission: 'bash' }
    });

    node.sessionIdentityService.promote(session.id, 'native-opencode');
    const migrated = state.get(execution.id);
    expect(migrated).toEqual({ ...record, sessionId: 'native-opencode' });
    node.openCodeClient.migrateSessionIdentity(session.id, 'native-opencode');
    expect(state.get(execution.id)).toBe(migrated);
    expect(migrated?.abort).toBe(abort);
    expect(migrated?.client).toBe(client);
    expect(state.get('other-execution')).toBe(unrelated);
    expect(node.runtime.conversationTurnForRun(run.id)?.sessionId).toBe('native-opencode');
    expect(
      node.runners.decideApproval({
        runId: execution.id,
        approvalId: 'opencode:request-1',
        decision: 'APPROVED'
      })
    ).toBe(true);
    expect(client.replyPermission).toHaveBeenCalledExactlyOnceWith(root, 'request-1', 'APPROVED');
    expect(node.runners.cancelManagedRun(execution.id, 'INTERRUPT')).toBe(true);
    await vi.waitFor(() =>
      expect(node.runtime.findMessageSubmission('native-opencode', 'first')).toMatchObject({
        run: { id: run.id, status: 'INTERRUPTED' }
      })
    );
    expect(client.abort).toHaveBeenCalledExactlyOnceWith(root, 'native-opencode');
    expect(abort.signal.aborted).toBe(true);
    expect(state.has(execution.id)).toBe(false);
  });
});
