<script setup lang="ts">
import { computed } from 'vue';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import type { SettingsSection } from '../../model/settings.js';
import { translate } from '../../service/locale-preference-service.js';
import type { WorkbenchView } from '../../util/workbench-route.js';
import type { ScheduleSection } from '../schedule/scheduled-task-navigation.js';
type ManagementSection = string;

const props = defineProps<{
  readonly mobileViewport: boolean;
  readonly view: WorkbenchView;
  readonly scheduleSection?: ScheduleSection | undefined;
  readonly scheduleSessionScoped?: boolean;
  readonly sidebarCollapsed: boolean;
  readonly workspaceStartupBlocked?: boolean;
  readonly settingsSection: SettingsSection;
  readonly managementSection: ManagementSection;
  readonly settingsItems: readonly { readonly id: SettingsSection; readonly label: string }[];
  readonly managementItems: readonly { readonly id: ManagementSection; readonly label: string }[];
  readonly conversationTitle: string | undefined;
}>();

const workspaceTabsActive = computed(
  () => props.view === 'nodes' && props.scheduleSection === undefined
);
const rootLabelKey = computed(() =>
  props.scheduleSection !== undefined
    ? 'generated.scheduledSession.panelTitle'
    : props.view === 'settings'
      ? 'navigation.settings'
      : props.view === 'conversations'
        ? 'navigation.conversations'
        : 'navigation.management'
);
const currentLabel = computed(() => {
  if (props.scheduleSessionScoped) return translate('generated.scheduledSession.sessionTitle');
  if (props.scheduleSection !== undefined)
    return translate(`generated.scheduledSession.${props.scheduleSection}`);
  if (props.view === 'conversations') return props.conversationTitle;
  if (props.view === 'settings')
    return props.settingsItems.find((item) => item.id === props.settingsSection)?.label;
  if (props.view === 'management')
    return props.managementItems.find((item) => item.id === props.managementSection)?.label;
  return undefined;
});

const emit = defineEmits<{
  toggleSidebar: [];
}>();
</script>

<template>
  <header
    v-if="!mobileViewport || view !== 'nodes' || scheduleSection !== undefined"
    :class="['workbench-header', { 'workspace-tabs-active': workspaceTabsActive }]"
  >
    <button
      v-if="
        !mobileViewport &&
        (scheduleSection !== undefined || view !== 'nodes' || !workspaceStartupBlocked)
      "
      class="workbench-tree-toggle mar-icon-button mar-icon-action mar-icon-action--panel-toggle"
      v-tooltip="
        sidebarCollapsed ? $t('navigation.expandSidebar') : $t('navigation.collapseSidebar')
      "
      :aria-label="
        sidebarCollapsed ? $t('navigation.expandSidebar') : $t('navigation.collapseSidebar')
      "
      :aria-expanded="!sidebarCollapsed"
      type="button"
      @click="emit('toggleSidebar')"
    >
      <MarIcon :name="sidebarCollapsed ? 'sidebar' : 'sidebar-expanded'" />
    </button>
    <div v-if="workspaceTabsActive" class="workspace-tabs-slot">
      <slot name="workspace-tabs"></slot>
    </div>
    <div v-else class="breadcrumb" :aria-label="$t('navigation.currentLocation')">
      <span>{{ $t(rootLabelKey) }}</span>
      <template v-if="currentLabel">
        <MarIcon
          class="breadcrumb-separator"
          name="chevron-right"
          size="0.65rem"
          aria-hidden="true"
        />
        <component
          :is="scheduleSection === undefined ? 'strong' : 'h1'"
          v-tooltip="
            scheduleSection === undefined && view === 'conversations' ? currentLabel : undefined
          "
          >{{ currentLabel }}</component
        >
      </template>
    </div>
  </header>
</template>

<style scoped>
.workbench-header {
  box-sizing: border-box;
  display: flex;
  height: var(--mar-workbench-header-height);
  flex: 0 0 var(--mar-workbench-header-height);
  align-items: center;
  gap: 0.35rem;
  border-bottom: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-chrome);
  padding: 0 64px 0 4px;
}

.workbench-header.workspace-tabs-active {
  gap: 0;
}

.workbench-tree-toggle {
  display: inline-grid;
  flex: 0 0 auto;
  width: var(--mar-compact-control-size);
  height: var(--mar-compact-control-size);
  min-width: var(--mar-compact-control-size);
  min-height: var(--mar-compact-control-size);
  place-items: center;
  line-height: 1;
}

.workbench-tree-toggle :deep(.mar-icon) {
  display: grid;
  place-items: center;
}

.workspace-tabs-slot {
  display: flex;
  min-width: 0;
  height: 100%;
  flex: 1 1 auto;
  align-items: center;
  overflow: visible;
}

.breadcrumb {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 0.35rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
}

.breadcrumb > span {
  flex: none;
  white-space: nowrap;
}

.breadcrumb-separator {
  flex: none;
  align-self: center;
  color: var(--mar-text-secondary);
}

.breadcrumb strong,
.breadcrumb h1 {
  min-width: 0;
  overflow: hidden;
  color: var(--mar-text-primary);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.breadcrumb h1 {
  margin: 0;
  font-size: inherit;
}

@media (max-width: 767px) {
  .workbench-header {
    height: auto;
    min-block-size: 42px;
    flex: none;
    padding-block: 6px;
    padding-inline: 14px;
  }
}
</style>
