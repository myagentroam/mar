import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Web hosted conversation entry', () => {
  it('The main menu always shows Conversations without hiding the page by Node capability', async () => {
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

    expect(navigationStart).toBeGreaterThanOrEqual(0);
    expect(navigationEnd).toBeGreaterThan(navigationStart);
    expect(navigationSource).toContain(
      "{ id: 'conversations', label: translate('navigation.conversations'), icon: '◉' }"
    );
    expect(navigationSource).not.toContain('hostedConversationNavigationAvailable');
  });

  it('Templates use native dropdown disabled state and creation is inline rather than modal', async () => {
    const [entrySource, workspaceSource, composerSource, headerSource, zhMessages, enMessages] =
      await Promise.all([
        readFile(
          resolve(
            process.cwd(),
            'packages/web-core/src/view/conversation/HostedConversationEntryPage.vue'
          ),
          'utf8'
        ),
        readFile(
          resolve(
            process.cwd(),
            'packages/web-core/src/view/conversation/HostedConversationWorkspacePage.vue'
          ),
          'utf8'
        ),
        readFile(
          resolve(
            process.cwd(),
            'packages/web-core/src/view/conversation/HostedConversationComposer.vue'
          ),
          'utf8'
        ),
        readFile(
          resolve(process.cwd(), 'packages/web-core/src/view/workbench/WorkbenchHeader.vue'),
          'utf8'
        ),
        readFile(
          resolve(process.cwd(), 'packages/web-core/src/i18n/hosted-conversations.zh-CN.ts'),
          'utf8'
        ),
        readFile(
          resolve(process.cwd(), 'packages/web-core/src/i18n/hosted-conversations.en-US.ts'),
          'utf8'
        )
      ]);

    expect(zhMessages).toContain("chooseTemplate: '加载模板'");
    expect(zhMessages).toContain("chooseTemplateLabel: '加载模板：'");
    expect(zhMessages).toContain("noTemplates: '当前没有可使用的对话模板。'");
    expect(zhMessages).toContain("searchHistory: '搜索对话标题'");
    expect(enMessages).toContain("chooseTemplate: 'Load template'");
    expect(enMessages).toContain("chooseTemplateLabel: 'Load template:'");
    expect(enMessages).toContain(
      "noTemplates: 'No conversation templates are currently available.'"
    );
    expect(enMessages).toContain("searchHistory: 'Search chat titles'");

    expect(entrySource).toContain('const sequence = ++loadSequence;');
    expect(entrySource).toContain('if (sequence !== loadSequence) return;');
    expect(entrySource).toContain(':disabled="creating || !template.available"');
    expect(entrySource).toContain('<el-select');
    expect(entrySource).toContain('@visible-change="refreshTemplatesOnOpen"');
    expect(entrySource).toContain('hide-required-asterisk');
    expect(entrySource).toContain(`:label="translate('hostedConversations.chooseTemplateLabel')"`);
    expect(entrySource).toContain('class="conversation-create-panel"');
    expect(entrySource).toContain('class="conversation-template-empty"');
    expect(entrySource).not.toContain('<el-empty');
    expect(entrySource).toContain('<el-icon class="conversation-create-icon"');
    expect(entrySource).toContain('class="template-selection-row"');
    expect(entrySource).toContain('class="create-conversation-button"');
    expect(entrySource).toContain('ChatDotRound');
    expect(entrySource).toContain('ChatLineSquare');
    expect(entrySource).not.toContain(':icon="Plus"');
    expect(entrySource).toContain("translate('hostedConversations.start')");
    expect(entrySource).toContain('service.create()');
    expect(entrySource).toContain('place-items: center;');
    const createPanelStyles = entrySource.match(/\.conversation-create-panel\s*\{([^}]*)\}/s)?.[1];
    expect(createPanelStyles).toBeDefined();
    expect(createPanelStyles).not.toContain('border:');
    const createIconStyles = entrySource.match(/\.conversation-create-icon\s*\{([^}]*)\}/s)?.[1];
    expect(createIconStyles).toBeDefined();
    expect(createIconStyles).not.toContain('background:');
    expect(createIconStyles).not.toContain('border:');
    expect(createIconStyles).not.toContain('border-radius:');
    expect(entrySource).not.toContain('role="radiogroup"');
    expect(entrySource).not.toContain('refresh-templates');
    expect(entrySource).not.toContain('selected-template-summary');
    expect(entrySource).not.toContain('templateHostedBy');
    expect(workspaceSource).toContain('@click="beginNewConversation"');
    expect(workspaceSource).toContain('<HostedConversationEntryPage');
    expect(workspaceSource).toContain(
      '.history-refresh-button :deep(.el-icon) {\n  font-size: var(--mar-font-size-body);'
    );
    expect(composerSource).toContain('<el-dropdown');
    expect(composerSource).toContain('trigger="click"');
    expect(composerSource).toContain('@command="updateModel(String($event))"');
    expect(composerSource).toContain('class="hosted-model-trigger"');
    expect(composerSource).toContain(':disabled="modelSelectionDisabled"');
    expect(composerSource).not.toContain('<el-select');
    expect(composerSource).toContain('min-height: var(--mar-compact-control-size);');
    expect(composerSource).toMatch(
      /\.hosted-model-trigger \{[^}]*border: 0;[^}]*cursor: pointer;/s
    );
    expect(composerSource).toMatch(
      /\.hosted-template-name \{[^}]*border: 1px solid var\(--mar-border-medium\);/s
    );
    expect(composerSource).toMatch(
      /\.hosted-model-trigger > span \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s
    );
    expect(workspaceSource).not.toContain('v-model="createOpen"');
    expect(headerSource).toContain('v-if="!mobileViewport"');
    expect(headerSource).not.toContain("!mobileViewport && view !== 'conversations'");
  });
});
