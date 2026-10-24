import { describe, expect, it, vi } from 'vitest';
import { serializeComposerTag } from '@myagentroam/protocol';
import { RecentRunProjectionService } from '../../src/service/recent-run-projection-service.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NodeAgentSession } from '../../src/database.js';
import type { NodeAgentRun } from '../../src/runtime-model.js';

function session(): NodeAgentSession {
  return {
    id: 'session-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: 'session-1',
    nativeControl: 'MAR_MANAGED',
    channelToken: null,
    cwd: '/workspace',
    model: null,
    effort: null,
    access: null,
    customTitle: null,
    runnerTitle: 'Test session',
    pinnedAt: null,
    titleSource: 'RUNNER',
    lastActivityAt: 100,
    createdAt: 100
  };
}

function run(status: NodeAgentRun['status'], version: number, updatedAt: number): NodeAgentRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    runner: 'codex',
    status,
    recoveryState: 'ACTIVE',
    version,
    clientMessageId: 'message-1',
    initiatedByUserId: 7,
    createdAt: 100,
    startedAt: 100,
    completedAt: ['SUCCEEDED', 'FAILED', 'INTERRUPTED'].includes(status) ? updatedAt : null,
    updatedAt
  };
}

describe('Node recent Run lightweight projection', () => {
  it.each([
    {
      name: 'session origin longer than the preview limit',
      input: `${serializeComposerTag('mar_session_origin', {
        sessionId: 'origin-session',
        name: 'c'.repeat(480)
      })}\nPlease   review\nthis change`,
      expected: 'Please review this change'
    },
    {
      name: 'Goal objective without internal instructions',
      input: serializeComposerTag('mar_goal_start', {
        objective: 'Review <workspace> & fix issues',
        instruction: 'Internal instructions'
      }),
      expected: 'Review <workspace> & fix issues'
    },
    {
      name: 'steer message without its instruction wrapper',
      input: serializeComposerTag('mar_steer', { message: 'Please continue' }),
      expected: 'Please continue'
    },
    {
      name: 'scheduled objective',
      input: serializeComposerTag('mar_schedule', { objective: 'Check the workspace' }),
      expected: 'Check the workspace'
    },
    {
      name: 'literal markup in a code example',
      input: 'Explain this:\n```xml\n<mar_restart />\n```',
      expected: 'Explain this: ```xml <mar_restart /> ```'
    }
  ])('publishes only visible message text for $name', ({ input, expected }) => {
    const emit = vi.fn();
    const service = new RecentRunProjectionService(emit, () => 1_000);
    try {
      service.record(run('RUNNING', 1, 100), session(), input);
      expect(service.snapshot()[0]?.userMessage).toBe(expected);
      expect(emit).toHaveBeenLastCalledWith({
        kind: 'UPDATE',
        run: expect.objectContaining({ userMessage: expected })
      });
    } finally {
      service.dispose();
    }
  });

  it.each([
    ['restart', serializeComposerTag('mar_restart', {})],
    [
      'Goal continuation',
      serializeComposerTag('mar_goal_continue', {
        objective: 'Internal objective',
        instruction: 'Continue internally'
      })
    ],
    [
      'session origin only',
      serializeComposerTag('mar_session_origin', { sessionId: 'origin-session', name: 'Peer' })
    ]
  ])('does not expose %s or replace a valid summary with it', (_name, input) => {
    const emit = vi.fn();
    const service = new RecentRunProjectionService(emit, () => 1_000);
    try {
      service.record(run('STARTING', 1, 100), session(), input);
      expect(service.snapshot()[0]).not.toHaveProperty('userMessage');
      expect(emit.mock.lastCall?.[0].run).not.toHaveProperty('userMessage');

      service.record(run('RUNNING', 2, 200), session(), 'User request');
      service.record(run('SUCCEEDED', 3, 300), session(), input);
      expect(service.snapshot()[0]?.userMessage).toBe('User request');
      expect(emit).toHaveBeenLastCalledWith({
        kind: 'UPDATE',
        run: expect.objectContaining({ userMessage: 'User request', status: 'SUCCEEDED' })
      });

      service.record(
        { ...run('RUNNING', 1, 500), id: 'run-2', createdAt: 400, startedAt: 400 },
        session(),
        input
      );
      expect(service.snapshot()[0]).not.toHaveProperty('userMessage');
    } finally {
      service.dispose();
    }
  });

  it('locks in the start time when a Run accepts input and does not reorder on terminal update', () => {
    const emit = vi.fn();
    const service = new RecentRunProjectionService(emit, () => 1_000);
    service.record(run('STARTING', 1, 100), session());
    expect(service.snapshot()[0]).toMatchObject({ startedAt: 100, sortAt: 100 });
    service.record(run('RUNNING', 3, 300), session());
    service.record(run('SUCCEEDED', 4, 400), session());
    expect(service.snapshot()[0]).toMatchObject({
      status: 'SUCCEEDED',
      startedAt: 100,
      completedAt: 400,
      sortAt: 100
    });
    service.dispose();
  });

  it('ignores internal Runs without an initiating user', () => {
    const emit = vi.fn();
    const service = new RecentRunProjectionService(emit);
    const { initiatedByUserId: _initiatedByUserId, ...internal } = run('RUNNING', 1, 100);
    void _initiatedByUserId;
    service.record(internal, session());
    expect(service.snapshot()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    service.dispose();
  });

  it('ignores temporary sessions without a native Runner identity', () => {
    const emit = vi.fn();
    const service = new RecentRunProjectionService(emit);
    service.record(run('STARTING', 1, 100), { ...session(), externalSessionId: null });
    expect(service.snapshot()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    service.dispose();
  });

  it('projects an upgraded identity as the official session with the same user message', () => {
    const emit = vi.fn();
    const service = new RecentRunProjectionService(emit);
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      (id) =>
        id === 'workspace-1'
          ? {
              id,
              path: '/workspace',
              kind: 'DIRECTORY',
              gitSummary: null,
              createdAt: 1,
              updatedAt: 1
            }
          : undefined,
      () => 100,
      (changedRun, changedSession, userMessage) =>
        service.record(changedRun, changedSession, userMessage)
    );
    const bootstrap = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      cwd: '/workspace'
    });
    runtime.createMessageRun({
      sessionId: bootstrap.id,
      clientMessageId: 'message-1',
      content: 'Continue investigating',
      initiatedByUserId: 7
    });
    expect(emit).not.toHaveBeenCalled();

    runtime.promoteSessionIdentity(bootstrap.id, 'native-session-1');

    expect(service.snapshot()).toEqual([
      expect.objectContaining({
        sessionId: 'native-session-1',
        userMessage: 'Continue investigating'
      })
    ]);
    service.dispose();
  });

  it('continuous Runs update the summary only from real user messages and ignore internal Goal continuations', () => {
    const service = new RecentRunProjectionService(vi.fn());
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      () => ({
        id: 'workspace-1',
        path: '/workspace',
        kind: 'DIRECTORY',
        gitSummary: null,
        createdAt: 1,
        updatedAt: 1
      }),
      () => 100,
      (changedRun, changedSession, userMessage) =>
        service.record(changedRun, changedSession, userMessage)
    );
    const activeSession = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'session-1',
      cwd: '/workspace'
    });
    const created = runtime.createMessageRun({
      sessionId: activeSession.id,
      clientMessageId: 'message-1',
      content: 'First user message',
      initiatedByUserId: 7
    });
    runtime.createQueueItem({
      sessionId: activeSession.id,
      clientMessageId: 'message-2',
      content: 'User intervention',
      initiatedByUserId: 7
    });
    runtime.claimNextQueueItem(activeSession.id);
    expect(service.snapshot()[0]).toMatchObject({ userMessage: 'User intervention' });

    runtime.createQueueItem({
      sessionId: activeSession.id,
      clientMessageId: 'goal:continue-1',
      content: 'Goal Continue',
      initiatedByUserId: 7
    });
    runtime.claimNextQueueItem(activeSession.id);
    runtime.transitionRun(created.run.id, 'RUNNING');
    expect(service.snapshot()[0]).toMatchObject({ userMessage: 'User intervention' });
    service.dispose();
  });

  it('keeps the real user message summary when Conversation echoes attachment-enriched Runner input', () => {
    const service = new RecentRunProjectionService(vi.fn());
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      () => ({
        id: 'workspace-1',
        path: '/workspace',
        kind: 'DIRECTORY',
        gitSummary: null,
        createdAt: 1,
        updatedAt: 1
      }),
      () => 100,
      (changedRun, changedSession, userMessage) =>
        service.record(changedRun, changedSession, userMessage)
    );
    const activeSession = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'session-1',
      cwd: '/workspace'
    });
    const created = runtime.createMessageRun({
      sessionId: activeSession.id,
      clientMessageId: 'message-with-attachment',
      content: 'Read the attachment',
      initiatedByUserId: 7
    });
    const runnerInput =
      'Read the attachment\n\nAttachments available in the Workspace:\n- .mar/temp-files/run/notes.pdf';

    runtime.updatePreparingTurnMessage(created.run.id, runnerInput, []);
    runtime.transitionRun(created.run.id, 'RUNNING');

    expect(runtime.currentRunMessageText(created.run.id)).toBe(runnerInput);
    expect(service.snapshot()[0]).toMatchObject({ userMessage: 'Read the attachment' });
    service.dispose();
  });

  it('replaces an older Run with a new Run in the same session without inheriting the old Run time', () => {
    const service = new RecentRunProjectionService(vi.fn(), () => 1_000);
    service.record(run('INTERRUPTED', 5, 300), session());
    service.record(
      {
        ...run('RUNNING', 2, 500),
        id: 'run-2',
        clientMessageId: 'message-2',
        createdAt: 400,
        startedAt: 400
      },
      session(),
      `  Fix\n${'issue'.repeat(120)}  `
    );
    service.record(run('INTERRUPTED', 6, 600), session());
    expect(service.snapshot()).toEqual([
      expect.objectContaining({
        runId: 'run-2',
        sessionId: 'session-1',
        status: 'RUNNING',
        createdAt: 400,
        startedAt: 400,
        completedAt: null,
        sortAt: 400,
        userMessage: `Fix ${'issue'.repeat(99)}i`
      })
    ]);
    service.dispose();
  });

  it('keeps separate tasks for different initiating users in the same session', () => {
    const service = new RecentRunProjectionService(vi.fn(), () => 1_000);
    service.record(run('RUNNING', 1, 100), session());
    service.record(
      {
        ...run('RUNNING', 1, 200),
        id: 'run-user-8',
        clientMessageId: 'message-user-8',
        initiatedByUserId: 8,
        createdAt: 190
      },
      session()
    );
    expect(service.snapshot().map((item) => [item.userId, item.runId])).toEqual([
      [8, 'run-user-8'],
      [7, 'run-1']
    ]);
    service.dispose();
  });
});
