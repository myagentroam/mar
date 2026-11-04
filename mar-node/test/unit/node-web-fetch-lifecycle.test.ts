import { describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { WebFetchService } from '../../src/service/web-fetch-service.js';

describe('shared web browser lifecycle', () => {
  it('waits for a cancelled late browser launch and closes the resulting browser', async () => {
    let start!: (browser: Browser) => void;
    const launch = new Promise<Browser>((resolve) => {
      start = resolve;
    });
    const browser = {
      on: vi.fn(),
      isConnected: () => true,
      close: vi.fn(async () => undefined)
    } as unknown as Browser;
    const launchBrowser = vi.fn(() => launch);
    const service = new WebFetchService({ launchBrowser });
    const controller = new AbortController();
    const request = service.fetch(
      { url: 'https://example.test/', mode: 'browser' },
      controller.signal
    );
    const failure = expect(request).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_CANCELLED'
    });
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledOnce());
    controller.abort();
    await failure;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    start(browser);
    await closing;
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('waits for a cancelled late context and its asynchronous close', async () => {
    let create!: (context: never) => void;
    const contextGate = new Promise<never>((resolve) => {
      create = resolve;
    });
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const context = { close: vi.fn(() => closeGate) };
    const browser = {
      on: vi.fn(),
      isConnected: () => true,
      newContext: vi.fn(() => contextGate),
      close: vi.fn(async () => undefined)
    } as unknown as Browser;
    const service = new WebFetchService({ launchBrowser: vi.fn(async () => browser) as never });
    const controller = new AbortController();
    const request = service.fetch(
      { url: 'https://example.test/', mode: 'browser' },
      controller.signal
    );
    const failure = expect(request).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_CANCELLED'
    });
    await vi.waitFor(() => expect(browser.newContext).toHaveBeenCalledOnce());
    controller.abort();
    await failure;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    create(context as never);
    await vi.waitFor(() => expect(context.close).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    finishClose();
    await closing;
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('waits for idle browser closure and does not launch during the handoff', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => gate);
    const browser = {
      on: vi.fn(),
      isConnected: () => true,
      newContext: vi.fn(async () => {
        throw new Error('fixture');
      }),
      close
    } as unknown as Browser;
    const launchBrowser = vi.fn(async () => browser);
    const service = new WebFetchService({ launchBrowser });
    const input = { url: 'https://example.test/', mode: 'browser' as const };
    try {
      await expect(service.fetch(input, new AbortController().signal)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(close).toHaveBeenCalledTimes(1);
      const next = service.fetch(input, new AbortController().signal);
      const nextFailure = expect(next).rejects.toMatchObject({
        code: 'MAR_AGENT_WEB_FETCH_CANCELLED'
      });
      let closed = false;
      const closing = service.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(launchBrowser).toHaveBeenCalledTimes(1);
      release();
      await nextFailure;
      await closing;
      expect(closed).toBe(true);
    } finally {
      release();
      await service.close();
      vi.useRealTimers();
    }
  });

  it('drains an expired browser without cancelling active work and shares the next launch', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
    let finishContext!: () => void;
    const contextGate = new Promise<never>((_resolve, reject) => {
      finishContext = () => reject(new Error('fixture finished'));
    });
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const firstBrowser = {
      on: vi.fn(),
      isConnected: () => true,
      newContext: vi.fn(() => contextGate),
      close: vi.fn(() => closeGate)
    } as unknown as Browser;
    const nextBrowser = {
      on: vi.fn(),
      isConnected: () => true,
      newContext: vi.fn(async () => {
        throw new Error('fixture');
      }),
      close: vi.fn(async () => undefined)
    } as unknown as Browser;
    const launchBrowser = vi
      .fn()
      .mockResolvedValueOnce(firstBrowser)
      .mockResolvedValue(nextBrowser);
    const service = new WebFetchService({ launchBrowser });
    const input = { url: 'https://example.test/', mode: 'browser' as const };
    try {
      const active = service.fetch(input, new AbortController().signal);
      const activeFailure = expect(active).rejects.toMatchObject({
        code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED'
      });
      await vi.waitFor(() => expect(firstBrowser.newContext).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const queued = service.fetch(input, new AbortController().signal);
      const queuedFailure = expect(queued).rejects.toMatchObject({
        code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED'
      });
      expect(firstBrowser.close).not.toHaveBeenCalled();
      finishContext();
      await activeFailure;
      expect(firstBrowser.close).toHaveBeenCalledOnce();
      const requests = Array.from({ length: 4 }, () =>
        service.fetch(input, new AbortController().signal)
      );
      const results = Promise.all(requests.map((request) => expect(request).rejects.toThrow()));
      expect(launchBrowser).toHaveBeenCalledTimes(1);
      finishClose();
      await queuedFailure;
      await results;
      expect(launchBrowser).toHaveBeenCalledTimes(2);
      expect(nextBrowser.newContext).toHaveBeenCalledTimes(5);
    } finally {
      finishContext();
      finishClose();
      await service.close();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('waits for an age-retired browser to finish closing on service shutdown', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
    let finishContext!: () => void;
    let finishClose!: () => void;
    const browser = {
      on: vi.fn(),
      isConnected: () => true,
      newContext: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            finishContext = () => reject(new Error('context failed'));
          })
      ),
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          })
      )
    } as unknown as Browser;
    const service = new WebFetchService({ launchBrowser: async () => browser });
    try {
      const active = service.fetch(
        { url: 'https://example.test', mode: 'browser' },
        new AbortController().signal
      );
      const failed = expect(active).rejects.toBeDefined();
      await vi.waitFor(() => expect(finishContext).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      finishContext();
      await failed;
      expect(browser.close).toHaveBeenCalledOnce();
      let closed = false;
      const closing = service.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      finishClose();
      await closing;
      expect(closed).toBe(true);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
