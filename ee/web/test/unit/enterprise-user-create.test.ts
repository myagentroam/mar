import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnterpriseManagementComposition } from '../../src/composition/enterprise-management.js';
import { i18n } from '../../../../packages/web-core/src/service/locale-preference-service.js';
import { showMessage } from '../../../../packages/web-core/src/service/message-feedback-service.js';
import type { ManagementPageContext } from '../../../../packages/web-core/src/service/management-composition.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger,
  type TestElement
} from '../../../../packages/web-core/test/unit/support/component-renderer.js';

// @test-covers ee/web/src/composition/enterprise-management.ts
// @test-covers ee/web/src/view/settings/EnterpriseUserManagementPage.vue
// Preserve the registered loader and real page; only select the renderer compilation mode.
vi.mock(
  '../../src/view/settings/EnterpriseUserManagementPage.vue',
  async () => import('../../src/view/settings/EnterpriseUserManagementPage.vue?unit-render')
);
vi.mock(
  '@myagentroam/web-core/LoadingPanel.vue',
  async () => import('../../../../packages/web-core/src/view/common/LoadingPanel.vue?unit-render')
);
vi.mock('../../../../packages/web-core/src/service/message-feedback-service.js', () => ({
  showMessage: vi.fn()
}));

const originalLocale = i18n.global.locale.value;
const views: ReturnType<typeof renderComponent>[] = [];
type CreatedUser = { user: { username: string }; temporaryPassword: string };
const created = (username: string, password: string): CreatedUser => ({
  user: { username },
  temporaryPassword: password
});

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
function inForm(node: TestElement): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.type === 'ElForm') return true;
  return false;
}
async function mount(
  write: () => Promise<CreatedUser> = async () => created('returned-user', 'fixture-password'),
  validate: () => Promise<boolean> = async () => true
) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/organizations')
      return {
        organizations: [
          { id: 1, name: 'Root', parentOrganizationId: null },
          { id: 2, name: 'Team', parentOrganizationId: 1 }
        ]
      };
    if (path === '/api/enterprise/users' && init?.method === 'POST') return write();
    if (path.startsWith('/api/enterprise/users?'))
      return { users: [], page: 1, pageSize: 20, total: 0, hasMore: false };
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  const context: ManagementPageContext = {
    admin: {
      authenticated: true,
      mustChangePassword: false,
      edition: 'ENTERPRISE',
      role: 'ADMIN',
      isAdmin: true,
      managementWritable: true
    },
    request: request as ManagementPageContext['request'],
    nodes: [],
    onlineNodeCount: 0,
    serverVersion: undefined
  };
  const composition = createEnterpriseManagementComposition();
  expect(composition.items(context.admin).some((item) => item.id === 'users')).toBe(true);
  const page = composition.resolve('users', context.admin);
  expect(page.id).toBe('users');
  const view = renderComponent(page.component, page.props(context), {}, { validate });
  views.push(view);
  await vi.waitFor(
    () =>
      expect(
        view.findAll('ElButton').some((item) => textContent(item).trim() === 'Create user')
      ).toBe(true),
    { timeout: 5000 }
  );
  await flushComponent();
  const actions = (label: string) =>
    view.findAll('ElButton').filter((item) => textContent(item).trim() === label);
  const action = (label: string) => {
    expect(actions(label).length).toBeGreaterThan(0);
    return actions(label).at(-1)!;
  };
  const inputs = () => view.findAll('ElInput').filter(inForm);
  const open = () => trigger(actions('Create user')[0]!, 'onClick');
  const submit = () => trigger(action('Create user'), 'onClick');
  const input = (index: number, value: string) =>
    trigger(inputs()[index]!, 'onUpdate:modelValue', value);
  const values = () => inputs().map((item) => item.props['modelValue']);
  const writes = () => request.mock.calls.filter(([, init]) => init?.method === 'POST');
  const reads = () =>
    request.mock.calls.filter(([path]) => path.startsWith('/api/enterprise/users?'));
  return { view, request, action, open, submit, input, values, writes, reads };
}

describe('Registered enterprise users creation lifecycle', () => {
  it.each(['footer', 'dialog'] as const)(
    'reopens an empty form after %s cancellation',
    async (path) => {
      const fixture = await mount();
      await fixture.open();
      await fixture.input(0, 'discarded');
      await fixture.input(1, 'discarded@example.test');
      await fixture.input(2, 'Discarded nickname');
      if (path === 'footer') await trigger(fixture.action('Cancel'), 'onClick');
      else await trigger(fixture.view.findAll('ElDialog')[0]!, 'onUpdate:modelValue', false);
      expect(fixture.view.findAll('ElForm')).toHaveLength(0);
      await fixture.open();
      expect(fixture.values()).toEqual(['', '', '']);
      expect(fixture.writes()).toHaveLength(0);
    }
  );

  it.each(['invalid', 'rejected'] as const)(
    'requires successful field validation when %s',
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

  it('keeps existing optional-field, role and scalar-organization semantics and delivers the response identity', async () => {
    const fixture = await mount();
    await fixture.open();
    await fixture.input(0, 'requested-user');
    await fixture.input(2, 'Display name');
    await trigger(
      fixture.view.findAll('ElSelect').filter(inForm)[0]!,
      'onUpdate:modelValue',
      'ORG_ADMIN'
    );
    await trigger(fixture.view.findAll('el-cascader').filter(inForm)[0]!, 'onUpdate:modelValue', 2);
    await fixture.submit();
    expect(JSON.parse(fixture.writes()[0]![1]!.body as string)).toEqual({
      username: 'requested-user',
      nickname: 'Display name',
      role: 'ORG_ADMIN',
      organizationId: 2
    });
    expect(fixture.view.findAll('ElForm')).toHaveLength(0);
    expect(textContent(fixture.view.root)).toContain('returned-user');
    expect(textContent(fixture.view.root)).toContain('fixture-password');
    expect(fixture.reads()).toHaveLength(2);
  });

  it('submits once while validation and the write are pending', async () => {
    const pending = deferred<CreatedUser>();
    const validate = vi.fn(async () => true);
    const fixture = await mount(() => pending.promise, validate);
    await fixture.open();
    await fixture.input(0, 'once');
    const first = fixture.submit();
    await flushComponent();
    const second = fixture.submit();
    await flushComponent();
    const count = fixture.writes().length;
    pending.resolve(created('once', 'once-password'));
    await Promise.all([first, second]);
    expect(count).toBe(1);
    expect(validate).toHaveBeenCalledOnce();
  });

  it('preserves a failed draft for correction and retry', async () => {
    const failure = new Error('USER_ALREADY_EXISTS');
    const write = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(created('corrected', 'retry-password'));
    const fixture = await mount(write);
    await fixture.open();
    await fixture.input(0, 'duplicate');
    await fixture.input(1, 'member@example.test');
    await fixture.submit();
    expect(fixture.values()).toEqual(['duplicate', 'member@example.test', '']);
    expect(showMessage).toHaveBeenCalledWith(expect.any(String), 'error', failure);
    await fixture.input(0, 'corrected');
    await fixture.submit();
    expect(fixture.writes()).toHaveLength(2);
    expect(textContent(fixture.view.root)).toContain('retry-password');
  });

  it('does not submit the new draft when an old validation finishes', async () => {
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

  it('delivers late success credentials and refreshes without closing the next draft', async () => {
    const pending = deferred<CreatedUser>();
    const fixture = await mount(() => pending.promise);
    await fixture.open();
    await fixture.input(0, 'submitted-user');
    const first = fixture.submit();
    await flushComponent();
    await trigger(fixture.action('Cancel'), 'onClick');
    await fixture.open();
    await fixture.input(0, 'next-user');
    pending.resolve(created('submitted-user', 'submitted-user-password'));
    await first;
    expect(fixture.values()).toEqual(['next-user', '', '']);
    expect(textContent(fixture.view.root)).toContain('submitted-user-password');
    expect(fixture.reads()).toHaveLength(2);
  });

  it('isolates old failure feedback and finally from the next pending write', async () => {
    const old = deferred<CreatedUser>();
    const current = deferred<CreatedUser>();
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
    expect(fixture.action('Create user').props['loading']).toBe(true);
    await fixture.submit();
    expect(fixture.writes()).toHaveLength(2);
    current.resolve(created('current', 'current-password'));
    await second;
  });

  it.each(['old-first', 'new-first'] as const)(
    'preserves both successful receipts arriving %s',
    async (order) => {
      const old = deferred<CreatedUser>();
      const current = deferred<CreatedUser>();
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
      results[0]!.resolve(created('first-user', 'first-receipt-password'));
      await completions[0];
      results[1]!.resolve(created('second-user', 'second-receipt-password'));
      await completions[1];
      expect(textContent(fixture.view.root)).toContain('first-receipt-password');
      expect(textContent(fixture.view.root)).not.toContain('second-receipt-password');
      await trigger(fixture.action('Done'), 'onClick');
      expect(textContent(fixture.view.root)).toContain('second-receipt-password');
    }
  );

  it.each(['success', 'failure'] as const)('ignores a late %s after unmount', async (outcome) => {
    const pending = deferred<CreatedUser>();
    const fixture = await mount(() => pending.promise);
    await fixture.open();
    await fixture.input(0, 'old-page');
    const first = fixture.submit();
    await flushComponent();
    const calls = fixture.request.mock.calls.length;
    fixture.view.unmount();
    views.splice(views.indexOf(fixture.view), 1);
    if (outcome === 'success') pending.resolve(created('old-page', 'old-password'));
    else pending.reject(new Error('old-page failure'));
    await first;
    expect(fixture.request).toHaveBeenCalledTimes(calls);
    expect(showMessage).not.toHaveBeenCalled();
  });
});
