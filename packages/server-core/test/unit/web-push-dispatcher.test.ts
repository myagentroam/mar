import { describe, expect, it, vi } from 'vitest';
import {
  WebPushDispatcher,
  type WebPushTransportInput,
  type WebPushProjection
} from '../../src/web-push-dispatcher.js';

const allow = async () => true;

function fixture() {
  let online = false;
  let enabled = true;
  const clients = [1, 2, 3].map((id) => ({
    subscriptionId: String(id),
    bindingVersion: 1,
    enabled: true,
    userId: 1,
    sessionHash: 'session',
    subscription: {
      endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
      expirationTime: null,
      keys: { p256dh: 'public', auth: 'secret' }
    }
  }));
  const projection = {
    account: 'alice',
    notification: {
      id: 'notice-1',
      title: 'Task',
      message: 'Completed',
      expiresAt: 60_000,
      read: false
    }
  };
  const subscriptions = { eligible: vi.fn(async () => clients), expire: vi.fn(async () => true) };
  const transport = vi.fn(async (_input: WebPushTransportInput) => ({ statusCode: 201 }));
  const resolve = vi.fn<(userId: number, id: string) => Promise<WebPushProjection | undefined>>(
    async () => projection
  );
  const configuration = {
    delivery: vi.fn(async () =>
      enabled
        ? { subject: 'https://console.example.test', publicKey: 'public', privateKey: 'private' }
        : undefined
    )
  };
  const dispatcher = new WebPushDispatcher({
    configuration,
    clients: subscriptions,
    online: () => online,
    resolve,
    transport,
    now: () => 1_000
  });
  return {
    dispatcher,
    transport,
    subscriptions,
    clients,
    projection,
    resolve,
    setOnline: (value: boolean) => {
      online = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    }
  };
}

describe('bounded Web Push fan-out', () => {
  it('returns independent multi-client outcomes and preserves accepted counts after a later recheck fails', async () => {
    const f = fixture();
    f.subscriptions.eligible
      .mockResolvedValueOnce(f.clients)
      .mockResolvedValueOnce(f.clients)
      .mockRejectedValueOnce(new Error('database temporarily unavailable'));
    const result = await f.dispatcher.dispatch(1, 'notice-1', allow);
    expect(result).toMatchObject({
      status: 'partial',
      eligible: 3,
      attempted: 2,
      accepted: 2,
      skipped: 1
    });
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(f.subscriptions.eligible).toHaveBeenCalledWith(1, '2');
  });

  it('distinguishes online suppression, global disabling, and no eligible clients', async () => {
    const online = fixture();
    online.setOnline(true);
    expect(await online.dispatcher.dispatch(1, 'notice-1', allow)).toMatchObject({
      status: 'suppressed',
      reason: 'WEB_PUSH_ONLINE'
    });
    const disabled = fixture();
    disabled.setEnabled(false);
    expect(await disabled.dispatcher.dispatch(1, 'notice-1', allow)).toMatchObject({
      status: 'skipped',
      reason: 'WEB_PUSH_DISABLED'
    });
    const empty = fixture();
    empty.clients.splice(0);
    expect(await empty.dispatcher.dispatch(1, 'notice-1', allow)).toMatchObject({
      status: 'skipped',
      reason: 'WEB_PUSH_NO_CLIENTS'
    });
  });

  it('separates definitive failures and uncertain transmissions in its device counts', async () => {
    const f = fixture();
    f.transport
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockRejectedValueOnce(new Error('transport lost'));
    expect(await f.dispatcher.dispatch(1, 'notice-1', allow)).toMatchObject({
      status: 'partial',
      eligible: 3,
      attempted: 3,
      accepted: 1,
      failed: 1,
      uncertain: 1,
      skipped: 0
    });
  });

  it('sends one notification to all independent clients and coalesces duplicate queued work', async () => {
    const f = fixture();
    f.clients[1]!.subscription.endpoint = 'https://uccm-intl.ucweb.com/wpush/m/fixture';
    f.clients[2]!.subscription.endpoint = 'https://push.example.test:8443/up/fixture';
    expect(f.dispatcher.enqueue(1, 'notice-1', allow)).toBe('queued');
    expect(f.dispatcher.enqueue(1, 'notice-1', allow)).toBe('duplicate');
    await f.dispatcher.flush();
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(
      f.transport.mock.calls.map(
        ([input]) => (input as { subscription: { endpoint: string } }).subscription.endpoint
      )
    ).toEqual(f.clients.map((row) => row.subscription.endpoint));
    const input = f.transport.mock.calls[0]![0] as { payload: string; ttl: number };
    const payload = JSON.parse(input.payload);
    expect(payload.data).toMatchObject({
      id: 'notice-1',
      account: 'alice',
      subscriptionId: '1',
      bindingVersion: 1
    });
    expect(input.ttl).toBe(59);
    expect(Buffer.byteLength(input.payload)).toBeLessThanOrEqual(3500);
  });

  it('suppresses every client when any workbench socket is online', async () => {
    const f = fixture();
    f.setOnline(true);
    expect(f.dispatcher.enqueue(1, 'notice-1', allow)).toBe('skipped_online');
    await f.dispatcher.flush();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('rechecks target authorization independently before each actual send', async () => {
    const f = fixture();
    const authorize = vi.fn(async () => true).mockResolvedValueOnce(false);
    f.dispatcher.enqueue(1, 'notice-1', authorize);
    await f.dispatcher.flush();
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(f.transport).toHaveBeenCalledTimes(2);
  });

  it('stops the remaining clients if the user comes online or the administrator disables Push', async () => {
    for (const stop of ['online', 'disabled']) {
      const f = fixture();
      f.transport.mockImplementation(async () => {
        if (stop === 'online') f.setOnline(true);
        else f.setEnabled(false);
        return { statusCode: 201 };
      });
      f.dispatcher.enqueue(1, 'notice-1', allow);
      await f.dispatcher.flush();
      expect(f.transport).toHaveBeenCalledOnce();
    }
  });

  it('continues after a client failure and only expires the failed version on 404 or 410', async () => {
    const f = fixture();
    f.transport.mockRejectedValueOnce({ statusCode: 410, body: 'never return vendor content' });
    f.dispatcher.enqueue(1, 'notice-1', allow);
    await f.dispatcher.flush();
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(f.subscriptions.expire).toHaveBeenCalledWith({
      subscriptionId: '1',
      bindingVersion: 1,
      endpoint: f.clients[0]!.subscription.endpoint
    });
  });

  it('does not send an expired, read or inaccessible projection', async () => {
    const f = fixture();
    f.projection.notification.read = true;
    f.dispatcher.enqueue(1, 'notice-1', allow);
    await f.dispatcher.flush();
    expect(f.transport).not.toHaveBeenCalled();
    f.projection.notification.read = false;
    f.projection.notification.expiresAt = 999;
    f.dispatcher.enqueue(1, 'notice-1', allow);
    await f.dispatcher.flush();
    expect(f.transport).not.toHaveBeenCalled();
    f.projection.notification.expiresAt = 60_000;
    f.resolve.mockResolvedValue(undefined);
    f.dispatcher.enqueue(1, 'notice-1', allow);
    await f.dispatcher.flush();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('does not send an old snapshot after the stored binding has rotated', async () => {
    const f = fixture();
    f.subscriptions.eligible
      .mockResolvedValueOnce(f.clients)
      .mockResolvedValue(f.clients.map((client) => ({ ...client, bindingVersion: 2 })));
    f.dispatcher.enqueue(1, 'notice-1', allow);
    await f.dispatcher.flush();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('continues fan-out when stale-subscription cleanup itself fails', async () => {
    const f = fixture();
    f.transport.mockRejectedValueOnce({ statusCode: 410 });
    f.subscriptions.expire.mockRejectedValueOnce(new Error('database unavailable'));
    f.dispatcher.enqueue(1, 'notice-1', allow);
    await f.dispatcher.flush();
    expect(f.transport).toHaveBeenCalledTimes(3);
  });

  it('times out and aborts each hung transport without retrying', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.transport.mockImplementation(() => new Promise(() => {}));
      f.dispatcher.enqueue(1, 'notice-1', allow);
      const flushed = f.dispatcher.flush();
      await vi.advanceTimersByTimeAsync(15_001);
      await flushed;
      expect(f.transport).toHaveBeenCalledTimes(3);
      expect(f.transport.mock.calls.every(([input]) => input.signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the entire pending set and discards queued work on shutdown', async () => {
    const f = fixture();
    for (let id = 0; id < 128; id++)
      expect(f.dispatcher.enqueue(1, String(id), allow)).toBe('queued');
    expect(f.dispatcher.enqueue(1, 'overflow', allow)).toBe('queue_full');
    f.dispatcher.close();
    await f.dispatcher.flush();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('bounds work, rejects new sends after close and never retries an uncertain transport', async () => {
    const f = fixture();
    f.transport.mockRejectedValue({ statusCode: 503 });
    f.dispatcher.enqueue(1, 'notice-1', allow);
    await f.dispatcher.flush();
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(f.subscriptions.expire).not.toHaveBeenCalled();
    f.dispatcher.close();
    expect(f.dispatcher.enqueue(1, 'notice-2', allow)).toBe('closed');
  });
});
