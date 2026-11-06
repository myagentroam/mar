import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPwaApplicationService } from '../../src/service/pwa-application-service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PWA application registration', () => {
  it('shares registration and returns an existing controller without waiting for installation', async () => {
    const worker = {} as ServiceWorker;
    const container = Object.assign(new EventTarget(), {
      controller: worker,
      register: vi.fn(() => new Promise<ServiceWorkerRegistration>(() => undefined))
    });
    const service = createPwaApplicationService(container as unknown as ServiceWorkerContainer);
    void service.start();
    void service.start();
    expect(container.register).toHaveBeenCalledOnce();
    await expect(service.activeWorker()).resolves.toBe(worker);
  });

  it('bounds the wait even when registration never finishes', async () => {
    vi.useFakeTimers();
    const container = Object.assign(new EventTarget(), {
      controller: null,
      register: vi.fn(() => new Promise<ServiceWorkerRegistration>(() => undefined))
    });
    const service = createPwaApplicationService(container as unknown as ServiceWorkerContainer);
    const result = service.activeWorker(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBeUndefined();
  });

  it('returns the controller when it arrives before the deadline', async () => {
    const container = Object.assign(new EventTarget(), {
      controller: null as ServiceWorker | null,
      register: vi.fn().mockResolvedValue(new EventTarget())
    });
    const service = createPwaApplicationService(container as unknown as ServiceWorkerContainer);
    const result = service.activeWorker();
    const worker = {} as ServiceWorker;
    container.controller = worker;
    container.dispatchEvent(new Event('controllerchange'));
    await expect(result).resolves.toBe(worker);
  });

  it('releases pending waits and does not restart after disposal', async () => {
    const container = Object.assign(new EventTarget(), {
      controller: null,
      register: vi.fn(() => new Promise<ServiceWorkerRegistration>(() => undefined))
    });
    const service = createPwaApplicationService(container as unknown as ServiceWorkerContainer);
    const result = service.activeWorker();
    service.dispose();
    await expect(result).resolves.toBeUndefined();
    await expect(service.start()).resolves.toBeUndefined();
    expect(container.register).toHaveBeenCalledOnce();
  });

  it('returns an existing active worker while a newer worker is still installing and the page is uncontrolled', async () => {
    const active = new EventTarget() as ServiceWorker;
    const installing = Object.assign(new EventTarget(), { state: 'installing' });
    const registration = Object.assign(new EventTarget(), { active, installing, waiting: null });
    const container = Object.assign(new EventTarget(), {
      controller: null,
      register: vi.fn().mockResolvedValue(registration)
    });
    const service = createPwaApplicationService(container as unknown as ServiceWorkerContainer);
    await expect(service.activeWorker()).resolves.toBe(active);
    expect(container.register).toHaveBeenCalledOnce();
    expect(installing.state).toBe('installing');
    service.dispose();
  });

  it('notices activation without requiring a controller change', async () => {
    const installing = new EventTarget();
    const registration = Object.assign(new EventTarget(), {
      active: null as ServiceWorker | null,
      installing,
      waiting: null
    });
    const container = Object.assign(new EventTarget(), {
      controller: null,
      register: vi.fn().mockResolvedValue(registration)
    });
    const service = createPwaApplicationService(container as unknown as ServiceWorkerContainer);
    const result = service.activeWorker();
    await vi.waitFor(() => expect(container.register).toHaveBeenCalledOnce());
    await Promise.resolve();
    registration.active = installing as ServiceWorker;
    installing.dispatchEvent(new Event('statechange'));
    await expect(result).resolves.toBe(installing);
    service.dispose();
  });
});

describe('PWA application update coordination', () => {
  function fixture(pageBuild = 'page', controlled = true, navigationType = 'navigate') {
    const reload = vi.fn();
    const window = Object.assign(new EventTarget(), { location: { reload } });
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('performance', {
      getEntriesByType: () => [{ type: navigationType }]
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('unexpected network version request'))
    );
    const makeWorker = (buildId: string, health = { degraded: false, entry: true }) =>
      Object.assign(new EventTarget(), {
        postMessage: vi.fn((data: { type: string }, ports: MessagePort[]) => {
          if (data.type === 'MAR_PWA_STATUS') {
            ports[0]!.postMessage({
              buildId,
              version: `version-${buildId}`,
              supported: true,
              ...health
            });
          }
        })
      });
    const active = makeWorker('active');
    const registration = Object.assign(new EventTarget(), {
      active: active as unknown as ServiceWorker | null,
      waiting: null as ServiceWorker | null,
      installing: null as ServiceWorker | null,
      update: vi.fn().mockResolvedValue(undefined)
    });
    const container = Object.assign(new EventTarget(), {
      controller: controlled ? (active as unknown as ServiceWorker) : null,
      register: vi.fn().mockResolvedValue(registration)
    });
    const service = createPwaApplicationService(container as unknown as ServiceWorkerContainer, {
      version: `version-${pageBuild}`,
      buildId: pageBuild
    });
    return { reload, makeWorker, active, registration, container, service };
  }

  it('recognizes a peer update before navigation but not the initial controller claim', async () => {
    const f = fixture('active', false);
    await f.service.start();
    expect(f.service.isReloadingForUpdate()).toBe(false);
    f.container.controller = f.active as unknown as ServiceWorker;
    f.container.dispatchEvent(new Event('controllerchange'));
    expect(f.service.isReloadingForUpdate()).toBe(false);
    f.container.controller = f.makeWorker('next') as unknown as ServiceWorker;
    expect(f.service.isReloadingForUpdate()).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('rechecks the current worker when its state changes', async () => {
    const f = fixture('active');
    const health = { degraded: false, entry: true };
    const active = f.makeWorker('active', health);
    f.registration.active = active as unknown as ServiceWorker;
    f.container.controller = active as unknown as ServiceWorker;

    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.offline).toBe('ready'));
    health.entry = false;
    active.dispatchEvent(new Event('statechange'));
    await vi.waitFor(() => expect(f.service.state.value.offline).toBe('degraded'));
    f.service.dispose();
  });

  it('releases redundant worker observers across successive registrations', async () => {
    const f = fixture('active');
    const activeAdd = vi.spyOn(f.active, 'addEventListener');
    const activeRemove = vi.spyOn(f.active, 'removeEventListener');
    const settleChecks = async () => {
      await f.service.checkForUpdate(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };
    const retire = async (
      worker: ReturnType<typeof f.makeWorker> & { state: string },
      add: ReturnType<typeof vi.spyOn>,
      remove: ReturnType<typeof vi.spyOn>
    ) => {
      await settleChecks();
      const checksBeforeRetirement = f.active.postMessage.mock.calls.length;
      worker.state = 'redundant';
      worker.dispatchEvent(new Event('statechange'));
      await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
      expect(remove).toHaveBeenCalledWith('statechange', add.mock.calls[0]![1]);
      await vi.waitFor(() =>
        expect(f.active.postMessage.mock.calls.length).toBeGreaterThan(checksBeforeRetirement)
      );
      await settleChecks();

      const checksAfterRetirement = f.active.postMessage.mock.calls.length;
      worker.dispatchEvent(new Event('statechange'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(f.active.postMessage).toHaveBeenCalledTimes(checksAfterRetirement);

      f.registration.dispatchEvent(new Event('updatefound'));
      await settleChecks();
    };

    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.checked).toBe(true));
    expect(activeAdd).toHaveBeenCalledOnce();

    const first = Object.assign(f.makeWorker('first'), { state: 'installing' });
    const firstAdd = vi.spyOn(first, 'addEventListener');
    const firstRemove = vi.spyOn(first, 'removeEventListener');
    f.registration.installing = first as unknown as ServiceWorker;
    f.registration.dispatchEvent(new Event('updatefound'));
    await vi.waitFor(() => expect(firstAdd).toHaveBeenCalledOnce());
    f.registration.dispatchEvent(new Event('updatefound'));
    expect(firstAdd).toHaveBeenCalledOnce();
    await retire(first, firstAdd, firstRemove);
    expect(firstAdd).toHaveBeenCalledOnce();

    const second = Object.assign(f.makeWorker('second'), { state: 'installing' });
    const secondAdd = vi.spyOn(second, 'addEventListener');
    const secondRemove = vi.spyOn(second, 'removeEventListener');
    f.registration.installing = second as unknown as ServiceWorker;
    f.registration.dispatchEvent(new Event('updatefound'));
    await vi.waitFor(() => expect(secondAdd).toHaveBeenCalledOnce());
    f.registration.dispatchEvent(new Event('updatefound'));
    expect(secondAdd).toHaveBeenCalledOnce();
    await retire(second, secondAdd, secondRemove);
    expect(secondAdd).toHaveBeenCalledOnce();

    const alreadyRedundant = Object.assign(f.makeWorker('already-redundant'), {
      state: 'redundant'
    });
    const alreadyRedundantAdd = vi.spyOn(alreadyRedundant, 'addEventListener');
    f.registration.installing = alreadyRedundant as unknown as ServiceWorker;
    f.registration.dispatchEvent(new Event('updatefound'));
    expect(alreadyRedundantAdd).not.toHaveBeenCalled();

    const remaining = f.makeWorker('remaining');
    const remainingAdd = vi.spyOn(remaining, 'addEventListener');
    const remainingRemove = vi.spyOn(remaining, 'removeEventListener');
    f.registration.waiting = remaining as unknown as ServiceWorker;
    f.registration.dispatchEvent(new Event('updatefound'));
    await vi.waitFor(() => expect(remainingAdd).toHaveBeenCalledOnce());
    f.registration.dispatchEvent(new Event('updatefound'));
    expect(remainingAdd).toHaveBeenCalledOnce();

    f.service.dispose();
    expect(activeRemove).toHaveBeenCalledOnce();
    expect(activeRemove).toHaveBeenCalledWith('statechange', activeAdd.mock.calls[0]![1]);
    expect(firstRemove).toHaveBeenCalledOnce();
    expect(secondRemove).toHaveBeenCalledOnce();
    expect(remainingRemove).toHaveBeenCalledOnce();
    expect(remainingRemove).toHaveBeenCalledWith('statechange', remainingAdd.mock.calls[0]![1]);
  });

  it('requires the matching actual controller before declaring this page offline ready', async () => {
    const f = fixture('active');
    f.container.controller = null;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.checked).toBe(true));
    expect(f.service.state.value.offline).toBe('preparing');
    f.container.controller = f.active as unknown as ServiceWorker;
    f.container.dispatchEvent(new Event('controllerchange'));
    await vi.waitFor(() => expect(f.service.state.value.offline).toBe('ready'));
    f.service.dispose();
  });

  it('shows unavailable shell resources when a check finds the controller entry missing', async () => {
    const f = fixture('active');
    const health = { degraded: false, entry: true };
    const active = f.makeWorker('active', health) as unknown as ServiceWorker;
    f.registration.active = active;
    f.container.controller = active;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.offline).toBe('ready'));
    health.entry = false;
    await f.service.checkForUpdate(false);
    expect(f.service.state.value.offline).toBe('degraded');
    f.service.dispose();
  });

  it('does not infer online-only mode when the first active worker status is unknown', async () => {
    vi.useFakeTimers();
    const f = fixture('active');
    f.active.postMessage.mockImplementation(() => undefined);
    const checked = expect(f.service.checkForUpdate(false)).rejects.toThrow(
      'Active worker unavailable'
    );
    await vi.advanceTimersByTimeAsync(3_001);
    await checked;
    expect(fetch).not.toHaveBeenCalled();
    expect(f.service.state.value.update).toBeUndefined();
    expect(f.service.state.value.offline).not.toBe('ready');
    f.service.dispose();
  });

  it('does not fall back to online refresh when registration hangs with an existing controller', async () => {
    vi.useFakeTimers();
    const f = fixture('active');
    f.container.register.mockImplementation(() => new Promise(() => undefined));
    const checked = expect(f.service.checkForUpdate(false)).rejects.toThrow(
      'Worker registration unavailable'
    );
    await vi.advanceTimersByTimeAsync(8_001);
    await checked;
    expect(fetch).not.toHaveBeenCalled();
    expect(f.service.state.value.update).toBeUndefined();
    f.service.dispose();
  });

  it('keeps online version checks when registration is explicitly rejected without a controller', async () => {
    const f = fixture('old');
    f.container.controller = null;
    f.container.register.mockRejectedValue(new DOMException('Disabled', 'SecurityError'));
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ version: '2', hash: 'new' })));
    await f.service.checkForUpdate(false);
    expect(f.service.state.value).toMatchObject({
      offline: 'online',
      update: { mode: 'online', buildId: 'new' }
    });
    expect(fetch).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('bounds the complete online version response, including a stalled body', async () => {
    vi.useFakeTimers();
    const fetchVersion = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => new Promise(() => undefined) });
    vi.stubGlobal('fetch', fetchVersion);
    const service = createPwaApplicationService(undefined, { version: '1', buildId: 'a' });
    const checked = expect(service.checkForUpdate()).rejects.toThrow('Web version unavailable');
    await vi.advanceTimersByTimeAsync(8_001);
    await checked;
    expect(fetchVersion.mock.calls[0]![1].signal.aborted).toBe(true);
    service.dispose();
  });

  it('compares online version and build identity and preserves the previous state on invalid responses', async () => {
    const fetchVersion = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '1', hash: 'old' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '1', hash: 'new' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '1' })))
      .mockResolvedValueOnce(new Response('null'));
    vi.stubGlobal('fetch', fetchVersion);
    const service = createPwaApplicationService(undefined, { version: '1', buildId: 'old' });
    await service.checkForUpdate(false);
    expect(service.state.value.update).toBeUndefined();
    await service.checkForUpdate(false);
    expect(service.state.value.update).toMatchObject({
      mode: 'online',
      buildId: 'new',
      version: '1'
    });
    await expect(service.checkForUpdate(false)).rejects.toThrow('Invalid web version');
    await expect(service.checkForUpdate(false)).rejects.toThrow('Invalid web version');
    expect(service.state.value.update?.buildId).toBe('new');
    service.dispose();
  });

  it('coalesces concurrent online update checks', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchVersion = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchVersion);
    const service = createPwaApplicationService(undefined, { version: '1', buildId: 'old' });
    const first = service.checkForUpdate();
    const second = service.checkForUpdate();
    await vi.waitFor(() => expect(fetchVersion).toHaveBeenCalledOnce());
    resolveFetch(new Response(JSON.stringify({ version: '1', hash: 'old' })));
    await Promise.all([first, second]);
    expect(fetchVersion).toHaveBeenCalledOnce();
    expect(service.state.value.update).toBeUndefined();
    service.dispose();
  });

  it('prioritizes a waiting target and never offers a downgrade to an older active worker', async () => {
    const f = fixture('waiting');
    const waiting = f.makeWorker('waiting');
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.checked).toBe(true));
    expect(f.service.state.value.update).toBeUndefined();
    expect(f.service.state.value.reload).toMatchObject({ action: 'activate', buildId: 'waiting' });
    expect(f.service.state.value.offline).toBe('preparing');
    expect(fetch).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it.each([
    { degraded: false, entry: false },
    { degraded: true, entry: true }
  ])('does not offer an unhealthy waiting target: %o', async (health) => {
    const f = fixture('waiting');
    f.registration.waiting = f.makeWorker('waiting', health) as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.checked).toBe(true));
    expect(f.service.state.value.update).toBeUndefined();
    expect(f.service.state.value.reload).toBeUndefined();
    await expect(f.service.checkForUpdate()).rejects.toThrow('Waiting worker not ready');
    expect(fetch).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it.each([
    { degraded: false, entry: false },
    { degraded: true, entry: true }
  ])('rechecks a published waiting target before applying: %o', async (unhealthy) => {
    const f = fixture('active');
    const health = { degraded: false, entry: true };
    const waiting = f.makeWorker('next', health);
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.update?.buildId).toBe('next'));
    Object.assign(health, unhealthy);
    await expect(f.service.applyUpdate()).resolves.toBe('UNAVAILABLE');
    expect(
      waiting.postMessage.mock.calls.every(([message]) => message.type !== 'MAR_PWA_APPLY')
    ).toBe(true);
    expect(f.service.state.value.update).toBeUndefined();
    expect(f.service.state.value.reload).toBeUndefined();
    expect(f.reload).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('offers only an explicit prepared-version reload when active differs without a waiting worker', async () => {
    const f = fixture('older-page');
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.checked).toBe(true));
    expect(f.service.state.value.update).toBeUndefined();
    expect(f.service.state.value.reload).toMatchObject({
      mode: 'worker',
      action: 'reload',
      buildId: 'active'
    });
    f.service.dispose();
  });

  it('does not activate after the application service is disposed', async () => {
    const f = fixture('active');
    const waiting = f.makeWorker('next');
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.update?.buildId).toBe('next'));
    f.service.dispose();
    await expect(f.service.applyUpdate()).resolves.toBe('UNAVAILABLE');
    expect(
      waiting.postMessage.mock.calls.every(([message]) => message.type !== 'MAR_PWA_APPLY')
    ).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('activates an already prepared update on browser reload and reloads once after takeover', async () => {
    const f = fixture('active', true, 'reload');
    const waiting = f.makeWorker('next');
    const status = waiting.postMessage.getMockImplementation()!;
    let reply: MessagePort | undefined;
    waiting.postMessage.mockImplementation((data, ports) => {
      if (data.type === 'MAR_PWA_APPLY') reply = ports[0];
      else status(data, ports);
    });
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() => expect(reply).toBeDefined());
    expect(f.reload).not.toHaveBeenCalled();
    const applying = f.service.applyUpdate();
    reply!.postMessage({ applied: true });
    f.registration.waiting = null;
    f.registration.active = waiting as unknown as ServiceWorker;
    f.container.controller = waiting as unknown as ServiceWorker;
    f.container.dispatchEvent(new Event('controllerchange'));
    await expect(applying).resolves.toBe('APPLIED');
    await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
    expect(
      waiting.postMessage.mock.calls.filter(([data]) => data.type === 'MAR_PWA_APPLY')
    ).toHaveLength(1);
    f.container.dispatchEvent(new Event('controllerchange'));
    await f.service.checkForUpdate(false);
    expect(f.reload).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('does not auto-activate an update that finishes downloading after reload startup', async () => {
    const f = fixture('active', true, 'reload');
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.checked).toBe(true));
    const waiting = f.makeWorker('next');
    f.registration.waiting = waiting as unknown as ServiceWorker;
    f.registration.dispatchEvent(new Event('updatefound'));
    await vi.waitFor(() => expect(f.service.state.value.update?.buildId).toBe('next'));
    expect(waiting.postMessage.mock.calls.some(([data]) => data.type === 'MAR_PWA_APPLY')).toBe(
      false
    );
    expect(f.reload).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('does not auto-activate a replacement for the worker waiting at reload startup', async () => {
    const f = fixture('active', true, 'reload');
    f.registration.waiting = f.makeWorker('first') as unknown as ServiceWorker;
    const replacement = f.makeWorker('replacement');
    f.registration.update.mockImplementation(async () => {
      f.registration.waiting = replacement as unknown as ServiceWorker;
    });
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.update?.buildId).toBe('replacement'));
    expect(replacement.postMessage.mock.calls.some(([data]) => data.type === 'MAR_PWA_APPLY')).toBe(
      false
    );
    expect(f.reload).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it.each([
    { degraded: false, entry: false },
    { degraded: true, entry: true }
  ])('does not auto-activate an unhealthy target on reload: %o', async (health) => {
    const f = fixture('active', true, 'reload');
    const waiting = f.makeWorker('next', health);
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await expect(f.service.checkForUpdate()).rejects.toThrow('Waiting worker not ready');
    expect(waiting.postMessage.mock.calls.some(([data]) => data.type === 'MAR_PWA_APPLY')).toBe(
      false
    );
    expect(f.reload).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('does not retry rejected automatic activation on visibility or network recovery', async () => {
    const f = fixture('active', true, 'reload');
    const waiting = f.makeWorker('next');
    const status = waiting.postMessage.getMockImplementation()!;
    waiting.postMessage.mockImplementation((data, ports) => {
      if (data.type === 'MAR_PWA_APPLY') ports[0]!.postMessage({ applied: false });
      else status(data, ports);
    });
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() =>
      expect(
        waiting.postMessage.mock.calls.filter(([data]) => data.type === 'MAR_PWA_APPLY')
      ).toHaveLength(1)
    );
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await f.service.checkForUpdate();
    expect(
      waiting.postMessage.mock.calls.filter(([data]) => data.type === 'MAR_PWA_APPLY')
    ).toHaveLength(1);
    expect(f.service.state.value.update?.buildId).toBe('next');
    expect(f.reload).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('leaves a prepared update waiting on ordinary navigation until clicked, then reloads once after takeover', async () => {
    const f = fixture('active');
    expect(f.service.isReloadingForUpdate()).toBe(false);
    f.reload.mockImplementation(() => expect(f.service.isReloadingForUpdate()).toBe(true));
    const waiting = f.makeWorker('next');
    const status = waiting.postMessage.getMockImplementation()!;
    let reply: MessagePort | undefined;
    waiting.postMessage.mockImplementation((data, ports) => {
      if (data.type === 'MAR_PWA_APPLY') reply = ports[0];
      else status(data, ports);
    });
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.update?.buildId).toBe('next'));
    expect(reply).toBeUndefined();
    expect(f.reload).not.toHaveBeenCalled();

    const applying = f.service.applyUpdate();
    await vi.waitFor(() => expect(reply).toBeDefined());
    reply!.postMessage({ applied: true });
    await Promise.resolve();
    expect(f.reload).not.toHaveBeenCalled();
    f.container.controller = waiting as unknown as ServiceWorker;
    f.container.dispatchEvent(new Event('controllerchange'));
    await expect(applying).resolves.toBe('APPLIED');
    expect(f.reload).toHaveBeenCalledOnce();
    f.container.dispatchEvent(new Event('controllerchange'));
    expect(f.reload).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('does not reload when the waiting worker rejects activation', async () => {
    const f = fixture('active');
    const waiting = f.makeWorker('next');
    const status = waiting.postMessage.getMockImplementation()!;
    waiting.postMessage.mockImplementation((data, ports) => {
      if (data.type === 'MAR_PWA_APPLY') ports[0]!.postMessage({ applied: false });
      else status(data, ports);
    });
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.update?.buildId).toBe('next'));
    await expect(f.service.applyUpdate()).resolves.toBe('UNAVAILABLE');
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.service.isReloadingForUpdate()).toBe(false);
    f.service.dispose();
  });

  it('clears a target rejected by the waiting worker after status', async () => {
    const f = fixture('active');
    const waiting = f.makeWorker('next');
    const status = waiting.postMessage.getMockImplementation()!;
    waiting.postMessage.mockImplementation((data, ports) => {
      if (data.type === 'MAR_PWA_APPLY')
        ports[0]!.postMessage({ applied: false, reason: 'UNAVAILABLE' });
      else status(data, ports);
    });
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.update?.buildId).toBe('next'));
    await expect(f.service.applyUpdate()).resolves.toBe('UNAVAILABLE');
    expect(f.service.state.value.update).toBeUndefined();
    expect(f.reload).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('does not reload after disposal while activation is pending', async () => {
    const f = fixture('active');
    const waiting = f.makeWorker('next');
    const status = waiting.postMessage.getMockImplementation()!;
    let reply: MessagePort | undefined;
    waiting.postMessage.mockImplementation((data, ports) => {
      if (data.type === 'MAR_PWA_APPLY') reply = ports[0];
      else status(data, ports);
    });
    f.registration.waiting = waiting as unknown as ServiceWorker;
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.update?.buildId).toBe('next'));
    const applying = f.service.applyUpdate();
    await vi.waitFor(() => expect(reply).toBeDefined());
    f.service.dispose();
    f.container.controller = waiting as unknown as ServiceWorker;
    f.container.dispatchEvent(new Event('controllerchange'));
    reply!.postMessage({ applied: true });
    await expect(applying).resolves.toBe('UNAVAILABLE');
    expect(f.reload).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('does not reload after disposal while the active worker status is pending', async () => {
    const f = fixture('older-page');
    await f.service.start();
    await vi.waitFor(() => expect(f.service.state.value.reload).toBeDefined());
    let reply: MessagePort | undefined;
    f.active.postMessage.mockImplementation((_data, ports) => {
      reply = ports[0];
    });
    const applying = f.service.applyUpdate();
    await vi.waitFor(() => expect(reply).toBeDefined());
    f.service.dispose();
    reply!.postMessage({
      buildId: 'active',
      version: 'version-active',
      supported: true,
      degraded: false,
      entry: true
    });
    await expect(applying).resolves.toBe('UNAVAILABLE');
    expect(f.reload).not.toHaveBeenCalled();
  });
});
