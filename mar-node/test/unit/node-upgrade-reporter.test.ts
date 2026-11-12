import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeUpgradeReporter } from '../../src/service/node-upgrade-reporter.js';

afterEach(() => vi.useRealTimers());

describe('Supervisor upgrade reporter', () => {
  it('coalesces steps while a request is in flight and never follows redirects', async () => {
    let finish!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const send = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first)
      .mockResolvedValue(new Response(JSON.stringify({ state: 'UPGRADING' }), { status: 200 }));
    const reporter = new NodeUpgradeReporter('https://server.test', 'node', 'private-token', send);
    try {
      reporter.update({ attemptId: 'a', step: 'CLOSING_NODE' });
      reporter.update({ attemptId: 'a', step: 'INSTALLING' });
      reporter.update({ attemptId: 'a', step: 'WAITING_FOR_ONLINE', result: 'INSTALLED' });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[1]?.redirect).toBe('manual');
      finish(new Response(null, { status: 302, headers: { location: 'https://other.test' } }));
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toMatchObject({
        step: 'WAITING_FOR_ONLINE'
      });
      expect(String(send.mock.calls[0]?.[0])).toBe(
        'https://server.test/api/nodes/node/upgrade/report'
      );
      expect(send.mock.calls[0]?.[1]?.headers).toMatchObject({
        authorization: 'Bearer private-token'
      });
    } finally {
      reporter.stop();
    }
  });

  it('accepts HTTP and maps WS/WSS origins while rejecting URL credentials and other protocols', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ state: 'UPGRADING' }), { status: 200 }));
    const origins = [
      ['http://server.test', 'http://server.test/api/nodes/node/upgrade/report'],
      ['ws://server.test', 'http://server.test/api/nodes/node/upgrade/report'],
      ['wss://server.test', 'https://server.test/api/nodes/node/upgrade/report']
    ] as const;
    let expectedCalls = 0;
    for (const [origin, expectedEndpoint] of origins) {
      const reporter = new NodeUpgradeReporter(origin, 'node', 'token', send);
      try {
        reporter.update({ attemptId: 'a', step: 'INSTALLING' });
        expectedCalls += 1;
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(expectedCalls));
        expect(String(send.mock.calls.at(-1)?.[0])).toBe(expectedEndpoint);
      } finally {
        reporter.stop();
      }
    }
    for (const invalidOrigin of ['https://user:password@server.test', 'ftp://server.test']) {
      expect(() => new NodeUpgradeReporter(invalidOrigin, 'node', 'token')).toThrow(
        'NODE_UPGRADE_REPORT_ORIGIN_INVALID'
      );
    }
  });

  it('stops after credential rejection', async () => {
    vi.useFakeTimers();
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const reporter = new NodeUpgradeReporter('http://server.test', 'node', 'token', send);
    reporter.update({ attemptId: 'a', step: 'INSTALLING' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(1);
    reporter.stop();
  });
});
