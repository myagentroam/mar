<script setup lang="ts">
// Renders production settings and navigation with isolated data; no shared services or database.
import { computed, onBeforeUnmount, ref } from 'vue';
import SettingsContent from '../../src/view/settings/SettingsContent.vue';
import WorkbenchNavigation from '../../src/view/workbench/WorkbenchNavigation.vue';
import WorkbenchHeader from '../../src/view/workbench/WorkbenchHeader.vue';
import { createWorkbenchNavigationService } from '../../src/service/workbench-navigation-service.js';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { createWebPerformanceDiagnostics } from '../../src/service/web-performance-diagnostic-service.js';
import { translate } from '../../src/service/locale-preference-service.js';
import { formatDateTime } from '../../src/util/time-presentation.js';
import type { SettingsSection } from '../../src/model/settings.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';
import type { PersonalUsageOverview, UsageTotals } from '@myagentroam/protocol';

const navigation = createWorkbenchNavigationService<WorkbenchView, SettingsSection, string>({
  initialView: 'settings',
  initialSettingsSection: 'appearance',
  initialManagementSection: 'system',
  opensMobileSidebar: () => true
});
navigation.start();
const { settingsSection, mobileViewport, sidebarCollapsed, mobileSidebarOpen } = navigation;
const settingsItems = computed(() => [
  { id: 'account' as const, label: translate('navigation.account') },
  { id: 'usage' as const, label: translate('usageStatistics.title') },
  { id: 'appearance' as const, label: translate('settings.appearance') },
  { id: 'custom-themes' as const, label: translate('customThemes.title') },
  {
    id: 'notifications' as const,
    label: translate('workbenchNotificationCenter.systemNotifications.title')
  },
  { id: 'quick-prompts' as const, label: translate('quickPrompts.title') },
  { id: 'personal-instructions' as const, label: translate('navigation.personalInstructions') },
  { id: 'git' as const, label: translate('personalGit.title') },
  { id: 'shortcuts' as const, label: translate('navigation.shortcuts') },
  { id: 'about' as const, label: translate('navigation.about') }
]);
const initial = new URL(location.href).searchParams.get('section');
if (initial === 'registration' || settingsItems.value.some((item) => item.id === initial))
  navigation.selectSettings(initial as SettingsSection);

async function request<T>(path: string): Promise<T> {
  if (path.startsWith('/api/me/usage/records?'))
    return { total: '0', records: [], nextCursor: null } as T;
  if (path.startsWith('/api/me/usage/overview?')) {
    const totals: UsageTotals = {
      inputTokens: '0',
      outputTokens: '0',
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: '0',
      requests: '0',
      completeRequests: '0',
      partialRequests: '0',
      unknownRequests: '0'
    };
    const overview: PersonalUsageOverview = {
      asOf: 1794524400000,
      availableFrom: 1793920000000,
      firstRecordedAt: null,
      lastReceivedAt: null,
      last24Hours: totals,
      last7Days: totals,
      selected: totals,
      buckets: [],
      runners: [],
      models: [],
      coverage: 'observed-only'
    };
    return overview as T;
  }
  if (path === '/api/personal-instructions')
    return {
      instructions: {
        common: 'Keep changes focused. Explain important decisions and verify the result.',
        marAgent: '',
        codex: '',
        claudeCode: '',
        openCode: ''
      }
    } as T;
  if (path === '/api/personal-git') return { configuration: { credentials: [] } } as T;
  throw new Error(`Unexpected fixture request: ${path}`);
}
const notifications = createWorkbenchNotificationService(ref(undefined));
const diagnostics = createWebPerformanceDiagnostics();
onBeforeUnmount(() => {
  navigation.dispose();
  notifications.dispose();
});
</script>

<template>
  <main class="settings-layout-fixture">
    <WorkbenchNavigation
      web-version="0.13.20"
      view="settings"
      :navigation-items="[
        { id: 'nodes', label: translate('navigation.nodes') },
        { id: 'conversations', label: translate('navigation.conversations') },
        { id: 'management', label: translate('navigation.management') },
        { id: 'settings', label: translate('navigation.settings') }
      ]"
      :settings-section="settingsSection"
      :settings-items="settingsItems"
      management-section="system"
      :management-items="[]"
      :sidebar-collapsed="sidebarCollapsed"
      :mobile-sidebar-open="mobileSidebarOpen"
      :sidebar-content-visible="!sidebarCollapsed || mobileSidebarOpen"
      :nodes="[]"
      :expanded-node-ids="[]"
      :workspace-target="undefined"
      :dragging-workspace="undefined"
      :loading="false"
      :node-label="(node) => node.id"
      :workspace-label="(workspace) => workspace.path"
      :workspaces="() => []"
      :mobile-viewport="mobileViewport"
      :notification-service="notifications"
      :performance-diagnostics="diagnostics"
      :uploads="[]"
      :upload-status-label="() => ''"
      @select-settings="navigation.selectSettings"
      @select-navigation="navigation.selectView"
      @close-mobile-sidebar="navigation.closeMobileSidebar"
    />
    <section class="settings-workspace" :class="{ compact: sidebarCollapsed }">
      <WorkbenchHeader
        view="settings"
        :mobile-viewport="mobileViewport"
        :sidebar-collapsed="sidebarCollapsed"
        :settings-section="settingsSection"
        :settings-items="settingsItems"
        management-section="system"
        :management-items="[]"
        :conversation-title="undefined"
        @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
      />
      <SettingsContent
        :section="settingsSection"
        web-version="0.13.20"
        :sessions="[
          {
            id: 'current',
            current: true,
            createdAt: 1794524400000,
            expiresAt: 1795129200000,
            ipAddress: '192.0.2.10',
            userAgent: 'Chrome · Linux'
          }
        ]"
        new-password=""
        password-validation-error=""
        :registration-token="undefined"
        :registration-loading="false"
        :loading="false"
        :change-password="async () => true"
        :format-session-time="formatDateTime"
        :request="request"
        :quick-prompts="[
          {
            id: 'review',
            phrase: 'review',
            prompt: 'Review the current change. Focus on correctness, scope and regression risks.',
            updatedAt: 1794524400000
          }
        ]"
        :quick-prompts-loading="false"
        :quick-prompts-failed="false"
        :refresh-quick-prompts="async () => {}"
        :system-notifications="notifications.systemNotifications"
      />
    </section>
  </main>
</template>

<style scoped>
.settings-layout-fixture {
  height: 100dvh;
  overflow: hidden;
}
.settings-workspace {
  display: flex;
  height: 100%;
  min-width: 0;
  flex-direction: column;
  margin-left: var(--mar-workbench-sidebar-total-width);
}
.settings-workspace.compact {
  margin-left: var(--mar-activity-rail-width);
}
.settings-workspace :deep(.settings-content) {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
}
@media (max-width: 767px) {
  .settings-workspace,
  .settings-workspace.compact {
    margin-left: 0;
  }
}
</style>
