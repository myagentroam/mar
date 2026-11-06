import { describe, expect, it } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { AgentNetworkObservations } from '../../src/service/agent-network-observations.js';
import { AgentNetworkRunProjection } from '../../src/service/agent-network-run-projection.js';

function fixture(parentWorkspace = 'workspace') {
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => ({ id, path: '/' + id, kind: 'DIRECTORY', gitSummary: null })
  );
  const observations = new AgentNetworkObservations();
  const projection = new AgentNetworkRunProjection(runtime, observations);
  const parent = runtime.createAgentSession({
    workspaceId: parentWorkspace,
    cwd: '/' + parentWorkspace,
    runner: 'codex'
  });
  const child = runtime.createAgentSession({
    workspaceId: 'workspace',
    cwd: '/workspace',
    runner: 'codex',
    parentSessionId: parent.id
  });
  const { run } = runtime.createMessageRun({
    sessionId: child.id,
    clientMessageId: 'input',
    content: 'work'
  });
  return { runtime, observations, projection, parent, child, run };
}

describe('Agent Network Run projection', () => {
  it('projects approvals and terminal identity to the direct parent, not a foreign Workspace', () => {
    const f = fixture();
    const parent = f.observations.attach(f.parent.id);
    f.runtime.createApproval({
      runId: f.run.id,
      approvalId: 'approval',
      payload: { toolName: 'command' },
      expiresAt: Date.now() + 60_000
    });
    f.projection.accept({
      run: f.run,
      executionId: 'execution',
      eventType: 'approval.request',
      payload: {}
    });
    expect(parent.capture(f.child.id)).toMatchObject({
      runId: f.run.id,
      executionId: 'execution',
      updates: [{ kind: 'message', value: expect.stringContaining('pendingApprovals') }]
    });
    f.projection.accept({
      run: f.run,
      executionId: 'execution',
      eventType: 'run.completed',
      payload: {},
      terminalStatus: 'SUCCEEDED'
    });
    expect(parent.capture(f.child.id)?.updates).toContainEqual(
      expect.objectContaining({ kind: 'terminal', value: 'SUCCEEDED' })
    );
    parent.close();
    const other = fixture('foreign');
    const foreign = other.observations.attach(other.parent.id);
    other.projection.accept({
      run: other.run,
      executionId: 'execution',
      eventType: 'run.completed',
      payload: {},
      terminalStatus: 'SUCCEEDED'
    });
    expect(foreign.capture(other.child.id)).toBeUndefined();
    foreign.close();
  });

  it('owns transient attachment and closes it only for the matching terminal Run', () => {
    const f = fixture();
    expect(() =>
      f.projection.ensureObservations({ sessionId: f.child.id, runId: 'missing' })
    ).toThrow('AGENT_ACTOR_NOT_ACTIVE');
    const observer = f.projection.ensureObservations({ sessionId: f.child.id, runId: f.run.id });
    expect(f.projection.ensureObservations({ sessionId: f.child.id, runId: f.run.id })).toBe(
      observer
    );
    f.projection.accept({
      run: { ...f.run, id: 'stale' },
      executionId: 'stale',
      eventType: 'run.completed',
      payload: {},
      terminalStatus: 'SUCCEEDED'
    });
    expect(f.observations.get(f.child.id)).toBe(observer);
    f.projection.accept({
      run: f.run,
      executionId: 'execution',
      eventType: 'run.completed',
      payload: {},
      terminalStatus: 'SUCCEEDED'
    });
    expect(f.observations.get(f.child.id)).toBeUndefined();
  });

  it('disposes its transient observers without closing Runner-owned contexts', () => {
    const f = fixture();
    const context = f.observations.attach(f.parent.id);
    f.projection.ensureObservations({ sessionId: f.child.id, runId: f.run.id });
    f.projection.dispose();
    expect(f.observations.get(f.child.id)).toBeUndefined();
    expect(f.observations.get(f.parent.id)).toBe(context);
    context.close();
  });

  it.each(['terminal', 'dispose'] as const)(
    'closes the owned observer after Session identity promotion on %s',
    (boundary) => {
      const f = fixture();
      const observer = f.projection.ensureObservations({ sessionId: f.child.id, runId: f.run.id });
      const promoted = f.runtime.promoteSessionIdentity(f.child.id, 'native-session');
      f.observations.promote(f.child.id, promoted.id);
      expect(f.observations.get(promoted.id)).toBe(observer);
      if (boundary === 'dispose') f.projection.dispose();
      else
        f.projection.accept({
          run: f.runtime.getRun(f.run.id)!,
          executionId: 'execution',
          eventType: 'run.completed',
          payload: {},
          terminalStatus: 'SUCCEEDED'
        });
      expect(f.observations.get(promoted.id)).toBeUndefined();
    }
  );

  it.each(['terminal', 'dispose'] as const)(
    'does not close a replacement Runner context on %s',
    (boundary) => {
      const f = fixture();
      const transient = f.projection.ensureObservations({
        sessionId: f.child.id,
        runId: f.run.id
      });
      transient.close();
      const context = f.observations.attach(f.child.id);
      if (boundary === 'dispose') f.projection.dispose();
      else
        f.projection.accept({
          run: f.run,
          executionId: 'execution',
          eventType: 'run.completed',
          payload: {},
          terminalStatus: 'SUCCEEDED'
        });
      expect(f.observations.get(f.child.id)).toBe(context);
      context.close();
    }
  );
});
