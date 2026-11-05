import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { createWorkbenchPageController } from '../../packages/web-core/src/service/workbench-page-controller.js';
import { createWorkbenchNavigationService } from '../../packages/web-core/src/service/workbench-navigation-service.js';
import { renderComponent } from '../../packages/web-core/test/unit/support/component-renderer.js';
import { createWorkbenchWorkspaceTreeController } from '../../ee/web/src/service/workbench-workspace-tree-controller.js';
import {
  localePreferenceService,
  translate
} from '../../ee/web/src/service/locale-preference-service';

const root = 'packages/web-core';
const read = (path: string) => readFileSync(path, 'utf8');
function expectSharedEntry(path: string, entry: string): void {
  expect(existsSync(path)).toBe(false);
  const manifest = JSON.parse(read(`${root}/package.json`));
  const target: unknown = manifest.exports[`./${entry}`];
  expect(typeof target).toBe('string');
  expect(existsSync(`${root}/${target}`)).toBe(true);
}
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
    expect(adapter).not.toMatch(/CodexLoginAttemptPoller|\/api\/admin\/mar-agent/u);
    expect(existsSync('ee/web/src/view/settings/ImageGenerationManagement.vue')).toBe(false);
    expectSharedEntry(
      'ee/web/src/service/codex-credential-management-service.ts',
      'codex-credential-management'
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
    expect(read('ee/web/src/service/environment-secret-service.ts')).toContain(
      '@myagentroam/web-core/environment-secrets'
    );
    expect(read(`${root}/src/service/environment-secret-service.ts`)).not.toMatch(
      /organizationId|visibility|ORGANIZATION|ENTERPRISE/u
    );
    expect(read('ee/web/src/view/settings/SystemConfigurationPage.vue')).toContain(
      "key: 'audit-retention'"
    );
    expectSharedEntry('ee/web/src/service/management-url-service.ts', 'management-url');
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
    expect(read(`${root}/src/service/mcp-center-service.ts`)).not.toMatch(
      /ENTERPRISE|ORGANIZATION|PERSONAL/u
    );
    expect(read('ee/web/src/service/mcp-center-service.ts')).toContain(
      "from '@myagentroam/web-core/mcp-center'"
    );
  });

  it('shares the Hosted client while keeping template management and Server admission private', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const [file, entry] of [
      ['hosted-conversation-entry-service', 'hosted-conversation-entry'],
      ['hosted-conversation-workspace-service', 'hosted-conversation-workspace'],
      ['hosted-conversation-file-preview-service', 'hosted-conversation-file-preview'],
      ['hosted-conversation-file-tree-service', 'hosted-conversation-file-tree'],
      ['workbench-clock-service', 'workbench-clock']
    ]) {
      expect(manifest.exports[`./${entry}`]).toBe(`./src/service/${file}.ts`);
      expect(existsSync(`ee/web/src/service/${file}.ts`)).toBe(false);
      expect(read(`${root}/src/service/${file}.ts`)).not.toMatch(
        /@myagentroam-enterprise|ConversationTemplateService|conversation-template-service|\/api\/admin\/|resource-grants/u
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
    const templateManagement = read('ee/web/src/service/conversation-template-service.ts');
    expect(templateManagement).toContain('@myagentroam/web-core/conversation-template-management');
    expect(templateManagement).toContain('...createCore(request)');
    expect(templateManagement).not.toContain("request<unknown>('/api/conversation-templates')");
    expect(templateManagement).toContain('/api/resource-grants');
    const commonTemplateManagement = read(`${root}/src/service/conversation-template-service.ts`);
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
      ['service/conversation-scroll-service', 'conversation-scroll'],
      ['service/conversation-image-service', 'conversation-images'],
      ['util/conversation-presentation', 'conversation-presentation'],
      ['util/conversation-domain', 'conversation-domain']
    ]) {
      expect(existsSync(`ee/web/src/${file}.ts`)).toBe(false);
      expect(manifest.exports[`./${entry}`]).toBe(`./src/${file}.ts`);
    }
    for (const [file, prefix] of [
      ['packages/web-core/src/view/workbench/WorkspaceSessionPane.vue', '../conversation/'],
      [`${root}/src/view/conversation/HostedConversationWorkspacePage.vue`, './']
    ]) {
      expect(read(file!)).toContain(`${prefix}ConversationTimeline.vue`);
      expect(read(file!)).toContain(`${prefix}ConversationScroll.vue`);
    }
    expect(read(`${root}/src/util/workbench-presentation.ts`)).toContain(
      "export { absoluteMessageTime } from './conversation-presentation.js'"
    );
    expect(existsSync('ee/web/src/util/workbench-presentation.ts')).toBe(false);
  });

  it('assembles independent Workspace tools with page-owned subscriptions', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    expect(existsSync(`${root}/src/view/workspace/WorkspaceInspector.vue`)).toBe(false);
    expect(manifest.exports['./WorkspaceInspector.vue']).toBeUndefined();
    const surface = read(`${root}/src/view/workbench/WorkbenchSurface.vue`);
    for (const name of [
      'WorkspaceFilesPanel',
      'WorkspaceContentSearch',
      'WorkspaceGitChanges',
      'WorkspaceGitHistory',
      'WorkspaceFileWorkbench'
    ]) {
      expect(surface).toContain(name);
      expect(read(`${root}/src/view/workspace/${name}.vue`)).not.toMatch(
        /from ['"]@\/|@myagentroam-enterprise|HostedConversation|new WebSocket|createWorkspaceWatchService|createSessionWatchService/u
      );
    }
    expectSharedEntry('ee/web/src/util/trailing-task.ts', 'trailing-task');
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
        `${root}/src/view/workspace/WorkspaceFileWorkbench.vue`,
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
      ['service/file-editor-preference-service', 'file-editor-preference'],
      ['service/markdown-preview-preference-service', 'markdown-preview-preference'],
      ['util/file-preview', 'file-preview'],
      ['util/markdown-preview', 'markdown-preview'],
      ['util/mobile-preview-pinch-zoom', 'mobile-preview-pinch-zoom']
    ]) {
      expect(existsSync(`ee/web/src/${path}.ts`)).toBe(false);
      expect(manifest.exports[`./${entry}`]).toBe(`./src/${path}.ts`);
    }
  });

  it('shares file navigation, icon preferences and local assets without private copies', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const [name, folder] of [
      ['FileTypeIcon', 'workspace'],
      ['WorkspaceFileTree', 'workspace'],
      ['QuickOpenDialog', 'workspace'],
      ['ComposerReferencePicker', 'composer']
    ]) {
      expect(existsSync(`ee/web/src/view/${folder}/${name}.vue`)).toBe(false);
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/${folder}/${name}.vue`);
    }
    expect(existsSync('ee/web/src/icon-themes')).toBe(false);
    expectSharedEntry(
      'ee/web/src/service/icon-theme-preference-service.ts',
      'icon-theme-preference'
    );
    expectSharedEntry('ee/web/src/service/workspace-file-tree-service.ts', 'workspace-file-tree');
    expect(read(`${root}/src/view/workspace/WorkspaceFilesPanel.vue`)).toContain(
      './WorkspaceFileTree.vue'
    );
    expect(read('packages/web-core/src/view/workspace/WorkspaceRegistrationPicker.vue')).toContain(
      "import FileTypeIcon from '../workspace/FileTypeIcon.vue'"
    );
    expect(read('packages/web-core/src/view/workbench/WorkbenchPage.vue')).toContain(
      '../../view/workspace/QuickOpenDialog.vue'
    );
    expect(read('packages/web-core/src/view/workbench/WorkspaceSessionPane.vue')).toContain(
      '../composer/ComposerReferencePicker.vue'
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
    const pane = read('packages/web-core/src/view/workbench/WorkspaceSessionPane.vue');
    expect(surface).toContain('./WorkspaceSessionPane.vue');
    for (const name of components) {
      expect(existsSync(`ee/web/src/view/composer/${name}.vue`)).toBe(false);
      expect(manifest.exports[`./${name}.vue`]).toBe(`./src/view/composer/${name}.vue`);
      expect(pane).toContain(`../composer/${name}.vue`);
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
      'service/workspace-session-service': 'workspace-session',
      'service/workbench-page-lifecycle-service': 'page-lifecycle',
      'service/workbench-event-projection-service': 'event-projection',
      'service/web-performance-diagnostic-service': 'performance-diagnostics',
      'service/workbench-capability-service': 'capability-service',
      'service/workbench-entity-service': 'entity-service',
      'service/workbench-entity-controller': 'entity-controller',
      'service/workbench-presentation-state-service': 'presentation-state',
      'service/workbench-page-interaction-service': 'page-interaction',
      'service/workbench-new-session-controller': 'new-session-controller',
      'service/runner-usage-service': 'runner-usage',
      'util/workbench-presentation': 'workbench-presentation',
      'util/workbench-guards': 'workbench-guards',
      'util/session-list': 'session-list'
    };
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const [name, entry] of Object.entries(entries)) {
      expect(existsSync(`ee/web/src/${name}.ts`)).toBe(false);
      expect(manifest.exports[`./${entry}`]).toBe(`./src/${name}.ts`);
      expect(read(`${root}/src/${name}.ts`)).not.toMatch(
        /@\/|@myagentroam-enterprise|\/api\/organizations|ownerOrganizationId|ENTERPRISE_LICENSE/u
      );
    }
  });

  it('uses one public notification, upload and update client implementation', () => {
    const manifest = JSON.parse(read(`${root}/package.json`));
    for (const [name, entry] of [
      ['workbench-notification-service', 'notifications'],
      ['workbench-notification-navigation-service', 'notification-navigation'],
      ['workspace-upload-service', 'workspace-upload'],
      ['pwa-application-service', 'pwa-application']
    ]) {
      expect(existsSync(`ee/web/src/service/${name}.ts`)).toBe(false);
      expect(manifest.exports[`./${entry}`]).toBe(`./src/service/${name}.ts`);
    }
    expect(existsSync('ee/web/src/view/workbench/WorkbenchActivityCenter.vue')).toBe(false);
    expect(read(`${root}/src/view/workbench/WorkbenchNavigation.vue`)).toContain(
      './WorkbenchActivityCenter.vue'
    );
  });

  it('keeps enterprise page assembly limited to explicit shared page extensions', () => {
    const controller = read('ee/web/src/service/workbench-page-controller.ts');
    expect(controller).toContain('@myagentroam/web-core/page-controller');
    expect(controller).not.toContain('createWorkspaceWatchService');
    const surface = read('ee/web/src/view/workbench/WorkbenchSurface.vue');
    expect(surface).toContain('@myagentroam/web-core/WorkbenchSurface.vue');
    expect(surface).toContain('#workspace-registration');
    expect(surface).toContain('#management-notice');
    const page = read('ee/web/src/view/workbench/WorkbenchPage.vue');
    expect(page).toContain('@myagentroam/web-core/WorkbenchPage.vue');
    expect(page).toContain('EnterpriseLoginExtension');
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
    expect(read('ee/web/src/service/admin-auth-service.ts')).not.toContain("'/api/auth/login'");
  });

  it('shares locale and registry mechanisms but keeps product page IDs and messages private', () => {
    expect(read(`${root}/src/service/management-composition.ts`)).not.toMatch(
      /['"](?:organizations|users|oauth|audit|conversation-templates)['"]/u
    );
    expect(existsSync('ee/web/src/view/settings/SystemInformationPage.vue')).toBe(false);
    expect(read(`${root}/src/view/SystemInformationPage.vue`)).not.toMatch(/license|License/u);
  });

  it('invalidates pending workbench requests when authentication is revoked', async () => {
    let resolvePending!: (response: Response) => void;
    let resolveUnauthenticated!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => (resolvePending = resolve));
    const unauthenticatedResponse = new Promise<Response>(
      (resolve) => (resolveUnauthenticated = resolve)
    );
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const path = String(input);
      if (path === '/api/pending') return pendingResponse;
      if (path === '/api/unauthenticated') return unauthenticatedResponse;
      if (path === '/api/auth/me')
        return Promise.resolve(Response.json({ authenticated: true, mustChangePassword: false }));
      if (path === '/api/auth/csrf')
        return Promise.resolve(Response.json({ csrfToken: 'fixture-csrf' }));
      return Promise.resolve(Response.json({ nodes: [], notifications: [], recentRuns: [] }));
    });
    const storage = new Map<string, string>();
    const sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    };
    const location = new URL('https://console.example.test/console');
    const history = { state: null, replaceState: vi.fn() };
    vi.stubGlobal('localStorage', sessionStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);
    vi.stubGlobal('location', location);
    vi.stubGlobal('history', history);
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        location,
        history,
        sessionStorage,
        matchMedia: () => ({
          matches: false,
          addEventListener() {},
          removeEventListener() {}
        })
      })
    );
    vi.stubGlobal(
      'document',
      Object.assign(new EventTarget(), {
        visibilityState: 'visible',
        hasFocus: () => true,
        documentElement: { dataset: {}, style: { setProperty() {} } }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    let page!: ReturnType<typeof createWorkbenchPageController>;
    let rendered: ReturnType<typeof renderComponent> | undefined;
    try {
      const navigation = createWorkbenchNavigationService({
        initialView: 'nodes',
        initialSettingsSection: 'account',
        initialManagementSection: 'system',
        opensMobileSidebar: () => false
      });
      rendered = renderComponent(
        defineComponent({
          setup() {
            page = createWorkbenchPageController({
              navigation,
              management: { items: () => [] },
              systemManagementSection: 'system',
              nodeManagementSection: 'nodes',
              webVersion: '0.10.1'
            });
            return () => h('div');
          }
        })
      );

      const pendingRequest = page.request('/api/pending');
      expect(page.nodes.value).toEqual([]);
      expect(page.navigationItems.value.map((item) => item.id)).toContain('conversations');
      const pendingRejected = expect(pendingRequest).rejects.toMatchObject({
        name: 'AbortError'
      });
      const unauthenticatedRequest = page.request('/api/unauthenticated');
      const unauthenticatedRejected = expect(unauthenticatedRequest).rejects.toMatchObject({
        code: 'UNAUTHENTICATED'
      });
      resolveUnauthenticated(Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 }));
      await unauthenticatedRejected;
      resolvePending(Response.json({ completed: true }));
      await pendingRejected;
    } finally {
      rendered?.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('uses the shared shell, bootstrap and styles rather than a second application implementation', () => {
    expect(existsSync('ee/web/src/App.vue')).toBe(false);
    const bootstrap = read('ee/web/src/bootstrap.ts');
    expect(bootstrap).toContain("from '@myagentroam/web-core/bootstrap'");
    expect(bootstrap).not.toMatch(/createApp|app\.mount|serviceWorker\.register/u);
    expectSharedEntry('ee/web/src/service/theme-preference-service.ts', 'theme');
    expect(read('ee/web/src/styles.css')).not.toContain('--mar-bg-page');
    expect(read(`${root}/src/styles.css`)).not.toContain('enterprise-frozen-banner');
    expect(read(`${root}/src/App.vue`)).not.toMatch(
      /MarketingHomePage|WorkbenchPage|StandaloneFilePreviewPage/u
    );
  });

  it('shares the Hosted lifecycle adapter without duplicating the generic Watch coordinator', () => {
    const common = read(`${root}/src/service/workbench-watch-coordinator.ts`);
    expect(common).not.toMatch(/hosted|Hosted|conversation-templates|\/api\//u);
    const adapter = read(`${root}/src/service/hosted-conversation-watch-coordinator.ts`);
    expect(adapter).toContain("from './workbench-watch-coordinator.js'");
    expectSharedEntry(
      'ee/web/src/service/workbench-watch-coordinator.ts',
      'hosted-watch-coordinator'
    );
  });

  it('reuses the public realtime connection without a second enterprise socket implementation', () => {
    expectSharedEntry('ee/web/src/service/workbench-live-service.ts', 'live');
  });

  it('shares Workspace subscriptions and leases without importing enterprise ownership models', () => {
    expectSharedEntry('ee/web/src/service/workspace-watch-service.ts', 'workspace-watch');
    expectSharedEntry('ee/web/src/service/watch-lease-lifecycle-service.ts', 'watch-lease');
    expect(read(`${root}/src/service/workspace-watch-service.ts`)).not.toMatch(
      /ownership|ORGANIZATION|ownerOrganizationId|model\/workbench/u
    );
  });

  it('shares native Session observation and models while keeping resource ownership and navigation private', () => {
    expectSharedEntry(
      'ee/web/src/service/workbench-session-watch-controller.ts',
      'session-watch-controller'
    );
    expectSharedEntry('ee/web/src/util/conversation-segments.ts', 'conversation-segments');
    expect(read(`${root}/src/model/workbench.ts`)).not.toMatch(
      /ownership|ORGANIZATION|ownerOrganizationId|ManagementSection|WorkbenchView/u
    );
    const enterpriseModel = read('ee/web/src/model/workbench.ts');
    expect(enterpriseModel).toContain('Workspace extends CoreWorkspace');
    expect(enterpriseModel).toContain("ownerType: 'ORGANIZATION'");
    expect(enterpriseModel).not.toContain('interface Session');
    expect(enterpriseModel).not.toContain('interface ConversationTurn');
    expect(read(`${root}/src/service/workbench-session-watch-controller.ts`)).not.toMatch(
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
      ['run-service', 'run-state'],
      ['conversation-state-service', 'conversation-state'],
      ['conversation-projection-service', 'conversation-projection'],
      ['workbench-conversation-snapshot-service', 'conversation-snapshot'],
      ['workspace-view-cache-service', 'workspace-cache'],
      ['workspace-runtime-state-service', 'workspace-runtime']
    ]) {
      expectSharedEntry(`ee/web/src/service/${file}.ts`, entry!);
      expect(read(`${root}/src/service/${file}.ts`)).not.toMatch(
        /HostedConversation|\/api\/|ownerOrganizationId/u
      );
    }
    expectSharedEntry('ee/web/src/util/conversation-history.ts', 'conversation-history');
  });

  it('shares Composer state and public version gates without including enterprise features', () => {
    for (const [file, entry] of [
      ['runner-profile-service', 'runner-profile'],
      ['runner-interaction-service', 'runner-interaction'],
      ['composer-configuration-service', 'composer-configuration'],
      ['workbench-composer-controller', 'composer-controller'],
      ['composer-queue-service', 'composer-queue'],
      ['composer-skill-service', 'composer-skills'],
      ['file-reference-service', 'file-reference'],
      ['quick-prompt-service', 'quick-prompts'],
      ['workbench-composer-interaction-controller', 'composer-interaction']
    ]) {
      expectSharedEntry(`ee/web/src/service/${file}.ts`, entry!);
    }
    expectSharedEntry('ee/web/src/util/node-features.ts', 'node-features');
    for (const locale of ['en-US', 'zh-CN']) {
      expect(read(`ee/web/src/i18n/messages.generated.${locale}.ts`)).not.toMatch(
        /'(?:runnerProfileService|workbenchComposerController)\.[^']+':/u
      );
    }
  });

  it('reuses public draft, paging, refresh and skill state without private implementations', () => {
    for (const [file, entry] of [
      ['workspace-session-paging-service', 'session-paging'],
      ['session-draft-service', 'session-draft'],
      ['session-snapshot-refresh-service', 'snapshot-refresh'],
      ['composer-skill-token-service', 'skill-tokens'],
      ['effective-workspace-skill-service', 'effective-skills']
    ]) {
      expectSharedEntry(`ee/web/src/service/${file}.ts`, entry!);
    }
    expect(read(`${root}/src/service/workbench-selection-state-service.ts`)).not.toMatch(
      /ownership|Organization|Hosted/u
    );
  });

  it('keeps neutral selection recovery separate from public routes and private management identifiers', () => {
    for (const file of [
      'workbench-navigation-service',
      'workbench-navigation-watch-service',
      'workbench-selection-persistence-service'
    ]) {
      expect(read(`packages/web-core/src/service/${file}.ts`)).not.toMatch(
        /HostedConversation|hostedConversation|['"]conversations['"]|['"]users['"]|['"]organizations['"]|parseWorkbenchRoute/u
      );
    }
    expectSharedEntry('ee/web/src/service/workbench-route-service.ts', 'route-service');
    expect(read(`${root}/src/service/workbench-route-service.ts`)).toContain(
      "from './workbench-selection-persistence-service.js'"
    );
    expect(read(`${root}/src/util/workbench-route.ts`)).not.toMatch(
      /MANAGEMENT_SECTIONS|organizations|users|oauth|audit/u
    );
    expect(read('ee/web/src/util/workbench-route.ts')).toContain(
      '@myagentroam/web-core/workbench-route'
    );
    expectSharedEntry('ee/web/src/service/workbench-navigation-watch-service.ts', 'view-watch');
    expect(read('ee/web/src/service/workbench-navigation-service.ts')).toContain(
      '@myagentroam/web-core/navigation'
    );
  });

  it('has one Workspace identity and no independently selectable foreground Node', () => {
    const selection = read(`${root}/src/service/workbench-selection-state-service.ts`);
    expect(selection).toContain('workspaceTarget');
    expect(selection).not.toMatch(/selectedNodeId|selectedWorkspaceId/u);
    expect(read(`${root}/src/service/workbench-workspace-tree-controller.ts`)).not.toMatch(
      /CrossNode|selectNode/u
    );
    const exports = JSON.parse(read(`${root}/package.json`)).exports;
    expect(exports).not.toHaveProperty('./node-selection');
    const navigation = read(`${root}/src/view/workspace/WorkspaceTree.vue`);
    expect(navigation).not.toContain("emit('selectNode'");
  });

  it('maps the shared Workspace activation intent to the enterprise navigation identity', async () => {
    const view = ref('conversations');
    const closeMobileSidebar = vi.fn();
    const revealWorkspace = vi.fn();
    const tree = createWorkbenchWorkspaceTreeController({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      nodes: ref([{ id: 'node-1', connected: true, disabled: false }]),
      workspaces: ref([{ id: 'workspace-1' }]),
      tree: { revealWorkspace },
      view,
      closeMobileSidebar,
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
    expect(closeMobileSidebar).toHaveBeenCalledOnce();
    expect(revealWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'node-1', workspaceId: 'workspace-1' })
    );
  });

  it('keeps Workspace selection, tree and cache controllers public without product page identifiers', () => {
    for (const [name, entry] of [
      ['workspace-tab-service', 'workspace-tabs'],
      ['workspace-tree-service', 'workspace-tree'],
      ['workbench-workspace-selection-service', 'workspace-selection'],
      ['workbench-session-selection-service', 'session-selection'],
      ['workbench-workspace-cache-controller', 'workspace-cache-controller']
    ]) {
      expectSharedEntry(`ee/web/src/service/${name}.ts`, entry!);
    }
    for (const name of [
      'workbench-workspace-selection-service',
      'workbench-workspace-tree-controller'
    ]) {
      const source = read(`packages/web-core/src/service/${name}.ts`);
      expect(source).not.toMatch(
        /WorkbenchView|options\.view\b|['"]conversations['"]|['"]nodes['"]/u
      );
    }
  });

  it('composes ordinary and hosted foreground state publicly while the host supplies navigation', () => {
    const common = read('packages/web-core/src/service/workbench-base-state-service.ts');
    expect(common).not.toMatch(/createWorkbenchNavigation|enterprise|@\//u);
    expect(existsSync('ee/web/src/service/workbench-base-state-service.ts')).toBe(false);
    const page = read('packages/web-core/src/service/workbench-page-controller.ts');
    expect(page).toContain('createWorkbenchPageStateService({');
    expect(page).toContain('navigation: options.navigation');
    expectSharedEntry('ee/web/src/service/workbench-surface-state-service.ts', 'surface-state');
    expect(read('packages/web-core/src/service/workbench-surface-state-service.ts')).not.toMatch(
      /WorkbenchWorkspaceCacheController|workbench-workspace-cache-controller/u
    );
  });

  it('keeps the ordinary execution transaction chain public without enterprise copies', () => {
    for (const [name, entry] of [
      ['workbench-approval-service', 'approval'],
      ['workbench-runner-channel-service', 'runner-channel'],
      ['workspace-queue-service', 'workspace-queue'],
      ['workbench-session-message-service', 'session-message'],
      ['conversation-user-input-service', 'user-input']
    ]) {
      expectSharedEntry(`ee/web/src/service/${name}.ts`, entry!);
      expect(read(`packages/web-core/src/service/${name}.ts`)).not.toMatch(
        /enterprise|HostedConversation|hostedConversation|organizationId|@\//u
      );
    }
    expect(read(`${root}/src/util/conversation-presentation.ts`)).toContain(
      "export { userInputQuestions } from './conversation-user-input.js'"
    );
    expect(existsSync('ee/web/src/util/conversation-presentation.ts')).toBe(false);
    expect(existsSync('ee/web/src/util/conversation-domain.ts')).toBe(false);
  });

  it('uses one shared submission gate for ordinary sessions and enterprise conversations', () => {
    expectSharedEntry('ee/web/src/service/workbench-context-command-service.ts', 'context-command');
    expectSharedEntry('ee/web/src/service/workbench-plan-service.ts', 'plan');
    expectSharedEntry('ee/web/src/service/workbench-run-control-service.ts', 'run-control');
    expectSharedEntry('ee/web/src/service/workbench-submission-service.ts', 'submission');
    expect(read('packages/web-core/src/service/workbench-submission-service.ts')).not.toMatch(
      /enterprise|HostedConversation|@\//u
    );
  });

  it('reuses public attachment services and keeps enterprise error semantics private', () => {
    for (const [file, entry] of [
      ['composer-attachment-service', 'composer-attachments'],
      ['composer-attachment-drag-tracker', 'attachment-drag'],
      ['composer-attachment-input-service', 'attachment-input'],
      ['composer-paste-service', 'composer-paste']
    ]) {
      expectSharedEntry(`ee/web/src/service/${file}.ts`, entry!);
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
    for (const locale of ['en-US', 'zh-CN']) {
      expect(read(`ee/web/src/i18n/messages.generated.${locale}.ts`)).not.toMatch(
        /'terminal(?:Dock|TabView)\.[^']+':/u
      );
    }
  });

  it('keeps workspace registration state and directory UI public with narrow ownership extensions', () => {
    const service = read('packages/web-core/src/service/workspace-registration-service.ts');
    const picker = read('packages/web-core/src/view/workspace/WorkspaceRegistrationPicker.vue');
    expect(service).not.toMatch(/ownerOrganizationId|ownerType|ORGANIZATION|Enterprise/u);
    expect(picker).not.toMatch(
      /ownerOrganizationId|nodeOwnership|Enterprise|\/api\/organizations/u
    );
    expect(picker).toContain('<slot name="ownership" />');
    const wrapper = read('ee/web/src/view/workspace/WorkspaceRegistrationPicker.vue');
    expect(wrapper).toContain('@myagentroam/web-core/WorkspaceRegistrationPicker.vue');
  });

  it('reuses common history pagination and realtime coordination without private API dependencies', () => {
    for (const [file, entry] of [
      ['workbench-conversation-paging-service', 'conversation-paging'],
      ['workbench-conversation-realtime-service', 'conversation-realtime'],
      ['terminal-relay-service', 'terminal-relay']
    ]) {
      expectSharedEntry(`ee/web/src/service/${file}.ts`, entry!);
    }
    for (const locale of ['en-US', 'zh-CN']) {
      expect(read(`ee/web/src/i18n/messages.generated.${locale}.ts`)).not.toMatch(
        /'(?:workbenchConversationPagingService|terminalRelayService)\.[^']+':/u
      );
    }
  });
});
