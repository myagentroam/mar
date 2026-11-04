import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import { WebFetchService } from '../../src/service/web-fetch-service.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const finish: Array<() => void> = [];
  const newContext = vi.fn(
    () =>
      new Promise<BrowserContext>((_resolve, reject) => {
        finish.push(() => reject(new Error('fixture context failure')));
      })
  );
  const browser = {
    on: vi.fn(),
    isConnected: () => true,
    newContext,
    close: vi.fn(async () => undefined)
  } as unknown as Browser;
  const launchBrowser = vi.fn(async () => browser);
  const service = new WebFetchService({ launchBrowser });
  const request = (allowUntrustedTls = true, signal = new AbortController().signal) =>
    service
      .fetch({ url: 'https://example.test/', mode: 'browser' }, signal, { allowUntrustedTls })
      .catch((error: unknown) => error);
  const result = { service, finish, newContext, launchBrowser, request };
  cleanups.push(async () => {
    const closing = service.close();
    finish.forEach((release) => release());
    await closing;
  });
  return result;
}

describe('web fetch admission queue', () => {
  it('admits waiting reads in FIFO order without allowing new arrivals to bypass them', async () => {
    const current = fixture();
    const active = Array.from({ length: 4 }, () => current.request());
    await vi.waitFor(() => expect(current.newContext).toHaveBeenCalledTimes(4));
    const first = current.request(false);
    const second = current.request(true);
    current.finish[0]!();
    const last = current.request(false);
    await active[0];
    await vi.waitFor(() => expect(current.newContext).toHaveBeenCalledTimes(5));
    expect(current.newContext.mock.calls[4]).toEqual([
      expect.objectContaining({ ignoreHTTPSErrors: false })
    ]);
    current.finish[4]!();
    await first;
    await vi.waitFor(() => expect(current.newContext).toHaveBeenCalledTimes(6));
    expect(current.newContext.mock.calls[5]).toEqual([
      expect.objectContaining({ ignoreHTTPSErrors: true })
    ]);
    current.finish[5]!();
    await second;
    await vi.waitFor(() => expect(current.newContext).toHaveBeenCalledTimes(7));
    expect(current.newContext.mock.calls[6]).toEqual([
      expect.objectContaining({ ignoreHTTPSErrors: false })
    ]);
    current.finish[6]!();
    await last;
    expect(current.launchBrowser).toHaveBeenCalledOnce();
  });

  it.each(['cancellation', 'timeout'] as const)(
    'removes a waiting read on %s without consuming capacity',
    async (reason) => {
      const deadlines: AbortController[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
        const deadline = new AbortController();
        deadlines.push(deadline);
        return deadline.signal;
      });
      const current = fixture();
      const active = Array.from({ length: 4 }, () => current.request());
      await vi.waitFor(() => expect(current.newContext).toHaveBeenCalledTimes(4));
      const controller = new AbortController();
      const removed = current.request(false, controller.signal);
      const next = current.request(true);
      if (reason === 'timeout') deadlines[4]!.abort();
      else controller.abort();
      await expect(removed).resolves.toMatchObject({
        code: reason === 'timeout' ? 'MAR_AGENT_WEB_FETCH_TIMEOUT' : 'MAR_AGENT_WEB_FETCH_CANCELLED'
      });
      expect(current.newContext).toHaveBeenCalledTimes(4);
      current.finish[0]!();
      await active[0];
      await vi.waitFor(() => expect(current.newContext).toHaveBeenCalledTimes(5));
      expect(current.newContext.mock.calls[4]).toEqual([
        expect.objectContaining({ ignoreHTTPSErrors: true })
      ]);
      current.finish[4]!();
      await next;
      expect(current.newContext).toHaveBeenCalledTimes(5);
    }
  );

  it('keeps the original thirty-second deadline after a queued read is admitted', async () => {
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
    const current = fixture();
    const active = Array.from({ length: 4 }, () => current.request());
    await vi.waitFor(() => expect(current.newContext).toHaveBeenCalledTimes(4));
    const queued = current.request();
    current.finish[0]!();
    await active[0];
    await vi.waitFor(() => expect(current.newContext).toHaveBeenCalledTimes(5));
    deadlines[4]!.abort();
    await expect(queued).resolves.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_TIMEOUT' });
    expect(timeout).toHaveBeenCalledTimes(5);
    expect(timeout.mock.calls.every(([milliseconds]) => milliseconds === 30_000)).toBe(true);
  });

  it('cancels active and queued reads on shutdown without starting waiting contexts', async () => {
    const current = fixture();
    const requests = Array.from({ length: 6 }, () => current.request());
    await vi.waitFor(() => expect(current.newContext).toHaveBeenCalledTimes(4));
    const closing = current.service.close();
    for (const request of requests)
      await expect(request).resolves.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_CANCELLED' });
    current.finish.forEach((finish) => finish());
    await closing;
    expect(current.newContext).toHaveBeenCalledTimes(4);
    await expect(current.request()).resolves.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_CANCELLED'
    });
    expect(current.launchBrowser).toHaveBeenCalledOnce();
  });
});
