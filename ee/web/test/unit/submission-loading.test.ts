import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SecretManager from '../../../../packages/web-core/src/view/settings/EnvironmentSecretManager.vue?unit-render';
import ScheduleDialog from '../../../../packages/web-core/src/view/workspace/SessionScheduleDialog.vue?unit-render';
import OrganizationPage from '../../src/view/settings/OrganizationManagementPage.vue?unit-render';
import EnterpriseSettings from '../../src/view/settings/SettingsContent.vue?unit-render';
import {
  i18n,
  translate
} from '../../../../packages/web-core/src/service/locale-preference-service.js';
import { showMessage } from '../../../../packages/web-core/src/service/message-feedback-service.js';
import { ElMessageBox } from '../../../../packages/web-core/src/service/message-box-service.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from '../../../../packages/web-core/test/unit/support/component-renderer.js';

vi.mock('../../../../packages/web-core/src/service/message-feedback-service.js', () => ({
  showMessage: vi.fn()
}));

const originalLocale = i18n.global.locale.value;
beforeEach(() => {
  i18n.global.locale.value = 'en-US';
  vi.stubGlobal('__MAR_WEB_VERSION__', 'test');
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute() {},
      removeAttribute() {},
      classList: { add() {}, remove() {} },
      style: { setProperty() {}, removeProperty() {} }
    }
  });
  vi.stubGlobal('window', {
    location: { search: '', href: 'https://fixture.test/console', origin: 'https://fixture.test' },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never);
});
afterEach(() => {
  i18n.global.locale.value = originalLocale;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(showMessage).mockClear();
});

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function button(view: ReturnType<typeof renderComponent>, label: string) {
  const found = view
    .findAll('ElButton')
    .find((node) => textContent(node).trim() === label || node.props['aria-label'] === label);
  expect(found, label).toBeDefined();
  return found!;
}
function clickPending(view: ReturnType<typeof renderComponent>, label: string) {
  return (button(view, label).props.onClick as () => Promise<void>)();
}

describe('submission and authoritative reread loading', () => {
  it.each([
    ['PERSONAL', 'success'],
    ['NODE', 'success'],
    ['PERSONAL', 'failure'],
    ['NODE', 'failure'],
    ['PERSONAL', 'read-failure'],
    ['NODE', 'read-failure']
  ] as const)('separates %s secret submission from list loading (%s)', async (scope, outcome) => {
    const write = deferred();
    const read = deferred();
    const result = { secrets: [], page: 1, pageSize: 20, total: 0, hasMore: false };
    const request = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementation((_path: string, init?: RequestInit) =>
        init?.method === 'POST' ? write.promise : read.promise
      );
    const view = renderComponent(SecretManager, {
      request,
      scopes: [scope],
      writable: true,
      ...(scope === 'NODE' ? { nodeId: 'node' } : {})
    });
    try {
      await flushComponent();
      await trigger(
        button(view, translate('generated.environmentSecretManager.addSecret')),
        'onClick'
      );
      const submission = clickPending(view, 'Save');
      await flushComponent();
      expect(button(view, 'Save').props.loading).toBe(true);
      expect(button(view, 'Cancel').props.disabled).toBe(true);
      expect(view.findAll('ElForm')[0]!.props.disabled).toBe(true);
      expect(
        view
          .findAll('section')
          .find((node) => String(node.props.class).includes('page-loading-panel'))!.props[
          'aria-busy'
        ]
      ).toBe(false);
      const close = vi.fn();
      (view.findAll('ElDialog')[0]!.props['before-close'] as (done: () => void) => void)(close);
      expect(close).not.toHaveBeenCalled();
      await clickPending(view, 'Save');
      expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      if (outcome === 'failure') {
        write.reject(new Error('Write failed'));
        await submission;
        await flushComponent();
        expect(button(view, 'Save').props.loading).toBe(false);
        expect(view.findAll('ElForm')[0]!.props.disabled).toBe(false);
        expect(request).toHaveBeenCalledTimes(2);
      } else {
        write.resolve({});
        await flushComponent();
        expect(view.findAll('ElForm')).toHaveLength(0);
        expect(request).toHaveBeenCalledTimes(3);
        expect(
          view
            .findAll('section')
            .find((node) => String(node.props.class).includes('page-loading-panel'))!.props[
            'aria-busy'
          ]
        ).toBe(true);
        expect(
          button(view, translate('generated.environmentSecretManager.addSecret')).props.disabled
        ).toBe(true);
        if (outcome === 'read-failure') read.reject(new Error('Read failed'));
        else read.resolve(result);
        await submission;
        await flushComponent();
        expect(
          button(view, translate('generated.environmentSecretManager.addSecret')).props.disabled
        ).toBe(false);
      }
      expect(vi.mocked(showMessage).mock.calls.filter(([, type]) => type === 'error')).toHaveLength(
        outcome === 'success' ? 0 : 1
      );
      if (scope === 'PERSONAL' && outcome === 'read-failure') {
        expect(
          view
            .findAll('button')
            .some((node) => textContent(node).includes(translate('common.loadFailedRetry')))
        ).toBe(false);
      }
    } finally {
      view.unmount();
    }
  });

  it.each([
    ['create', true],
    ['edit', true],
    ['create', false],
    ['edit', false]
  ] as const)('locks organization %s until the write ends (success=%s)', async (mode, success) => {
    const write = deferred();
    const read = deferred();
    const result = { organizations: [{ id: 1, name: 'Root', parentOrganizationId: null }] };
    const request = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementation((_path: string, init?: RequestInit) =>
        init?.method ? write.promise : read.promise
      );
    const view = renderComponent(OrganizationPage, { request, writable: true });
    try {
      await flushComponent();
      const openLabel = translate(
        mode === 'create'
          ? 'generated.organizationUserManagementPage.addChild'
          : 'generated.organizationUserManagementPage.edit'
      );
      // Row actions are rendered through the public table slot.
      const rowButton = view
        .findAll('ElButton')
        .find((node) => textContent(node).trim() === openLabel);
      expect(rowButton).toBeDefined();
      await trigger(rowButton!, 'onClick', { stopPropagation() {} });
      const saveLabel = translate(
        mode === 'create'
          ? 'generated.organizationUserManagementPage.createOrganization2'
          : 'generated.organizationUserManagementPage.save'
      );
      const submission = clickPending(view, saveLabel);
      await flushComponent();
      expect(button(view, saveLabel).props.loading).toBe(true);
      expect(view.findAll('ElForm')[0]!.props.disabled).toBe(true);
      await clickPending(view, saveLabel);
      expect(request).toHaveBeenCalledTimes(2);
      if (success) {
        write.resolve({});
        await flushComponent();
        expect(view.findAll('ElForm')).toHaveLength(0);
        expect(request).toHaveBeenCalledTimes(3);
        read.resolve(result);
      } else {
        write.reject(new Error('Write failed'));
      }
      await submission;
      await flushComponent();
      if (!success) {
        expect(button(view, saveLabel).props.loading).toBe(false);
        expect(view.findAll('ElForm')[0]!.props.disabled).toBe(false);
        expect(request).toHaveBeenCalledTimes(2);
      }
    } finally {
      view.unmount();
    }
  });

  it.each(
    (['save', 'remove', 'accept', 'reject'] as const).flatMap((action) =>
      [true, false].map((success) => [action, success] as const)
    )
  )('loads only the triggered schedule %s button (success=%s)', async (action, success) => {
    const write = deferred();
    const read = deferred();
    const result = {
      task: {
        id: 'task',
        objective: 'Objective',
        cron: '0 9 * * *',
        timezone: 'UTC',
        enabled: true,
        ownerUserId: 1,
        notifyOnTerminal: false,
        revision: 1,
        nextRunAt: null
      },
      proposals: [
        {
          id: 'proposal',
          proposed_by_user_id: 1,
          objective: 'New objective',
          cron: null,
          timezone: null,
          created_at: 1
        }
      ],
      canResolveProposals: true,
      occurrences: [],
      occurrencePage: 1,
      occurrenceTotal: 0,
      nodeTimezone: 'UTC'
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementation((_path: string, init?: RequestInit) =>
        init?.method ? write.promise : read.promise
      );
    const close = vi.fn();
    const view = renderComponent(ScheduleDialog, {
      modelValue: true,
      session: { id: 'session' },
      nodeId: 'node',
      workspaceId: 'workspace',
      request,
      'onUpdate:modelValue': close
    });
    try {
      await flushComponent();
      const label = translate(`generated.scheduledSession.${action}`);
      const submission = clickPending(view, label);
      await flushComponent();
      expect(button(view, label).props.loading).toBe(true);
      expect(view.findAll('ElButton').filter((node) => node.props.loading)).toHaveLength(1);
      expect(view.findAll('ElForm')[0]!.props.disabled).toBe(true);
      expect(view.findAll('ElForm')[0]!.props['aria-busy']).toBe(false);
      await trigger(view.findAll('ElDialog')[0]!, 'onUpdate:modelValue', false);
      expect(close).not.toHaveBeenCalled();
      await clickPending(view, label);
      expect(request).toHaveBeenCalledTimes(2);
      if (!success) {
        write.reject(new Error('Write failed'));
        await submission;
        await flushComponent();
        expect(view.findAll('ElButton').filter((node) => node.props.loading)).toHaveLength(0);
        expect(view.findAll('ElForm')[0]!.props.disabled).toBe(false);
        expect(view.findAll('ElForm')[0]!.props['aria-busy']).toBe(false);
        expect(request).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(showMessage).mock.calls.filter(([, type]) => type === 'error')
        ).toHaveLength(1);
        return;
      }
      write.resolve({});
      await flushComponent();
      expect(view.findAll('ElButton').filter((node) => node.props.loading)).toHaveLength(0);
      expect(view.findAll('ElForm')[0]!.props['aria-busy']).toBe(true);
      expect(view.findAll('ElForm')[0]!.props.disabled).toBe(true);
      expect(request).toHaveBeenCalledTimes(3);
      read.resolve(result);
      await submission;
      await flushComponent();
      expect(view.findAll('ElForm')[0]!.props['aria-busy']).toBe(false);
      expect(view.findAll('ElForm')[0]!.props.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it.each([true, false])(
    'uses the OAuth refresh button without duplicating a table mask (success=%s)',
    async (success) => {
      const read = deferred();
      const result = { bindings: [{ providerKey: 'fixture', name: 'Fixture', bound: false }] };
      const request = vi
        .fn()
        .mockResolvedValueOnce(result)
        .mockImplementation(() => read.promise);
      const view = renderComponent(EnterpriseSettings, {
        section: 'account',
        sessions: [],
        newPassword: '',
        passwordValidationError: '',
        registrationToken: undefined,
        loading: false,
        changePassword: async () => true,
        formatSessionTime: String,
        request,
        edition: 'ENTERPRISE',
        role: 'MEMBER',
        managementWritable: true,
        quickPrompts: [],
        quickPromptsLoading: false,
        quickPromptsFailed: false,
        refreshQuickPrompts: async () => undefined
      });
      try {
        await flushComponent();
        const label = translate('generated.settingsContent.refresh');
        const refresh = clickPending(view, label);
        await flushComponent();
        expect(button(view, label).props.loading).toBe(true);
        expect(button(view, label).props.disabled).toBe(true);
        expect(button(view, translate('generated.settingsContent.bind')).props.disabled).toBe(true);
        await clickPending(view, label);
        expect(request).toHaveBeenCalledTimes(2);
        if (success) read.resolve(result);
        else read.reject(new Error('Read failed'));
        await refresh;
        await flushComponent();
        expect(button(view, label).props.loading).toBe(false);
        expect(button(view, label).props.disabled).toBe(false);
        expect(button(view, translate('generated.settingsContent.bind')).props.disabled).toBe(
          false
        );
        expect(
          view.findAll('ElTable').find((node) => node.props['row-key'] === 'providerKey')!.props
            .data
        ).toEqual(result.bindings);
        expect(
          vi.mocked(showMessage).mock.calls.filter(([, type]) => type === 'error')
        ).toHaveLength(success ? 0 : 1);
      } finally {
        view.unmount();
      }
    }
  );

  it.each([true, false])(
    'rereads after unbinding and ignores the older refresh (success=%s)',
    async (success) => {
      const write = deferred();
      const oldRead = deferred();
      const freshRead = deferred();
      const original = { bindings: [{ providerKey: 'fixture', name: 'Fixture', bound: true }] };
      const updated = { bindings: [{ ...original.bindings[0]!, bound: false }] };
      const request = vi
        .fn()
        .mockResolvedValueOnce(original)
        .mockImplementation((_path: string, init?: RequestInit) =>
          init?.method === 'DELETE' ? write.promise : oldRead.promise
        );
      const view = renderComponent(EnterpriseSettings, {
        section: 'account',
        sessions: [],
        newPassword: '',
        passwordValidationError: '',
        registrationToken: undefined,
        loading: false,
        changePassword: async () => true,
        formatSessionTime: String,
        request,
        edition: 'ENTERPRISE',
        role: 'MEMBER',
        managementWritable: true,
        quickPrompts: [],
        quickPromptsLoading: false,
        quickPromptsFailed: false,
        refreshQuickPrompts: async () => undefined
      });
      try {
        await flushComponent();
        const unbind = clickPending(view, translate('generated.settingsContent.unbind'));
        await flushComponent();
        const refreshLabel = translate('generated.settingsContent.refresh');
        const refresh = clickPending(view, refreshLabel);
        await flushComponent();
        expect(request).toHaveBeenCalledTimes(3);
        request.mockImplementationOnce(() => freshRead.promise);
        write.resolve({});
        await flushComponent();
        expect(request).toHaveBeenCalledTimes(4);
        expect(button(view, refreshLabel).props.loading).toBe(false);
        const table = () =>
          view.findAll('ElTable').find((node) => node.props['row-key'] === 'providerKey')!;
        expect(table().props['aria-busy']).toBe(true);
        freshRead.resolve(updated);
        await unbind;
        await flushComponent();
        expect(table().props.data).toEqual(updated.bindings);
        expect(table().props['aria-busy']).toBe(false);
        if (success) oldRead.resolve(original);
        else oldRead.reject(new Error('Stale refresh failed'));
        await refresh;
        await flushComponent();
        expect(table().props.data).toEqual(updated.bindings);
        expect(table().props['aria-busy']).toBe(false);
        expect(
          vi.mocked(showMessage).mock.calls.filter(([, type]) => type === 'error')
        ).toHaveLength(0);
      } finally {
        write.resolve({});
        oldRead.resolve(original);
        freshRead.resolve(updated);
        view.unmount();
      }
    }
  );
});
