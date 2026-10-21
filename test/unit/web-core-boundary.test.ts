import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { createWorkbenchWorkspaceTreeController } from '../../ee/web/src/service/WorkbenchWorkspaceTreeController.js';
import { createWorkbenchLiveService as publicLiveService } from '../../packages/web-core/src/service/WorkbenchLiveService';
import { createWorkbenchLiveService as enterpriseLiveService } from '../../ee/web/src/service/WorkbenchLiveService';
import {
  localePreferenceService,
  translate
} from '../../ee/web/src/service/LocalePreferenceService';

const root = 'packages/web-core';
const read = (path: string) => readFileSync(path, 'utf8');
describe('single shared Web implementation', () => {
  it('shares complete model, credential and image flows with private ownership and grant extensions', () => {
    const page = read(`${root}/src/view/settings/MarAgentModelManagementPage.vue`);
    expect(page).not.toMatch(
      /props\.edition|props\.role|\/api\/organizations|\/api\/resource-grants|ownerOrganizationId/u
    );
    for (const slot of [
      'credential-ownership',
      'model-actions',
      'model-access-column',
      'model-access-details',
      'model-extensions'
    ]) {
      expect(page).toContain(`name="${slot}"`);
    }
    const adapter = read('ee/web/src/view/settings/MarAgentModelManagementPage.vue');
    expect(adapter).toContain('@myagentroam/web-core/MarAgentModelManagementPage.vue');
    expect(adapter).toContain('ModelGrantExtension');
    expect(adapter).toContain('createModelCredentialOwnershipService');
    expect(adapter).toMatch(/onMounted\(\(\) => \{\s*void ownership\.loadOrganizations\(\);/u);
    expect(adapter).toContain('ownership.label(model.ownership)');
    expect(adapter).not.toMatch(/CodexLoginAttemptPoller|\/api\/admin\/mar-agent/u);
    expect(existsSync('ee/web/src/view/settings/ImageGenerationManagement.vue')).toBe(false);
    expect(read('ee/web/src/service/CodexCredentialManagementService.ts')).toBe(
      "export * from '@myagentroam/web-core/codex-credential-management';\n"
    );
  });

  it('uses public Skill and MCP source pages with ownership-only enterprise adapters', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const name of ['SkillSourceManagementPage', 'McpSourceManagementPage']) {
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/skill/${name}.vue`);
      expect(read(`${root}/src/view/skill/${name}.vue`)).not.toMatch(
        /@\/|ORGANIZATION|ENTERPRISE|organizationId/u
      );
      const adapter = read(`ee/web/src/view/skill/${name}.vue`);
      expect(adapter).toContain(`@myagentroam/web-core/${name}.vue`);
      expect(adapter).toContain('createCatalogOwnershipService');
      expect(adapter).not.toContain('<el-table');
      expect(adapter).not.toContain('check-update');
    }
  });

  it('shares secret and system configuration pages while keeping organization and audit extensions private', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const name of [
      'EnvironmentSecretManager',
      'SecretManagementPage',
      'SystemConfigurationPage'
    ]) {
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/settings/${name}.vue`);
      expect(read(`${root}/src/view/settings/${name}.vue`)).not.toMatch(
        /@\/|organizationId|ORGANIZATION|ENTERPRISE|audit-retention|auditRetentionDays/u
      );
      const host = read(`ee/web/src/view/settings/${name}.vue`);
      expect(host).toContain(`@myagentroam/web-core/${name}.vue`);
      expect(host).not.toContain('<el-table');
    }
    expect(read('ee/web/src/service/EnvironmentSecretService.ts')).toContain(
      '@myagentroam/web-core/environment-secrets'
    );
    expect(read(`${root}/src/service/EnvironmentSecretService.ts`)).not.toMatch(
      /organizationId|visibility|ORGANIZATION|ENTERPRISE/u
    );
    expect(read('ee/web/src/view/settings/SystemConfigurationPage.vue')).toContain(
      "key: 'audit-retention'"
    );
    expect(read('ee/web/src/service/ManagementUrlService.ts')).toContain(
      '@myagentroam/web-core/management-url'
    );
  });

  it('uses public workbench shell components with host-supplied management IDs and version', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const [directory, name] of [
      ['workbench', 'WorkbenchHeader'],
      ['workbench', 'WorkbenchNavigation'],
      ['workbench', 'WebPerformanceIndicator'],
      ['workspace', 'WorkspaceTree'],
      ['workspace', 'WorkspaceTabs'],
      ['workspace', 'WorkspaceSessionList'],
      ['workspace', 'WorkspaceSessionCleanupDialog']
    ]) {
      expect(existsSync(`ee/web/src/view/${directory}/${name}.vue`)).toBe(false);
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/${directory}/${name}.vue`);
      expect(read(`${root}/src/view/${directory}/${name}.vue`)).not.toMatch(
        /@\/|@myagentroam-enterprise|__MAR_WEB_VERSION__|ownerOrganizationId|\/api\/organizations/u
      );
    }
    expect(read(`${root}/src/view/workbench/WorkbenchNavigation.vue`)).toContain(
      'readonly webVersion: string'
    );
    expect(read('packages/web-core/src/view/workbench/WorkbenchPage.vue')).toContain(
      ':web-version="page.webVersion"'
    );
    expect(read(`${root}/src/service/McpCenterService.ts`)).not.toMatch(
      /ENTERPRISE|ORGANIZATION|PERSONAL/u
    );
    expect(read('ee/web/src/service/McpCenterService.ts')).toContain(
      "from '@myagentroam/web-core/mcp-center'"
    );
  });

  it('shares the Hosted client while keeping template management and Server admission private', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const [file, entry] of [
      ['HostedConversationEntryService', 'hosted-conversation-entry'],
      ['HostedConversationWorkspaceService', 'hosted-conversation-workspace'],
      ['HostedConversationFilePreviewService', 'hosted-conversation-file-preview'],
      ['HostedConversationFileTreeService', 'hosted-conversation-file-tree'],
      ['WorkbenchClockService', 'workbench-clock']
    ]) {
      expect(manifest.exports[`./${entry}`]).toBe(`./src/service/${file}.ts`);
      expect(read(`ee/web/src/service/${file}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
      expect(read(`${root}/src/service/${file}.ts`)).not.toMatch(
        /@myagentroam-enterprise|ConversationTemplateService|\/api\/admin\/|resource-grants/u
      );
    }
    for (const name of [
      'HostedConversationComposer',
      'HostedConversationEntryPage',
      'HostedConversationWorkspacePage'
    ]) {
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/conversation/${name}.vue`);
      expect(existsSync(`ee/web/src/view/conversation/${name}.vue`)).toBe(false);
      expect(read(`${root}/src/view/conversation/${name}.vue`)).not.toMatch(
        /from ['"]@\/|@myagentroam-enterprise|new WebSocket|\/api\/admin\//u
      );
    }
    const templateManagement = read('ee/web/src/service/ConversationTemplateService.ts');
    expect(templateManagement).toContain('@myagentroam/web-core/conversation-template-management');
    expect(templateManagement).toContain('...createCore(request)');
    expect(templateManagement).not.toContain("request<unknown>('/api/conversation-templates')");
    expect(templateManagement).toContain('/api/resource-grants');
    const commonTemplateManagement = read(`${root}/src/service/ConversationTemplateService.ts`);
    expect(commonTemplateManagement).toContain('listAvailableConversationTemplates(request)');
    expect(commonTemplateManagement).toContain('/api/admin/conversation-templates');
    expect(commonTemplateManagement).not.toContain('/api/resource-grants');
    expect(read('packages/web-core/src/view/workbench/WorkbenchSurface.vue')).toContain(
      '../../view/conversation/HostedConversationWorkspacePage.vue'
    );
    const nodeFeatures = read(`${root}/src/util/node-features.ts`);
    expect(nodeFeatures).toContain("export const FEATURE_DEMO = '__feature-demo__';");
    expect(nodeFeatures).toContain("[FEATURE_DEMO]: { introducedIn: '0.9.119' }");
    expect(nodeFeatures).not.toContain("'hosted-conversation-rollback'");
  });

  it('shares Conversation views, rendering and scroll/image state without private implementation copies', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const [name, folder] of [
      ['ConversationHeader', 'conversation'],
      ['ConversationScroll', 'conversation'],
      ['ConversationTimeline', 'conversation'],
      ['ImagePreviewDialogs', 'conversation'],
      ['AgentMarkdown', 'common']
    ]) {
      expect(existsSync(`ee/web/src/view/${folder}/${name}.vue`)).toBe(false);
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/${folder}/${name}.vue`);
      expect(read(`${root}/src/view/${folder}/${name}.vue`)).not.toMatch(
        /from ['"]@\/|@myagentroam-enterprise|fetch\(|new WebSocket|PageController/u
      );
    }
    for (const [file, entry] of [
      ['service/ConversationScrollService', 'conversation-scroll'],
      ['service/ConversationImageService', 'conversation-images'],
      ['util/conversation-presentation', 'conversation-presentation'],
      ['util/conversation-domain', 'conversation-domain']
    ]) {
      expect(read(`ee/web/src/${file}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
      expect(manifest.exports[`./${entry}`]).toBe(`./src/${file}.ts`);
    }
    for (const [file, prefix] of [
      ['packages/web-core/src/view/workbench/WorkbenchSurface.vue', '../../view/conversation/'],
      [`${root}/src/view/conversation/HostedConversationWorkspacePage.vue`, './']
    ]) {
      expect(read(file!)).toContain(`${prefix}ConversationTimeline.vue`);
      expect(read(file!)).toContain(`${prefix}ConversationScroll.vue`);
    }
    expect(read(`${root}/src/util/workbench-presentation.ts`)).toContain(
      "export { absoluteMessageTime } from './conversation-presentation.js'"
    );
    expect(read('ee/web/src/util/workbench-presentation.ts')).not.toContain(
      'export function absoluteMessageTime'
    );
  });

  it('composes one public Workspace Inspector with the existing page-owned subscriptions', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    expect(existsSync('ee/web/src/view/workspace/WorkspaceInspector.vue')).toBe(false);
    expect(manifest.exports['./WorkspaceInspector.vue']).toBe(
      './src/view/workspace/WorkspaceInspector.vue'
    );
    expect(read('packages/web-core/src/view/workbench/WorkbenchSurface.vue')).toContain(
      '../../view/workspace/WorkspaceInspector.vue'
    );
    const inspector = read(`${root}/src/view/workspace/WorkspaceInspector.vue`);
    expect(inspector).toContain('readonly subscriptionSnapshot?');
    expect(inspector).not.toMatch(
      /from ['"]@\/|@myagentroam-enterprise|HostedConversation|new WebSocket|createWorkspaceWatchService|createSessionWatchService/u
    );
    expect(read('ee/web/src/util/trailing-task.ts')).toBe(
      "export * from '@myagentroam/web-core/trailing-task';\n"
    );
    const presentation = read(`${root}/src/util/workbench-presentation.ts`);
    expect(presentation).toContain('./file-presentation.js');
    expect(presentation).not.toMatch(/function (?:currentChangesBranch|fileSizeLabel)\(/u);
  });

  it('shares file preview, editing and Diff views without private implementation copies', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const name of [
      'GitDiffViewer',
      'CodeFileEditor',
      'MarkdownFilePreview',
      'PdfFilePreview',
      'InlineFindBar',
      'StandaloneFilePreviewPage'
    ]) {
      expect(existsSync(`ee/web/src/view/workspace/${name}.vue`)).toBe(false);
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/workspace/${name}.vue`);
      expect(read(`${root}/src/view/workspace/${name}.vue`)).not.toMatch(
        /from ['"]@\/|enterprise-web|HostedConversation|\/api\/hosted-conversations/u
      );
    }
    expect(read('ee/web/src/bootstrap.ts')).toContain(
      '@myagentroam/web-core/StandaloneFilePreviewPage.vue'
    );
    for (const [file, componentImport] of [
      [
        `${root}/src/view/workspace/WorkspaceInspector.vue`,
        "import WorkspaceTextFilePage from './WorkspaceTextFilePage.vue';"
      ],
      [
        `${root}/src/view/conversation/HostedConversationWorkspacePage.vue`,
        "import WorkspaceTextFilePage from '../workspace/WorkspaceTextFilePage.vue';"
      ]
    ]) {
      expect(read(file!)).toContain(componentImport!);
    }
    for (const [path, entry] of [
      ['service/FileEditorPreferenceService', 'file-editor-preference'],
      ['service/MarkdownPreviewPreferenceService', 'markdown-preview-preference'],
      ['util/file-preview', 'file-preview'],
      ['util/markdown-preview', 'markdown-preview'],
      ['util/mobile-preview-pinch-zoom', 'mobile-preview-pinch-zoom']
    ]) {
      expect(read(`ee/web/src/${path}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
      expect(manifest.exports[`./${entry}`]).toBe(`./src/${path}.ts`);
    }
  });

  it('shares file navigation, icon preferences and local assets without private copies', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const [name, folder] of [
      ['FileTypeIcon', 'workspace'],
      ['WorkspaceFileTree', 'workspace'],
      ['QuickOpenDialog', 'workspace'],
      ['ComposerFileReferencePicker', 'composer']
    ]) {
      expect(existsSync(`ee/web/src/view/${folder}/${name}.vue`)).toBe(false);
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/${folder}/${name}.vue`);
    }
    expect(existsSync('ee/web/src/icon-themes')).toBe(false);
    expect(read('ee/web/src/service/IconThemePreferenceService.ts')).toBe(
      "export * from '@myagentroam/web-core/icon-theme-preference';\n"
    );
    expect(read('ee/web/src/service/WorkspaceFileTreeService.ts')).toBe(
      "export * from '@myagentroam/web-core/workspace-file-tree';\n"
    );
    expect(read(`${root}/src/view/workspace/WorkspaceInspector.vue`)).toContain(
      './WorkspaceFileTree.vue'
    );
    expect(read('packages/web-core/src/view/workspace/WorkspaceRegistrationPicker.vue')).toContain(
      "import FileTypeIcon from '../workspace/FileTypeIcon.vue'"
    );
    expect(read('packages/web-core/src/view/workbench/WorkbenchPage.vue')).toContain(
      '../../view/workspace/QuickOpenDialog.vue'
    );
    expect(read('packages/web-core/src/view/workbench/WorkbenchSurface.vue')).toContain(
      '../../view/composer/ComposerFileReferencePicker.vue'
    );
    expect(read('mar-web-console/vite.config.ts')).toContain(
      '@myagentroam/web-core/build/third-party-notices'
    );
    expect(JSON.parse(read('mar-web-console/package.json')).devDependencies).toMatchObject({
      '@myagentroam/web-core': 'workspace:*'
    });
    expect(read('mar-web-console/vite.config.ts')).not.toContain('ee/web/src/icon-themes');
    expect(read(`${root}/vite.config.mts`)).toContain('thirdPartyNoticesPlugin');
  });

  it('composes the same public Composer views in ordinary and hosted conversations', () => {
    const components = [
      'ConversationComposer',
      'ComposerToolbar',
      'ComposerQueue',
      'ComposerAttachments',
      'ComposerCommandPicker'
    ];
    const manifest = JSON.parse(read(`${root}/package.json`));
    const surface = read('packages/web-core/src/view/workbench/WorkbenchSurface.vue');
    for (const name of components) {
      expect(existsSync(`ee/web/src/view/composer/${name}.vue`)).toBe(false);
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/composer/${name}.vue`);
      expect(surface).toContain(`../../view/composer/${name}.vue`);
      const source = read(`${root}/src/view/composer/${name}.vue`);
      expect(source).not.toMatch(/PageController|fetch\(|new WebSocket|from ['"]@\//u);
    }
    expect(read(`${root}/src/view/conversation/HostedConversationComposer.vue`)).toContain(
      '../composer/ConversationComposer.vue'
    );
  });

  it('tracks shared locale changes in enterprise translation state', () => {
    const preference = localePreferenceService();
    const previous = preference.locale.value;
    try {
      preference.setLocale('zh-CN');
      expect(translate('generated.sessionPresentation.newSession')).toBe('新建会话');
      expect(translate('navigation.help')).toBe('帮助');
      expect(translate('generated.oAuthManagementPage.saveAndDisable')).toBe('保存并停用');
      preference.setLocale('en-US');
      expect(translate('generated.sessionPresentation.newSession')).toBe('New Session');
      expect(translate('navigation.help')).toBe('Help');
      expect(translate('generated.oAuthManagementPage.saveAndDisable')).toBe('Save and disable');
    } finally {
      preference.setLocale(previous);
    }
  });

  it('builds public pages without enterprise imports, messages or API clients', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    expect(manifest.name).toBe('@myagentroam/web-core');
    expect(manifest.dependencies['@myagentroam/protocol']).toBe('workspace:*');
    const inspect = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) inspect(path);
        else if (/\.(?:ts|vue)$/u.test(path)) {
          const text = read(path);
          expect(text).not.toMatch(
            /@myagentroam-enterprise|packages\/enterprise-|\/api\/(?:oauth|organizations|enterprise|license|resource-grants)|enterpriseLogin|orEnterprise/u
          );
          expect(text).not.toMatch(/from ['"]@\//u);
        }
      }
    };
    inspect(`${root}/src`);
  });

  it('keeps ordinary page services and presentation in the public implementation', () => {
    const entries = {
      'service/WorkspaceSessionService': 'workspace-session',
      'service/WorkbenchPageLifecycleService': 'page-lifecycle',
      'service/WorkbenchEventProjectionService': 'event-projection',
      'service/WebPerformanceDiagnosticService': 'performance-diagnostics',
      'service/WorkbenchCapabilityService': 'capability-service',
      'service/WorkbenchEntityService': 'entity-service',
      'service/WorkbenchEntityController': 'entity-controller',
      'service/WorkbenchPresentationStateService': 'presentation-state',
      'service/WorkbenchPageInteractionService': 'page-interaction',
      'service/WorkbenchNewSessionController': 'new-session-controller',
      'service/RunnerUsageService': 'runner-usage',
      'util/workbench-presentation': 'workbench-presentation',
      'util/workbench-guards': 'workbench-guards',
      'util/session-list': 'session-list'
    };
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const [name, entry] of Object.entries(entries)) {
      expect(read(`ee/web/src/${name}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
      expect(manifest.exports[`./${entry}`]).toBe(`./src/${name}.ts`);
      expect(read(`${root}/src/${name}.ts`)).not.toMatch(
        /@\/|@myagentroam-enterprise|\/api\/organizations|ownerOrganizationId|ENTERPRISE_LICENSE/u
      );
    }
  });

  it('uses one public notification, upload and update client implementation', () => {
    for (const [name, entry] of [
      ['WorkbenchNotificationService', 'notifications'],
      ['WorkbenchNotificationNavigationService', 'notification-navigation'],
      ['WorkspaceUploadService', 'workspace-upload'],
      ['WebVersionUpdateService', 'web-version-update']
    ]) {
      expect(read(`ee/web/src/service/${name}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
    }
    expect(existsSync('ee/web/src/view/workbench/WorkbenchNotificationCenter.vue')).toBe(false);
    expect(read(`${root}/src/view/workbench/WorkbenchNavigation.vue`)).toContain(
      './WorkbenchNotificationCenter.vue'
    );
  });

  it('keeps enterprise page assembly limited to explicit shared page extensions', () => {
    const controller = read('ee/web/src/service/WorkbenchPageController.ts');
    expect(controller).toContain('@myagentroam/web-core/page-controller');
    expect(controller).toContain('submitWorkspaceRegistration,');
    expect(controller).not.toContain('createWorkspaceWatchService');
    const surface = read('ee/web/src/view/workbench/WorkbenchSurface.vue');
    expect(surface).toContain('@myagentroam/web-core/WorkbenchSurface.vue');
    expect(surface).toContain('#workspace-registration');
    expect(surface).toContain('#management-notice');
    expect(surface).not.toContain('ConversationTimeline');
    const page = read('ee/web/src/view/workbench/WorkbenchPage.vue');
    expect(page).toContain('@myagentroam/web-core/WorkbenchPage.vue');
    expect(page).toContain('EnterpriseLoginExtension');
    expect(page).not.toContain('class="console-shell"');
    expect(page).not.toContain('class="sidebar-scrim"');
  });

  it('uses shared gates and a private OAuth extension instead of duplicate login pages', () => {
    expect(existsSync('ee/web/src/view/auth/LoginPage.vue')).toBe(false);
    expect(existsSync('ee/web/src/view/auth/PasswordGate.vue')).toBe(false);
    expect(read('packages/web-core/src/view/workbench/WorkbenchPage.vue')).toContain(
      '../../view/LoginPage.vue'
    );
    expect(read(`${root}/src/view/LoginPage.vue`)).toContain('<slot name="identity-extension"');
    expect(read('ee/web/src/view/auth/EnterpriseLoginExtension.vue')).toContain(
      '/api/oauth/providers'
    );
    expect(read('ee/web/src/service/AdminAuthService.ts')).not.toContain("'/api/auth/login'");
  });

  it('shares locale and registry mechanisms but keeps product page IDs and messages private', () => {
    expect(read('ee/web/src/service/LocalePreferenceService.ts')).not.toContain('createI18n');
    expect(read('ee/web/src/service/LocalePreferenceService.ts')).toContain(
      'registerLocaleMessages(messages)'
    );
    expect(read('ee/web/src/service/ManagementComposition.ts')).not.toContain('new Map');
    expect(read(`${root}/src/service/ManagementComposition.ts`)).not.toMatch(
      /['"](?:organizations|users|oauth|audit|conversation-templates)['"]/u
    );
    expect(existsSync('ee/web/src/view/settings/SystemInformationPage.vue')).toBe(false);
    expect(read(`${root}/src/view/SystemInformationPage.vue`)).not.toMatch(/license|License/u);
    expect(read(`${root}/src/view/SystemInformationPage.vue`)).toContain(
      "emit('extensionChanged')"
    );
    expect(read('packages/web-core/src/view/workbench/WorkbenchSurface.vue')).toContain(
      '@extension-changed="page.refreshAdmin"'
    );
    expect(read('packages/web-core/src/service/WorkbenchPageController.ts')).toContain(
      'invalidateRequests: workbenchHttpService.invalidateAuthentication'
    );
  });

  it('uses the shared shell, bootstrap and styles rather than a second application implementation', () => {
    expect(existsSync('ee/web/src/App.vue')).toBe(false);
    const bootstrap = read('ee/web/src/bootstrap.ts');
    expect(bootstrap).toContain("from '@myagentroam/web-core/bootstrap'");
    expect(bootstrap).toContain('documentationAvailable: true');
    expect(bootstrap).not.toMatch(/createApp|app\.mount|serviceWorker\.register/u);
    expect(read('ee/web/src/service/ThemePreferenceService.ts')).toContain(
      "export * from '@myagentroam/web-core/theme'"
    );
    expect(read('ee/web/src/styles.css')).not.toContain('--mar-bg-page');
    expect(read(`${root}/src/styles.css`)).not.toContain('enterprise-frozen-banner');
    expect(read(`${root}/src/App.vue`)).not.toMatch(
      /MarketingHomePage|WorkbenchPage|StandaloneFilePreviewPage/u
    );
  });

  it('shares the Hosted lifecycle adapter without duplicating the generic Watch coordinator', () => {
    const common = read(`${root}/src/service/WorkbenchWatchCoordinator.ts`);
    expect(common).not.toMatch(/hosted|Hosted|conversation-templates|\/api\//u);
    const adapter = read(`${root}/src/service/HostedConversationWatchCoordinator.ts`);
    expect(adapter).toContain("from './WorkbenchWatchCoordinator.js'");
    expect(adapter).not.toMatch(/let reconcile|let trailing|function enqueue/u);
    expect(read('ee/web/src/service/WorkbenchWatchCoordinator.ts')).toContain(
      "from '@myagentroam/web-core/hosted-watch-coordinator'"
    );
  });

  it('reuses the public realtime connection without a second enterprise socket implementation', () => {
    expect(enterpriseLiveService).toBe(publicLiveService);
    const adapter = read('ee/web/src/service/WorkbenchLiveService.ts');
    expect(adapter).toContain("from '@myagentroam/web-core/live'");
    expect(adapter).not.toMatch(/new WebSocket|setInterval|addEventListener/u);
    expect(read(`${root}/src/service/WorkbenchLiveService.ts`)).toContain(
      "new URL('/api/workbench/live', window.location.origin)"
    );
  });

  it('shares Workspace subscriptions and leases without importing enterprise ownership models', () => {
    expect(read('ee/web/src/service/WorkspaceWatchService.ts')).toBe(
      "export * from '@myagentroam/web-core/workspace-watch';\n"
    );
    expect(read('ee/web/src/service/WatchLeaseLifecycleService.ts')).toBe(
      "export * from '@myagentroam/web-core/watch-lease';\n"
    );
    expect(read(`${root}/src/service/WorkspaceWatchService.ts`)).not.toMatch(
      /ownership|ORGANIZATION|ownerOrganizationId|model\/workbench/u
    );
  });

  it('shares native Session observation and models while keeping resource ownership and navigation private', () => {
    expect(read('ee/web/src/service/WorkbenchSessionWatchController.ts')).toBe(
      "export * from '@myagentroam/web-core/session-watch-controller';\n"
    );
    expect(read('ee/web/src/util/conversation-segments.ts')).toBe(
      "export * from '@myagentroam/web-core/conversation-segments';\n"
    );
    expect(read(`${root}/src/model/workbench.ts`)).not.toMatch(
      /ownership|ORGANIZATION|ownerOrganizationId|ManagementSection|WorkbenchView/u
    );
    const enterpriseModel = read('ee/web/src/model/workbench.ts');
    expect(enterpriseModel).toContain('Workspace extends CoreWorkspace');
    expect(enterpriseModel).toContain("ownerType: 'ORGANIZATION'");
    expect(enterpriseModel).not.toContain('interface Session');
    expect(enterpriseModel).not.toContain('interface ConversationTurn');
    expect(read(`${root}/src/service/WorkbenchSessionWatchController.ts`)).not.toMatch(
      /hosted|Hosted|conversation-templates/u
    );
    for (const locale of ['en-US', 'zh-CN']) {
      expect(read(`ee/web/src/i18n/messages.generated.${locale}.ts`)).not.toMatch(
        /'sessionPresentation\.[^']+':/u
      );
    }
  });

  it('keeps conversation and Run projection plus workspace caches in the public dependency graph', () => {
    for (const [file, entry] of [
      ['RunService', 'run-state'],
      ['ConversationStateService', 'conversation-state'],
      ['ConversationProjectionService', 'conversation-projection'],
      ['WorkbenchConversationSnapshotService', 'conversation-snapshot'],
      ['WorkspaceViewCacheService', 'workspace-cache'],
      ['WorkspaceRuntimeStateService', 'workspace-runtime']
    ]) {
      expect(read(`ee/web/src/service/${file}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
      expect(read(`${root}/src/service/${file}.ts`)).not.toMatch(
        /HostedConversation|\/api\/|ownerOrganizationId/u
      );
    }
    expect(read('ee/web/src/util/conversation-history.ts')).toBe(
      "export * from '@myagentroam/web-core/conversation-history';\n"
    );
  });

  it('shares Composer state and public version gates without including enterprise features', () => {
    for (const [file, entry] of [
      ['RunnerProfileService', 'runner-profile'],
      ['RunnerInteractionService', 'runner-interaction'],
      ['ComposerConfigurationService', 'composer-configuration'],
      ['WorkbenchComposerController', 'composer-controller'],
      ['ComposerQueueService', 'composer-queue'],
      ['ComposerSkillService', 'composer-skills'],
      ['FileReferenceService', 'file-reference'],
      ['QuickPromptService', 'quick-prompts'],
      ['WorkbenchComposerInteractionController', 'composer-interaction']
    ]) {
      expect(read(`ee/web/src/service/${file}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
    }
    const nodeFeatures = read(`${root}/src/util/node-features.ts`);
    expect(nodeFeatures).toContain("export const FEATURE_DEMO = '__feature-demo__';");
    expect(nodeFeatures).toContain("[FEATURE_DEMO]: { introducedIn: '0.9.119' }");
    expect(nodeFeatures).not.toContain("'conversation-hosting'");
    expect(read('ee/web/src/util/node-features.ts')).toContain(
      "from '@myagentroam/web-core/node-features'"
    );
    for (const locale of ['en-US', 'zh-CN']) {
      expect(read(`ee/web/src/i18n/messages.generated.${locale}.ts`)).not.toMatch(
        /'(?:runnerProfileService|workbenchComposerController)\.[^']+':/u
      );
    }
  });

  it('reuses public draft, paging, refresh and skill state without private implementations', () => {
    for (const [file, entry] of [
      ['WorkspaceSessionPagingService', 'session-paging'],
      ['SessionDraftService', 'session-draft'],
      ['SessionSnapshotRefreshService', 'snapshot-refresh'],
      ['ComposerSkillTokenService', 'skill-tokens'],
      ['EffectiveWorkspaceSkillService', 'effective-skills']
    ]) {
      expect(read(`ee/web/src/service/${file}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
    }
    expect(read('ee/web/src/service/WorkbenchSelectionStateService.ts')).toContain(
      'createSharedSelection<Workspace>()'
    );
    expect(read(`${root}/src/service/WorkbenchSelectionStateService.ts`)).not.toMatch(
      /ownership|Organization|Hosted/u
    );
  });

  it('keeps neutral selection recovery separate from public routes and private management identifiers', () => {
    for (const file of [
      'WorkbenchNavigationService',
      'WorkbenchNavigationWatchService',
      'WorkbenchSelectionPersistenceService'
    ]) {
      expect(read(`packages/web-core/src/service/${file}.ts`)).not.toMatch(
        /HostedConversation|hostedConversation|['"]conversations['"]|['"]users['"]|['"]organizations['"]|parseWorkbenchRoute/u
      );
    }
    expect(read('ee/web/src/service/WorkbenchRouteService.ts')).toContain(
      '@myagentroam/web-core/route-service'
    );
    expect(read('ee/web/src/service/WorkbenchRouteService.ts')).not.toMatch(
      /localStorage|pendingRestores|function restoreSession/u
    );
    expect(read(`${root}/src/service/WorkbenchRouteService.ts`)).toContain(
      "from './WorkbenchSelectionPersistenceService.js'"
    );
    expect(read(`${root}/src/util/workbench-route.ts`)).not.toMatch(
      /MANAGEMENT_SECTIONS|organizations|users|oauth|audit/u
    );
    expect(read('ee/web/src/util/workbench-route.ts')).toContain(
      '@myagentroam/web-core/workbench-route'
    );
    expect(read('ee/web/src/service/WorkbenchNavigationWatchService.ts')).toContain(
      '@myagentroam/web-core/view-watch'
    );
    expect(read('ee/web/src/service/WorkbenchNavigationService.ts')).toContain(
      '@myagentroam/web-core/navigation'
    );
  });

  it('has one Workspace identity and no independently selectable foreground Node', () => {
    const selection = read(`${root}/src/service/WorkbenchSelectionStateService.ts`);
    expect(selection).toContain('workspaceTarget');
    expect(selection).not.toMatch(/selectedNodeId|selectedWorkspaceId/u);
    expect(read(`${root}/src/service/WorkbenchWorkspaceTreeController.ts`)).not.toMatch(
      /CrossNode|selectNode/u
    );
    const exports = JSON.parse(read(`${root}/package.json`)).exports;
    expect(exports).not.toHaveProperty('./node-selection');
    const navigation = read(`${root}/src/view/workspace/WorkspaceTree.vue`);
    expect(navigation).not.toContain("emit('selectNode'");
  });

  it('maps the shared Workspace activation intent to the enterprise navigation identity', async () => {
    const view = ref('conversations');
    const tree = createWorkbenchWorkspaceTreeController({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      nodes: ref([{ id: 'node-1', connected: true, disabled: false }]),
      workspaces: ref([{ id: 'workspace-1' }]),
      view,
      activateWorkspace: async () => true
    } as never);
    await tree.activateWorkspaceTab({
      id: 'node-1:workspace-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      label: 'Workspace',
      lastActiveAt: 1
    });
    expect(view.value).toBe('nodes');
  });

  it('keeps Workspace selection, tree and cache controllers public without product page identifiers', () => {
    for (const [name, entry] of [
      ['WorkspaceTabService', 'workspace-tabs'],
      ['WorkspaceTreeService', 'workspace-tree'],
      ['WorkbenchWorkspaceSelectionService', 'workspace-selection'],
      ['WorkbenchSessionSelectionService', 'session-selection'],
      ['WorkbenchWorkspaceCacheController', 'workspace-cache-controller']
    ]) {
      expect(read(`ee/web/src/service/${name}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
    }
    for (const name of ['WorkbenchWorkspaceSelectionService', 'WorkbenchWorkspaceTreeController']) {
      const source = read(`packages/web-core/src/service/${name}.ts`);
      expect(source).not.toMatch(
        /WorkbenchView|options\.view\b|['"]conversations['"]|['"]nodes['"]/u
      );
      expect(source).toContain('options.showWorkbench()');
    }
  });

  it('composes ordinary and hosted foreground state publicly while the host supplies navigation', () => {
    const common = read('packages/web-core/src/service/WorkbenchBaseStateService.ts');
    expect(common).not.toMatch(/createWorkbenchNavigation|enterprise|@\//u);
    const enterprise = read('ee/web/src/service/WorkbenchBaseStateService.ts');
    expect(enterprise).toContain('@myagentroam/web-core/base-state');
    expect(enterprise).toContain('createWorkbenchPageStateService<typeof navigation, Workspace>');
    expect(enterprise).not.toMatch(/customRef|createSessionDraftService|createRunService/u);
    expect(enterprise).not.toContain('hostedSelection');
    expect(common).toContain('const navigation = options.navigation;');
    expect(common).toContain("targetType: 'HOSTED_CONVERSATION'");
    expect(read('ee/web/src/service/WorkbenchSurfaceStateService.ts')).toBe(
      "export * from '@myagentroam/web-core/surface-state';\n"
    );
    expect(read('packages/web-core/src/service/WorkbenchSurfaceStateService.ts')).not.toContain(
      'WorkbenchWorkspaceCacheController'
    );
    expect(read('ee/web/src/service/WorkbenchWorkspaceCacheController.ts')).not.toContain(
      'export interface WorkspaceInspectorHandle'
    );
  });

  it('keeps the ordinary execution transaction chain public without enterprise copies', () => {
    for (const [name, entry] of [
      ['WorkbenchApprovalService', 'approval'],
      ['WorkbenchRunnerChannelService', 'runner-channel'],
      ['WorkspaceQueueService', 'workspace-queue'],
      ['WorkbenchSessionMessageService', 'session-message'],
      ['ConversationUserInputService', 'user-input']
    ]) {
      expect(read(`ee/web/src/service/${name}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
      expect(read(`packages/web-core/src/service/${name}.ts`)).not.toMatch(
        /enterprise|HostedConversation|hostedConversation|organizationId|@\//u
      );
    }
    expect(read(`${root}/src/util/conversation-presentation.ts`)).toContain(
      "export { userInputQuestions } from './conversation-user-input.js'"
    );
    expect(read('ee/web/src/util/conversation-presentation.ts')).not.toContain(
      'export function userInputQuestions'
    );
    expect(read('ee/web/src/util/conversation-domain.ts')).not.toContain(
      'export function takeoverFailure'
    );
  });

  it('uses one shared submission gate for ordinary sessions and enterprise conversations', () => {
    expect(read('ee/web/src/service/WorkbenchContextCommandService.ts')).toBe(
      "export * from '@myagentroam/web-core/context-command';\n"
    );
    expect(read('ee/web/src/service/WorkbenchPlanService.ts')).toBe(
      "export * from '@myagentroam/web-core/plan';\n"
    );
    expect(read('ee/web/src/service/WorkbenchRunControlService.ts')).toBe(
      "export * from '@myagentroam/web-core/run-control';\n"
    );
    expect(read('ee/web/src/service/WorkbenchSubmissionService.ts')).toBe(
      "export * from '@myagentroam/web-core/submission';\n"
    );
    expect(read('packages/web-core/src/service/WorkbenchSubmissionService.ts')).not.toMatch(
      /enterprise|HostedConversation|@\//u
    );
  });

  it('reuses public attachment services and keeps enterprise error semantics private', () => {
    for (const [file, entry] of [
      ['ComposerAttachmentService', 'composer-attachments'],
      ['ComposerAttachmentDragTracker', 'attachment-drag'],
      ['ComposerAttachmentInputService', 'attachment-input'],
      ['ComposerPasteService', 'composer-paste']
    ]) {
      expect(read(`ee/web/src/service/${file}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
      expect(read(`packages/web-core/src/service/${file}.ts`)).not.toMatch(
        /enterprise|hostedConversation|HostedConversation|@\//u
      );
    }
    expect(read(`${root}/src/util/workbench-presentation.ts`)).toContain('./error-presentation.js');
    for (const locale of ['en-US', 'zh-CN']) {
      const common = read(`packages/web-core/src/i18n/error-presentation.${locale}.ts`);
      expect(common).not.toMatch(
        /LICENSE_MANAGEMENT_FROZEN|ENTERPRISE_LICENSE_REQUIRED|CONVERSATION_HOSTING_/u
      );
      const enterprise = read(`ee/web/src/i18n/messages.${locale}.ts`);
      expect(enterprise).toContain('LICENSE_MANAGEMENT_FROZEN');
      expect(enterprise).toContain('ENTERPRISE_LICENSE_REQUIRED');
    }
  });

  it('composes the single public Terminal UI without enterprise imports or duplicated messages', () => {
    for (const name of ['TerminalDock', 'TerminalTabView']) {
      const source = read(`packages/web-core/src/view/terminal/${name}.vue`);
      expect(source).not.toMatch(/@\/|enterprise|workbench-presentation/u);
    }
    expect(read('packages/web-core/src/view/workbench/WorkbenchSurface.vue')).toContain(
      "import TerminalDock from '../../view/terminal/TerminalDock.vue'"
    );
    expect(read('packages/web-core/src/view/workbench/WorkbenchSurface.vue')).toContain(
      ':error-message="errorMessage"'
    );
    for (const locale of ['en-US', 'zh-CN']) {
      expect(read(`ee/web/src/i18n/messages.generated.${locale}.ts`)).not.toMatch(
        /'terminal(?:Dock|TabView)\.[^']+':/u
      );
    }
  });

  it('keeps workspace registration state and directory UI public with narrow ownership extensions', () => {
    const service = read('packages/web-core/src/service/WorkspaceRegistrationService.ts');
    const picker = read('packages/web-core/src/view/workspace/WorkspaceRegistrationPicker.vue');
    expect(service).not.toMatch(/ownerOrganizationId|ownerType|ORGANIZATION|Enterprise/u);
    expect(picker).not.toMatch(
      /ownerOrganizationId|nodeOwnership|Enterprise|\/api\/organizations/u
    );
    expect(picker).toContain('<slot name="ownership" />');
    const wrapper = read('ee/web/src/view/workspace/WorkspaceRegistrationPicker.vue');
    expect(wrapper).toContain('@myagentroam/web-core/WorkspaceRegistrationPicker.vue');
    expect(wrapper).toContain('inheritAttrs: false');
    expect(wrapper).not.toContain('directoryBreadcrumbs');
    expect(wrapper).not.toContain('directoryFormValue');
    expect(wrapper).not.toContain('v-bind="props"');
  });

  it('reuses common history pagination and realtime coordination without private API dependencies', () => {
    for (const [file, entry] of [
      ['WorkbenchConversationPagingService', 'conversation-paging'],
      ['WorkbenchConversationRealtimeService', 'conversation-realtime'],
      ['TerminalRelayService', 'terminal-relay']
    ]) {
      expect(read(`ee/web/src/service/${file}.ts`)).toBe(
        `export * from '@myagentroam/web-core/${entry}';\n`
      );
    }
    for (const locale of ['en-US', 'zh-CN']) {
      expect(read(`ee/web/src/i18n/messages.generated.${locale}.ts`)).not.toMatch(
        /'(?:workbenchConversationPagingService|terminalRelayService)\.[^']+':/u
      );
    }
  });
});
