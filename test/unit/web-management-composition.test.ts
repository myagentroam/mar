import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import {
  createManagementComposition,
  type ManagementPageDefinition
} from '../../ee/web/src/service/ManagementComposition.js';
import { createCommonManagementPages } from '../../ee/web/src/composition/common-management.js';
import { createCommonManagementPages as createPublicManagementPages } from '../../packages/web-core/src/service/CommonManagementPages.js';
import { createEnterpriseManagementComposition } from '../../ee/web/src/composition/enterprise-management.js';
import type { AdminState } from '../../ee/web/src/service/AdminAuthService.js';

// This suite exercises catalogue composition, not the Vue loading presentation.
vi.mock('../../packages/web-core/src/view/common/LoadingPanel.vue', () => ({ default: {} }));
vi.mock('../../ee/web/src/view/settings/OrganizationManagementPage.vue', () => ({
  __esModule: true,
  default: { render: () => 'organization-management-probe' }
}));
vi.mock('../../ee/web/src/view/settings/EnterpriseUserManagementPage.vue', () => ({
  __esModule: true,
  default: { render: () => 'user-management-probe' }
}));

const personal: AdminState = {
  authenticated: true,
  mustChangePassword: false,
  isAdmin: true,
  edition: 'COMMUNITY',
  licenseState: 'COMMUNITY',
  role: null,
  managementWritable: true
};

function enterprise(role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER'): AdminState {
  return { ...personal, edition: 'ENTERPRISE', licenseState: 'ENTERPRISE_VALID', role };
}

describe('Workbench management composition', () => {
  it('preserves the public page identities, order and labels when applying enterprise extensions', () => {
    const publicPages = createPublicManagementPages();
    const extendedPages = createCommonManagementPages();
    expect(publicPages.length).toBeGreaterThan(0);
    const catalogue = (pages: readonly ManagementPageDefinition[]) =>
      pages.map(({ id, order, labelKey }) => ({ id, order, labelKey }));
    expect(catalogue(extendedPages)).toEqual(catalogue(publicPages));
  });

  it('keeps organization and user management in separate pages without a mode switch', async () => {
    const composition = createEnterpriseManagementComposition();
    const admin = enterprise('ADMIN');
    for (const [id, expected, excluded] of [
      ['organizations', 'organization-management-probe', 'user-management-probe'],
      ['users', 'user-management-probe', 'organization-management-probe']
    ] as const) {
      const page = composition.resolve(id, admin);
      const html = await renderToString(createSSRApp({ render: () => h(page.component) }));
      expect(html).toContain(expected);
      expect(html).not.toContain(excluded);
    }
  });

  it('uses one ordered page catalogue for Community-state navigation and rendering', () => {
    const composition = createEnterpriseManagementComposition();
    expect(composition.items(personal).map((item) => item.id)).toEqual([
      'resource-nodes',
      'resource-workspaces',
      'skill-config',
      'skill-sources',
      'mcp-sources',
      'secrets',
      'mar-agent-models',
      'conversation-templates',
      'configuration',
      'system'
    ]);
    for (const item of composition.items(personal)) {
      expect(composition.resolve(item.id, personal).id).toBe(item.id);
      expect(item.labelKey).toMatch(/^navigation\./u);
    }
  });

  it.each([
    [
      'ADMIN',
      [
        'organizations',
        'users',
        'resource-nodes',
        'resource-workspaces',
        'skill-config',
        'skill-sources',
        'mcp-sources',
        'secrets',
        'mar-agent-models',
        'oauth',
        'conversation-templates',
        'audit',
        'configuration',
        'system'
      ]
    ],
    [
      'ORG_ADMIN',
      [
        'organizations',
        'users',
        'resource-nodes',
        'resource-workspaces',
        'skill-config',
        'skill-sources',
        'mcp-sources',
        'secrets',
        'mar-agent-models',
        'audit',
        'system'
      ]
    ],
    [
      'MEMBER',
      ['skill-config', 'skill-sources', 'mcp-sources', 'secrets', 'mar-agent-models', 'system']
    ]
  ] as const)('keeps the %s navigation order without mounting hidden pages', (role, ids) => {
    const composition = createEnterpriseManagementComposition();
    const admin = enterprise(role);
    expect(composition.items(admin).map((item) => item.id)).toEqual(ids);
    if (role !== 'ADMIN') expect(composition.resolve('oauth', admin).id).toBe('system');
    if (role === 'MEMBER') expect(composition.resolve('users', admin).id).toBe('system');
  });

  it('re-evaluates visibility when a user or product state changes', () => {
    const composition = createEnterpriseManagementComposition();
    expect(composition.resolve('organizations', enterprise('ADMIN')).id).toBe('organizations');
    expect(composition.resolve('organizations', personal).id).toBe('system');
    expect(composition.resolve('users', enterprise('MEMBER')).id).toBe('system');
    const frozen = {
      ...enterprise('ADMIN'),
      licenseState: 'ENTERPRISE_FROZEN' as const,
      managementWritable: false
    };
    expect(composition.items(frozen)).toEqual(composition.items(enterprise('ADMIN')));
    const request = async <T>(): Promise<T> => undefined as T;
    expect(
      composition.resolve('users', frozen).props({
        admin: frozen,
        request,
        nodes: [],
        onlineNodeCount: 0,
        serverVersion: '0.9.63'
      }).writable
    ).toBe(false);
  });

  it('keeps License and enterprise identity pages out of the common declaration while retaining templates', () => {
    const composition = createManagementComposition(createCommonManagementPages());
    const ids = composition.items(personal).map((item) => item.id);
    for (const id of ['organizations', 'users', 'oauth', 'audit']) expect(ids).not.toContain(id);
    expect(ids).toContain('conversation-templates');
    expect(composition.resolve('conversation-templates', personal).id).toBe(
      'conversation-templates'
    );
    expect(composition.resolve('oauth', enterprise('ADMIN')).id).toBe('system');
    const request = async <T>(): Promise<T> => undefined as T;
    const context = {
      admin: personal,
      request,
      nodes: [],
      onlineNodeCount: 0,
      serverVersion: '0.9.63'
    };
    expect(composition.resolve('system', personal).props(context)).not.toHaveProperty('extension');
    expect(
      createEnterpriseManagementComposition().resolve('system', personal).props(context)
    ).toHaveProperty('extension');
  });

  it('rejects duplicate IDs and missing or inaccessible fallback pages', () => {
    const pages = createCommonManagementPages();
    expect(() => createManagementComposition([...pages, pages[0]!])).toThrow(
      'WEB_MANAGEMENT_PAGE_DUPLICATE'
    );
    expect(() => createManagementComposition(pages.filter((page) => page.id !== 'system'))).toThrow(
      'WEB_MANAGEMENT_SYSTEM_PAGE_REQUIRED'
    );
    const system = pages.find((page) => page.id === 'system')!;
    const inaccessible: ManagementPageDefinition = { ...system, visible: () => false };
    expect(() => createManagementComposition([inaccessible]).resolve('users', personal)).toThrow(
      'WEB_MANAGEMENT_SYSTEM_PAGE_UNAVAILABLE'
    );
  });

  it('uses the shared template declaration while keeping License and identity pages private', async () => {
    const common = await readFile('ee/web/src/composition/common-management.ts', 'utf8');
    const system = await readFile('packages/web-core/src/view/SystemInformationPage.vue', 'utf8');
    expect(common).not.toMatch(
      /(?:LicenseManagementPage|OrganizationManagementPage|EnterpriseUserManagementPage|OAuthManagementPage|AuditManagementPage)/u
    );
    expect(system).not.toContain('LicenseManagementPage');
    const surface = await readFile(
      'packages/web-core/src/view/workbench/WorkbenchSurface.vue',
      'utf8'
    );
    expect(surface).not.toMatch(
      /import (?:OrganizationManagementPage|EnterpriseUserManagementPage|OAuthManagementPage|AuditManagementPage|ConversationTemplateManagementPage)/u
    );
  });
});
