import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { ElMessageBox } from 'element-plus';
import type { MarAgentModelSummary } from '@myagentroam/protocol';
import Page from '../../src/view/settings/MarAgentModelManagementPage.vue?unit-render';
import { i18n } from '../../src/service/locale-preference-service.js';
import { commonMessages } from '../../src/i18n/messages.js';
import { showMessage } from '../../src/service/message-feedback-service.js';
import { managementDateTime } from '../../src/util/time-presentation.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger,
  type TestElement
} from './support/component-renderer.js';

vi.mock('../../src/service/message-feedback-service.js', () => ({ showMessage: vi.fn() }));

const messages = commonMessages['en-US'].marAgentModels;
const previousLocale = i18n.global.locale.value;
vi.mock('../../src/view/settings/PromptCompletionSettings.vue?unit-render', () => ({
  default: { render: () => null }
}));
const model: MarAgentModelSummary = {
  id: 'model-1',
  name: 'Fixture model',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://fixture.invalid',
  modelId: 'free-form-fixture',
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_000,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: 'high',
  conversationModel: true,
  titleGeneration: true,
  codeMode: true,
  hostedWebSearch: false,
  enabled: true,
  sortOrder: 0,
  access: 'RESTRICTED'
};
const credentials = (['CODEX_OAUTH', 'CHATGPT_OAUTH', 'XAI_OAUTH'] as const).map((type, index) => ({
  id: `credential-${index}`,
  name: `Fixture ${type}`,
  type,
  ownership: { ownerType: 'PERSONAL' as const, ownerUserId: 37 },
  status: 'ACTIVE' as const,
  accessTokenExpiresAt: 1_800_000,
  lastRefreshAt: 600_000,
  lastCheckedAt: 900_000,
  earliestRefreshAt: 1_500_000,
  accountId: `fixture-account-${index}`,
  proxy: { configured: true, host: 'fixture.invalid', port: 1080, hasUsername: false },
  revision: 2
}));
const usage = {
  runner: 'codex',
  windows: [],
  fetchedAt: 1_000_000,
  cached: false,
  profile: {
    lifetimeTokens: null,
    currentDayTokens: null,
    lastSevenDaysTokens: null,
    statsAsOf: null,
    dailyUsageBuckets: []
  },
  subscription: {
    provider: 'XAI',
    period: 'WEEKLY',
    startsAt: null,
    resetsAt: 1_800_000,
    usedPercentage: 37.5,
    prepaidBalanceCents: 1234
  }
};
type View = ReturnType<typeof renderComponent>;
function button(view: View, label: string): TestElement {
  return view.findAll('ElButton').find((node) => textContent(node).trim() === label)!;
}
function control(view: View, label: string, type: string): TestElement {
  return view.findAll(type).find((node) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (parent.type === 'ElFormItem' && parent.props['label'] === label) return true;
    return false;
  })!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function requestFixture(models: readonly MarAgentModelSummary[] = [model]) {
  return vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (path === '/api/admin/mar-agent/models' || path === '/api/mar-agent/models')
      return init?.method ? {} : { models };
    if (path === '/api/admin/mar-agent/codex-credentials') return { credentials };
    const credential = credentials.find((item) => path.endsWith(`/${item.id}`));
    if (credential) return { details: { credential, socks5Url: 'socks5://fixture.invalid:1080' } };
    if (path.endsWith('/usage')) return { usage };
    throw new Error(`Unexpected fixture request: ${path}`);
  });
}
beforeEach(() => {
  vi.mocked(showMessage).mockClear();
  i18n.global.locale.value = 'en-US';
  vi.stubGlobal('window', {
    location: { search: '', href: 'http://fixture/console' },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
  vi.stubGlobal('Document', class {});
  vi.stubGlobal('ShadowRoot', class {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  i18n.global.locale.value = previousLocale;
});

describe('Model management component behavior', () => {
  it.each([
    { locale: 'zh-CN', initial: undefined, expected: true },
    { locale: 'en-US', initial: false, expected: false }
  ] as const)('edits the model GC setting in $locale', async ({ locale, initial, expected }) => {
    i18n.global.locale.value = locale;
    const labels = commonMessages[locale].marAgentModels;
    const request = requestFixture([
      initial === undefined ? model : { ...model, gcEnabled: initial }
    ]);
    const view = renderComponent(
      Page,
      { request, canManageModels: true, writable: true, nodes: [] },
      {},
      { validate: async () => true }
    );
    try {
      await flushComponent();
      await trigger(button(view, labels.edit), 'onClick');
      const setting = view
        .findAll('ElCheckbox')
        .find((node) => textContent(node).trim() === labels.gcEnabled)!;
      expect(setting.props['modelValue']).toBe(expected);
      await trigger(setting, 'onUpdate:modelValue', !expected);
      await trigger(button(view, labels.save), 'onClick');
      const saved = request.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({ gcEnabled: !expected });
    } finally {
      view.unmount();
    }
  });
  it.each(['zh-CN', 'en-US'] as const)(
    'edits and saves the explicit subagent model purpose in %s',
    async (locale) => {
      i18n.global.locale.value = locale;
      const labels = commonMessages[locale].marAgentModels;
      const request = requestFixture([{ ...model, subagentModel: true }]);
      const view = renderComponent(
        Page,
        { request, canManageModels: true, writable: true, nodes: [] },
        {},
        { validate: async () => true }
      );
      try {
        await flushComponent();
        await trigger(button(view, labels.edit), 'onClick');
        const setting = view
          .findAll('ElCheckbox')
          .find((node) => textContent(node).trim() === labels.subagentModel)!;
        expect(setting.props['modelValue']).toBe(true);
        await trigger(setting, 'onUpdate:modelValue', false);
        await trigger(button(view, labels.save), 'onClick');
        const saved = request.mock.calls.find(([, init]) => init?.method === 'PUT');
        expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({ subagentModel: false });
      } finally {
        view.unmount();
      }
    }
  );
  it('does not submit twice or submit an old draft after validation outlives the dialog', async () => {
    const request = requestFixture();
    const gate = deferred<boolean>();
    const validate = vi.fn(() => gate.promise);
    const view = renderComponent(
      Page,
      { request, canManageModels: true, writable: true, nodes: [] },
      {},
      { validate }
    );
    try {
      await flushComponent();
      await trigger(button(view, messages.add), 'onClick');
      const first = trigger(button(view, messages.save), 'onClick');
      const second = trigger(button(view, messages.save), 'onClick');
      expect(validate).toHaveBeenCalledOnce();
      const dialog = view.findAll('ElDialog').find((node) => node.props['modelValue'] === true)!;
      await trigger(dialog, 'onUpdate:modelValue', false);
      await trigger(button(view, messages.add), 'onClick');
      gate.resolve(true);
      await Promise.all([first, second]);
      expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      expect(view.findAll('ElDialog').some((node) => node.props['modelValue'] === true)).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it('does not start a credential login from validation belonging to a closed dialog', async () => {
    const request = requestFixture();
    const gate = deferred<boolean>();
    const validate = vi.fn(() => gate.promise);
    const view = renderComponent(
      Page,
      { request, canManageModels: true, writable: true, nodes: [] },
      {},
      { validate }
    );
    try {
      await flushComponent();
      await trigger(button(view, messages.codexAddCredential), 'onClick');
      const first = trigger(button(view, messages.codexStartLogin), 'onClick');
      const second = trigger(button(view, messages.codexStartLogin), 'onClick');
      expect(validate).toHaveBeenCalledOnce();
      const dialog = view.findAll('ElDialog').find((node) => node.props['modelValue'] === true)!;
      await trigger(dialog, 'onUpdate:modelValue', false);
      await trigger(button(view, messages.codexAddCredential), 'onClick');
      gate.resolve(true);
      await Promise.all([first, second]);
      expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it.each(['success', 'failure'] as const)(
    'keeps a reopened draft intact when an already submitted model save returns %s',
    async (outcome) => {
      const base = requestFixture();
      const gate = deferred<void>();
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          await gate.promise;
          if (outcome === 'failure') throw new Error('old save failed');
          return {};
        }
        return base(path, init);
      });
      const view = renderComponent(
        Page,
        { request, canManageModels: true, writable: true, nodes: [] },
        {},
        { validate: async () => true }
      );
      try {
        await flushComponent();
        await trigger(button(view, messages.add), 'onClick');
        const pending = trigger(button(view, messages.save), 'onClick');
        await flushComponent();
        expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
        const dialog = view.findAll('ElDialog').find((node) => node.props['modelValue'] === true)!;
        await trigger(dialog, 'onUpdate:modelValue', false);
        await trigger(button(view, messages.add), 'onClick');
        await trigger(control(view, messages.name, 'ElInput'), 'onUpdate:modelValue', 'New draft');
        vi.mocked(showMessage).mockClear();
        gate.resolve();
        await pending;
        expect(control(view, messages.name, 'ElInput').props['modelValue']).toBe('New draft');
        expect(showMessage).not.toHaveBeenCalled();
        expect(
          base.mock.calls.filter(([path]) => path === '/api/admin/mar-agent/models')
        ).toHaveLength(outcome === 'success' ? 2 : 1);
      } finally {
        view.unmount();
      }
    }
  );

  it('opens the dedicated compact settings from the advanced management tab', async () => {
    const baseRequest = requestFixture();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/mar-agent/compact')
        return { configuration: { enabled: true, modelId: model.id, reasoningEffort: 'high' } };
      return baseRequest(path, init);
    });
    const view = renderComponent(Page, {
      request,
      canManageModels: true,
      canManageCompact: true,
      writable: true,
      nodes: []
    });
    try {
      await flushComponent();
      expect(request.mock.calls.some(([path]) => path.endsWith('/compact'))).toBe(false);
      await trigger(view.findAll('ElTabs')[0]!, 'onUpdate:modelValue', 'compact');
      await flushComponent();
      expect(textContent(view.root)).toContain(commonMessages['en-US'].promptCompletion.compact);
      expect(textContent(view.root)).toContain(messages.compactHint);
      expect(request).toHaveBeenCalledWith('/api/admin/mar-agent/compact', {
        signal: expect.any(AbortSignal)
      });
      expect(button(view, messages.compactSave)).toBeDefined();
    } finally {
      view.unmount();
    }
  });

  it('loads the full authoritative model set, preserves protocol labels and refreshes without paging', async () => {
    const models = Array.from({ length: 27 }, (_, index) => ({
      ...model,
      id: `model-${index}`,
      name: `Fixture model ${index}`,
      sortOrder: index,
      protocol: index % 2 ? ('ANTHROPIC_MESSAGES' as const) : ('OPENAI_RESPONSES' as const)
    }));
    const request = requestFixture(models);
    const view = renderComponent(Page, {
      request,
      canManageModels: true,
      writable: false,
      nodes: []
    });
    try {
      await flushComponent();
      expect(view.findAll('ElTable')[0]?.props['data']).toEqual(models);
      expect(view.findAll('ElPagination')).toHaveLength(0);
      expect(textContent(view.root)).toContain(messages.protocolOpenAI);
      expect(textContent(view.root)).toContain(messages.protocolAnthropic);
      await trigger(button(view, messages.refresh), 'onClick');
      expect(
        request.mock.calls.filter(([path]) => path === '/api/admin/mar-agent/models')
      ).toHaveLength(2);
      expect(request).toHaveBeenCalledWith('/api/admin/mar-agent/models', { cache: 'no-store' });
      expect(button(view, messages.add)).toBeUndefined();
    } finally {
      view.unmount();
    }
  });

  it('validates a free-form model draft, preserves failed input, and removes protocol-inapplicable fields', async () => {
    const base = requestFixture();
    let failSave = true;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (failSave) throw new Error('Fixture save unavailable');
        return {};
      }
      return base(path, init);
    });
    const validate = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const prepareModel = vi.fn().mockResolvedValue(undefined);
    const view = renderComponent(
      Page,
      {
        request,
        canManageModels: true,
        writable: true,
        nodes: [],
        prepareModel,
        modelOwnership: () => ({ ownerType: 'PERSONAL', ownerUserId: 37 })
      },
      { 'model-ownership': () => h('span', 'Host ownership field') },
      { validate }
    );
    try {
      await flushComponent();
      await trigger(button(view, messages.add), 'onClick');
      expect(prepareModel).toHaveBeenCalledOnce();
      expect(textContent(view.root)).toContain('Host ownership field');
      for (const field of ['responsesEncoding', 'highDensityCompaction'])
        expect(view.findAll('ElForm')[0]?.props['model']).not.toHaveProperty(field);
      expect(control(view, messages.context, 'ElInputNumber').props['modelValue']).toBe(256_000);
      expect(control(view, messages.output, 'ElInputNumber').props['modelValue']).toBe(32_000);
      expect(control(view, messages.defaultReasoningEffort, 'ElSelect').props['modelValue']).toBe(
        'medium'
      );
      await trigger(
        control(view, messages.name, 'ElInput'),
        'onUpdate:modelValue',
        '  Saved fixture  '
      );
      await trigger(
        control(view, messages.model, 'ElInput'),
        'onUpdate:modelValue',
        'free/form-model:custom'
      );
      await trigger(control(view, messages.protocol, 'ElSelect'), 'onChange', 'OPENAI_RESPONSES');
      await trigger(control(view, messages.transport, 'ElSelect'), 'onUpdate:modelValue', 'HTTP_2');
      await trigger(control(view, messages.protocol, 'ElSelect'), 'onChange', 'ANTHROPIC_MESSAGES');
      expect(control(view, messages.transport, 'ElSelect')).toBeUndefined();
      await trigger(control(view, messages.enabled, 'ElSwitch'), 'onUpdate:modelValue', false);
      await trigger(
        control(view, messages.defaultReasoningEffort, 'ElSelect'),
        'onUpdate:modelValue',
        'high'
      );
      for (const label of [messages.titleGeneration, messages.codeMode])
        await trigger(
          view.findAll('ElCheckbox').find((node) => textContent(node).trim() === label)!,
          'onUpdate:modelValue',
          true
        );
      await trigger(button(view, messages.save), 'onClick');
      expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      await trigger(button(view, messages.save), 'onClick');
      expect(vi.mocked(showMessage).mock.calls.filter(([, type]) => type === 'error')).toHaveLength(
        1
      );
      expect(control(view, messages.model, 'ElInput').props['modelValue']).toBe(
        'free/form-model:custom'
      );
      failSave = false;
      await trigger(button(view, messages.save), 'onClick');
      const saved = JSON.parse(
        request.mock.calls.findLast(([, init]) => init?.method === 'POST')![1]!.body as string
      );
      expect(saved).toMatchObject({
        name: 'Saved fixture',
        modelId: 'free/form-model:custom',
        contextWindowTokens: 256_000,
        maxOutputTokens: 32_000,
        protocol: 'ANTHROPIC_MESSAGES',
        enabled: false,
        titleGeneration: true,
        codeMode: true,
        gcEnabled: true,
        metadata: { useResourceUrl: false },
        defaultReasoningEffort: 'high',
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        ownership: { ownerType: 'PERSONAL', ownerUserId: 37 }
      });
      for (const field of [
        'responsesTransport',
        'responsesEncoding',
        'highDensityCompaction',
        'serviceTier'
      ])
        expect(saved).not.toHaveProperty(field);
      expect(view.findAll('ElDialog')).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'keeps the resource URL setting and its explanation together in %s',
    async (locale) => {
      i18n.global.locale.value = locale;
      const labels = commonMessages[locale].marAgentModels;
      const base = requestFixture([{ ...model, metadata: { useResourceUrl: true } }]);
      const request = vi.fn(async (path: string, init?: RequestInit) =>
        init?.method === 'PUT' ? {} : base(path, init)
      );
      const view = renderComponent(Page, {
        request,
        canManageModels: true,
        writable: true,
        nodes: []
      });
      try {
        await flushComponent();
        await trigger(button(view, labels.edit), 'onClick');
        const setting = view
          .findAll('ElCheckbox')
          .find((node) => textContent(node).trim() === labels.useResourceUrl)!;
        expect(setting.props['modelValue']).toBe(true);
        const field = view
          .findAll('ElFormItem')
          .find((node) => node.props['label'] === labels.capabilities)!;
        expect(textContent(field)).toContain(labels.resourceUrlDescription);
        const reasoning = view
          .findAll('ElFormItem')
          .find((node) => node.props['label'] === labels.reasoningEfforts)!;
        expect(textContent(reasoning)).not.toContain(labels.resourceUrlDescription);
        await trigger(setting, 'onUpdate:modelValue', false);
        await trigger(button(view, labels.save), 'onClick');
        const saved = request.mock.calls.find(([, init]) => init?.method === 'PUT');
        expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({
          metadata: { useResourceUrl: false }
        });
      } finally {
        view.unmount();
      }
    }
  );

  it('shows mixed OAuth types and keeps ChatGPT usage available in read-only details', async () => {
    const request = requestFixture();
    const view = renderComponent(Page, {
      request,
      canManageModels: true,
      writable: false,
      nodes: [],
      credentialScopeLabel: () => 'Host ownership label'
    });
    try {
      await flushComponent();
      await trigger(view.findAll('ElTabs')[0]!, 'onUpdate:modelValue', 'codexCredentials');
      const table = view
        .findAll('ElTable')
        .find(
          (node) =>
            Array.isArray(node.props['data']) &&
            (node.props['data'] as { id: string }[]).some((row) => row.id === 'credential-0')
        )!;
      expect(table.props['data']).toEqual(credentials);
      expect(table.children.find((node) => node.props['prop'] === 'name')?.props['label']).toBe(
        messages.credentialName
      );
      expect(textContent(table)).toContain(managementDateTime(credentials[1]!.earliestRefreshAt));
      for (const label of [
        messages.codexLegacyCredential,
        messages.chatgptCredential,
        messages.grokSubscriptionCredential
      ])
        expect(textContent(table)).toContain(label);
      await trigger(table, 'onRowClick', credentials[1]);
      const dialog = view.findAll('ElDialog')[0]!;
      expect(textContent(dialog)).toContain('Host ownership label');
      expect(textContent(dialog)).toContain(managementDateTime(credentials[1]!.earliestRefreshAt));
      const link = view.findAll('ElButton').find((node) => node.props['href'])!;
      expect(link.props).toMatchObject({
        href: 'https://chatgpt.com/settings/usage',
        target: '_blank',
        rel: 'noopener noreferrer'
      });
      for (const action of [
        messages.codexRefresh,
        messages.codexRelogin,
        messages.codexLoadCatalog
      ])
        expect(button(view, action)).toBeUndefined();
      expect(request.mock.calls.some(([path]) => path.endsWith('/usage'))).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it('renders X subscription usage on demand with remaining percentage and independent prepaid balance', async () => {
    const request = requestFixture();
    const view = renderComponent(Page, {
      request,
      canManageModels: true,
      writable: false,
      nodes: []
    });
    try {
      await flushComponent();
      await trigger(view.findAll('ElTabs')[0]!, 'onUpdate:modelValue', 'codexCredentials');
      const table = view
        .findAll('ElTable')
        .find(
          (node) =>
            Array.isArray(node.props['data']) &&
            (node.props['data'] as { id: string }[]).some((row) => row.id === 'credential-0')
        )!;
      await trigger(table, 'onRowClick', credentials[2]);
      expect(request.mock.calls.some(([path]) => path.endsWith('/usage'))).toBe(false);
      await trigger(button(view, messages.codexQueryUsage), 'onClick');
      const dialog = view.findAll('ElDialog')[0]!;
      for (const value of [messages.grokUsageTitle, '37.5%', '62.5%', '$12.34'])
        expect(textContent(dialog)).toContain(value);
      expect(textContent(dialog)).not.toContain(messages.codexUsageLifetimeTokens);
      expect(request).toHaveBeenCalledWith(
        '/api/admin/mar-agent/codex-credentials/credential-2/usage',
        { cache: 'no-store' }
      );
      expect(request.mock.calls.filter(([path]) => path.endsWith('/usage'))).toHaveLength(1);
    } finally {
      view.unmount();
    }
  });

  it('offers only capable online Nodes for ChatGPT login and uses credential-specific form labels', async () => {
    const request = requestFixture();
    const nodes = [
      {
        id: 'ready',
        displayName: 'Ready local Node',
        connected: true,
        disabled: false,
        capabilities: { chatgptLogin: { apiVersion: 1, loopback: true } }
      },
      {
        id: 'offline',
        connected: false,
        disabled: false,
        capabilities: { chatgptLogin: { apiVersion: 1, loopback: true } }
      },
      { id: 'unsupported', connected: true, disabled: false, capabilities: {} }
    ];
    const view = renderComponent(Page, { request, canManageModels: true, writable: true, nodes });
    try {
      await flushComponent();
      await trigger(button(view, messages.codexAddCredential), 'onClick');
      expect(control(view, messages.credentialName, 'ElInput')).toBeDefined();
      const rules = view.findAll('ElForm')[0]?.props['rules'] as { name: { message: string }[] };
      expect(rules.name[0]?.message).toBe(messages.credentialNameRequired);
      await trigger(
        control(view, messages.credentialType, 'ElSelect'),
        'onUpdate:modelValue',
        'CHATGPT_OAUTH'
      );
      const select = control(view, messages.chatgptLocalNode, 'ElSelect');
      expect(
        select.children
          .filter((node) => node.type === 'ElOption')
          .map((node) => node.props['value'])
      ).toEqual(['ready']);
      await trigger(
        control(view, messages.credentialType, 'ElSelect'),
        'onUpdate:modelValue',
        'XAI_OAUTH'
      );
      expect(control(view, messages.chatgptLocalNode, 'ElSelect')).toBeUndefined();
      expect(textContent(view.findAll('ElDialog')[0]!)).toContain(messages.grokProxyHint);
      await trigger(
        control(view, messages.credentialType, 'ElSelect'),
        'onUpdate:modelValue',
        'CHATGPT_OAUTH'
      );
      await trigger(
        control(view, messages.credentialName, 'ElInput'),
        'onUpdate:modelValue',
        'Fixture login'
      );
      await trigger(
        control(view, messages.chatgptLocalNode, 'ElSelect'),
        'onUpdate:modelValue',
        'ready'
      );
      request.mockRejectedValueOnce(new Error('Fixture login unavailable'));
      await trigger(button(view, messages.chatgptStartLogin), 'onClick');
      const login = request.mock.calls.find(([, init]) => init?.method === 'POST')!;
      expect(login[0]).toBe('/api/admin/mar-agent/codex-login-attempts');
      expect(JSON.parse(login[1]!.body as string)).toMatchObject({
        type: 'CHATGPT_OAUTH',
        nodeId: 'ready',
        name: 'Fixture login'
      });
      expect(
        vi.mocked(showMessage).mock.calls.map(([message, type]) => ({ message, type }))
      ).toContainEqual({ message: 'Fixture login unavailable', type: 'error' });
      await trigger(button(view, messages.cancel), 'onClick');
      await trigger(button(view, messages.add), 'onClick');
      await trigger(control(view, messages.protocol, 'ElSelect'), 'onChange', 'GROK');
      expect(
        control(view, messages.codexCredential, 'ElSelect')
          .children.filter((node) => node.type === 'ElOption')
          .map((node) => node.props['value'])
      ).toEqual(['credential-2']);
      expect(control(view, messages.serviceTier, 'ElSelect')).toBeUndefined();
    } finally {
      view.unmount();
    }
  });

  it.each([false, true])(
    'saves reordered models through the appropriate endpoint (personal=%s)',
    async (personal) => {
      const models = [model, { ...model, id: 'model-2', name: 'Second fixture', sortOrder: 1 }];
      const base = requestFixture(models);
      const endpoint = personal
        ? '/api/mar-agent/models/order'
        : '/api/admin/mar-agent/models/order';
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (path === endpoint) return {};
        return base(path, init);
      });
      const view = renderComponent(Page, {
        request,
        canManageModels: !personal,
        writable: true,
        nodes: []
      });
      try {
        await flushComponent();
        const table = view
          .findAll('ElTable')
          .find((node) => (node.props['data'] as unknown[])?.length === 2)!;
        if (personal) expect(textContent(table)).not.toContain(messages.status);
        await trigger(
          button(view, personal ? messages.adjustPersonalOrder : messages.adjustOrder),
          'onClick'
        );
        const handles = view.findAll('div').filter((node) => node.props['draggable'] === true);
        await trigger(handles[0]!, 'onDragstart', { dataTransfer: {} });
        await trigger(handles[1]!, 'onDragenter', { preventDefault() {} });
        await trigger(button(view, messages.saveOrder), 'onClick');
        expect(request).toHaveBeenCalledWith(endpoint, {
          method: 'PUT',
          body: JSON.stringify({ modelIds: ['model-2', 'model-1'] })
        });
      } finally {
        view.unmount();
      }
    }
  );

  it('tests through an eligible Node and preserves stable codes, request IDs and upstream diagnostics', async () => {
    const base = requestFixture();
    const result = {
      success: false,
      code: 'FIXTURE_UPSTREAM_REJECTED',
      message: 'Fixture upstream rejection',
      httpStatus: 429,
      requestId: 'fixture-server-request',
      response: {
        body: 'fixture upstream body',
        bodyTruncated: true,
        contentType: 'text/plain',
        requestId: 'fixture-upstream-request',
        retryAfter: '7'
      }
    };
    const request = vi.fn(async (path: string, init?: RequestInit) =>
      path.endsWith('/test') ? result : base(path, init)
    );
    const nodes = [true, false].map((connected) => ({
      id: connected ? 'ready' : 'offline',
      displayName: connected ? 'Ready Node' : 'Offline Node',
      connected,
      disabled: false,
      capabilities: {
        marAgentRuntimeCredentials: { apiVersion: 1, websocket: true, httpVersions: ['1.1', '2'] }
      }
    }));
    const view = renderComponent(Page, { request, canManageModels: true, writable: true, nodes });
    try {
      await flushComponent();
      await trigger(button(view, messages.test), 'onClick');
      const select = control(view, messages.modelTestNode, 'ElSelect');
      expect(
        select.children
          .filter((node) => node.type === 'ElOption')
          .map((node) => node.props['value'])
      ).toEqual(['ready']);
      await trigger(select, 'onUpdate:modelValue', 'ready');
      await trigger(
        view
          .findAll('ElButton')
          .filter((node) => textContent(node).trim() === messages.test)
          .at(-1)!,
        'onClick'
      );
      expect(request).toHaveBeenCalledWith('/api/admin/mar-agent/models/model-1/test', {
        method: 'POST',
        body: JSON.stringify({ nodeId: 'ready' })
      });
      for (const value of [result.code, result.requestId, result.response.requestId, '429', '7'])
        expect(textContent(view.findAll('ElDialog')[0]!)).toContain(value);
      expect(
        view.findAll('ElInput').find((node) => Object.hasOwn(node.props, 'readonly'))?.props[
          'modelValue'
        ]
      ).toBe(result.response.body);
      expect(textContent(view.findAll('ElDialog')[0]!)).toContain(result.message);
      expect(showMessage).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it.each(['DEFERRED', 'DEGRADED'] as const)(
    'renders the %s credential refresh outcome without claiming a refresh succeeded',
    async (outcome) => {
      const credential = { ...credentials[1]!, earliestRefreshAt: Date.now() + 3_600_000 };
      const refreshed = { ...credential, status: outcome === 'DEGRADED' ? 'DEGRADED' : 'ACTIVE' };
      const base = requestFixture();
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith('/refresh')) return { credential: refreshed };
        if (path.endsWith(`/${credential.id}`))
          return { details: { credential, socks5Url: 'socks5://fixture.invalid:1080' } };
        if (path === '/api/admin/mar-agent/codex-credentials') return { credentials: [credential] };
        return base(path, init);
      });
      const view = renderComponent(Page, {
        request,
        canManageModels: true,
        writable: true,
        nodes: []
      });
      try {
        await flushComponent();
        await trigger(view.findAll('ElTabs')[0]!, 'onUpdate:modelValue', 'codexCredentials');
        const table = view
          .findAll('ElTable')
          .find((node) =>
            (node.props['data'] as { id: string }[]).some((row) => row.id === credential.id)
          )!;
        await trigger(table, 'onRowClick', credential);
        await trigger(button(view, messages.codexRefresh), 'onClick');
        expect(request).toHaveBeenCalledWith(
          `/api/admin/mar-agent/codex-credentials/${credential.id}/refresh`,
          { method: 'POST' }
        );
        if (outcome === 'DEFERRED')
          expect(showMessage).toHaveBeenCalledWith(
            i18n.global.t('marAgentModels.chatgptRefreshDeferred', {
              time: managementDateTime(credential.earliestRefreshAt)
            }),
            'info'
          );
        else expect(showMessage).toHaveBeenCalledWith(messages.codexRefreshDegraded, 'warning');
        expect(vi.mocked(showMessage).mock.calls.some(([, type]) => type === 'success')).toBe(
          false
        );
      } finally {
        view.unmount();
      }
    }
  );

  it('loads a credential catalogue through the host preparation and renders ownership and missing-context defaults', async () => {
    const base = requestFixture();
    const request = vi.fn(async (path: string, init?: RequestInit) =>
      path.endsWith('/models/load')
        ? {
            catalog: {
              catalogHash: 'a'.repeat(64),
              fetchedAt: 1_000,
              models: [
                {
                  upstreamModelId: 'upstream-fixture',
                  displayName: 'Catalogue fixture',
                  reasoningEfforts: [],
                  unsupportedReasoningEfforts: [],
                  inputCapabilities: ['TEXT'],
                  hostedWebSearch: false,
                  warnings: [],
                  requiredInputs: ['contextWindowTokens']
                }
              ]
            }
          }
        : path.endsWith('/models/import')
          ? {
              result: {
                items: [
                  {
                    upstreamModelId: 'upstream-fixture',
                    status: 'CREATED',
                    modelId: 'imported-model'
                  }
                ]
              }
            }
          : base(path, init)
    );
    const prepareCatalog = vi.fn();
    const view = renderComponent(
      Page,
      { request, canManageModels: true, writable: true, nodes: [], prepareCatalog },
      { 'catalog-ownership': () => h('span', 'Host catalogue ownership') }
    );
    try {
      await flushComponent();
      await trigger(view.findAll('ElTabs')[0]!, 'onUpdate:modelValue', 'codexCredentials');
      const table = view
        .findAll('ElTable')
        .find((node) =>
          (node.props['data'] as { id: string }[]).some((row) => row.id === credentials[0]!.id)
        )!;
      await trigger(table, 'onRowClick', credentials[0]);
      await trigger(button(view, messages.codexLoadCatalog), 'onClick');
      expect(prepareCatalog).toHaveBeenCalledWith(credentials[0]);
      expect(request).toHaveBeenCalledWith(
        '/api/admin/mar-agent/codex-credentials/credential-0/models/load',
        { method: 'POST' }
      );
      expect(textContent(view.findAll('ElDialog')[0]!)).toContain('Host catalogue ownership');
      expect(textContent(view.findAll('ElDialog')[0]!)).toContain('upstream-fixture');
      expect(view.findAll('ElInputNumber')[0]?.props['modelValue']).toBe(256_000);
      await trigger(view.findAll('ElCheckbox')[0]!, 'onUpdate:modelValue', true);
      await trigger(button(view, messages.codexImport), 'onClick');
      const imported = request.mock.calls.find(([path]) => path.endsWith('/models/import'))!;
      expect(imported[0]).toBe('/api/admin/mar-agent/codex-credentials/credential-0/models/import');
      expect(JSON.parse(String(imported[1]?.body))).toMatchObject({
        catalogHash: 'a'.repeat(64),
        models: [{ upstreamModelId: 'upstream-fixture', name: 'Catalogue fixture' }]
      });
    } finally {
      view.unmount();
    }
  });

  it.each(['edit', 'catalog'] as const)(
    'preserves the newest credential %s dialog when an older request resolves',
    async (operation) => {
      const late = deferred<unknown>();
      const base = requestFixture([]);
      const catalog = (name: string) => ({
        catalog: {
          catalogHash: 'a'.repeat(64),
          fetchedAt: 1_000,
          models: [
            {
              upstreamModelId: name,
              displayName: name,
              reasoningEfforts: [],
              unsupportedReasoningEfforts: [],
              inputCapabilities: ['TEXT'],
              hostedWebSearch: false,
              warnings: [],
              requiredInputs: ['contextWindowTokens']
            }
          ]
        }
      });
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/api/admin/mar-agent/codex-credentials')
          return { credentials: credentials.slice(0, 2) };
        if (
          path ===
          `/api/admin/mar-agent/codex-credentials/credential-0${operation === 'catalog' ? '/models/load' : ''}`
        )
          return late.promise;
        if (path.endsWith('/models/load')) return catalog('Current catalogue');
        return base(path, init);
      });
      const view = renderComponent(Page, {
        request,
        canManageModels: true,
        writable: true,
        nodes: []
      });
      try {
        await flushComponent();
        await trigger(view.findAll('ElTabs')[0]!, 'onUpdate:modelValue', 'codexCredentials');
        const table = view
          .findAll('ElTable')
          .find((node) =>
            (node.props['data'] as { id: string }[]).some((row) => row.id === credentials[0]!.id)
          )!;
        if (operation === 'edit') {
          const opening = trigger(
            view
              .findAll('ElButton')
              .filter((node) => textContent(node).trim() === messages.edit)[0]!,
            'onClick'
          );
          await flushComponent();
          await trigger(
            view
              .findAll('ElButton')
              .filter((node) => textContent(node).trim() === messages.edit)[1]!,
            'onClick'
          );
          expect(control(view, messages.credentialName, 'ElInput').props['modelValue']).toBe(
            credentials[1]!.name
          );
          late.resolve({
            details: { credential: credentials[0], socks5Url: 'socks5://fixture.invalid:1080' }
          });
          await opening;
        } else {
          await trigger(table, 'onRowClick', credentials[0]);
          const loading = trigger(button(view, messages.codexLoadCatalog), 'onClick');
          await flushComponent();
          await trigger(view.findAll('ElDialog')[0]!, 'onUpdate:modelValue', false);
          await trigger(table, 'onRowClick', credentials[1]);
          await trigger(button(view, messages.codexLoadCatalog), 'onClick');
          expect(textContent(view.findAll('ElDialog')[0]!)).toContain('Current catalogue');
          late.resolve(catalog('Obsolete catalogue'));
          await loading;
        }
        await flushComponent();
        if (operation === 'edit')
          expect(control(view, messages.credentialName, 'ElInput').props['modelValue']).toBe(
            credentials[1]!.name
          );
        else {
          expect(textContent(view.findAll('ElDialog')[0]!)).toContain('Current catalogue');
          expect(textContent(view.root)).not.toContain('Obsolete catalogue');
        }
      } finally {
        view.unmount();
      }
    }
  );

  it('edits, tests and confirms removal of a credential through its row actions', async () => {
    let credential = credentials[0]!;
    let removed = false;
    const testResult = deferred<unknown>();
    const base = requestFixture([]);
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/mar-agent/codex-credentials')
        return { credentials: removed ? [] : [credential] };
      if (path.endsWith('/credential-0/test')) return testResult.promise;
      if (path.endsWith('/credential-0') && init?.method === 'PATCH') {
        credential = { ...credential, name: JSON.parse(String(init.body)).name };
        return { credential };
      }
      if (path.endsWith('/credential-0') && init?.method === 'DELETE') {
        removed = true;
        return {};
      }
      if (path.endsWith('/credential-0'))
        return { details: { credential, socks5Url: 'socks5://fixture.invalid:1080' } };
      return base(path, init);
    });
    const confirmation = vi
      .spyOn(ElMessageBox, 'confirm')
      .mockRejectedValueOnce('cancel')
      .mockResolvedValue('confirm' as never);
    const view = renderComponent(Page, {
      request,
      canManageModels: false,
      writable: true,
      nodes: []
    });
    try {
      await flushComponent();
      await trigger(view.findAll('ElTabs')[0]!, 'onUpdate:modelValue', 'codexCredentials');
      await trigger(button(view, messages.edit), 'onClick');
      await trigger(
        control(view, messages.credentialName, 'ElInput'),
        'onUpdate:modelValue',
        'Renamed fixture'
      );
      await trigger(button(view, messages.save), 'onClick');
      expect(credential.name).toBe('Renamed fixture');
      const patch = request.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
      expect(JSON.parse(String(patch[1]?.body))).toMatchObject({ name: 'Renamed fixture' });
      const testing = trigger(button(view, messages.test), 'onClick');
      await flushComponent();
      expect(button(view, messages.test).props['loading']).toBe(true);
      expect(button(view, messages.edit).props['disabled']).toBe(true);
      expect(button(view, messages.remove).props['disabled']).toBe(true);
      testResult.resolve({ result: { success: true, code: null } });
      await testing;
      expect(button(view, messages.test).props['loading']).toBe(false);
      expect(showMessage).toHaveBeenCalledWith(messages.codexTestSucceeded, 'success');
      await trigger(button(view, messages.remove), 'onClick');
      expect(removed).toBe(false);
      await trigger(button(view, messages.remove), 'onClick');
      expect(confirmation).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledWith('/api/admin/mar-agent/codex-credentials/credential-0', {
        method: 'DELETE'
      });
      expect(removed).toBe(true);
      expect(
        view.findAll('ElTable').some((node) => (node.props['data'] as unknown[]).length > 0)
      ).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it('refreshes a pending device login manually without starting another login', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = {
      id: 'fixture-attempt',
      status: 'PENDING',
      type: 'CODEX_OAUTH',
      userCode: 'FIXTURE-CODE',
      verificationUri: 'https://fixture.invalid/device',
      expiresAt: Date.now() + 60_000,
      pollIntervalMs: 60_000
    };
    const refresh = deferred<unknown>();
    const base = requestFixture([]);
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/mar-agent/codex-login-attempts') return { attempt: pending };
      if (path.endsWith('/fixture-attempt')) return refresh.promise;
      return base(path, init);
    });
    const view = renderComponent(Page, {
      request,
      canManageModels: false,
      writable: true,
      nodes: []
    });
    try {
      await flushComponent();
      await trigger(view.findAll('ElTabs')[0]!, 'onUpdate:modelValue', 'codexCredentials');
      await trigger(button(view, messages.codexAddCredential), 'onClick');
      await trigger(
        control(view, messages.credentialName, 'ElInput'),
        'onUpdate:modelValue',
        'Device fixture'
      );
      await trigger(button(view, messages.codexStartLogin), 'onClick');
      expect(textContent(view.root)).toContain('FIXTURE-CODE');
      const refreshing = trigger(button(view, messages.codexRefreshLoginStatus), 'onClick');
      await flushComponent();
      expect(button(view, messages.codexRefreshLoginStatus).props['loading']).toBe(true);
      refresh.resolve({
        attempt: {
          id: pending.id,
          status: 'FAILED',
          code: 'FIXTURE_LOGIN_REJECTED',
          message: 'Fixture login rejected'
        }
      });
      await refreshing;
      expect(request).toHaveBeenCalledWith(
        '/api/admin/mar-agent/codex-login-attempts/fixture-attempt'
      );
      expect(
        request.mock.calls.filter(([path]) => path === '/api/admin/mar-agent/codex-login-attempts')
      ).toHaveLength(1);
      expect(textContent(view.root)).not.toContain('FIXTURE-CODE');
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('ignores late credential details after switching and late usage after closing', async () => {
    const first = deferred<unknown>();
    const pendingUsage = deferred<unknown>();
    const base = requestFixture();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/credential-0')) return first.promise;
      if (path.endsWith('/usage')) return pendingUsage.promise;
      return base(path, init);
    });
    const view = renderComponent(Page, {
      request,
      canManageModels: true,
      writable: false,
      nodes: []
    });
    try {
      await flushComponent();
      await trigger(view.findAll('ElTabs')[0]!, 'onUpdate:modelValue', 'codexCredentials');
      const table = view
        .findAll('ElTable')
        .find(
          (node) =>
            Array.isArray(node.props['data']) &&
            (node.props['data'] as { id: string }[]).some((row) => row.id === 'credential-0')
        )!;
      const old = trigger(table, 'onRowClick', credentials[0]);
      await flushComponent();
      await trigger(table, 'onRowClick', credentials[2]);
      first.resolve({
        details: { credential: credentials[0], socks5Url: 'socks5://old.invalid:1080' }
      });
      await old;
      expect(textContent(view.findAll('ElDialog')[0]!)).not.toContain('old.invalid');
      expect(textContent(view.findAll('ElDialog')[0]!)).toContain('Fixture XAI_OAUTH');
      const query = trigger(button(view, messages.codexQueryUsage), 'onClick');
      await flushComponent();
      await trigger(view.findAll('ElDialog')[0]!, 'onUpdate:modelValue', false);
      pendingUsage.resolve({ usage });
      await query;
      expect(view.findAll('ElDialog')).toHaveLength(0);
      expect(textContent(view.root)).not.toContain('62.5%');
    } finally {
      view.unmount();
    }
  });
});
