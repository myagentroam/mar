import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UserManagementPage from '../../../../ee/web/src/view/settings/UserManagementPage.vue?unit-render';
import { i18n } from '../../src/service/locale-preference-service.js';
import { showMessage } from '../../src/service/message-feedback-service.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

vi.mock('../../src/service/message-feedback-service.js', () => ({ showMessage: vi.fn() }));

const originalLocale = i18n.global.locale.value;
const views: ReturnType<typeof renderComponent>[] = [];

beforeEach(() => {
  i18n.global.locale.value = 'en-US';
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('window', {
    location: { search: '', href: 'https://console.example.test/console' },
    history: { replaceState: vi.fn() },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
});

afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  i18n.global.locale.value = originalLocale;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function mount(
  write: () => Promise<{ temporaryPassword: string }> = async () => ({
    temporaryPassword: 'fixture-password'
  }),
  validate: () => Promise<boolean> = async () => true
) {
  const request = vi.fn(async (_path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? write()
      : { users: [], page: 1, pageSize: 20, total: 0, hasMore: false }
  );
  const view = renderComponent(UserManagementPage, { request }, {}, { validate });
  views.push(view);
  await flushComponent();
  const action = (label: string) => {
    const node = view.findAll('ElButton').find((item) => textContent(item).trim() === label);
    expect(node).toBeDefined();
    return node!;
  };
  const open = () => trigger(action('Create user'), 'onClick');
  const submit = () => trigger(view.findAll('ElButton').at(-1)!, 'onClick');
  const input = (index: number, value: string) =>
    trigger(view.findAll('ElInput')[index]!, 'onUpdate:modelValue', value);
  const values = () => view.findAll('ElInput').map((item) => item.props['modelValue']);
  const writes = () => request.mock.calls.filter(([, init]) => init?.method === 'POST');
  return { view, request, action, open, submit, input, values, writes };
}

describe('Create user form lifecycle', () => {
  it.each(['footer', 'dialog'] as const)(
    'destroys the form and rebuilds an empty draft after %s cancellation',
    async (path) => {
      const fixture = await mount();
      await fixture.open();
      await fixture.input(0, 'discarded');
      await fixture.input(1, 'discarded@example.test');
      await fixture.input(2, 'Discarded nickname');
      if (path === 'footer') await trigger(fixture.action('Cancel'), 'onClick');
      else {
        const dialog = fixture.view.findAll('ElDialog')[0]!;
        await trigger(dialog, 'onClose');
        await trigger(dialog, 'onUpdate:modelValue', false);
      }
      expect(fixture.view.findAll('ElForm')).toHaveLength(0);
      await fixture.open();
      expect(fixture.values()).toEqual(['', '', '']);
      expect(fixture.writes()).toHaveLength(0);
    }
  );

  it.each(['invalid', 'rejected'] as const)(
    'requires successful Element Plus validation before writing when validation is %s',
    async (result) => {
      const validate = vi.fn(async () => {
        if (result === 'rejected') throw { username: [{ message: 'invalid' }] };
        return false;
      });
      const fixture = await mount(undefined, validate);
      await fixture.open();
      await fixture.input(0, 'not-enough-to-bypass-validation');
      await fixture.submit();
      expect(validate).toHaveBeenCalledOnce();
      expect(fixture.writes()).toHaveLength(0);
      expect(showMessage).not.toHaveBeenCalled();
    }
  );

  it('submits a trimmed snapshot once and preserves the temporary password and list refresh', async () => {
    const pending = deferred<{ temporaryPassword: string }>();
    const validate = vi.fn(async () => true);
    const fixture = await mount(() => pending.promise, validate);
    await fixture.open();
    await fixture.input(0, '  normal-user  ');
    await fixture.input(1, '  ');
    await fixture.input(2, '  Display name  ');
    const first = fixture.submit();
    await flushComponent();
    await fixture.submit();
    expect(validate).toHaveBeenCalledOnce();
    expect(fixture.writes()).toHaveLength(1);
    expect(JSON.parse(fixture.writes()[0]![1]!.body as string)).toEqual({
      username: 'normal-user',
      email: '',
      nickname: 'Display name'
    });
    pending.resolve({ temporaryPassword: 'only-issued-once' });
    await first;
    expect(fixture.view.findAll('ElForm')).toHaveLength(0);
    expect(textContent(fixture.view.root)).toContain('only-issued-once');
    expect(textContent(fixture.view.root)).toContain('normal-user');
    expect(fixture.request.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  });

  it('retains a failed draft and re-enables submitting it for correction and retry', async () => {
    const failure = new Error('USER_ALREADY_EXISTS');
    const write = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({
      temporaryPassword: 'retry-password'
    });
    const fixture = await mount(write);
    await fixture.open();
    await fixture.input(0, 'duplicate');
    await fixture.input(1, 'member@example.test');
    await fixture.submit();
    expect(fixture.values()).toEqual(['duplicate', 'member@example.test', '']);
    expect(showMessage).toHaveBeenCalledOnce();
    expect(showMessage).toHaveBeenCalledWith(expect.any(String), 'error', failure);
    await fixture.input(0, 'corrected');
    await fixture.submit();
    expect(fixture.writes()).toHaveLength(2);
    expect(textContent(fixture.view.root)).toContain('retry-password');
  });

  it('does not submit a closed form when validation finishes in the next opening', async () => {
    const pending = deferred<boolean>();
    const validate = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    const fixture = await mount(undefined, validate);
    await fixture.open();
    await fixture.input(0, 'old');
    const first = fixture.submit();
    await flushComponent();
    await trigger(fixture.action('Cancel'), 'onClick');
    await fixture.open();
    await fixture.input(0, 'new');
    pending.resolve(true);
    await first;
    expect(fixture.writes()).toHaveLength(0);
    expect(fixture.values()).toEqual(['new', '', '']);
    await fixture.submit();
    expect(fixture.writes()).toHaveLength(1);
  });

  it('keeps a late successful write receipt without closing or clearing the next draft', async () => {
    const pending = deferred<{ temporaryPassword: string }>();
    const fixture = await mount(() => pending.promise);
    await fixture.open();
    await fixture.input(0, 'submitted-user');
    const first = fixture.submit();
    await flushComponent();
    await trigger(fixture.action('Cancel'), 'onClick');
    await fixture.open();
    await fixture.input(0, 'next-user');
    pending.resolve({ temporaryPassword: 'submitted-user-password' });
    await first;
    expect(fixture.values()).toEqual(['next-user', '', '']);
    expect(textContent(fixture.view.root)).toContain('submitted-user-password');
    expect(fixture.request.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  });

  it('isolates a late failure and its finally block from a new pending submission', async () => {
    const old = deferred<{ temporaryPassword: string }>();
    const current = deferred<{ temporaryPassword: string }>();
    const write = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const fixture = await mount(write);
    await fixture.open();
    await fixture.input(0, 'old');
    const first = fixture.submit();
    await flushComponent();
    await trigger(fixture.action('Cancel'), 'onClick');
    await fixture.open();
    await fixture.input(0, 'current');
    const second = fixture.submit();
    await flushComponent();
    old.reject(new Error('stale failure'));
    await first;
    expect(showMessage).not.toHaveBeenCalled();
    expect(fixture.values()).toEqual(['current', '', '']);
    expect(fixture.view.findAll('ElButton').at(-1)!.props['loading']).toBe(true);
    await fixture.submit();
    expect(fixture.writes()).toHaveLength(2);
    current.resolve({ temporaryPassword: 'current-password' });
    await second;
  });

  it.each(['old-first', 'new-first'] as const)(
    'keeps both one-time receipts when cancelled and current writes succeed %s',
    async (order) => {
      const old = deferred<{ temporaryPassword: string }>();
      const current = deferred<{ temporaryPassword: string }>();
      let count = 0;
      const fixture = await mount(() => (++count === 1 ? old.promise : current.promise));
      await fixture.open();
      await fixture.input(0, 'old');
      const first = fixture.submit();
      await flushComponent();
      await trigger(fixture.action('Cancel'), 'onClick');
      await fixture.open();
      await fixture.input(0, 'current');
      const second = fixture.submit();
      await flushComponent();
      const results = order === 'old-first' ? [old, current] : [current, old];
      const completions = order === 'old-first' ? [first, second] : [second, first];
      results[0]!.resolve({ temporaryPassword: 'first-receipt-password' });
      await completions[0];
      results[1]!.resolve({ temporaryPassword: 'second-receipt-password' });
      await completions[1];
      expect(textContent(fixture.view.root)).toContain('first-receipt-password');
      expect(textContent(fixture.view.root)).not.toContain('second-receipt-password');
      const receipt = fixture.view
        .findAll('ElDialog')
        .find((node) => node.props['title'] === 'User Created');
      expect(receipt).toBeDefined();
      await trigger(receipt!, 'onClose');
      expect(textContent(fixture.view.root)).toContain('second-receipt-password');
    }
  );

  it.each(['success', 'failure'] as const)(
    'ignores a late %s after the page unmounts',
    async (outcome) => {
      const pending = deferred<{ temporaryPassword: string }>();
      const fixture = await mount(() => pending.promise);
      await fixture.open();
      await fixture.input(0, 'old-page');
      const first = fixture.submit();
      await flushComponent();
      fixture.view.unmount();
      views.splice(views.indexOf(fixture.view), 1);
      if (outcome === 'success') pending.resolve({ temporaryPassword: 'old-password' });
      else pending.reject(new Error('old-page failure'));
      await first;
      expect(fixture.request).toHaveBeenCalledTimes(2);
      expect(showMessage).not.toHaveBeenCalled();
    }
  );
});
