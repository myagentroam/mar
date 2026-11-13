import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElMessage, ElMessageBox } from 'element-plus';
import { createSSRApp, defineComponent, h, ref, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createResourceHostingService } from '../../src/service/resource-hosting-service.js';
import ResourceGrantExtension from '../../src/view/settings/ResourceGrantExtension.vue?unit-render';
import ModelGrantExtension from '../../src/view/settings/ModelGrantExtension.vue?unit-render';
import EnvironmentSecretManager from '../../src/view/settings/EnvironmentSecretManager.vue?unit-render';
import OAuthManagementPage from '../../src/view/settings/OAuthManagementPage.vue?unit-render';
import EnterpriseNodeDetails from '../../src/view/settings/NodeDetailsDialogs.vue?unit-render';
import EnterpriseUserManagementPage from '../../src/view/settings/EnterpriseUserManagementPage.vue?unit-render';
import OrganizationManagementPage from '../../src/view/settings/OrganizationManagementPage.vue?unit-render';
import EnterpriseModels from '../../src/view/settings/MarAgentModelManagementPage.vue?unit-render';
import EnterpriseResources from '../../src/view/settings/ResourceManagementPanel.vue?unit-render';
import ResourceManagementFilters from '../../src/view/settings/ResourceManagementFilters.vue?unit-render';
import WorkspaceRegistrationPicker from '../../src/view/workspace/WorkspaceRegistrationPicker.vue?unit-render';
import { i18n } from '../../../../packages/web-core/src/service/locale-preference-service.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from '../../../../packages/web-core/test/unit/support/component-renderer.js';

const originalLocale = i18n.global.locale.value;
const organizations = [
  { id: 1, name: 'Engineering', parentOrganizationId: null },
  { id: 2, name: 'Research', parentOrganizationId: 1 },
  { id: 3, name: 'Platform', parentOrganizationId: 2 },
  { id: 9, name: 'Operations', parentOrganizationId: null }
];

beforeEach(() => {
  i18n.global.locale.value = 'en-US';
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('window', {
    location: {
      search: '',
      href: 'https://console.example.test/console',
      origin: 'https://console.example.test'
    },
    history: { replaceState: vi.fn() },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
  vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }) as never);
  vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close() {} }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  i18n.global.locale.value = originalLocale;
});

function button(view: ReturnType<typeof renderComponent>, label: string) {
  const found = view.findAll('ElButton').find((node) => textContent(node).trim() === label);
  expect(found).toBeDefined();
  return found!;
}

describe('Enterprise management components', () => {
  it.each([
    ['NODE', true],
    ['NODE', false],
    ['WORKSPACE', true],
    ['WORKSPACE', false]
  ] as const)(
    'keeps %s removal after organization grants when writable=%s',
    async (resourceType, writable) => {
      const rows = [
        {
          id: 'organization-node',
          nodeId: 'organization-node',
          workspaceId: 'organization-workspace',
          displayName: 'Organization resource',
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 2 }
        },
        {
          id: 'personal-node',
          nodeId: 'personal-node',
          workspaceId: 'personal-workspace',
          displayName: 'Personal resource',
          ownership: { ownerType: 'PERSONAL', ownerUserId: 7 }
        }
      ];
      const request = vi.fn(async (path: string) => {
        if (path === '/api/organizations') return { organizations };
        if (path === '/api/enterprise/users') return { users: [] };
        if (path.startsWith('/api/resources?'))
          return {
            nodes: resourceType === 'NODE' ? rows : [],
            workspaces: resourceType === 'WORKSPACE' ? rows : [],
            page: 1,
            pageSize: 20,
            total: rows.length,
            hasMore: false
          };
        throw new Error(`Unexpected fixture request: ${path}`);
      });
      const view = renderComponent(EnterpriseResources, {
        request,
        writable,
        resourceType,
        edition: 'ENTERPRISE',
        role: 'ADMIN'
      });
      try {
        await flushComponent();
        const actionRows = view
          .findAll('div')
          .filter((node) => node.props['class'] === 'mar-row-actions');
        expect(actionRows).toHaveLength(2);
        for (const [index, actionRow] of actionRows.entries()) {
          const actions = actionRow.children.filter((node) => node.type === 'ElButton');
          expect(actions.map((node) => textContent(node).trim())).toEqual(
            index === 0 ? ['Edit', 'Grant', 'Delete'] : ['Edit', 'Delete']
          );
          expect(actions.every((node) => node.props['disabled'] === !writable)).toBe(true);
          expect(actions.at(-1)?.props['type']).toBe('danger');
        }
        expect(request.mock.calls.every(([path]) => !path.startsWith('/api/resource-grants'))).toBe(
          true
        );
      } finally {
        view.unmount();
      }
    }
  );

  it.each(['ADMIN', 'ORG_ADMIN', 'MEMBER'] as const)(
    'projects personal model management and scoped ownership for enterprise %s',
    async (role) => {
      const request = vi.fn(async (path: string) => {
        if (path === '/api/organizations')
          return {
            organizations: [{ id: 2, name: 'Fixture organization', parentOrganizationId: null }]
          };
        if (path === '/api/admin/mar-agent/models' || path === '/api/mar-agent/models')
          return {
            models: [
              {
                id: 'visible-model',
                name: 'Scoped fixture model',
                protocol: 'OPENAI_RESPONSES',
                baseUrl: 'https://models.invalid/v1',
                modelId: 'fixture-model',
                contextWindowTokens: 128_000,
                maxOutputTokens: 16_000,
                inputCapabilities: ['TEXT'],
                outputCapabilities: ['TEXT'],
                reasoningEfforts: ['medium', 'high'],
                conversationModel: true,
                hostedWebSearch: false,
                responsesTransport: 'HTTP2',
                defaultReasoningEffort: 'medium',
                titleGeneration: false,
                codeMode: false,
                enabled: true,
                sortOrder: 0,
                ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 2 },
                access: 'PUBLIC'
              }
            ]
          };
        if (path === '/api/admin/mar-agent/codex-credentials') return { credentials: [] };
        throw new Error(`Unexpected fixture request: ${path}`);
      });
      const view = renderComponent(EnterpriseModels, {
        request,
        writable: true,
        nodes: [],
        edition: 'ENTERPRISE',
        role,
        organizationId: 2
      });
      try {
        await flushComponent();
        if (role === 'MEMBER') expect(request).not.toHaveBeenCalledWith('/api/organizations');
        else expect(request).toHaveBeenCalledWith('/api/organizations');
        const modelTable = view
          .findAll('ElTable')
          .find((node) => (node.props['data'] as unknown[])?.length === 1)!;
        await trigger(modelTable, 'onRowClick', (modelTable.props['data'] as unknown[])[0]);
        expect(textContent(view.findAll('ElDialog')[0]!)).toContain(
          i18n.global.t('marAgentModels.codexCredentialScopeOrganization', {
            value0: role === 'MEMBER' ? '2' : 'Fixture organization'
          })
        );
        await trigger(view.findAll('ElDialog')[0]!, 'onUpdate:modelValue', false);
        const tabs = view.findAll('ElTabPane').map((node) => node.props['name']);
        expect(tabs).toEqual(
          expect.arrayContaining(['modelOrder', 'models', 'codexCredentials', 'imageGeneration'])
        );
        await trigger(button(view, i18n.global.t('marAgentModels.add')), 'onClick');
        const ownership = view
          .findAll('ElFormItem')
          .find((node) => node.props['label'] === i18n.global.t('marAgentModels.modelOwnership'))!;
        const options = ownership.children
          .flatMap((node) => node.children)
          .filter((node) => node.type === 'ElOption');
        expect(options[0]?.props['label']).toBe(
          i18n.global.t('marAgentModels.codexCredentialScopePersonal')
        );
        const values = options.map((node) => node.props['value']);
        expect(values).toEqual(role === 'MEMBER' ? ['PERSONAL'] : ['PERSONAL', 'ORGANIZATION']);
        await trigger(button(view, i18n.global.t('marAgentModels.cancel')), 'onClick');
        expect(request.mock.calls.some(([path]) => path.includes('/models/load'))).toBe(false);
      } finally {
        view.unmount();
      }
    }
  );

  it('restores the organization page keyword without consuming the user page filter', async () => {
    window.location.search = '?organizations.keyword=Research&users.keyword=unrelated-user';
    window.location.href = `https://console.example.test/console${window.location.search}`;
    const request = vi.fn(async () => ({ organizations }));
    const view = renderComponent(OrganizationManagementPage, {
      request: request as never,
      writable: true
    });
    try {
      await flushComponent();
      expect(request).toHaveBeenCalledWith('/api/organizations');
      const keyword = view
        .findAll('ElInput')
        .find((node) => node.props['modelValue'] === 'Research');
      expect(keyword).toBeDefined();
      await trigger(keyword!, 'onUpdate:modelValue', 'Platform');
      const updated = new URL(
        String(vi.mocked(window.history.replaceState).mock.calls.at(-1)?.[2]),
        window.location.href
      );
      expect(updated.searchParams.get('organizations.keyword')).toBe('Platform');
      expect(updated.searchParams.get('users.keyword')).toBe('unrelated-user');
    } finally {
      view.unmount();
    }
  });

  it('uses scalar organization selections in user management and the resource owner filter', async () => {
    window.location.search =
      '?users.organization=9&users.keyword=fixture-user&organizations.keyword=Research';
    window.location.href = `https://console.example.test/console${window.location.search}`;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/organizations') return { organizations };
      if (path.startsWith('/api/enterprise/users') && init?.method === 'POST')
        return { user: { username: 'new-user' }, temporaryPassword: 'temporary-password' };
      if (path.startsWith('/api/enterprise/users'))
        return { users: [], page: 1, pageSize: 20, total: 0, hasMore: false };
      throw new Error(`Unexpected request: ${path}`);
    });
    const view = renderComponent(EnterpriseUserManagementPage, {
      request: request as never,
      writable: true,
      admin: true
    });
    try {
      await flushComponent();
      const filter = view.findAll('el-cascader')[0]!;
      expect(filter.props['modelValue']).toBe(9);
      expect(
        view.findAll('ElInput').some((node) => node.props['modelValue'] === 'fixture-user')
      ).toBe(true);
      expect(filter.props).toHaveProperty('filterable');
      expect(filter.props['props']).toEqual({ checkStrictly: true, emitPath: false });
      await trigger(filter, 'onUpdate:modelValue', 3);
      const updated = new URL(
        String(vi.mocked(window.history.replaceState).mock.calls.at(-1)?.[2]),
        window.location.href
      );
      expect(updated.searchParams.get('users.organization')).toBe('3');
      expect(updated.searchParams.get('organizations.keyword')).toBe('Research');
      expect(request.mock.calls.some(([path]) => path.includes('organizationId=3'))).toBe(true);
      const create = view
        .findAll('ElButton')
        .find((node) => textContent(node).trim() === 'Create user')!;
      await trigger(create, 'onClick');
      const formCascade = view.findAll('el-cascader').at(-1)!;
      await trigger(formCascade, 'onUpdate:modelValue', 2);
      const username = view
        .findAll('ElInput')
        .find((node) => String(node.props['placeholder']).toLowerCase().includes('username'))!;
      await trigger(username, 'onUpdate:modelValue', 'new-user');
      const save = view
        .findAll('ElButton')
        .filter((node) => textContent(node).trim() === 'Create user')
        .at(-1)!;
      await trigger(save, 'onClick');
      expect(request).toHaveBeenCalledWith('/api/enterprise/users', {
        method: 'POST',
        body: JSON.stringify({
          username: 'new-user',
          email: undefined,
          nickname: undefined,
          role: 'MEMBER',
          organizationId: 2
        })
      });
    } finally {
      view.unmount();
    }

    const updates = vi.fn();
    const filters = renderComponent(ResourceManagementFilters, {
      resourceType: 'NODE',
      keyword: '',
      ownerType: 'ORGANIZATION',
      ownerOrganizationId: 2,
      ownerUserId: undefined,
      status: '',
      organizationOptions: [{ value: 1, label: 'Engineering', children: [] }],
      userOptions: [],
      'onUpdate:ownerOrganizationId': updates
    });
    try {
      const organizationFilter = filters.findAll('el-cascader')[0]!;
      expect(organizationFilter.props).toHaveProperty('filterable');
      expect(organizationFilter.props['props']).toEqual({ checkStrictly: true, emitPath: false });
      await trigger(organizationFilter, 'onUpdate:modelValue', 1);
      expect(updates).toHaveBeenCalledWith(1);
    } finally {
      filters.unmount();
    }
  });

  it('limits EE hosting operations by resource ownership and forwards rendered detail actions', async () => {
    const disabled = {
      state: 'DISABLED',
      apiVersion: 1,
      acceptsNewConversations: false,
      supportsExistingConversations: false,
      capacity: 'AVAILABLE'
    } as const;
    const enabled = {
      ...disabled,
      state: 'AVAILABLE',
      acceptsNewConversations: true,
      sandboxBackend: 'BUBBLEWRAP',
      sandboxPolicyVersion: 1,
      supportsExistingConversations: true
    } as const;
    const request = vi.fn(async () => ({ capability: enabled }));
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirmed' as never);
    const context = { role: 'ADMIN' as const, writable: true, edition: 'ENTERPRISE' as const };
    const service = createResourceHostingService(request as never, () => context);
    const organizationNode = {
      resourceType: 'NODE',
      nodeId: 'organization-node',
      platform: 'linux',
      connected: true,
      disabled: false,
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
      capabilities: { conversationHosting: disabled }
    } as Parameters<typeof service.describe>[0];
    const personalNode = {
      ...organizationNode,
      nodeId: 'personal-node',
      ownership: { ownerType: 'PERSONAL', ownerUserId: 4 }
    } as never;
    expect(service.describe(organizationNode)?.canEnable).toBe(true);
    expect(service.describe(personalNode)).toBeUndefined();
    const update = vi.fn();
    await service.enable(personalNode, update);
    expect(confirm).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    confirm.mockRejectedValueOnce('cancel');
    await service.enable(organizationNode, update);
    expect(request).not.toHaveBeenCalled();
    await service.enable(organizationNode, update);
    expect(request).toHaveBeenCalledWith(
      '/api/management/nodes/organization-node/conversation-hosting/enable',
      { method: 'POST', body: '{"enabled":true}' }
    );
    const updateRow = update.mock.calls[0]![0] as (row: typeof organizationNode) => unknown;
    expect(updateRow(organizationNode)).toMatchObject({
      capabilities: { conversationHosting: enabled }
    });
    request.mockClear();
    update.mockClear();
    const enabledNode = {
      ...organizationNode,
      capabilities: { conversationHosting: enabled }
    } as never;
    confirm.mockRejectedValueOnce('cancel');
    await service.disable(enabledNode, update);
    expect(request).not.toHaveBeenCalled();
    await service.disable(enabledNode, update);
    expect(request).toHaveBeenCalledWith(
      '/api/management/nodes/organization-node/conversation-hosting/disable',
      { method: 'POST', body: '{}' }
    );

    const enableHosting = vi.fn();
    const enableView = renderComponent(
      defineComponent({
        setup: () => () =>
          h(EnterpriseNodeDetails, {
            nodeOpen: true,
            workspaceOpen: false,
            usageOpen: false,
            node: {
              id: 'organization-node',
              label: 'Organization node',
              platform: 'linux'
            } as never,
            ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
            hosting: {
              enabled: false,
              canEnable: true,
              canDisable: false,
              hint: 'Available',
              changing: false
            },
            usageDisabledReason: () => '',
            request: request as never,
            onEnableHosting: enableHosting
          })
      })
    );
    try {
      const enable = button(enableView, 'Enable hosted conversations');
      expect(enable.props['type']).toBe('primary');
      expect(await renderToString(createSSRApp(enable.props['icon'] as Component))).toContain(
        'data-mar-icon="success"'
      );
      await trigger(enable, 'onClick');
      expect(enableHosting).toHaveBeenCalledOnce();
    } finally {
      enableView.unmount();
    }
    const disableHosting = vi.fn();
    const disableView = renderComponent(
      defineComponent({
        setup: () => () =>
          h(EnterpriseNodeDetails, {
            nodeOpen: true,
            workspaceOpen: false,
            usageOpen: false,
            node: {
              id: 'organization-node',
              label: 'Organization node',
              platform: 'linux'
            } as never,
            hosting: {
              enabled: true,
              canEnable: false,
              canDisable: true,
              hint: 'Enabled',
              changing: false
            },
            usageDisabledReason: () => '',
            request: request as never,
            onDisableHosting: disableHosting
          })
      })
    );
    try {
      const disable = button(disableView, 'Disable hosted conversations');
      expect(disable.props['type']).toBe('warning');
      expect(await renderToString(createSSRApp(disable.props['icon'] as Component))).toContain(
        'data-mar-icon="error"'
      );
      await trigger(disable, 'onClick');
      expect(disableHosting).toHaveBeenCalledOnce();
    } finally {
      disableView.unmount();
    }
  });

  it('opens resource grants, renders organization labels, and submits a scalar organization ID', async () => {
    const grants = [
      { id: 'grant-1', targetType: 'ORGANIZATION', targetOrganizationId: 3 },
      { id: 'grant-unknown', targetType: 'ORGANIZATION', targetOrganizationId: 88 }
    ];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/resource-grants?')) return { grants };
      if (path === '/api/resource-grants' && init?.method === 'POST') return {};
      throw new Error(`Unexpected request: ${path}`);
    });
    const exposed = ref<{ open: (row: never) => Promise<void> }>();
    const view = renderComponent(
      defineComponent({
        setup: () => () =>
          h(ResourceGrantExtension, {
            ref: exposed,
            request: request as never,
            writable: true,
            organizations,
            users: []
          })
      })
    );
    const row = {
      resourceType: 'NODE',
      nodeId: 'node-a',
      workspaceId: null,
      label: 'Managed node',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    };
    try {
      await exposed.value!.open(row as never);
      await flushComponent();
      expect(textContent(view.root)).toContain('Engineering / Research / Platform');
      expect(textContent(view.root)).toContain('88');
      const cascader = view.findAll('el-cascader')[0]!;
      expect(cascader.props).toHaveProperty('filterable');
      expect(cascader.props['props']).toEqual({ checkStrictly: true, emitPath: false });
      await trigger(cascader, 'onUpdate:modelValue', 3);
      await trigger(button(view, 'Grant'), 'onClick');
      expect(request).toHaveBeenCalledWith('/api/resource-grants', {
        method: 'POST',
        body: JSON.stringify({
          resourceType: 'NODE',
          nodeId: 'node-a',
          targetType: 'ORGANIZATION',
          targetOrganizationId: 3
        })
      });
    } finally {
      view.unmount();
    }
  });

  it('loads model grants and submits their organization target through the rendered control', async () => {
    const model = { id: 'model-a', name: 'Assistant', modelId: 'vendor/assistant' };
    const grants = [{ id: 'model-grant', targetType: 'ORGANIZATION', targetOrganizationId: 2 }];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/organizations') return { organizations };
      if (path === '/api/enterprise/users') return { users: [] };
      if (path.startsWith('/api/resource-grants?')) return { grants };
      if (path === '/api/resource-grants' && init?.method === 'POST') return {};
      throw new Error(`Unexpected request: ${path}`);
    });
    const refresh = vi.fn(async () => [model]);
    const exposed = ref<{ open: (row: never) => Promise<void> }>();
    const view = renderComponent(
      defineComponent({
        setup: () => () =>
          h(ModelGrantExtension, {
            ref: exposed,
            request: request as never,
            writable: true,
            refresh
          })
      })
    );
    try {
      await exposed.value!.open(model as never);
      await flushComponent();
      expect(textContent(view.root)).toContain('Engineering / Research');
      const cascader = view.findAll('el-cascader')[0]!;
      expect(cascader.props['props']).toEqual({ checkStrictly: true, emitPath: false });
      await trigger(cascader, 'onUpdate:modelValue', 3);
      await trigger(button(view, 'Grant'), 'onClick');
      expect(request).toHaveBeenCalledWith('/api/resource-grants', {
        method: 'POST',
        body: JSON.stringify({
          resourceType: 'MODEL',
          modelId: 'model-a',
          targetType: 'ORGANIZATION',
          targetOrganizationId: 3
        })
      });
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it('keeps direct-Node workspace registration personal and limits organizational choices to the Node subtree', async () => {
    const personalRequest = vi.fn();
    const personalRegister = vi.fn();
    const personalView = renderComponent(
      defineComponent({
        setup: () => () =>
          h(WorkspaceRegistrationPicker, {
            modelValue: [],
            directory: undefined,
            selectedPath: '/workspace',
            pendingDirectoryName: '',
            loadingDirectory: false,
            loading: false,
            nodeReady: true,
            selectedPathValid: true,
            enterprise: true,
            role: 'MEMBER',
            nodeOwnership: { ownerType: 'PERSONAL', ownerUserId: 4 },
            nodeManageable: false,
            workspaceCreatable: true,
            request: personalRequest as never,
            onRegister: personalRegister
          })
      })
    );
    try {
      await flushComponent();
      expect(personalRequest).not.toHaveBeenCalled();
      expect(textContent(personalView.root)).toContain('Personal');
      const form = personalView.findAll('form')[0]!;
      await trigger(form, 'onSubmit', { preventDefault() {} });
      expect(personalRegister).toHaveBeenCalledOnce();
      expect(personalRegister).toHaveBeenCalledWith();
    } finally {
      personalView.unmount();
    }

    const request = vi.fn(async () => ({ organizations }));
    const register = vi.fn();
    const view = renderComponent(
      defineComponent({
        setup: () => () =>
          h(WorkspaceRegistrationPicker, {
            modelValue: [],
            directory: undefined,
            selectedPath: '/workspace',
            pendingDirectoryName: '',
            loadingDirectory: false,
            loading: false,
            nodeReady: true,
            selectedPathValid: true,
            enterprise: true,
            role: 'ADMIN',
            nodeOwnership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
            nodeManageable: true,
            workspaceCreatable: true,
            request: request as never,
            onRegister: register
          })
      })
    );
    try {
      await flushComponent();
      const select = view.findAll('ElSelect')[0]!;
      const options = view.findAll('ElOption').map((node) => node.props['value']);
      expect(options).toEqual([1, 2, 3]);
      await trigger(select, 'onUpdate:modelValue', 3);
      await trigger(view.findAll('form')[0]!, 'onSubmit', { preventDefault() {} });
      expect(register).toHaveBeenCalledWith({ ownerType: 'ORGANIZATION', ownerOrganizationId: 3 });
    } finally {
      view.unmount();
    }
  });

  it('renders organization secret ownership and submits organization-scoped fields through the shared form', async () => {
    const existing = {
      id: 'secret-1',
      scope: 'ORGANIZATION',
      name: 'DEPLOY_TOKEN',
      value: 'fixture-secret-value',
      nodeId: null,
      workspaceId: null,
      organizationId: 3,
      visibility: 'PUBLIC',
      createdAt: 1,
      updatedAt: 1
    };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/environment-secrets') && init?.method === 'POST') return {};
      if (path.startsWith('/api/environment-secrets'))
        return { secrets: [existing], page: 1, pageSize: 20, total: 1, hasMore: false };
      throw new Error(`Unexpected request: ${path}`);
    });
    const view = renderComponent(EnvironmentSecretManager, {
      request: request as never,
      scopes: ['PERSONAL', 'ORGANIZATION'],
      writable: true,
      organizations
    });
    try {
      await flushComponent();
      expect(textContent(view.root)).toContain('Engineering / Research / Platform');
      const actionCell = view
        .findAll('div')
        .find((node) => node.props['class'] === 'mar-row-actions');
      expect(actionCell).toBeDefined();
      const stopSecretRowClick = vi.fn();
      await trigger(actionCell!, 'onClick', { stopPropagation: stopSecretRowClick });
      expect(stopSecretRowClick).toHaveBeenCalledOnce();
      const table = view.findAll('ElTable')[0]!;
      await trigger(table, 'onRowClick', existing);
      expect(textContent(view.root)).toContain('DEPLOY_TOKEN');
      expect(textContent(view.findAll('ElDescriptions')[0]!)).not.toContain('fixture-secret-value');
      await trigger(button(view, 'Close'), 'onClick');
      await trigger(button(view, 'Add Environment Secret'), 'onClick');
      const scope = view.findAll('ElSelect')[0]!;
      await trigger(scope, 'onUpdate:modelValue', 'ORGANIZATION');
      await flushComponent();
      const cascader = view.findAll('el-cascader')[0]!;
      expect(cascader.props['props']).toEqual({ checkStrictly: true, emitPath: false });
      await trigger(cascader, 'onUpdate:modelValue', 2);
      const inputs = view.findAll('ElInput');
      const nameInput = inputs.find((node) =>
        String(node.props['placeholder']).includes('environment variable name')
      )!;
      const valueInput = inputs.find((node) =>
        String(node.props['placeholder']).includes('secret value')
      )!;
      await trigger(nameInput, 'onUpdate:modelValue', 'CI_TOKEN');
      await trigger(valueInput, 'onUpdate:modelValue', 'new-secret-value');
      await trigger(button(view, 'Save'), 'onClick');
      expect(request).toHaveBeenCalledWith('/api/environment-secrets', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'ORGANIZATION',
          name: 'CI_TOKEN',
          value: 'new-secret-value',
          organizationId: 2,
          visibility: 'PRIVATE'
        })
      });
    } finally {
      view.unmount();
    }
  });

  it('opens OAuth provider details without exposing the client secret and confirms status changes', async () => {
    const provider = {
      providerKey: 'corp-login',
      name: 'Corporate login',
      clientId: 'client-id',
      clientSecret: 'must-not-render',
      authorizationEndpoint: 'https://identity.example.test/authorize',
      tokenEndpoint: 'https://identity.example.test/token',
      userinfoEndpoint: 'https://identity.example.test/userinfo',
      scopes: ['openid', 'profile'],
      mappings: { externalUserId: '/sub', email: '/email', displayName: '/name' },
      pkceMode: 'S256',
      tokenAuthMethod: 'client_secret_post',
      autoProvisioningEnabled: false,
      enabled: true,
      testedAt: 1
    };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/oauth-providers') return { providers: [provider] };
      if (path.endsWith('/enabled') && init?.method === 'POST') return {};
      throw new Error(`Unexpected request: ${path}`);
    });
    const confirm = vi.spyOn(ElMessageBox, 'confirm');
    confirm.mockRejectedValueOnce('cancel').mockResolvedValue('confirmed' as never);
    const view = renderComponent(OAuthManagementPage, {
      request: request as never,
      writable: true
    });
    try {
      await flushComponent();
      const table = view.findAll('ElTable')[0]!;
      const actionCell = view
        .findAll('div')
        .find((node) => node.props['class'] === 'mar-row-actions');
      expect(actionCell).toBeDefined();
      const stopProviderRowClick = vi.fn();
      await trigger(actionCell!, 'onClick', { stopPropagation: stopProviderRowClick });
      expect(stopProviderRowClick).toHaveBeenCalledOnce();
      await trigger(table, 'onRowClick', provider);
      expect(textContent(view.root)).toContain(
        'https://console.example.test/api/oauth/corp-login/callback'
      );
      expect(textContent(view.root)).toContain('https://identity.example.test/authorize');
      expect(textContent(view.root)).not.toContain('must-not-render');
      const disable = button(view, 'Disable');
      await trigger(disable, 'onClick');
      expect(request).not.toHaveBeenCalledWith(
        '/api/oauth-providers/corp-login/enabled',
        expect.anything()
      );
      await trigger(disable, 'onClick');
      expect(request).toHaveBeenCalledWith('/api/oauth-providers/corp-login/enabled', {
        method: 'POST',
        body: '{"enabled":false}'
      });
    } finally {
      view.unmount();
    }
  });
});
