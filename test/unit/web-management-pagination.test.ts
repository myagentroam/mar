import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { classifyAuditEvent } from '../../ee/web/src/util/audit-presentation.js';
import { enUS as en } from '../../ee/web/src/i18n/messages.en-US.js';
import { zhCN as zh } from '../../ee/web/src/i18n/messages.zh-CN.js';
import {
  MANAGEMENT_PAGE_SIZE,
  createManagementPaginationService,
  managementPageItems
} from '../../ee/web/src/service/ManagementPaginationService';

function vueFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? vueFiles(path) : entry.name.endsWith('.vue') ? [path] : [];
  });
}

function tableColumnTags(source: string): readonly string[] {
  return source.match(/<el-table-column\b[\s\S]*?>/gu) ?? [];
}

function cascaderTags(source: string): readonly string[] {
  return source.match(/<el-cascader\b[\s\S]*?\/>/gu) ?? [];
}

describe('management pagination', () => {
  const items = Array.from({ length: 45 }, (_, index) => index + 1);
  const enterpriseViewRoot = join(process.cwd(), 'ee/web/src/view');
  const commonViewRoot = join(process.cwd(), 'packages/web-core/src/view');
  const commonManagementPages = new Set([
    'settings/ConversationTemplateManagementPage.vue',
    'settings/EnvironmentSecretManager.vue',
    'settings/MarAgentModelManagementPage.vue',
    'settings/ResourceManagementPanel.vue',
    'settings/SystemConfigurationPage.vue',
    'skill/McpCenterPanel.vue',
    'skill/McpSourceManagementPage.vue',
    'skill/SkillCenterPage.vue',
    'skill/SkillSourceManagementPage.vue'
  ]);

  function managementPageSource(file: string): string {
    return readFileSync(
      join(commonManagementPages.has(file) ? commonViewRoot : enterpriseViewRoot, file),
      'utf8'
    );
  }

  it('desktop returns one 20-item page', () => {
    expect(MANAGEMENT_PAGE_SIZE).toBe(20);
    expect(
      managementPageItems(items, {
        mobileViewport: ref(false),
        page: ref(2),
        mobileVisibleCount: ref(MANAGEMENT_PAGE_SIZE)
      })
    ).toEqual(items.slice(MANAGEMENT_PAGE_SIZE, MANAGEMENT_PAGE_SIZE * 2));
  });

  it('mobile returns the accumulated load-more window', () => {
    expect(
      managementPageItems(items, {
        mobileViewport: ref(true),
        page: ref(1),
        mobileVisibleCount: ref(MANAGEMENT_PAGE_SIZE * 2)
      })
    ).toEqual(items.slice(0, MANAGEMENT_PAGE_SIZE * 2));
  });

  it('preserves the current page after reload and reconciles when the last page disappears', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: false }))
    });
    try {
      const pagination = createManagementPaginationService();
      pagination.setPage(2);
      pagination.reconcile(25);
      expect(pagination.page.value).toBe(2);
      expect(managementPageItems(items.slice(0, 25), pagination)).toEqual(
        items.slice(MANAGEMENT_PAGE_SIZE, 25)
      );

      pagination.reconcile(10);
      expect(pagination.page.value).toBe(1);
      expect(managementPageItems(items.slice(0, 10), pagination)).toEqual(items.slice(0, 10));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('management action columns scroll with the table instead of staying fixed', () => {
    const viewRoot = join(process.cwd(), 'ee/web/src/view');
    const offenders = ['settings', 'skill']
      .flatMap((directory) => vueFiles(join(viewRoot, directory)))
      .concat(
        ['MarAgentModelManagementPage', 'ImageGenerationManagement', 'ResourceManagementPanel'].map(
          (name) => join(process.cwd(), 'packages/web-core/src/view/settings', `${name}.vue`)
        )
      )
      .concat(
        join(process.cwd(), 'packages/web-core/src/view/settings/SystemConfigurationPage.vue')
      )
      .concat(
        join(process.cwd(), 'packages/web-core/src/view/settings/EnvironmentSecretManager.vue')
      )
      .concat(
        [
          'SkillCenterPage',
          'McpCenterPanel',
          'SkillSourceManagementPage',
          'McpSourceManagementPage'
        ].map((name) => join(process.cwd(), 'packages/web-core/src/view/skill', `${name}.vue`))
      )
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes('fixed="right"');
      })
      .map((file) => relative(viewRoot, file));

    expect(offenders).toEqual([]);
  });

  it('management action columns retain explicit widths on mobile', () => {
    const viewRoot = join(process.cwd(), 'ee/web/src/view');
    const offenders = ['settings', 'skill']
      .flatMap((directory) => vueFiles(join(viewRoot, directory)))
      .concat(
        ['MarAgentModelManagementPage', 'ImageGenerationManagement', 'ResourceManagementPanel'].map(
          (name) => join(process.cwd(), 'packages/web-core/src/view/settings', `${name}.vue`)
        )
      )
      .concat(
        join(process.cwd(), 'packages/web-core/src/view/settings/SystemConfigurationPage.vue')
      )
      .concat(
        join(process.cwd(), 'packages/web-core/src/view/settings/EnvironmentSecretManager.vue')
      )
      .concat(
        [
          'SkillCenterPage',
          'McpCenterPanel',
          'SkillSourceManagementPage',
          'McpSourceManagementPage'
        ].map((name) => join(process.cwd(), 'packages/web-core/src/view/skill', `${name}.vue`))
      )
      .flatMap((file) =>
        tableColumnTags(readFileSync(file, 'utf8'))
          .filter((tag) => tag.includes('actions'))
          .filter(
            (tag) =>
              !/\b(?:width|min-width)\s*=/u.test(tag) ||
              tag.includes('pagination.mobileViewport.value ? undefined')
          )
          .map(() => relative(viewRoot, file))
      );

    expect(offenders).toEqual([]);
  });

  it('paged management tables consume server pages without slicing again in the browser', () => {
    for (const file of [
      'settings/ConversationTemplateManagementPage.vue',
      'settings/EnvironmentSecretManager.vue',
      'settings/EnterpriseUserManagementPage.vue',
      'settings/UserManagementPage.vue',
      'settings/ResourceManagementPanel.vue',
      'skill/McpCenterPanel.vue',
      'skill/McpSourceManagementPage.vue',
      'skill/SkillCenterPage.vue',
      'skill/SkillSourceManagementPage.vue'
    ]) {
      const source = managementPageSource(file);
      expect(source, file).toContain('<ManagementPagination');
      expect(source, file).not.toContain('managementPageItems');
      expect(source, file).toContain(':total="');
      expect(source, file).not.toMatch(/:total="[^"]*\.length"/u);
      expect(source, file).toContain(':has-more=');
    }
  });

  it('complete configuration and tree snapshots do not expose a paginator', () => {
    for (const file of [
      'settings/OAuthManagementPage.vue',
      'settings/OrganizationManagementPage.vue',
      'settings/SystemConfigurationPage.vue'
    ]) {
      const source = managementPageSource(file);
      expect(source, file).not.toContain('<ManagementPagination');
      expect(source, file).not.toContain('managementPageItems');
    }
  });

  it('model, template, and audit tables open details from clickable rows', () => {
    const pages: readonly (readonly [string, readonly string[]])[] = [
      [
        'settings/MarAgentModelManagementPage.vue',
        [
          'openModelDetails',
          'openCredentialDetails',
          'modelDetailOpen',
          'modelConfigurationId',
          'codexCredentialId'
        ]
      ],
      ['settings/ConversationTemplateManagementPage.vue', ['openDetail', 'templateId']],
      ['settings/AuditManagementPage.vue', ['openDetail', 'auditEventId']]
    ];
    const failures = pages.flatMap(([file, expected]) => {
      const source = managementPageSource(file);
      const missing =
        !source.includes('clickable-rows') ||
        !source.includes('@row-click=') ||
        !source.includes('width="min(720px, calc(100vw - 32px))"') ||
        expected.some((value) => !source.includes(value)) ||
        source.includes(':icon="View"');
      return missing ? [file] : [];
    });

    expect(failures).toEqual([]);
  });

  it('model, template, and audit detail dialogs expose a close button', () => {
    const dialogs: readonly (readonly [string, string, string])[] = [
      [
        'settings/MarAgentModelManagementPage.vue',
        'v-model="modelDetailOpen"',
        '@click="modelDetailOpen = false"'
      ],
      [
        'settings/ConversationTemplateManagementPage.vue',
        'v-model="detailDialogOpen"',
        '@click="detailDialogOpen = false"'
      ],
      [
        'settings/AuditManagementPage.vue',
        ':model-value="selected !== undefined"',
        '@click="selected = undefined"'
      ]
    ];
    const missing = dialogs.flatMap(([file, marker, closeHandler]) => {
      const source = managementPageSource(file);
      const start = source.indexOf(marker);
      const dialog = start === -1 ? '' : source.slice(start, source.indexOf('</el-dialog>', start));
      return dialog.includes('<template #footer>') &&
        dialog.includes(closeHandler) &&
        dialog.includes("translate('common.close')")
        ? []
        : [file];
    });

    expect(missing).toEqual([]);
  });

  it('maps conversation hosting audit events in both supported locales', () => {
    const events = [
      ['conversation_hosting_disabled', 'node', 'hostingDisable'],
      ['conversation_hosting_storage_inspected', 'node', 'storageInspect']
    ] as const;

    for (const [eventType, business, action] of events) {
      expect(classifyAuditEvent({ eventType })).toEqual([business, action]);
      expect(en.audit.actions[action]).toBeTruthy();
      expect(zh.audit.actions[action]).toBeTruthy();
    }
  });

  it('organization cascaders in management forms declare their full width directly', () => {
    const viewRoot = join(process.cwd(), 'ee/web/src/view');
    const forms: readonly (readonly [string, readonly string[]])[] = [
      ['settings/ConversationTemplateManagementPage.vue', ['targetOrganizationId']],
      ['settings/EnvironmentSecretManager.vue', ['organizationId']],
      ['settings/ModelGrantExtension.vue', ['targetOrganizationId']],
      ['settings/ResourceGrantExtension.vue', ['targetOrganizationId']],
      ['settings/MarAgentModelManagementPage.vue', ['credentialDraft.ownerOrganizationId']],
      ['settings/EnterpriseUserManagementPage.vue', ['userForm.organizationId']],
      ['settings/ResourceManagementPanel.vue', ['editOrganizationId', 'registrationOwner']],
      [
        'skill/McpSourceManagementPage.vue',
        ['sourceDraft.organizationId', 'catalogDraft.organizationId']
      ],
      [
        'skill/SkillSourceManagementPage.vue',
        ['sourceDraft.organizationId', 'catalogDraft.organizationId']
      ]
    ];
    const failures = forms.flatMap(([file, models]) => {
      const source = readFileSync(join(viewRoot, file), 'utf8');
      const tags = cascaderTags(source);
      const missingModels = models.filter(
        (model) =>
          !tags.some(
            (tag) => tag.includes(`v-model="${model}"`) && tag.includes('style="width: 100%"')
          )
      );
      return missingModels.length === 0 ? [] : [file];
    });

    expect(failures).toEqual([]);
  });
});
