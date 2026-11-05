<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import MarTab from '../common/MarTab.vue';
import PanelResizeHandle from './PanelResizeHandle.vue';
import MarIcon from '../common/MarIcon.vue';
import { tabStripIdentity } from '../../util/tab-strip-identity.js';
import type {
  AsideSession,
  AsideState,
  AsideTarget,
  AsideTool,
  AsideWorkspace
} from '../../service/workbench-aside-service.js';

const props = defineProps<{
  readonly workspace: AsideWorkspace;
  readonly state: AsideState;
  readonly tools: readonly { readonly id: AsideTool; readonly label: string }[];
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly title: string;
    readonly active: boolean;
  }[];
  readonly tabLabel: string;
  readonly closeLabel: (title: string) => string;
  readonly resizeLabel: string;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly mode: 'compact' | 'content';
  readonly mobile?: boolean;
  readonly closeSurfaceLabel?: string;
}>();
const emit = defineEmits<{
  selectTool: [target: AsideWorkspace & { readonly id: AsideTool }];
  selectSession: [target: AsideSession];
  closeSession: [target: AsideSession];
  resize: [width: number];
  closeSurface: [];
}>();
const element = ref<HTMLElement>();
const tabPrefix = `aside-${useId()}`;
const entries = computed(() => [
  ...props.tools
    .filter((tool) => props.state.tools.includes(tool.id))
    .map((tool) => ({
      id: `tool:${tool.id}`,
      label: tool.label,
      active: false,
      target: { kind: 'tool', id: tool.id } as AsideTarget
    })),
  ...props.state.sessions.map((sessionId, index) => {
    const session = props.sessions.find((item) => item.sessionId === sessionId);
    const label = session?.title ?? sessionId;
    return {
      id: `session:${sessionId}`,
      label,
      closeLabel: props.closeLabel(label),
      separatorBefore:
        index === 0 && props.tools.some((tool) => props.state.tools.includes(tool.id)),
      target: { kind: 'session', sessionId } as AsideTarget,
      active: session?.active ?? false
    };
  })
]);
const activeId = computed(() => {
  const target = props.state.active;
  return target?.kind === 'tool'
    ? `tool:${target.id}`
    : target?.kind === 'session'
      ? `session:${target.sessionId}`
      : undefined;
});
// The Inspector owns file windows and drafts, so moving between tools must not remount it.
const inspectorEntry = computed(() => {
  const tools = entries.value.filter(
    (entry) =>
      entry.target.kind === 'tool' &&
      entry.target.id !== 'terminal' &&
      entry.target.id !== 'browser'
  );
  return (
    tools.find((entry) => entry.id === activeId.value) ??
    tools.find(
      (entry) => entry.target.kind === 'tool' && entry.target.id === props.state.recentTool
    ) ??
    tools[0]
  );
});
function activate(id: string | number): void {
  const target = entries.value.find((entry) => entry.id === id)?.target;
  if (target?.kind === 'tool') emit('selectTool', { ...props.workspace, id: target.id });
  else if (target?.kind === 'session')
    emit('selectSession', { ...props.workspace, sessionId: target.sessionId });
}
function close(id: string | number): void {
  const target = entries.value.find((entry) => entry.id === id)?.target;
  if (target?.kind === 'session')
    emit('closeSession', { ...props.workspace, sessionId: target.sessionId });
}
</script>

<template>
  <aside ref="element" class="workbench-aside" :style="{ width: `${width}px` }">
    <PanelResizeHandle
      class="workbench-aside-resize"
      :target="element"
      :label="resizeLabel"
      :min="minWidth"
      :max="maxWidth"
      :width="width"
      :direction="-1"
      :gesture-key="mode"
      @resize="emit('resize', $event)"
    />
    <header class="workbench-aside-header">
      <button
        v-if="mobile"
        type="button"
        class="workbench-aside-back"
        :aria-label="closeSurfaceLabel"
        @click="emit('closeSurface')"
      >
        <MarIcon name="chevron-left" />
      </button>
      <MarTab
        class="workbench-aside-tabs"
        size="small"
        :items="entries"
        :id-prefix="tabPrefix"
        :active-id="activeId"
        :label="tabLabel"
        @activate="activate"
        @close="close"
      >
        <template #label="{ item }">
          <span class="workbench-aside-label">{{ item.label }}</span>
          <span
            v-if="entries.find((entry) => entry.id === item.id)?.active"
            class="workbench-aside-activity session-activity managed_active"
            aria-hidden="true"
            ><i />
          </span>
        </template>
      </MarTab>
    </header>
    <div class="workbench-aside-content">
      <div
        v-for="entry in entries.filter(
          (item) =>
            item.target.kind === 'tool' &&
            item.target.id !== 'terminal' &&
            item.target.id !== 'browser' &&
            item.id !== inspectorEntry?.id
        )"
        :id="tabStripIdentity(tabPrefix, entry.id).panel"
        :key="entry.id"
        hidden
        role="tabpanel"
        :aria-labelledby="tabStripIdentity(tabPrefix, entry.id).tab"
      />
      <div
        v-show="inspectorEntry !== undefined && inspectorEntry.id === activeId"
        :id="
          inspectorEntry === undefined
            ? undefined
            : tabStripIdentity(tabPrefix, inspectorEntry.id).panel
        "
        class="workbench-aside-panel"
        :role="inspectorEntry === undefined ? undefined : 'tabpanel'"
        :aria-labelledby="
          inspectorEntry === undefined
            ? undefined
            : tabStripIdentity(tabPrefix, inspectorEntry.id).tab
        "
      >
        <slot
          name="tool"
          :tool="inspectorEntry?.target.kind === 'tool' ? inspectorEntry.target.id : undefined"
        />
      </div>
      <div
        v-for="entry in entries.filter(
          (item) =>
            item.target.kind === 'session' ||
            item.target.id === 'terminal' ||
            item.target.id === 'browser'
        )"
        v-show="entry.id === activeId"
        :id="tabStripIdentity(tabPrefix, entry.id).panel"
        :key="entry.id"
        class="workbench-aside-panel"
        role="tabpanel"
        :aria-labelledby="tabStripIdentity(tabPrefix, entry.id).tab"
      >
        <slot
          v-if="
            entry.target.kind === 'tool' && entry.target.id === 'browser' && entry.id === activeId
          "
          name="browser"
        />
        <slot
          v-if="entry.target.kind === 'tool' && entry.target.id === 'terminal'"
          name="terminal"
          :visible="entry.id === activeId"
        />
        <slot
          v-if="entry.target.kind === 'session' && entry.id === activeId"
          name="session"
          :target="{ ...workspace, sessionId: entry.target.sessionId }"
        />
      </div>
    </div>
  </aside>
</template>

<style scoped>
.workbench-aside {
  position: relative;
  display: flex;
  flex: none;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-inline-start: 1px solid var(--mar-border-strong);
  background: var(--mar-bg-page);
}
.workbench-aside-header {
  --mar-tab-strip-active-bg: var(--mar-fill-selection);
  display: flex;
  flex: none;
  min-height: 32px;
  min-width: 0;
  border-bottom: 1px solid var(--mar-border-strong);
  background: var(--mar-bg-subtle);
}
.workbench-aside-back {
  display: grid;
  width: 30px;
  flex: 0 0 30px;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--mar-text-primary);
  cursor: pointer;
}
.workbench-aside-content {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}
.workbench-aside-panel {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}
.workbench-aside-resize {
  inset-inline-start: -4px;
}
.workbench-aside-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}
</style>
