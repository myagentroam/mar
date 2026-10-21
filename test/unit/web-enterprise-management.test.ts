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
} from '../../ee/web/src/service/EnterpriseManagementService.js';
import { createWorkspaceRegistrationService } from '../../ee/web/src/service/WorkspaceRegistrationService.js';
import { createSkillCenterService } from '../../ee/web/src/service/SkillCenterService.js';
import {
  managementUrlValues,
  replaceManagementUrlValues
} from '../../ee/web/src/service/ManagementUrlService.js';
import { parseWorkbenchRoute } from '../../ee/web/src/util/workbench-route.js';
import { i18n } from '../../ee/web/src/service/LocalePreferenceService.js';
import { createEnterpriseManagementComposition } from '../../ee/web/src/composition/enterprise-management.js';
import type { AdminState } from '../../ee/web/src/service/AdminAuthService.js';
import type { ManagementPageContext } from '../../ee/web/src/service/ManagementComposition.js';

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
      const request = vi.fn(async () => ({ favorites: [], sources: [] }));
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
    const controllerSource = await readFile(
      resolve(process.cwd(), 'packages/web-core/src/service/WorkbenchPageController.ts'),
      'utf8'
    );
    const navigationStart = controllerSource.indexOf('const navigationItems = computed<');
    const navigationEnd = controllerSource.indexOf(
      'const sidebarContentVisible = computed',
      navigationStart
    );
    const navigationSource = controllerSource.slice(navigationStart, navigationEnd);
    expect(navigationSource).not.toContain("{ id: 'skills'");
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

  it('Resource authorization buttons share one grant action label', async () => {
    const sources = await Promise.all(
      [
        'ee/web/src/view/settings/ResourceManagementPanel.vue',
        'ee/web/src/view/settings/MarAgentModelManagementPage.vue',
        'ee/web/src/view/settings/ConversationTemplateManagementPage.vue'
      ].map((path) => readFile(resolve(process.cwd(), path), 'utf8'))
    );

    for (const source of sources) {
      const grantSource = source.includes('ResourceGrantExtension')
        ? source +
          (await readFile(
            resolve(process.cwd(), 'ee/web/src/view/settings/ResourceGrantExtension.vue'),
            'utf8'
          ))
        : source.includes('ModelGrantExtension')
          ? source +
            (await readFile(
              resolve(process.cwd(), 'ee/web/src/view/settings/ModelGrantExtension.vue'),
              'utf8'
            ))
          : source;
      expect(grantSource.match(/translate\('common\.grant'\)/gu) ?? []).toHaveLength(2);
    }
    expect(i18n.global.t('common.grant')).toBe('授权');
    i18n.global.locale.value = 'en-US';
    expect(i18n.global.t('common.grant')).toBe('Grant');
  });
  it('MAR Agent model pages use management action layouts and readable protocol, status, and test feedback', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'packages/web-core/src/view/settings/MarAgentModelManagementPage.vue'),
      'utf8'
    );

    const extension = await readFile(
      resolve(process.cwd(), 'ee/web/src/view/settings/MarAgentModelManagementPage.vue'),
      'utf8'
    );
    const grants = await readFile(
      resolve(process.cwd(), 'ee/web/src/view/settings/ModelGrantExtension.vue'),
      'utf8'
    );
    const ownership = await readFile(
      resolve(process.cwd(), 'ee/web/src/service/ModelCredentialOwnershipService.ts'),
      'utf8'
    );
    expect(source).toContain('class="table-actions"');
    expect(source).toContain('class="row-actions"');
    expect(source).toContain(':loading="testingIds.has(row.id)"');
    expect(source).toContain("translate('marAgentModels.protocolOpenAI')");
    expect(source).toContain("translate('marAgentModels.protocolAnthropic')");
    expect(source).toContain("'marAgentModels.testAuthFailed'");
    expect(source).toContain('class="model-enabled"');
    expect(source).toContain("translate('marAgentModels.adjustOrder')");
    expect(source).toContain("'/api/admin/mar-agent/models/order'");
    expect(source).toContain("translate('marAgentModels.adjustPersonalOrder')");
    expect(source).toContain("'/api/mar-agent/models/order'");
    expect(grants).toContain("resourceType: 'MODEL'");
    expect(grants).toContain('modelId: row.id');
    expect(extension).toContain("'marAgentModels.public'");
    expect(extension).toContain("'marAgentModels.restricted'");
    expect(grants).toContain('/api/resource-grants');
    expect(source).toContain(':draggable="sorting"');
    expect(source).toContain('CodexLoginAttemptPoller');
    expect(source).toContain('createCodexCredentialManagementService');
    expect(source).toContain('eligibleMarAgentTransportTestNodes');
    expect(source).toContain('defaultReasoningEffort: ReasoningEffort');
    expect(source).toContain("defaultReasoningEffort: 'medium'");
    expect(source).toContain('defaultReasoningEffort: model.defaultReasoningEffort');
    expect(source).toContain('defaultReasoningEffort: draft.defaultReasoningEffort');
    expect(source).toContain(
      'draft.defaultReasoningEffort = resolveMarAgentDefaultReasoningEffort('
    );
    expect(source).toContain('v-model="draft.defaultReasoningEffort"');
    expect(source).toContain('v-model="draft.titleGeneration"');
    expect(source).toContain("translate('marAgentModels.titleGeneration')");
    expect(source).toContain('v-model="draft.codeMode"');
    expect(source).toContain("translate('marAgentModels.codeMode')");
    expect(source).toContain("translate('marAgentModels.defaultReasoningEffort')");
    expect(source).toContain('{{ row.defaultReasoningEffort }}');
    expect(source).toContain("translate('marAgentModels.codexCatalogReasoningDefault')");
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
    expect(source).toContain('name="models"');
    expect(source).toContain('name="codexCredentials"');
    expect(source).toContain('const canManageModels = computed(() =>');
    expect(source).toContain('v-if="canManageModels"');
    expect(extension).toContain('edition:');
    expect(extension).toContain('role:');
    expect(extension).toContain('organizationId:');
    expect(extension).toContain('credentialDraft.ownerType');
    expect(source).toContain("translate('marAgentModels.codexCredentialScope')");
    expect(source).toContain("translate('marAgentModels.codexCredentialScopePersonal')");
    expect(ownership).toContain(
      "return translate('marAgentModels.codexCredentialScopeOrganization', {"
    );
    expect(extension).toContain(
      "translate('marAgentModels.codexCredentialScopeOrganizationOption')"
    );
    expect(extension).toContain("translate('marAgentModels.organization')");
    expect(source).toContain('type ProtocolChoice = ReturnType<typeof modelProtocolChoice>');
    expect(source).toContain("translate('marAgentModels.protocolCodex')");
    expect(source).toContain('value="CODEX"');
    expect(source).toContain('isOAuthProtocol(draft.protocol)');
    expect(source).toContain('draft.responsesTransport');
    expect(source).not.toContain('responsesEncoding');
    expect(source).toContain("serviceTier: 'default'");
    expect(source).toContain(
      "serviceTier: model.serviceTier ?? (model.fastMode === true ? 'priority' : 'default')"
    );
    expect(source).toContain('...(codex ? { serviceTier: draft.serviceTier } : {})');
    const fastModeLabel = source.indexOf(':label="translate(\'marAgentModels.serviceTier\')"');
    const fastModeFieldStart = source.lastIndexOf('<el-form-item', fastModeLabel);
    const fastModeField = source.slice(
      fastModeFieldStart,
      source.indexOf('</el-form-item>', fastModeLabel)
    );
    expect(fastModeField).toContain('v-if="isOAuthProtocol(draft.protocol)"');
    expect(fastModeField).toContain('v-model="draft.serviceTier"');
    const transportLabel = source.indexOf(':label="translate(\'marAgentModels.transport\')"');
    const transportFieldStart = source.lastIndexOf('<el-form-item', transportLabel);
    const transportField = source.slice(
      transportFieldStart,
      source.indexOf('</el-form-item>', transportLabel)
    );
    expect(transportLabel).toBeGreaterThan(transportFieldStart);
    expect(transportField).toContain('v-if="isOAuthProtocol(draft.protocol)"');
    expect(source).toContain(
      "draft.responsesTransport = isOAuthProtocol(protocol) ? { transport: 'WEBSOCKET' } : undefined"
    );
    expect(source).toContain('...(codex && draft.responsesTransport !== undefined');
    expect(source).toContain('credentialService.credentialDetails(');
    expect(source).toContain('credentialService.credentialUsage(');
    expect(source).toContain('credentialService.testModel(');
    expect(source).toContain("result.message ?? translate('marAgentModels.testConnectionFailed')");
    expect(source).not.toContain("result.code === 'MAR_AGENT_MODEL_AUTH_FAILED'");
    expect(source).toContain('credentialService.loadCatalog(');
    expect(source).toContain('credentialService.importModels(');
    expect(source).toContain(':label="credential.name"');
    expect(source).toContain("translate('marAgentModels.codexCatalogReasoningSupported')");
    expect(source).toContain("translate('marAgentModels.codexCatalogReasoningUnsupported')");
    expect(source).not.toContain('v-model="draft.credentialType"');
    expect(source).not.toContain('catalogTransportChoice(');
    expect(source).not.toContain('setCatalogTransport(');
    expect(source).not.toContain(
      ':label="`${credential.name} · ${credentialStatusLabel(credential.status)}`"'
    );
    expect(source).not.toContain('allowPrimary');
    expect(source).not.toContain('allowSubagent');
    expect(source).not.toContain('>{{ scope.row.protocol }}</');
    const modelDataBinding = source.indexOf(':data="models"');
    const modelTableStart = source.lastIndexOf('<el-table', modelDataBinding);
    expect(modelDataBinding).toBeGreaterThanOrEqual(0);
    const modelTable = source.slice(
      modelTableStart,
      source.indexOf('</el-table>', modelTableStart)
    );
    expect(modelTable).not.toContain("translate('marAgentModels.credential')");
    expect(modelTable).not.toContain("translate('marAgentModels.transport')");

    const credentialDataBinding = source.indexOf(':data="credentials"');
    const credentialTableStart = source.lastIndexOf('<el-table', credentialDataBinding);
    expect(credentialDataBinding).toBeGreaterThanOrEqual(0);
    expect(credentialTableStart).toBeGreaterThanOrEqual(0);
    const credentialTable = source.slice(
      credentialTableStart,
      source.indexOf('</el-table>', credentialTableStart)
    );
    expect(credentialTable).not.toContain("translate('marAgentModels.codexProxy')");
    expect(credentialTable).not.toContain("translate('marAgentModels.codexImportedModels')");
    expect(credentialTable).toContain("translate('marAgentModels.codexCredentialScope')");
    expect(credentialTable).toContain('@row-click="openCredentialDetails"');
    expect(credentialTable).toContain('testCredential(row)');
    expect(credentialTable).toContain('openCredentialEdit(row)');
    expect(credentialTable).not.toContain('openCredentialLogin(row)');
    expect(credentialTable).not.toContain('openCatalog(row)');
    expect(credentialTable).toContain('removeCredential(row)');
    expect(credentialTable).toContain(`:loading="credentialActionIs(row.id, 'EDIT')"`);
    expect(credentialTable).toContain(`:loading="credentialActionIs(row.id, 'TEST')"`);
    expect(credentialTable).toContain(`:loading="credentialActionIs(row.id, 'REMOVE')"`);
    expect(credentialTable).toContain(':disabled="credentialActionBusy(row.id)"');
    expect(credentialTable).not.toContain(':loading="credentialActionIds.has(row.id)"');

    const credentialEditStart = source.indexOf('v-if="credentialDialog"');
    const credentialEditDialog = source.slice(
      credentialEditStart,
      source.indexOf('</el-dialog>', credentialEditStart)
    );
    expect(extension).toContain(
      `v-if="edition === 'ENTERPRISE' && (role === 'ADMIN' || role === 'ORG_ADMIN')"`
    );
    expect(extension).toContain(
      `v-if="canSelectOrganization || modelOwnership.draft.ownerType === 'ORGANIZATION'"`
    );
    const credentialEdit = source.slice(
      source.indexOf('async function openCredentialEdit'),
      source.indexOf('async function submitCredentialLogin')
    );
    const submitCredential = source.slice(
      source.indexOf('async function submitCredentialLogin'),
      source.indexOf('function resetCredentialDialog')
    );
    expect(source).toContain(
      "type ActiveTab = 'modelOrder' | 'models' | 'codexCredentials' | 'imageGeneration'"
    );
    expect(source).toContain('ImageGenerationManagement');
    expect(credentialEdit).not.toContain('imageModelId');
    expect(submitCredential).not.toContain('imageModelId');
    expect(submitCredential).toContain(
      'ownership: props.credentialOwnership?.() ?? credentialOwnershipValue.value'
    );
    expect(credentialEditDialog).not.toContain('v-model="credentialDraft.imageModelId"');
    expect(source).toContain('name="imageGeneration"');

    const credentialDetailsStart = source.indexOf('v-if="credentialDetailOpen"');
    const credentialDetails = source.slice(
      credentialDetailsStart,
      source.indexOf('</el-dialog>', credentialDetailsStart)
    );
    expect(source).toContain('const selectedCredentialDetails = ref<CodexCredentialDetails>();');
    expect(source).toContain('const selectedCredentialUsage = ref<CodexCredentialUsage>();');
    expect(source).toContain('function formatUsageStatsTimeZone');
    expect(source).toContain('const loginAttemptRefreshing = ref(false);');
    expect(source).toContain('async function openCredentialDetails');
    expect(source).toContain('async function refreshLoginAttempt');
    expect(source).toContain('await loginPoller.refresh();');
    expect(credentialDetails).toContain('selectedCredentialDetails.socks5Url');
    expect(credentialDetails).toContain('selectedCredentialUsage.windows');
    expect(credentialDetails).toContain('selectedCredentialUsage.profile.lifetimeTokens');
    expect(credentialDetails).toContain('selectedCredentialUsage.profile.currentDayTokens');
    expect(credentialDetails).toContain('selectedCredentialUsage.profile.lastSevenDaysTokens');
    expect(credentialDetails).toContain('selectedCredentialUsage.profile.statsAsOf');
    expect(credentialDetails).toContain(
      'formatUsageStatsTimeZone(selectedCredentialUsage.profile.statsAsOf)'
    );
    expect(credentialDetails).not.toContain('selectedCredentialUsage.profile.generatedAt');
    expect(credentialDetails).not.toContain('dailyUsageBuckets');
    expect(credentialDetails).toContain('runnerUsageWindowLabel(window)');
    expect(credentialDetails).toContain('loadCredentialUsage(');
    expect(credentialDetails).toContain(':icon="DataAnalysis"');
    expect(credentialDetails).toContain(':icon="Key"');
    expect(credentialDetails).not.toContain('openCredentialEdit(');
    expect(credentialDetails).toContain('refreshCredential(');
    expect(credentialDetails).not.toContain('testCredential(');
    expect(credentialDetails).toContain('openCredentialLogin(');
    expect(credentialDetails).toContain('openCatalog(');
    expect(credentialDetails).not.toContain('removeCredential(');
    expect(credentialDetails).not.toContain('codexImportedModels');
    expect(credentialDetails).not.toContain('codexMetadata');
    expect(source).not.toContain('customJson');
    expect(source).not.toContain('parseCustomMetadata');
    expect(source).not.toContain('marAgentModels.codexFedramp');

    const loginAttemptDialogStart = source.indexOf('v-if="loginAttemptDialog && loginAttempt"');
    const loginAttemptDialog = source.slice(
      loginAttemptDialogStart,
      source.indexOf('</el-dialog>', loginAttemptDialogStart)
    );
    expect(loginAttemptDialog).toContain('@click="refreshLoginAttempt"');
    expect(loginAttemptDialog).toContain(':loading="loginAttemptRefreshing"');
    expect(loginAttemptDialog).toContain("translate('marAgentModels.codexRefreshLoginStatus')");

    const refreshCredential = source.slice(
      source.indexOf('async function refreshCredential'),
      source.indexOf('async function testCredential')
    );
    expect(refreshCredential).toContain(
      'const refreshed = await credentialService.refreshCredential(credential.id);'
    );
    expect(refreshCredential).toContain('credential: refreshed');

    const catalogTableStart = source.indexOf('<el-table :data="catalogRows"');
    const catalogTable = source.slice(
      catalogTableStart,
      source.indexOf('</el-table>', catalogTableStart)
    );
    expect(catalogTable).not.toContain("translate('marAgentModels.availability')");
    expect(catalogTable).not.toContain('v-model="row.enabled"');
    expect(source).toMatch(/\.table-actions\s*\{[^}]*margin-bottom:\s*\d+px;/u);
  });
  it('Node detail actions share the Codex credential action-area and close-button layout', async () => {
    const [nodeDetails, credentialDetails] = await Promise.all([
      readFile(
        resolve(process.cwd(), 'packages/web-core/src/view/settings/NodeDetailsDialogs.vue'),
        'utf8'
      ),
      readFile(
        resolve(
          process.cwd(),
          'packages/web-core/src/view/settings/MarAgentModelManagementPage.vue'
        ),
        'utf8'
      )
    ] as const);
    const nodeDialogStart = nodeDetails.indexOf('v-if="nodeOpen"');
    const nodeDialog = nodeDetails.slice(
      nodeDialogStart,
      nodeDetails.indexOf('</el-dialog>', nodeDialogStart)
    );
    const credentialDialogStart = credentialDetails.indexOf('v-if="credentialDetailOpen"');
    const credentialDialog = credentialDetails.slice(
      credentialDialogStart,
      credentialDetails.indexOf('</el-dialog>', credentialDialogStart)
    );

    expect(credentialDialog).toContain('class="credential-detail-actions"');
    expect(nodeDialog).toContain('class="node-detail-actions"');
    expect(nodeDialog).toContain("translate('generated.resourceSharingPage.pushUpgrade2')");
    expect(nodeDialog).toContain("translate('generated.resourceSharingPage.cancelUpgrade')");
    expect(nodeDialog.indexOf('class="node-detail-actions"')).toBeLessThan(
      nodeDialog.indexOf("emit('update:nodeOpen', false)")
    );
    expect(nodeDialog).not.toContain('class="node-detail-footer"');
    expect(nodeDialog).toMatch(/<\/div>\s*<el-button\s+@click="emit\('update:nodeOpen', false\)"/u);
    const nodeActionsStart = nodeDialog.indexOf('class="node-detail-actions"');
    const nodeActions = nodeDialog.slice(
      nodeActionsStart,
      nodeDialog.indexOf('</div>', nodeActionsStart)
    );
    expect(nodeActions).toMatch(/<el-button\s+v-if="upgrade\?\.canUpgrade"\s+:icon="Upload"/u);
    expect(nodeActions).not.toMatch(/<el-button\s+v-if="upgrade\?\.canUpgrade"\s+type="primary"/u);
    expect(nodeActions).toMatch(/<el-button\s+v-if="upgrade\?\.waitingForRuns"\s+:icon="Close"/u);
    expect(nodeActions).not.toContain('type="primary"');
    expect(nodeDetails).toMatch(/\.node-detail-actions\s*\{[^}]*margin-bottom:\s*12px;/u);
    expect(nodeDetails).not.toContain('.node-detail-footer');
  });
  it('Node detail hosting fields provide enable and disable actions with icons', async () => {
    const [nodeDetails, enterpriseNodeDetails, resourceHosting, enterpriseResourceHosting] =
      await Promise.all([
        readFile(
          resolve(
            process.cwd(),
            'packages/web-core/src/view/settings/HostingNodeDetailsDialogs.vue'
          ),
          'utf8'
        ),
        readFile(resolve(process.cwd(), 'ee/web/src/view/settings/NodeDetailsDialogs.vue'), 'utf8'),
        readFile(
          resolve(process.cwd(), 'packages/web-core/src/service/ResourceHostingService.ts'),
          'utf8'
        ),
        readFile(resolve(process.cwd(), 'ee/web/src/service/ResourceHostingService.ts'), 'utf8')
      ] as const);
    const hostingDescription = nodeDetails.slice(
      nodeDetails.indexOf('<template #node-properties>'),
      nodeDetails.indexOf('</template>', nodeDetails.indexOf('<template #node-properties>'))
    );
    const hostingMutations = resourceHosting.slice(
      resourceHosting.indexOf('async function enableConversationHosting'),
      resourceHosting.length
    );

    expect(hostingDescription).toContain('<el-button');
    expect(hostingDescription).toContain('class="hosting-enablement-actions"');
    expect(hostingDescription).toContain('v-if="!hosting.enabled"');
    expect(hostingDescription).toContain("emit('enableHosting')");
    expect(hostingDescription).toContain('v-else');
    expect(hostingDescription).toContain("emit('disableHosting')");
    expect(hostingDescription).toContain(':icon="CircleCheck"');
    expect(hostingDescription).toContain(':icon="CircleClose"');
    expect(hostingDescription).toContain('type="primary"');
    expect(hostingDescription).toContain('type="warning"');
    expect(nodeDetails).toContain('ConversationHostingMaintenanceCard');
    expect(nodeDetails).toContain('v-if="');
    expect(nodeDetails).toContain('hosting.enabled');
    expect(enterpriseNodeDetails).toContain(
      "import CoreDialogs from '@myagentroam/web-core/HostingNodeDetailsDialogs.vue'"
    );
    expect(enterpriseNodeDetails).toContain('@enable-hosting="emit(\'enableHosting\')"');
    expect(enterpriseNodeDetails).toContain('@disable-hosting="emit(\'disableHosting\')"');
    expect(enterpriseNodeDetails).not.toContain('ConversationHostingMaintenanceCard');
    expect(enterpriseResourceHosting).toContain(
      "import { createResourceHostingService as createCore } from '@myagentroam/web-core/resource-hosting'"
    );
    expect(enterpriseResourceHosting).toContain("context().edition === 'COMMUNITY' ||");
    expect(enterpriseResourceHosting).toContain("row.ownership.ownerType === 'ORGANIZATION'");
    expect(hostingMutations).toContain('async function disableConversationHosting');
    expect(hostingMutations).toContain('await ElMessageBox.confirm(');
    expect(hostingMutations).toContain("translate('conversationHostingEnablement.enableConfirm')");
    expect(hostingMutations).toContain(
      "translate('conversationHostingEnablement.enableConfirmTitle')"
    );
    expect(hostingMutations).toContain("translate('conversationHostingEnablement.disableConfirm')");
    expect(hostingMutations).toContain(
      "translate('conversationHostingEnablement.disableConfirmTitle')"
    );
  });
  it('MAR Agent model pages ignore stale responses for closed or switched credential dialogs', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'packages/web-core/src/view/settings/MarAgentModelManagementPage.vue'),
      'utf8'
    );
    const credentialEdit = source.slice(
      source.indexOf('async function openCredentialEdit'),
      source.indexOf('async function submitCredentialLogin')
    );
    const credentialDetails = source.slice(
      source.indexOf('async function openCredentialDetails'),
      source.indexOf('function openCredentialLogin')
    );
    const openCredentialDetails = source.slice(
      source.indexOf('async function openCredentialDetails'),
      source.indexOf('async function loadCredentialUsage')
    );
    const credentialUsage = source.slice(
      source.indexOf('async function loadCredentialUsage'),
      source.indexOf('function resetCredentialDetails')
    );
    const catalogLoad = source.slice(
      source.indexOf('async function openCatalog'),
      source.indexOf('async function importCatalogModels')
    );

    expect(source).toContain('let credentialEditSequence = 0;');
    expect(credentialEdit).toContain('const sequence = ++credentialEditSequence;');
    expect(credentialEdit).toContain('if (sequence !== credentialEditSequence) return;');
    expect(source).toContain('credentialEditSequence += 1;');
    expect(source).toContain('let credentialDetailSequence = 0;');
    expect(credentialDetails).toContain('const sequence = ++credentialDetailSequence;');
    expect(credentialDetails).toContain('if (sequence !== credentialDetailSequence');
    expect(credentialDetails).toContain('credentialDetailSequence += 1;');
    expect(openCredentialDetails).toContain('credentialUsageLoading.value = false;');
    expect(source).toContain('watch(credentialDetailOpen');
    expect(credentialUsage).toContain('const sequence = credentialDetailSequence;');
    expect(credentialUsage).toContain('if (sequence !== credentialDetailSequence');
    expect(credentialDetails).toContain('selectedCredentialUsage.value = undefined;');
    expect(source).toContain('let catalogSequence = 0;');
    expect(catalogLoad).toContain('const sequence = ++catalogSequence;');
    expect(catalogLoad).toContain('if (sequence !== catalogSequence) return;');
    expect(source).toContain('catalogSequence += 1;');
  });
  it('Workbench supplies live Node lists to MAR Agent model management', () => {
    const context = managementContext(managementStates[0]!);
    const page = createEnterpriseManagementComposition().resolve('mar-agent-models', context.admin);
    expect(page.props(context).nodes).toBe(context.nodes);
    const refreshed = { ...context, nodes: [...context.nodes] };
    expect(refreshed.nodes).not.toBe(context.nodes);
    expect(page.props(refreshed).nodes).toBe(refreshed.nodes);
  });
  it('Enterprise members and organization administrators enter only the Codex credential view', () => {
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
  it('Conversation template pages reuse management layouts and provide publication, grant, and history actions', async () => {
    const [source, extension] = await Promise.all([
      readFile(
        resolve(
          process.cwd(),
          'packages/web-core/src/view/settings/ConversationTemplateManagementPage.vue'
        ),
        'utf8'
      ),
      readFile(
        resolve(process.cwd(), 'ee/web/src/view/settings/ConversationTemplateManagementPage.vue'),
        'utf8'
      )
    ]);

    expect(source).toContain('class="management-page conversation-template-management"');
    expect(source).toContain('class="table-actions"');
    expect(source).toContain('class="row-actions"');
    expect(source).not.toContain("<h2>{{ translate('conversationTemplates.title') }}</h2>");
    expect(source).toContain('service.publish(');
    expect(source).toContain('service.publishStatus(');
    expect(source).toContain('detail.versions');
    expect(source).toContain('row.publishedVersion');
    expect(source).not.toContain('detail.publishJobs');
    expect(source).not.toContain('r{{ row.draftRevision }}');
    expect(source).toContain('createManagementPaginationService');
    expect(source).toContain('managementPageItems');
    expect(source).toContain('<ManagementPagination');
    expect(source).toContain('class="clickable-rows"');
    expect(source).toContain('@row-click="openDetail"');
    expect(source).toContain('@click="detailDialogOpen = false"');
    expect(extension).toContain(
      "import CorePage from '@myagentroam/web-core/ConversationTemplateManagementPage.vue'"
    );
    expect(extension).toContain('v-bind="props"');
    expect(extension).toContain("node.ownership?.ownerType === 'ORGANIZATION'");
    expect(extension).toContain("edition === 'COMMUNITY'");
    expect(extension).toContain('service.listGrants(');
    expect(extension).toContain('service.createGrant(');
    expect(extension).toContain('service.removeGrant(');
    expect(extension).toContain("targetType: 'ORGANIZATION'");
    expect(extension).not.toContain(
      "const targetType = ref<'USER' | 'ORGANIZATION' | 'ENTERPRISE'>"
    );
    expect(extension).not.toContain("'/api/enterprise/users'");
    const grantDialog = extension.slice(
      extension.indexOf('v-if="grantDialogOpen && selectedTemplate"'),
      extension.indexOf(
        '</el-dialog>',
        extension.indexOf('v-if="grantDialogOpen && selectedTemplate"')
      )
    );
    expect(grantDialog).not.toContain('value="ENTERPRISE"');
    expect(grantDialog).not.toContain('value="USER"');
    expect(grantDialog).toContain('v-model="targetOrganizationId"');
    expect(extension).toContain(">{{ translate('common.grant') }}</el-button");
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

  it('Ownership and grant displays use organization names with ID fallback instead of empty labels', async () => {
    for (const [file, expression] of [
      [
        'EnvironmentSecretManager',
        'organizationDisplayLabel(props.organizations ?? [], secret.organizationId)'
      ],
      ['ResourceGrantExtension', 'organizationDisplayLabel(props.organizations, id)'],
      ['ModelGrantExtension', 'organizationDisplayLabel(organizations.value, organizationId)']
    ]) {
      const source = await readFile(
        resolve(process.cwd(), `ee/web/src/view/settings/${file}.vue`),
        'utf8'
      );
      expect(source).toContain(expression);
    }
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

  it('Secret and OAuth management tables expose read-only information through row details', async () => {
    const [secretSource, secretCore, oauthSource] = await Promise.all(
      [
        'ee/web/src/view/settings/EnvironmentSecretManager.vue',
        'packages/web-core/src/view/settings/EnvironmentSecretManager.vue',
        'ee/web/src/view/settings/OAuthManagementPage.vue'
      ].map((path) => readFile(resolve(process.cwd(), path), 'utf8'))
    );

    expect(secretSource).toContain('organizationCascaderOptions');
    expect(secretSource).toContain('<el-cascader');
    expect(secretCore).toContain('@row-click="openSecretDetails"');
    expect(secretCore).toContain('<el-descriptions');
    expect(secretCore).toContain('<div class="row-actions" @click.stop>');
    expect(oauthSource).toContain('class="clickable-rows oauth-provider-table"');
    expect(oauthSource).toContain('@row-click="openProviderDetails"');
    expect(oauthSource).toContain('<el-descriptions');
    expect(oauthSource).toContain('<div class="row-actions" @click.stop>');
  });

  it('Skill, MCP, and OAuth status changes require confirmation and source selection shares a row with search', async () => {
    const [skillSource, mcpSource, oauthSource] = await Promise.all(
      [
        'packages/web-core/src/view/skill/SkillSourceManagementPage.vue',
        'packages/web-core/src/view/skill/McpSourceManagementPage.vue',
        'ee/web/src/view/settings/OAuthManagementPage.vue'
      ].map((path) => readFile(resolve(process.cwd(), path), 'utf8'))
    );

    expect(skillSource).toContain('class="source-search-bar"');
    expect(skillSource).toContain('confirmSourceStatusChange');
    expect(mcpSource).toContain('class="source-search-bar"');
    expect(mcpSource).toContain('confirmSourceStatusChange');
    expect(oauthSource).toContain('confirmProviderStatusChange');
  });

  it('Management organization forms and filters use searchable hierarchical cascaders with scalar IDs', async () => {
    const [
      skillSource,
      mcpSource,
      userManagement,
      resourceManagement,
      resourceFilters,
      conversationTemplates,
      modelManagement,
      secretManagement
    ] = await Promise.all([
      readFile(
        resolve(process.cwd(), 'ee/web/src/view/skill/SkillSourceManagementPage.vue'),
        'utf8'
      ),
      readFile(resolve(process.cwd(), 'ee/web/src/view/skill/McpSourceManagementPage.vue'), 'utf8'),
      readFile(
        resolve(process.cwd(), 'ee/web/src/view/settings/EnterpriseUserManagementPage.vue'),
        'utf8'
      ),
      readFile(
        resolve(process.cwd(), 'ee/web/src/view/settings/ResourceManagementPanel.vue'),
        'utf8'
      ),
      readFile(
        resolve(process.cwd(), 'ee/web/src/view/settings/ResourceManagementFilters.vue'),
        'utf8'
      ),
      readFile(
        resolve(process.cwd(), 'ee/web/src/view/settings/ConversationTemplateManagementPage.vue'),
        'utf8'
      ),
      readFile(
        resolve(process.cwd(), 'ee/web/src/view/settings/MarAgentModelManagementPage.vue'),
        'utf8'
      ),
      readFile(
        resolve(process.cwd(), 'ee/web/src/view/settings/EnvironmentSecretManager.vue'),
        'utf8'
      )
    ] as const);

    for (const source of [
      skillSource,
      mcpSource,
      userManagement,
      resourceManagement,
      conversationTemplates,
      modelManagement,
      secretManagement
    ]) {
      expect(source).toContain(
        source === skillSource || source === mcpSource
          ? 'createCatalogOwnershipService'
          : source === modelManagement
            ? 'createModelCredentialOwnershipService'
            : source === resourceManagement
              ? 'createResourceOwnershipService'
              : 'organizationCascaderOptions'
      );
      expect(source).toContain(':props="{ checkStrictly: true, emitPath: false }"');
    }
    const expectOrganizationCascader = (
      source: string,
      model: string,
      options = 'organizationOptions'
    ) =>
      expect(source).toMatch(
        new RegExp(
          `<el-cascader(?=[^>]*v-model="${model}")(?=[^>]*filterable)(?=[^>]*:options="${options}")(?=[^>]*:props="\\{ checkStrictly: true, emitPath: false \\}")[^>]*>`,
          'u'
        )
      );
    expectOrganizationCascader(skillSource, 'sourceDraft\\.organizationId');
    expectOrganizationCascader(skillSource, 'catalogDraft\\.organizationId');
    expectOrganizationCascader(mcpSource, 'sourceDraft\\.organizationId');
    expectOrganizationCascader(mcpSource, 'catalogDraft\\.organizationId');
    expectOrganizationCascader(userManagement, 'userForm\\.organizationId');
    expectOrganizationCascader(resourceManagement, 'editOrganizationId');
    expectOrganizationCascader(resourceManagement, 'registrationOwner', 'registrationOwnerOptions');
    expectOrganizationCascader(
      await readFile(
        resolve(process.cwd(), 'ee/web/src/view/settings/ResourceGrantExtension.vue'),
        'utf8'
      ),
      'targetOrganizationId'
    );
    expectOrganizationCascader(resourceFilters, 'ownerOrganizationId');
    expectOrganizationCascader(conversationTemplates, 'targetOrganizationId');
    expectOrganizationCascader(
      await readFile(
        resolve(process.cwd(), 'ee/web/src/view/settings/ModelGrantExtension.vue'),
        'utf8'
      ),
      'targetOrganizationId'
    );
    expectOrganizationCascader(modelManagement, 'credentialDraft\\.ownerOrganizationId');
    expectOrganizationCascader(secretManagement, 'organizationId');
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

  it('Workspace registration through direct Node grants neither selects nor submits organization ownership', async () => {
    const [picker, surface] = await Promise.all([
      readFile(
        resolve(process.cwd(), 'ee/web/src/view/workspace/WorkspaceRegistrationPicker.vue'),
        'utf8'
      ),
      readFile(resolve(process.cwd(), 'ee/web/src/view/workbench/WorkbenchSurface.vue'), 'utf8')
    ]);
    expect(surface).toContain(
      ':workspace-creatable="page.workspaceRegistrationNode?.workspaceCreatable"'
    );
    expect(surface).toContain(':node-manageable="page.workspaceRegistrationNode?.manageable"');
    expect(picker).toContain('const fixedOrganizationOwnership = computed(');
    expect(picker).toContain('props.workspaceCreatable === true');
    expect(picker).toContain('props.nodeManageable === false');
    expect(picker).toContain('if (fixedOrganizationOwnership.value) {');
    expect(picker).toContain("emit('register');");
    expect(picker).toContain('v-else-if="fixedOrganizationOwnership"');
    expect(picker).toContain(
      'organizationDisplayLabel(organizations, nodeOwnership.ownerOrganizationId)'
    );
    expect(picker).toContain("if (!enterprise || props.role === 'MEMBER') return;");
    expect(picker).toContain('!fixedOrganizationOwnership');
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
