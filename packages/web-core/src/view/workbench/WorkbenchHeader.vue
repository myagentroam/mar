<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import type { SettingsSection } from '../../model/settings.js';
import type { WorkbenchView } from '../../util/workbench-route.js';
type ManagementSection = string;

defineProps<{
  readonly mobileViewport: boolean;
  readonly view: WorkbenchView;
  readonly sidebarCollapsed: boolean;
  readonly settingsSection: SettingsSection;
  readonly managementSection: ManagementSection;
  readonly settingsItems: readonly { readonly id: SettingsSection; readonly label: string }[];
  readonly managementItems: readonly { readonly id: ManagementSection; readonly label: string }[];
  readonly conversationTitle: string | undefined;
}>();

const emit = defineEmits<{
  toggleSidebar: [];
}>();
</script>

<template>
  <header
    v-if="!mobileViewport || view !== 'nodes'"
    :class="['workbench-header', { 'workspace-tabs-active': view === 'nodes' }]"
  >
    <button
      v-if="!mobileViewport"
      class="workbench-tree-toggle icon-button utility-control"
      :aria-label="
        sidebarCollapsed ? $t('navigation.expandSidebar') : $t('navigation.collapseSidebar')
      "
      :aria-expanded="!sidebarCollapsed"
      type="button"
      @click="emit('toggleSidebar')"
    >
      <MarIcon name="menu" v-if="sidebarCollapsed" />
      <MarIcon name="menu" v-else />
    </button>
    <div
      v-if="view === 'conversations' && conversationTitle"
      class="breadcrumb"
      :aria-label="$t('navigation.currentLocation')"
    >
      <span>{{ $t('navigation.conversations') }}</span>
      <strong v-tooltip="conversationTitle">{{ conversationTitle }}</strong>
    </div>
    <div v-else-if="view === 'nodes'" class="workspace-tabs-slot">
      <slot name="workspace-tabs"></slot>
    </div>
    <div v-else class="breadcrumb" :aria-label="$t('navigation.currentLocation')">
      <span>{{
        view === 'settings'
          ? $t('navigation.settings')
          : view === 'conversations'
            ? $t('navigation.conversations')
            : $t('navigation.management')
      }}</span>
      <strong v-if="view === 'settings'">{{
        settingsItems.find((item) => item.id === settingsSection)?.label
      }}</strong>
      <strong v-else-if="view === 'management'">{{
        managementItems.find((item) => item.id === managementSection)?.label
      }}</strong>
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
  padding-left: 0;
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

.workbench-tree-toggle[aria-expanded='true']:not(:hover):not(:focus-visible) {
  color: var(--mar-text-secondary);
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
  align-items: center;
  gap: 0.5rem;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}

.breadcrumb span + span::before,
.breadcrumb strong::before {
  margin-right: 0.5rem;
  color: var(--mar-border-strong);
  content: '/';
}

.breadcrumb strong {
  overflow: hidden;
  color: var(--mar-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<style scoped>
@media (max-width: 767px) {
  .workbench-header {
    flex: 0 0 48px;
    padding: 0 4px;
  }
}

@media (max-width: 460px) {
  .workbench-header {
    padding: 0 0.65rem;
  }
}
</style>
