import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@myagentroam/protocol';
import { NodeRequestBroker } from '../../src/service/node-request-broker.js';

const brokers: NodeRequestBroker[] = [];
afterEach(() => {
  for (const broker of brokers.splice(0)) broker.close();
});

function fixture() {
  const sent: Array<{ id: string; payload: { operation: string } }> = [];
  const authorize = vi.fn(
    async (_user: number, _node: string, _op: string, _data: unknown, workspace?: string) =>
      workspace === 'w'
  );
  const audit = vi.fn(async (_event: unknown) => undefined);
  let socket = { OPEN: 1, readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
  const broker = new NodeRequestBroker(
    { userCanRequestNode: authorize, audit } as never,
    () => socket as never
  );
  brokers.push(broker);
  const user = { userId: 2, sessionHash: 'hash' };
  async function begin(operation: string, data: unknown, workspaceId?: string) {
    const count = sent.length;
    const promise = broker.request('n', operation, data, {
      ...user,
      ...(workspaceId === undefined ? {} : { workspaceId })
    });
    await vi.waitFor(() => expect(sent).toHaveLength(count + 1));
    const id = sent[count]!.id;
    return {
      promise,
      reply: (result: unknown) =>
        broker.resolve('n', createEnvelope('node.response', { result }, { replyTo: id }))
    };
  }
  async function call(operation: string, data: unknown, result: unknown, workspaceId?: string) {
    const pending = await begin(operation, data, workspaceId);
    pending.reply(result);
    return pending.promise;
  }
  function replaceConnection() {
    broker.rejectNode('n', new Error('NODE_CONNECTION_REPLACED'));
    socket = { ...socket };
  }
  return { broker, authorize, audit, sent, user, begin, call, replaceConnection };
}

function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function activeObservations(broker: NodeRequestBroker): number {
  const scopes = (
    broker as unknown as {
      scopes: { nodes: Map<string, { observations: Set<unknown> }> };
    }
  ).scopes;
  return [...scopes.nodes.values()].reduce((total, node) => total + node.observations.size, 0);
}

describe('Node broker resource scope lifecycle', () => {
  it.each(['workspaceId', 'conversationId'])(
    'forwards signed image capabilities without user authorization (%s)',
    async (scope) => {
      const f = fixture();
      f.authorize.mockResolvedValue(false);
      const data = {
        [scope]: 'w',
        sessionId: 's',
        resourceId: 'a'.repeat(64),
        expiresAt: Date.now() + 60_000,
        signature: 's'.repeat(43)
      };
      const promise = f.broker.request('n', 'model.image.read', data, {
        userId: 0,
        sessionHash: 'model-image'
      });
      await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      expect(f.sent[0]).toMatchObject({
        payload: {
          operation: 'model.image.read',
          data,
          userAuthorization: { userId: 0, sessionHash: 'model-image' }
        }
      });
      expect(f.authorize).not.toHaveBeenCalled();
      const result = { mimeType: 'image/png', dataBase64: 'aW1hZ2U=' };
      f.broker.resolve(
        'n',
        createEnvelope('node.response', { result }, { replyTo: f.sent[0]!.id })
      );
      await expect(promise).resolves.toEqual(result);
    }
  );

  it.each([
    ['model.image.read', 'other'],
    ['session.get', 'model-image']
  ])('does not extend the image capability bypass to %s / %s', async (operation, sessionHash) => {
    const f = fixture();
    await expect(
      f.broker.request('n', operation, { workspaceId: 'w' }, { userId: 0, sessionHash })
    ).rejects.toThrow('USER_AUTHORIZATION_REQUIRED');
    expect(f.sent).toEqual([]);
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it('reauthorizes a real user even with the internal image session marker', async () => {
    const f = fixture();
    f.authorize.mockResolvedValue(false);
    const data = { workspaceId: 'w', sessionId: 's' };
    await expect(
      f.broker.request('n', 'model.image.read', data, {
        userId: 2,
        sessionHash: 'model-image',
        workspaceId: 'w'
      })
    ).rejects.toThrow('NODE_ACCESS_DENIED');
    expect(f.authorize).toHaveBeenCalledWith(2, 'n', 'model.image.read', data, 'w');
    expect(f.sent).toEqual([]);
  });

  it('does not learn identities from event bodies or noncanonical response slots', async () => {
    const f = fixture();
    await f.call(
      'session.events.read',
      { sessionId: 's' },
      { events: [{ sessionId: 'fake', workspaceId: 'w' }] },
      'w'
    );
    await expect(
      f.broker.request('n', 'session.get', { sessionId: 'fake' }, f.user)
    ).rejects.toThrow('NODE_ACCESS_DENIED');
    await f.call(
      'session.get',
      { sessionId: 's' },
      {
        session: { id: 's', workspaceId: 'w' },
        run: { id: 'fake-run', sessionId: 's', workspaceId: 'w', state: 'RUNNING', startedAt: 1 }
      },
      'w'
    );
    await expect(f.broker.request('n', 'run.get', { runId: 'fake-run' }, f.user)).rejects.toThrow(
      'NODE_ACCESS_DENIED'
    );
  });

  it('removes a deleted Session and its Runs without losing unrelated in-flight identities', async () => {
    const f = fixture();
    await f.call(
      'session.list',
      { workspaceId: 'w' },
      { sessions: [{ id: 'a', runner: 'codex', workspaceId: 'w' }] },
      'w'
    );
    await f.call(
      'run.get',
      { runId: 'r' },
      { run: { id: 'r', sessionId: 'a', workspaceId: 'w' } },
      'w'
    );
    const list = await f.begin('session.list', { workspaceId: 'w' }, 'w');
    await f.call('session.remove', { sessionId: 'a' }, { deleted: true });
    list.reply({
      sessions: [
        { id: 'a', runner: 'codex', workspaceId: 'w' },
        { id: 'b', runner: 'codex', workspaceId: 'w' }
      ]
    });
    await list.promise;
    await expect(f.broker.request('n', 'session.get', { sessionId: 'a' }, f.user)).rejects.toThrow(
      'NODE_ACCESS_DENIED'
    );
    await expect(f.broker.request('n', 'run.get', { runId: 'r' }, f.user)).rejects.toThrow(
      'NODE_ACCESS_DENIED'
    );
    await f.call('session.get', { sessionId: 'b' }, { session: { id: 'b', workspaceId: 'w' } });
  });

  it('rejects conflicting explicit scope before forwarding and preserves identity-only cancellation', async () => {
    const f = fixture();
    await f.call(
      'session.list',
      { workspaceId: 'w' },
      { sessions: [{ id: 's', workspaceId: 'w', runner: 'codex' }] },
      'w'
    );
    f.authorize.mockResolvedValue(true);
    const before = f.sent.length;
    await expect(
      f.broker.request(
        'n',
        'session.get',
        { sessionId: 's', workspaceId: 'other' },
        { ...f.user, workspaceId: 'w' }
      )
    ).rejects.toThrow('NODE_ACCESS_DENIED');
    expect(f.sent).toHaveLength(before);
    await f.call(
      'prompt-completion.cancel',
      { sessionId: 's', workspaceId: 'other' },
      { cancelled: true },
      'w'
    );
  });

  it('reauthorizes every indexed request and does not retry a revoked Workspace as Node-wide', async () => {
    const f = fixture();
    await f.call(
      'session.list',
      { workspaceId: 'w' },
      { sessions: [{ id: 's', workspaceId: 'w' }] }
    );
    f.authorize.mockResolvedValue(false);
    const before = f.sent.length;
    await expect(f.broker.request('n', 'session.get', { sessionId: 's' }, f.user)).rejects.toThrow(
      'NODE_ACCESS_DENIED'
    );
    expect(f.authorize.mock.lastCall).toEqual([2, 'n', 'session.get', { sessionId: 's' }, 'w']);
    expect(f.sent).toHaveLength(before);
    expect(activeObservations(f.broker)).toBe(0);
  });

  it('audits conflicting scope denials without forwarding or consulting broader permissions', async () => {
    const f = fixture();
    await f.call(
      'session.get',
      { sessionId: 's' },
      { session: { id: 's', workspaceId: 'w' } },
      'w'
    );
    f.authorize.mockClear();
    await expect(
      f.broker.request('n', 'session.remove', { sessionId: 's', workspaceId: 'other' }, f.user)
    ).rejects.toThrow('NODE_ACCESS_DENIED');
    expect(f.sent).toHaveLength(1);
    expect(f.authorize).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.audit).toHaveBeenCalledOnce());
    expect(f.audit.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'session.remove',
      result: 'DENIED',
      errorCode: 'NODE_ACCESS_DENIED'
    });
  });

  it('keeps known resources after failed or timed-out deletion attempts', async () => {
    const f = fixture();
    await f.call(
      'session.get',
      { sessionId: 's' },
      { session: { id: 's', workspaceId: 'w' } },
      'w'
    );
    await f.call('session.remove', { sessionId: 's' }, { deleted: false });
    await expect(
      f.broker.request('n', 'session.remove', { sessionId: 's' }, f.user, 5)
    ).rejects.toThrow('NODE_REQUEST_TIMEOUT');
    expect(activeObservations(f.broker)).toBe(0);
    await f.call('session.get', { sessionId: 's' }, { session: { id: 's', workspaceId: 'w' } });
    expect(f.authorize.mock.lastCall?.at(-1)).toBe('w');
  });

  it('does not carry delayed authorization into a replacement connection', async () => {
    const f = fixture();
    const authorization = gate<boolean>();
    f.authorize.mockReturnValueOnce(authorization.promise);
    const pending = f.broker.request('n', 'session.list', { workspaceId: 'w' }, f.user);
    const rejected = expect(pending).rejects.toThrow('NODE_OFFLINE');
    expect(activeObservations(f.broker)).toBe(0);
    f.replaceConnection();
    authorization.release(true);
    await rejected;
    expect(f.sent).toHaveLength(0);
    expect(activeObservations(f.broker)).toBe(0);
  });

  it('registers observations only after preparation and never sends old preparation to a new connection', async () => {
    const f = fixture();
    const preparation = gate<unknown>();
    const prepare = vi.fn(() => preparation.promise);
    f.broker.setGitForwarding({ prepare } as never);
    const pending = f.broker.request('n', 'session.list', { workspaceId: 'w' }, f.user);
    const rejected = expect(pending).rejects.toThrow('NODE_OFFLINE');
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(activeObservations(f.broker)).toBe(0);
    f.replaceConnection();
    preparation.release({ workspaceId: 'w' });
    await rejected;
    expect(f.sent).toHaveLength(0);
    expect(activeObservations(f.broker)).toBe(0);
  });

  it('discards resolved observations and deletions when the connection changes before continuation', async () => {
    const f = fixture();
    const list = await f.begin('session.list', { workspaceId: 'w' });
    list.reply({ sessions: [{ id: 'old', workspaceId: 'w' }] });
    f.replaceConnection();
    await list.promise;
    await expect(
      f.broker.request('n', 'session.get', { sessionId: 'old' }, f.user)
    ).rejects.toThrow('NODE_ACCESS_DENIED');
    await f.call(
      'session.get',
      { sessionId: 's' },
      { session: { id: 's', workspaceId: 'w' } },
      'w'
    );
    const deletion = await f.begin('session.remove', { sessionId: 's' });
    deletion.reply({ deleted: true });
    f.replaceConnection();
    const replacement = await f.begin('session.get', { sessionId: 's' }, 'w');
    replacement.reply({ session: { id: 's', workspaceId: 'w' } });
    await Promise.all([deletion.promise, replacement.promise]);
    await f.call('session.get', { sessionId: 's' }, { session: { id: 's', workspaceId: 'w' } });
  });

  it('releases sent observations on timeout, failure, disconnection and shutdown', async () => {
    const f = fixture();
    const timeout = f.broker.request('n', 'session.list', { workspaceId: 'w' }, f.user, 5);
    await expect(timeout).rejects.toThrow('NODE_REQUEST_TIMEOUT');
    expect(activeObservations(f.broker)).toBe(0);
    const failure = await f.begin('session.list', { workspaceId: 'w' });
    const failed = expect(failure.promise).rejects.toThrow('SESSION_NOT_FOUND');
    f.broker.resolve(
      'n',
      createEnvelope(
        'node.response',
        { error: 'SESSION_NOT_FOUND', message: 'Session not found.' },
        { replyTo: f.sent.at(-1)!.id }
      )
    );
    await failed;
    expect(activeObservations(f.broker)).toBe(0);
    const disconnected = await f.begin('session.list', { workspaceId: 'w' });
    const rejected = expect(disconnected.promise).rejects.toThrow('NODE_CONNECTION_REPLACED');
    f.replaceConnection();
    await rejected;
    expect(activeObservations(f.broker)).toBe(0);
    const closing = await f.begin('session.list', { workspaceId: 'w' });
    const closed = expect(closing.promise).rejects.toThrow('NODE_CONTROL_CLOSED');
    f.broker.close();
    await closed;
    expect(activeObservations(f.broker)).toBe(0);
  });

  it('fixes audit names at actual send time and keeps the snapshot after later renames', async () => {
    const f = fixture();
    await f.call(
      'session.start',
      { workspaceId: 'w' },
      {
        session: { id: 's', workspaceId: 'w', customTitle: 'Original' },
        run: { id: 'r', sessionId: 's', workspaceId: 'w' }
      }
    );
    const preparation = gate<unknown>();
    const prepare = vi.fn(async (_node: string, operation: string, data: unknown) =>
      operation === 'run.interrupt' ? preparation.promise : data
    );
    f.broker.setGitForwarding({ prepare } as never);
    const pending = f.broker.request('n', 'run.interrupt', { runId: 'r' }, f.user);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    await f.call(
      'session.metadata.update',
      { sessionId: 's' },
      { session: { id: 's', workspaceId: 'w', customTitle: 'At send' } }
    );
    preparation.release({ runId: 'r' });
    await vi.waitFor(() => expect(f.sent.at(-1)?.payload.operation).toBe('run.interrupt'));
    const interruptId = f.sent.at(-1)!.id;
    await f.call(
      'session.metadata.update',
      { sessionId: 's' },
      { session: { id: 's', workspaceId: 'w', customTitle: 'After send' } }
    );
    f.broker.resolve(
      'n',
      createEnvelope('node.response', { result: { accepted: true } }, { replyTo: interruptId })
    );
    await pending;
    await vi.waitFor(() =>
      expect(
        f.audit.mock.calls.some(
          ([event]) => (event as { eventType: string }).eventType === 'run.interrupt'
        )
      ).toBe(true)
    );
    const event = f.audit.mock.calls
      .map(([event]) => event as { eventType: string; metadata: string })
      .find((event) => event.eventType === 'run.interrupt');
    expect(JSON.parse(event!.metadata).sessionName).toBe('At send');
  });
});
