import { describe, expect, it } from 'vitest';
import {
  NodeResourceScopeIndex,
  observesRelayResources,
  projectRelayResources,
  relayResourceRemoval,
  type RelayResourceFacts,
  type RelaySessionFact
} from '../../src/service/node-resource-scope-index.js';
import { RelayAuditContextCache } from '../../src/service/relay-audit-context-cache.js';

const emptyFacts: RelayResourceFacts = { sessions: [], runs: [], terminals: [] };

function auditSession(
  id: string,
  workspaceId: string | undefined,
  title: string
): RelaySessionFact {
  return { id, workspaceId, complete: true, title };
}

describe('Node resource scope owner', () => {
  it('projects canonical session, marctl, graph, and terminal response slots', () => {
    expect(observesRelayResources('session.create')).toBe(true);
    expect(observesRelayResources('session.cli.context')).toBe(true);
    expect(observesRelayResources('session.graph')).toBe(true);
    expect(observesRelayResources('terminal.list')).toBe(true);
    expect(observesRelayResources('session.events.read')).toBe(false);

    expect(
      projectRelayResources(
        'session.create',
        { workspaceId: 'request-workspace' },
        {
          session: {
            id: 'created-session',
            workspaceId: 'created-workspace',
            customTitle: 'Created'
          },
          parentSessionId: 'not-an-alias'
        }
      )
    ).toEqual({
      sessions: [
        {
          id: 'created-session',
          workspaceId: 'created-workspace',
          complete: true,
          customTitle: 'Created',
          runnerTitle: undefined,
          conversationTitle: undefined
        }
      ],
      runs: [],
      terminals: []
    });

    expect(
      projectRelayResources(
        'session.start',
        {},
        {
          session: { id: 'started-session', workspaceId: 'w', customTitle: 'Started' },
          run: { id: 'started-run', sessionId: 'started-session', workspaceId: 'w' }
        }
      )
    ).toMatchObject({
      sessions: [{ id: 'started-session', workspaceId: 'w' }],
      runs: [{ id: 'started-run', sessionId: 'started-session', workspaceId: 'w' }],
      terminals: []
    });

    const queued = projectRelayResources(
      'session.message',
      { sessionId: 'queued-session' },
      {
        session: { id: 'queued-session', workspaceId: 'w' },
        submissionId: 'submission-1',
        queueItemId: 'queue-1',
        auditReceipt: { runId: 'not-a-run' }
      }
    );
    expect(queued.sessions).toMatchObject([{ id: 'queued-session', workspaceId: 'w' }]);
    expect(queued.runs).toEqual([]);

    expect(
      projectRelayResources(
        'session.get',
        {},
        {
          view: 'marctl',
          workspaceId: 'w',
          session: {
            id: 'cli-session',
            title: 'CLI title',
            runId: 'cli-run',
            latestMessage: { sessionId: 'not-a-session' }
          }
        }
      )
    ).toEqual({
      sessions: [{ id: 'cli-session', workspaceId: 'w', complete: false, title: 'CLI title' }],
      runs: [{ id: 'cli-run', sessionId: 'cli-session', workspaceId: 'w' }],
      terminals: []
    });

    const graph = projectRelayResources(
      'session.graph',
      { workspaceId: 'graph-workspace' },
      {
        nodes: [
          {
            id: 'graph-session',
            title: 'Graph title',
            workspaceId: 'untrusted-workspace',
            runId: 'not-a-graph-run',
            parentSessionId: 'not-a-parent',
            activity: { sessionId: 'not-an-activity-session' }
          }
        ],
        truncated: true
      }
    );
    expect(graph.sessions).toEqual([
      { id: 'graph-session', workspaceId: 'graph-workspace', complete: false, title: 'Graph title' }
    ]);
    expect(graph.runs).toEqual([]);

    expect(
      projectRelayResources(
        'terminal.list',
        { workspaceId: 'must-not-infer' },
        {
          terminals: [
            { id: 'workspace-terminal', workspaceId: 'w', state: 'RUNNING' },
            { id: 'node-terminal', workspaceId: null, state: 'RUNNING' },
            { id: 'incomplete-terminal', state: 'RUNNING' }
          ]
        }
      )
    ).toEqual({
      sessions: [],
      runs: [],
      terminals: [
        { id: 'workspace-terminal', workspaceId: 'w' },
        { id: 'node-terminal', workspaceId: null }
      ]
    });

    expect(
      projectRelayResources(
        'session.cli.context',
        {},
        {
          session: null,
          run: { id: 'orphan-run', sessionId: 'orphan-session', workspaceId: 'w' }
        }
      )
    ).toEqual({
      sessions: [],
      runs: [{ id: 'orphan-run', sessionId: 'orphan-session', workspaceId: 'w' }],
      terminals: []
    });
  });

  it('distinguishes null terminal scope from a miss and removes only confirmed targets', () => {
    const index = new NodeResourceScopeIndex();
    const observation = index.begin('node');
    index.observe(observation, {
      sessions: [
        { id: 'session-a', workspaceId: 'workspace-a', complete: true },
        { id: 'session-b', workspaceId: 'workspace-b', complete: true }
      ],
      runs: [
        { id: 'run-a', sessionId: 'session-a', workspaceId: 'workspace-a' },
        { id: 'run-b', sessionId: 'session-b', workspaceId: 'workspace-b' }
      ],
      terminals: [
        { id: 'terminal-a', workspaceId: 'workspace-a' },
        { id: 'node-terminal', workspaceId: null }
      ]
    });
    index.finish(observation);

    expect(index.resolve('node', 'terminal.close', { terminalId: 'node-terminal' })).toEqual({
      workspaceId: undefined,
      conflict: false
    });
    expect(
      index.resolve('node', 'terminal.close', {
        terminalId: 'node-terminal',
        workspaceId: 'workspace-a'
      })
    ).toEqual({ workspaceId: 'workspace-a', conflict: true });
    expect(
      index.resolve('node', 'terminal.close', {
        terminalId: 'unknown-terminal',
        workspaceId: 'workspace-a'
      })
    ).toEqual({ workspaceId: 'workspace-a', conflict: false });

    expect(
      relayResourceRemoval('session.remove', { sessionId: 'session-a' }, { deleted: false })
    ).toBeUndefined();
    const sessionRemoval = relayResourceRemoval(
      'session.remove',
      { sessionId: 'session-a' },
      { deleted: true }
    );
    expect(sessionRemoval).toEqual({ kind: 'session', id: 'session-a' });
    if (sessionRemoval) index.remove('node', sessionRemoval);
    expect(
      index.resolve('node', 'session.get', { sessionId: 'session-a' }).workspaceId
    ).toBeUndefined();
    expect(index.resolve('node', 'run.get', { runId: 'run-a' }).workspaceId).toBeUndefined();
    expect(index.resolve('node', 'session.get', { sessionId: 'session-b' }).workspaceId).toBe(
      'workspace-b'
    );

    const page = index.begin('node');
    index.observe(page, {
      sessions: [{ id: 'session-c', workspaceId: 'workspace-a', complete: true }],
      runs: [],
      terminals: []
    });
    index.finish(page);
    expect(index.resolve('node', 'session.get', { sessionId: 'session-b' }).workspaceId).toBe(
      'workspace-b'
    );

    expect(
      relayResourceRemoval(
        'workspace.sessions.cleanup',
        { workspaceId: 'workspace-b' },
        { removedCount: 1 }
      )
    ).toBeUndefined();
    expect(index.resolve('node', 'session.get', { sessionId: 'session-b' }).workspaceId).toBe(
      'workspace-b'
    );

    const workspaceRemoval = relayResourceRemoval(
      'workspace.remove',
      { workspaceId: 'workspace-a' },
      { workspace: { id: 'workspace-a' } }
    );
    expect(workspaceRemoval).toEqual({ kind: 'workspace', id: 'workspace-a' });
    if (workspaceRemoval) index.remove('node', workspaceRemoval);
    expect(
      index.resolve('node', 'session.get', { sessionId: 'session-c' }).workspaceId
    ).toBeUndefined();
    expect(
      index.resolve('node', 'terminal.close', { terminalId: 'terminal-a' }).workspaceId
    ).toBeUndefined();
    expect(index.resolve('node', 'session.get', { sessionId: 'session-b' }).workspaceId).toBe(
      'workspace-b'
    );
    expect(index.resolve('node', 'terminal.close', { terminalId: 'node-terminal' }).conflict).toBe(
      false
    );

    expect(
      relayResourceRemoval(
        'terminal.close',
        { terminalId: 'node-terminal' },
        { terminal: { id: 'other-terminal', state: 'EXITED' } }
      )
    ).toBeUndefined();
    const terminalRemoval = relayResourceRemoval(
      'terminal.close',
      { terminalId: 'node-terminal' },
      { terminal: { id: 'node-terminal', state: 'EXITED' } }
    );
    expect(terminalRemoval).toEqual({ kind: 'terminal', id: 'node-terminal' });
    if (terminalRemoval) index.remove('node', terminalRemoval);
    expect(
      index.resolve('node', 'terminal.close', { terminalId: 'node-terminal' }).workspaceId
    ).toBe(undefined);
  });

  it('resolves native-history images through canonical Session scope without creating Run aliases', () => {
    const index = new NodeResourceScopeIndex();
    const observation = index.begin('node');
    index.observe(observation, {
      sessions: [
        { id: 'session', workspaceId: 'workspace', complete: true },
        { id: 'hosted:conversation', workspaceId: 'workspace', complete: true }
      ],
      runs: [],
      terminals: []
    });
    index.finish(observation);
    const image = { runId: 'native-history:session', imageRef: 'reader:ref' };
    expect(index.resolve('node', 'run.image.read', image)).toEqual({
      workspaceId: 'workspace',
      conflict: false
    });
    expect(index.resolve('node', 'run.image.read', image, 'other').conflict).toBe(true);
    for (const operation of ['run.get', 'run.cancel', 'run.interrupt'])
      expect(index.resolve('node', operation, image).workspaceId).toBeUndefined();
    expect(index.resolve('other-node', 'run.image.read', image).workspaceId).toBeUndefined();
    expect(
      index.resolve('node', 'run.image.read', { runId: 'native-history:unknown' }).workspaceId
    ).toBeUndefined();
    expect(
      index.resolve('node', 'run.image.read', { runId: 'native-history:hosted:conversation' })
        .workspaceId
    ).toBeUndefined();
    index.remove('node', { kind: 'session', id: 'session' });
    expect(index.resolve('node', 'run.image.read', image).workspaceId).toBeUndefined();
  });

  it('filters deleted in-flight identities while retaining unrelated observations', () => {
    const index = new NodeResourceScopeIndex();
    const seed = index.begin('node');
    index.observe(seed, {
      sessions: [{ id: 'session-a', workspaceId: 'workspace-a', complete: true }],
      runs: [{ id: 'run-a', sessionId: 'session-a', workspaceId: 'workspace-a' }],
      terminals: []
    });
    index.finish(seed);

    const pending = index.begin('node');
    index.remove('node', { kind: 'session', id: 'session-a' });
    expect(pending.excluded.size).toBe(1);
    const filtered = index.observe(pending, {
      sessions: [
        { id: 'session-a', workspaceId: 'workspace-a', complete: true },
        { id: 'session-b', workspaceId: 'workspace-b', complete: true }
      ],
      runs: [
        { id: 'run-a', sessionId: 'session-a', workspaceId: 'workspace-a' },
        { id: 'run-b', sessionId: 'session-b', workspaceId: 'workspace-b' }
      ],
      terminals: []
    });
    expect(filtered.sessions.map(({ id }) => id)).toEqual(['session-b']);
    expect(filtered.runs.map(({ id }) => id)).toEqual(['run-b']);
    expect(index.resolve('node', 'session.get', { sessionId: 'session-a' }).workspaceId).toBe(
      undefined
    );
    expect(index.resolve('node', 'session.get', { sessionId: 'session-b' }).workspaceId).toBe(
      'workspace-b'
    );
    expect(index.resolve('node', 'run.get', { runId: 'run-b' }).workspaceId).toBe('workspace-b');

    index.finish(pending);
    expect(pending.excluded.size).toBe(0);
    expect(pending.scope.observations.size).toBe(0);
    const later = index.begin('node');
    expect(
      index.observe(later, {
        sessions: [{ id: 'session-a', workspaceId: 'workspace-a', complete: true }],
        runs: [],
        terminals: []
      }).sessions
    ).toMatchObject([{ id: 'session-a', workspaceId: 'workspace-a' }]);
    expect(index.resolve('node', 'session.get', { sessionId: 'session-a' }).workspaceId).toBe(
      'workspace-a'
    );
    index.finish(later);
  });

  it('does not restore known Workspace members from unscoped in-flight projections', () => {
    const index = new NodeResourceScopeIndex();
    const cache = new RelayAuditContextCache();
    const seed = index.begin('node');
    const initial: RelayResourceFacts = {
      sessions: [
        auditSession('session-a', 'workspace-a', 'A'),
        auditSession('session-b', 'workspace-b', 'B')
      ],
      runs: [
        { id: 'run-a', sessionId: 'session-a', workspaceId: 'workspace-a' },
        { id: 'run-b', sessionId: 'session-b', workspaceId: 'workspace-b' }
      ],
      terminals: [{ id: 'terminal-a', workspaceId: 'workspace-a' }]
    };
    index.observe(seed, initial);
    index.finish(seed);
    cache.observe('node', initial);
    const pending = index.begin('node');
    const removal = { kind: 'workspace', id: 'workspace-a' } as const;
    index.remove('node', removal);
    cache.remove('node', removal);
    const compact = projectRelayResources(
      'session.list',
      {},
      {
        view: 'marctl',
        sessions: [
          { id: 'session-a', title: 'Late A', runId: 'run-a' },
          { id: 'session-b', title: 'Fresh B', runId: 'run-b' },
          { id: 'unknown-session', title: 'Unknown' }
        ]
      }
    );
    const filtered = index.observe(pending, {
      ...compact,
      terminals: [{ id: 'terminal-a', workspaceId: null }]
    });
    cache.observe('node', filtered);
    expect(filtered.sessions.map(({ id }) => id)).toEqual(['session-b', 'unknown-session']);
    expect(filtered.runs.map(({ id }) => id)).toEqual(['run-b']);
    expect(filtered.terminals).toEqual([]);
    expect(cache.context('node', 'session-a').name).toBeUndefined();
    expect(cache.context('node', undefined, 'run-a').sessionId).toBeUndefined();
    expect(cache.context('node', 'session-b').name).toBe('Fresh B');
    expect(index.resolve('node', 'session.get', { sessionId: 'session-b' }).workspaceId).toBe(
      'workspace-b'
    );
    index.finish(pending);
    expect(pending.excluded.size).toBe(0);
    const later = index.begin('node');
    expect(
      index.observe(later, { ...emptyFacts, terminals: [{ id: 'terminal-a', workspaceId: null }] })
        .terminals
    ).toEqual([{ id: 'terminal-a', workspaceId: null }]);
    index.finish(later);
  });

  it('returns repeated resource churn to a fixed logical baseline', () => {
    const index = new NodeResourceScopeIndex();
    const baselineObservation = index.begin('node');
    index.observe(baselineObservation, {
      sessions: [{ id: 'fixed-session', workspaceId: 'fixed-workspace', complete: true }],
      runs: [{ id: 'fixed-run', sessionId: 'fixed-session', workspaceId: 'fixed-workspace' }],
      terminals: [{ id: 'fixed-terminal', workspaceId: 'fixed-workspace' }]
    });
    index.finish(baselineObservation);
    const baseline = {
      sessions: baselineObservation.scope.sessions.size,
      runs: baselineObservation.scope.runs.size,
      terminals: baselineObservation.scope.terminals.size
    };
    expect(baseline).toEqual({ sessions: 1, runs: 1, terminals: 1 });

    for (let i = 0; i < 24; i += 1) {
      const observation = index.begin('node');
      index.observe(observation, {
        sessions: [
          { id: `temporary-session-${i}`, workspaceId: `temporary-workspace-${i}`, complete: true }
        ],
        runs: [
          {
            id: `temporary-run-${i}`,
            sessionId: `temporary-session-${i}`,
            workspaceId: `temporary-workspace-${i}`
          }
        ],
        terminals: [{ id: `temporary-terminal-${i}`, workspaceId: `temporary-workspace-${i}` }]
      });
      index.finish(observation);
      index.remove('node', { kind: 'session', id: `temporary-session-${i}` });
      index.remove('node', { kind: 'terminal', id: `temporary-terminal-${i}` });
      expect({
        sessions: baselineObservation.scope.sessions.size,
        runs: baselineObservation.scope.runs.size,
        terminals: baselineObservation.scope.terminals.size
      }).toEqual(baseline);
    }

    expect(index.resolve('node', 'session.get', { sessionId: 'fixed-session' }).workspaceId).toBe(
      'fixed-workspace'
    );
    expect(index.resolve('node', 'run.get', { runId: 'fixed-run' }).workspaceId).toBe(
      'fixed-workspace'
    );
    expect(
      index.resolve('node', 'terminal.close', { terminalId: 'fixed-terminal' }).workspaceId
    ).toBe('fixed-workspace');
  });

  it('invalidates and releases old observations across clear and late finish', () => {
    const index = new NodeResourceScopeIndex();
    const old = index.begin('node');
    index.observe(old, {
      sessions: [{ id: 'old-session', workspaceId: 'old-workspace', complete: true }],
      runs: [],
      terminals: []
    });
    index.remove('node', { kind: 'session', id: 'deleted-session' });
    expect(old.excluded.size).toBe(1);
    expect(old.scope.observations.size).toBe(1);

    index.clear();
    expect(old.excluded.size).toBe(0);
    expect(old.scope.observations.size).toBe(0);
    expect(
      index.observe(old, {
        sessions: [{ id: 'stale-session', workspaceId: 'stale-workspace', complete: true }],
        runs: [],
        terminals: []
      })
    ).toEqual(emptyFacts);

    const current = index.begin('node');
    expect(current.scope).not.toBe(old.scope);
    index.observe(current, {
      sessions: [{ id: 'current-session', workspaceId: 'current-workspace', complete: true }],
      runs: [],
      terminals: []
    });
    index.finish(old);
    expect(index.resolve('node', 'session.get', { sessionId: 'current-session' }).workspaceId).toBe(
      'current-workspace'
    );
    index.finish(current);
    expect(current.scope.observations.size).toBe(0);
  });
});

describe('Node resource owner refresh behavior', () => {
  it('preserves known Workspace cleanup ownership after a Node-wide marctl refresh', () => {
    const index = new NodeResourceScopeIndex();
    const cache = new RelayAuditContextCache();
    const original: RelayResourceFacts = {
      sessions: [
        { id: 'session', workspaceId: 'workspace', complete: true, customTitle: 'Before' }
      ],
      runs: [{ id: 'run', sessionId: 'session', workspaceId: 'workspace' }],
      terminals: []
    };
    const initial = index.begin('node');
    index.observe(initial, original);
    index.finish(initial);
    cache.observe('node', original);

    const nodeWideRefresh = projectRelayResources(
      'session.list',
      {},
      { view: 'marctl', sessions: [{ id: 'session', title: 'After', runId: 'run' }] }
    );
    expect(nodeWideRefresh.sessions[0]?.workspaceId).toBeUndefined();
    expect(nodeWideRefresh.runs[0]?.workspaceId).toBeUndefined();
    const refresh = index.begin('node');
    index.observe(refresh, nodeWideRefresh);
    index.finish(refresh);
    cache.observe('node', nodeWideRefresh);

    expect(index.resolve('node', 'session.get', { sessionId: 'session' }).workspaceId).toBe(
      'workspace'
    );
    expect(index.resolve('node', 'run.get', { runId: 'run' }).workspaceId).toBe('workspace');
    expect(cache.context('node', 'session').name).toBe('After');
    expect(cache.context('node', undefined, 'run').sessionId).toBe('session');

    const removal = { kind: 'workspace', id: 'workspace' } as const;
    index.remove('node', removal);
    cache.remove('node', removal);
    expect(
      index.resolve('node', 'session.get', { sessionId: 'session' }).workspaceId
    ).toBeUndefined();
    expect(index.resolve('node', 'run.get', { runId: 'run' }).workspaceId).toBeUndefined();
    expect(cache.context('node', 'session').name).toBeUndefined();
    expect(cache.context('node', undefined, 'run').sessionId).toBeUndefined();
  });
});

describe('Relay audit context owner', () => {
  it('uses canonical name fallback, bounds names, and keeps returned snapshots stable', () => {
    const cache = new RelayAuditContextCache();
    const mutableSession = {
      id: 'snapshot-session',
      workspaceId: 'workspace',
      complete: true,
      customTitle: 'Before'
    };
    cache.observe('node', {
      sessions: [
        {
          id: 'runner-fallback',
          workspaceId: undefined,
          complete: true,
          title: '  ',
          customTitle: null,
          runnerTitle: 'Runner title',
          conversationTitle: 'Conversation title'
        },
        {
          id: 'conversation-fallback',
          workspaceId: undefined,
          complete: true,
          customTitle: ' ',
          runnerTitle: null,
          conversationTitle: 'Conversation title'
        },
        { id: 'long-title', workspaceId: 'workspace', complete: true, title: 'x'.repeat(600) },
        mutableSession
      ],
      runs: [{ id: 'snapshot-run', sessionId: 'snapshot-session', workspaceId: 'workspace' }],
      terminals: []
    });

    expect(cache.context('node', 'runner-fallback')).toEqual({
      sessionId: 'runner-fallback',
      name: 'Runner title'
    });
    expect(cache.context('node', 'conversation-fallback').name).toBe('Conversation title');
    expect(cache.context('node', 'long-title').name).toBe('x'.repeat(512));

    const snapshot = cache.context('node', undefined, 'snapshot-run');
    mutableSession.customTitle = 'After';
    cache.observe('node', { sessions: [mutableSession], runs: [], terminals: [] });
    expect(snapshot).toEqual({ sessionId: 'snapshot-session', name: 'Before' });
    expect(cache.context('node', undefined, 'snapshot-run')).toEqual({
      sessionId: 'snapshot-session',
      name: 'After'
    });

    cache.observe('node', {
      sessions: [{ id: 'snapshot-session', workspaceId: 'workspace', complete: false }],
      runs: [],
      terminals: []
    });
    expect(cache.context('node', 'snapshot-session').name).toBe('After');
    cache.observe('node', {
      sessions: [{ id: 'snapshot-session', workspaceId: 'workspace', complete: true }],
      runs: [],
      terminals: []
    });
    expect(cache.context('node', 'snapshot-session').name).toBeUndefined();
  });

  it('enforces one global LRU bound across Nodes and Run relationships', () => {
    const cache = new RelayAuditContextCache();
    cache.observe('node-a', {
      sessions: Array.from({ length: 4095 }, (_, i) => auditSession(`a-${i}`, undefined, `A ${i}`)),
      runs: [],
      terminals: []
    });
    cache.observe('node-b', {
      sessions: Array.from({ length: 4096 }, (_, i) => auditSession(`b-${i}`, undefined, `B ${i}`)),
      runs: [],
      terminals: []
    });
    cache.observe('node-a', {
      sessions: [],
      runs: [{ id: 'run-a', sessionId: 'a-0', workspaceId: undefined }],
      terminals: []
    });

    expect(cache.context('node-a', 'a-0').name).toBe('A 0');
    expect(cache.context('node-a', undefined, 'run-a')).toEqual({
      sessionId: 'a-0',
      name: 'A 0'
    });
    cache.observe('node-c', {
      sessions: [auditSession('overflow', undefined, 'Overflow')],
      runs: [],
      terminals: []
    });

    expect(cache.context('node-a', 'a-0').name).toBe('A 0');
    expect(cache.context('node-a', 'a-1').name).toBeUndefined();
    expect(cache.context('node-b', 'b-0').name).toBe('B 0');
    expect(cache.context('node-a', undefined, 'run-a')).toEqual({
      sessionId: 'a-0',
      name: 'A 0'
    });
    expect(cache.context('node-c', 'overflow').name).toBe('Overflow');
  });

  it('cleans entries by their own Node, Workspace, and Session ownership', () => {
    const cache = new RelayAuditContextCache();
    cache.observe('node-a', {
      sessions: [auditSession('shared-session', undefined, 'Node A')],
      runs: [
        { id: 'workspace-run', sessionId: 'shared-session', workspaceId: 'workspace' },
        { id: 'unscoped-run', sessionId: 'shared-session', workspaceId: undefined }
      ],
      terminals: []
    });
    cache.observe('node-b', {
      sessions: [auditSession('shared-session', 'workspace', 'Node B')],
      runs: [{ id: 'workspace-run', sessionId: 'shared-session', workspaceId: 'workspace' }],
      terminals: []
    });

    cache.remove('node-a', { kind: 'workspace', id: 'workspace' });
    expect(cache.context('node-a', 'shared-session').name).toBe('Node A');
    expect(cache.context('node-a', undefined, 'workspace-run').sessionId).toBeUndefined();
    expect(cache.context('node-a', undefined, 'unscoped-run')).toEqual({
      sessionId: 'shared-session',
      name: 'Node A'
    });
    expect(cache.context('node-b', 'shared-session').name).toBe('Node B');
    expect(cache.context('node-b', undefined, 'workspace-run')).toEqual({
      sessionId: 'shared-session',
      name: 'Node B'
    });

    cache.remove('node-a', { kind: 'session', id: 'shared-session' });
    expect(cache.context('node-a', 'shared-session').name).toBeUndefined();
    expect(cache.context('node-a', undefined, 'unscoped-run').sessionId).toBeUndefined();
    expect(cache.context('node-b', 'shared-session').name).toBe('Node B');
    expect(cache.context('node-b', undefined, 'workspace-run').sessionId).toBe('shared-session');
  });
});
