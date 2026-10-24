import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  enterpriseManagementAccess,
  oauthProviderInput,
  organizationCascaderOptions,
  organizationDisplayLabel,
  organizationPath,
  newOAuthProviderDraft,
  resourceEditBody,
  roleLabel
} from '../../ee/web/src/service/enterprise-management-service.js';
import { createWorkspaceRegistrationService } from '../../ee/web/src/service/workspace-registration-service.js';
import { createSkillCenterService } from '../../ee/web/src/service/skill-center-service.js';
import {
  managementUrlValues,
  replaceManagementUrlValues
} from '../../ee/web/src/service/management-url-service.js';
import { parseWorkbenchRoute } from '../../ee/web/src/util/workbench-route.js';
import { i18n } from '../../ee/web/src/service/locale-preference-service.js';
import { createEnterpriseManagementComposition } from '../../ee/web/src/composition/enterprise-management.js';
import type { AdminState } from '../../ee/web/src/service/admin-auth-service.js';
import type { ManagementPageContext } from '../../ee/web/src/service/management-composition.js';

const managementStates: readonly AdminState[] = [
  { authenticated: true, mustChangePassword: false, edition: 'COMMUNITY' },
  ...(['ADMIN', 'ORG_ADMIN', 'MEMBER'] as const).map((role) => ({
    authenticated: true,
    mustChangePassword: false,
    edition: 'ENTERPRISE' as const,
    role,
    organizationId: 7
  }))
];

function managementContext(admin: AdminState): ManagementPageContext {
  return {
    admin,
    request: async <T>() => undefined as T,
    nodes: [],
    onlineNodeCount: 0,
    serverVersion: '0.9.63'
  };
}

describe('Web enterprise management domain', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN';
  });
  it('Skill source extensions submit scalar organization ownership and reuse shared catalog refresh', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/api/skill-sources') return { sources: [] };
      if (path === '/api/skill-favorites') return { favorites: [] };
      throw new Error(`Unexpected request: ${path}`);
    });
    const service = createSkillCenterService(request as never);
    await service.addSource({
      name: 'Platform',
      locator: 'https://example.com/skills.git',
      scope: 'ORGANIZATION',
      organizationId: 3
    });
    expect(request).toHaveBeenCalledWith('/api/skill-sources', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'REPOSITORY',
        enabled: true,
        name: 'Platform',
        locator: 'https://example.com/skills.git',
        scope: 'ORGANIZATION',
        organizationId: 3
      })
    });
    expect(request).toHaveBeenCalledWith('/api/skill-sources');
    expect(service.loading.value).toBe(false);
  });
  it.each(['PERSONAL', 'ENTERPRISE', 'ORGANIZATION'] as const)(
    'Skill favorite ownership %s includes an organization ID only for organization scope',
    async (scope) => {
      const request = vi.fn(async () => ({
        favorites: [],
        sources: [],
        page: 1,
        pageSize: 20,
        total: 0,
        hasMore: false
      }));
      const service = createSkillCenterService(request as never);
      service.selectedSourceId.value = 'source';
      await service.favorite(
        {
          id: 'candidate',
          name: 'Example',
          description: '',
          source: 'source',
          skillPath: 'skills/example',
          installs: null
        },
        scope,
        3
      );
      expect(request).toHaveBeenCalledWith('/api/skill-favorites', {
        method: 'POST',
        body: JSON.stringify({
          sourceId: 'source',
          candidateId: 'candidate',
          skillPath: 'skills/example',
          featured: false,
          tags: [],
          scope,
          ...(scope === 'ORGANIZATION' ? { organizationId: 3 } : {})
        })
      });
      expect(service.loading.value).toBe(false);
    }
  );
  it('Restores management sections and filters from URLs and updates only the selected filter', () => {
    expect(
      parseWorkbenchRoute({ search: '?view=management&management=resource-nodes' } as Location)
    ).toMatchObject({ view: 'management', managementSection: 'resource-nodes' });
    expect(
      parseWorkbenchRoute({ search: '?view=management&management=skill-center' } as Location)
    ).toEqual({ view: 'management' });
    expect(
      parseWorkbenchRoute({ search: '?view=management&management=skill-config' } as Location)
    ).toMatchObject({ view: 'management', managementSection: 'skill-config' });
    expect(parseWorkbenchRoute({ search: '?view=skills&skill=mine' } as Location)).toEqual({});
    expect(
      parseWorkbenchRoute({ search: '?view=management&management=skill-sources' } as Location)
    ).toMatchObject({ view: 'management', managementSection: 'skill-sources' });
    expect(
      parseWorkbenchRoute({ search: '?view=management&management=mar-agent-models' } as Location)
    ).toMatchObject({ view: 'management', managementSection: 'mar-agent-models' });
    expect(
      parseWorkbenchRoute({
        search: '?view=management&management=conversation-templates'
      } as Location)
    ).toMatchObject({ view: 'management', managementSection: 'conversation-templates' });
    expect(parseWorkbenchRoute({ search: '?view=conversations' } as Location)).toMatchObject({
      view: 'conversations'
    });
    expect(
      parseWorkbenchRoute({
        search: '?view=conversations&node=node-1&conversation=conversation-1'
      } as Location)
    ).toMatchObject({
      view: 'conversations',
      hostedConversation: { nodeId: 'node-1', conversationId: 'conversation-1' }
    });
    expect(
      managementUrlValues('nodes', ['keyword', 'status'], {
        search: '?nodes.keyword=dev&nodes.status=online'
      } as Location)
    ).toEqual({ keyword: 'dev', status: 'online' });
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://mar.example/?view=management&nodes.keyword=old' },
      history: { replaceState }
    });
    replaceManagementUrlValues('nodes', { keyword: 'new', status: 'offline' });
    expect(replaceState.mock.calls[0]?.[2]).toContain('nodes.keyword=new');
    expect(replaceState.mock.calls[0]?.[2]).toContain('nodes.status=offline');
    vi.unstubAllGlobals();
  });

  it('Skill settings, Skill sources, MCP sources, and environment secrets are adjacent in management menus', async () => {
    const composition = createEnterpriseManagementComposition();
    for (const admin of managementStates) {
      const ids = composition.items(admin).map((item) => item.id);
      const orderedItems = [
        ...(admin.role === 'MEMBER' ? [] : ['resource-workspaces']),
        'skill-config',
        'skill-sources',
        'mcp-sources',
        'secrets'
      ];
      const start = ids.indexOf(admin.role === 'MEMBER' ? 'skill-config' : 'resource-workspaces');
      expect(start).toBeGreaterThanOrEqual(0);
      expect(ids.slice(start, start + orderedItems.length)).toEqual(orderedItems);
      expect(ids).not.toContain('skill-center');
    }
  });

  it('Conversation template grants use the localized shared action label', async () => {
    expect(i18n.global.t('common.grant')).toBe('授权');
    i18n.global.locale.value = 'en-US';
    expect(i18n.global.t('common.grant')).toBe('Grant');
  });
  it('provides bilingual model purpose and default reasoning labels', () => {
    expect(i18n.global.t('marAgentModels.defaultReasoningEffort')).toBe('默认思考强度');
    expect(i18n.global.t('marAgentModels.titleGeneration')).toBe('会话标题命名');
    expect(i18n.global.t('marAgentModels.codeMode')).toBe('Code Mode');
    expect(i18n.global.t('marAgentModels.codexCatalogReasoningDefault')).toBe('默认思考强度');
    i18n.global.locale.value = 'en-US';
    expect(i18n.global.t('marAgentModels.defaultReasoningEffort')).toBe('Default reasoning effort');
    expect(i18n.global.t('marAgentModels.titleGeneration')).toBe('Session title generation');
    expect(i18n.global.t('marAgentModels.codeMode')).toBe('Code Mode');
    expect(i18n.global.t('marAgentModels.codexCatalogReasoningDefault')).toBe(
      'Default reasoning effort'
    );
  });
  it('Node hosting details retain the public maintenance panel and EE adapter policy boundary', async () => {
    const [nodeDetails, enterpriseResourceHosting] = await Promise.all([
      readFile(
        resolve(process.cwd(), 'packages/web-core/src/view/settings/HostingNodeDetailsDialogs.vue'),
        'utf8'
      ),
      readFile(resolve(process.cwd(), 'ee/web/src/service/resource-hosting-service.ts'), 'utf8')
    ] as const);
    expect(nodeDetails).toContain('ConversationHostingMaintenanceCard');
    expect(enterpriseResourceHosting).toContain('@myagentroam/web-core/resource-hosting');
  });

  it('Workbench supplies live Node lists to MAR Agent model management', () => {
    const context = managementContext(managementStates[0]!);
    const page = createEnterpriseManagementComposition().resolve('mar-agent-models', context.admin);
    expect(page.props(context).nodes).toBe(context.nodes);
    const refreshed = { ...context, nodes: [...context.nodes] };
    expect(refreshed.nodes).not.toBe(context.nodes);
    expect(page.props(refreshed).nodes).toBe(refreshed.nodes);
  });
  it('Enterprise management descriptors preserve the current role and organization context', () => {
    const composition = createEnterpriseManagementComposition();
    for (const admin of managementStates) {
      expect(composition.items(admin).filter((item) => item.id === 'mar-agent-models')).toEqual([
        { id: 'mar-agent-models', labelKey: 'navigation.marAgentModels' }
      ]);
      expect(
        composition.resolve('mar-agent-models', admin).props(managementContext(admin))
      ).toMatchObject({
        edition: admin.edition ?? 'COMMUNITY',
        role: admin.role ?? null,
        organizationId: admin.organizationId ?? null
      });
    }
  });
  it('Template extensions retain the public page boundary and bilingual domain messages', async () => {
    const extension = await readFile(
      resolve(process.cwd(), 'ee/web/src/view/settings/ConversationTemplateManagementPage.vue'),
      'utf8'
    );
    expect(extension).toContain('@myagentroam/web-core/ConversationTemplateManagementPage.vue');
    expect(extension).not.toContain("'/api/enterprise/users'");
    expect(extension).not.toContain("resourceType: 'MODEL'");
    expect(i18n.global.t('conversationTemplates.edit')).toBe('编辑');
    expect(i18n.global.t('conversationTemplates.errorSourceImmutable')).toBe(
      '模板来源创建后不可修改；请新建模板以使用其他来源。'
    );
    i18n.global.locale.value = 'en-US';
    expect(i18n.global.t('navigation.conversations')).toBe('Chat');
    expect(i18n.global.t('navigation.conversationTemplates')).toBe('Chat Templates');
    expect(i18n.global.t('conversationTemplates.title')).toBe('Chat Templates');
    expect(i18n.global.t('conversationTemplates.edit')).toBe('Edit');
    expect(i18n.global.t('conversationTemplates.errorSourceImmutable')).toBe(
      'The template source cannot change after creation. Create a new template for another source.'
    );
  });
  it('Enterprise roles use one Chinese display-name mapping', () => {
    expect(roleLabel('ADMIN')).toBe('系统管理员');
    expect(roleLabel('ORG_ADMIN')).toBe('组织管理员');
    expect(roleLabel('MEMBER')).toBe('成员');
  });

  it('Resource editing always uses the active edit name and carries organization ownership separately', () => {
    expect(
      resourceEditBody({
        resourceType: 'NODE',
        displayName: '  研发节点  ',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
        ownerOrganizationId: 2
      })
    ).toEqual({
      displayName: '研发节点',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 2 }
    });
    expect(
      resourceEditBody({
        resourceType: 'NODE',
        displayName: '   ',
        ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
      })
    ).toEqual({ displayName: null });
  });
  it('Community and enterprise MEMBER users see management while frozen state retains read-only access and License import', () => {
    expect(
      enterpriseManagementAccess({
        edition: 'COMMUNITY',
        licenseState: 'COMMUNITY',
        role: null,
        managementWritable: true
      })
    ).toEqual({ visible: true, writable: true, licenseImportable: true });
    expect(
      enterpriseManagementAccess({
        edition: 'ENTERPRISE',
        licenseState: 'ENTERPRISE_VALID',
        role: 'MEMBER',
        managementWritable: true
      }).visible
    ).toBe(true);
    expect(
      enterpriseManagementAccess({
        edition: 'ENTERPRISE',
        licenseState: 'ENTERPRISE_FROZEN',
        role: 'ORG_ADMIN',
        managementWritable: false
      })
    ).toEqual({ visible: true, writable: false, licenseImportable: true });
  });

  it('Organization paths follow ancestor chains and terminate safely on cycles', () => {
    const organizations = [
      { id: 1, name: '企业根', parentOrganizationId: null },
      { id: 2, name: '研发', parentOrganizationId: 1 },
      { id: 3, name: '平台', parentOrganizationId: 2 }
    ];
    expect(organizationPath(organizations, 3)).toBe('企业根 / 研发 / 平台');
    expect(organizationDisplayLabel(organizations, 3)).toBe('企业根 / 研发 / 平台');
    expect(organizationDisplayLabel(organizations, 99)).toBe('99');
    expect(organizationDisplayLabel([], 3)).toBe('3');
    expect(organizationDisplayLabel([{ id: 3, name: '平台', parentOrganizationId: 2 }], 3)).toBe(
      '平台'
    );
    expect(
      organizationPath(
        [
          { id: 2, name: 'A', parentOrganizationId: 3 },
          { id: 3, name: 'B', parentOrganizationId: 2 }
        ],
        2
      )
    ).toBe('B / A');
  });

  it('Organization cascading selectors share one hierarchy and permit any organization node as the value', () => {
    expect(
      organizationCascaderOptions([
        { id: 1, name: '企业根', parentOrganizationId: null },
        { id: 2, name: '研发', parentOrganizationId: 1 },
        { id: 3, name: '平台', parentOrganizationId: 2 },
        { id: 4, name: '独立组织', parentOrganizationId: null }
      ])
    ).toEqual([
      {
        value: 1,
        label: '企业根',
        children: [
          {
            value: 2,
            label: '研发',
            children: [{ value: 3, label: '平台', children: [] }]
          }
        ]
      },
      { value: 4, label: '独立组织', children: [] }
    ]);
  });

  it('Organization cascading selectors retain orphaned and cyclic organizations as selectable roots', () => {
    expect(
      organizationCascaderOptions([
        { id: 1, name: '孤儿', parentOrganizationId: 99 },
        { id: 2, name: '循环 A', parentOrganizationId: 3 },
        { id: 3, name: '循环 B', parentOrganizationId: 2 }
      ])
    ).toEqual([
      { value: 1, label: '孤儿', children: [] },
      { value: 2, label: '循环 A', children: [] },
      { value: 3, label: '循环 B', children: [] }
    ]);
  });

  it('New OAuth sources disable automatic account creation by default and generate provider-specific callbacks', () => {
    const draft = newOAuthProviderDraft('feishu', 'https://mar.example');
    expect(draft).toMatchObject({
      providerKey: 'feishu',
      callbackUri: 'https://mar.example/api/oauth/feishu/callback',
      autoProvisioningEnabled: false,
      pkceMode: 'REQUIRED',
      mappings: { externalUserId: '/id' }
    });
    expect(draft.userinfoEndpoint).toBe('');
    expect(draft).not.toHaveProperty('emailTrustMode');
  });

  it('OAuth saves include only protocol fields and preserve the existing Secret during edits', () => {
    const draft = {
      ...newOAuthProviderDraft('feishu', 'https://mar.example'),
      name: '飞书',
      clientId: 'client-id',
      clientSecret: '',
      authorizationEndpoint: 'https://accounts.feishu.cn/authorize',
      tokenEndpoint: 'https://open.feishu.cn/token',
      userinfoEndpoint: 'https://open.feishu.cn/userinfo',
      scopes: ['openid', ''],
      mappings: { externalUserId: '/data/open_id', email: '  ', displayName: '/data/name' },
      enabled: true,
      testedAt: 1
    };
    expect(oauthProviderInput(draft)).toEqual({
      providerKey: 'feishu',
      name: '飞书',
      clientId: 'client-id',
      authorizationEndpoint: 'https://accounts.feishu.cn/authorize',
      tokenEndpoint: 'https://open.feishu.cn/token',
      userinfoEndpoint: 'https://open.feishu.cn/userinfo',
      scopes: ['openid'],
      pkceMode: 'REQUIRED',
      tokenAuthMethod: 'client_secret_basic',
      autoProvisioningEnabled: false,
      mappings: { externalUserId: '/data/open_id', displayName: '/data/name' }
    });
  });

  it('Workspace registration submits ownership and converts temporary candidates into a parent path and one-level name', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const service = createWorkspaceRegistrationService({
      targetNodeId: { value: 'node-a' } as never,
      globalLoading: { value: false } as never,
      request: async (path, init) => {
        requests.push({ path, ...(init === undefined ? {} : { init }) });
        return { workspace: { id: 'workspace-created' } } as never;
      },
      onRegistered: async () => undefined,
      notice: () => undefined,
      error: () => undefined,
      errorMessage: String
    });
    service.path.value = '/workspace';
    await service.register({ ownerType: 'ORGANIZATION', ownerOrganizationId: 2 });
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      nodeId: 'node-a',
      path: '/workspace',
      preserveGitConfig: false,
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 2 }
    });

    service.path.value = '/personal';
    await service.register({ ownerType: 'PERSONAL' });
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
      nodeId: 'node-a',
      path: '/personal',
      preserveGitConfig: false
    });

    service.directory.value = {
      homePath: '/home/node',
      currentPath: '/home/node',
      parentPath: null,
      browseRoots: ['/home/node'],
      selectable: true,
      entries: [],
      truncated: false
    };
    service.selectPendingDirectory('new-project');
    expect(service.selectedPathValid.value).toBe(true);
    await service.register({ ownerType: 'PERSONAL' });
    expect(JSON.parse(String(requests[2]!.init?.body))).toEqual({
      nodeId: 'node-a',
      path: '/home/node',
      preserveGitConfig: false,
      createDirectoryName: 'new-project'
    });
  });

  it('Directory navigation accepts only the latest response and ignores in-flight results after reset', async () => {
    type Result = {
      directory: {
        homePath: string;
        currentPath: string;
        parentPath: string | null;
        browseRoots: string[];
        selectable: boolean;
        entries: never[];
        truncated: boolean;
      };
    };
    const resolvers: Array<(value: Result) => void> = [];
    const service = createWorkspaceRegistrationService({
      targetNodeId: { value: 'node-a' } as never,
      globalLoading: { value: false } as never,
      request: () => new Promise<Result>((resolve) => resolvers.push(resolve)) as never,
      onRegistered: async () => undefined,
      notice: () => undefined,
      error: () => undefined,
      errorMessage: String
    });
    const listing = (currentPath: string): Result => ({
      directory: {
        homePath: '/home/node',
        currentPath,
        parentPath: '/home/node',
        browseRoots: ['/home/node'],
        selectable: true,
        entries: [],
        truncated: false
      }
    });

    const first = service.load('/home/node/first');
    const second = service.load('/home/node/second');
    resolvers[1]!(listing('/home/node/second'));
    await second;
    resolvers[0]!(listing('/home/node/first'));
    await first;
    expect(service.directory.value?.currentPath).toBe('/home/node/second');

    const staleAfterReset = service.load('/home/node/stale');
    service.reset();
    resolvers[2]!(listing('/home/node/stale'));
    await staleAfterReset;
    expect(service.directory.value).toBeUndefined();
    expect(service.loadingDirectory.value).toBe(false);
  });
});
