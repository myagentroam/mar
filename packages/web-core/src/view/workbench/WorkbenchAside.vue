<script setup lang="ts">
import '../session/session-markers.css';
import '../../styles/workbench-tab-header.css';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { MarPanelResizeHandle } from '@myagentroam/mar-ui/panel-resize-handle';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { MarTabs, tabStripIdentity } from '@myagentroam/mar-ui/tabs';
import { translate as t } from '../../service/locale-preference-service.js';
import {
  consoleKeyboardShortcutService,
  type ConsoleShortcutBinding
} from '../../service/console-keyboard-shortcut-service.js';
import {
  closeTabKeys,
  shortcutTooltip,
  workspaceKeys
} from '../../service/console-shortcut-keys.js';
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
  readonly tools: readonly {
    readonly id: AsideTool;
    readonly label: string;
    readonly tooltip?: string | undefined;
  }[];
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
  readonly inert?: boolean;
  readonly sessionLocation?: AsideSession | undefined;
  readonly mobile?: boolean;
  readonly closeSurfaceLabel?: string;
}>();
const emit = defineEmits<{
  selectTool: [target: AsideWorkspace & { readonly id: AsideTool }];
  selectSession: [target: AsideSession];
  closeSession: [target: AsideSession];
  closeBrowser: [target: AsideWorkspace];
  resize: [width: number];
  closeSurface: [];
}>();
const element = ref<HTMLElement>();
const tabPrefix = `aside-${useId()}`;
type AsideTab = {
  id: string;
  label: string;
  active: boolean;
  target: AsideTarget;
  tooltip?: string | undefined;
  closeLabel?: string;
  separatorBefore?: boolean;
};
const fixedTools = computed(() =>
  props.tools.filter((tool) => tool.id !== 'node-browser' && props.state.tools.includes(tool.id))
);
const browserTool = computed(() =>
  props.state.tools.includes('node-browser')
    ? props.tools.find((tool) => tool.id === 'node-browser')
    : undefined
);
const browserTab = computed(() => (props.state.browserOpen ? browserTool.value : undefined));
const entries = computed<AsideTab[]>(() => [
  ...fixedTools.value.map((tool) => ({
    id: `tool:${tool.id}`,
    label: tool.label,
    tooltip: tool.tooltip,
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
      separatorBefore: index === 0 && fixedTools.value.length > 0,
      target: { kind: 'session', sessionId } as AsideTarget,
      active: session?.active ?? false
    };
  }),
  ...(browserTab.value
    ? [
        {
          id: 'tool:node-browser',
          label: browserTab.value.label,
          closeLabel: props.closeLabel(browserTab.value.label),
          separatorBefore: props.state.sessions.length === 0 && fixedTools.value.length > 0,
          target: { kind: 'tool', id: 'node-browser' } as const,
          active: false
        }
      ]
    : [])
]);
const tabItems = computed(() =>
  entries.value.map(({ id, label, tooltip, closeLabel, separatorBefore }) => ({
    name: id,
    label,
    tooltip,
    closeLabel,
    closeTooltip:
      closeLabel && shortcutTooltip(closeLabel, id === activeId.value ? closeTabKeys : []),
    separatorBefore
  }))
);
const activeId = computed(() => {
  const target = props.state.active;
  return target?.kind === 'tool'
    ? `tool:${target.id}`
    : target?.kind === 'session'
      ? `session:${target.sessionId}`
      : undefined;
});
let locationSequence = 0;
const sessionLocation = ref<{ readonly id: string; readonly sequence: number }>();

function indicateSessionLocation(target: AsideSession): void {
  const id = `session:${target.sessionId}`;
  if (
    props.mobile ||
    props.inert ||
    props.workspace.nodeId !== target.nodeId ||
    props.workspace.workspaceId !== target.workspaceId ||
    activeId.value !== id
  )
    return;
  sessionLocation.value = { id, sequence: ++locationSequence };
  document.getElementById(tabStripIdentity(tabPrefix, id).panel)?.focus({ preventScroll: true });
}
watch(
  [
    () => props.workspace.nodeId,
    () => props.workspace.workspaceId,
    activeId,
    () => props.inert,
    () => props.mobile
  ],
  () => (sessionLocation.value = undefined)
);
watch(
  () => props.sessionLocation,
  (target) => {
    if (target !== undefined) indicateSessionLocation(target);
  },
  { flush: 'post' }
);

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
  else if (target?.kind === 'tool' && target.id === 'node-browser')
    emit('closeBrowser', props.workspace);
}

// Aside owns only local close intents; its domain owners
// retain tab cleanup, session drafts, selection fallback, and Run lifecycles.
let unregisterClose: (() => void) | undefined;
const closeBinding: ConsoleShortcutBinding = {
  command: 'aside.closeTab',
  priority: 60,
  scope: 'workspace',
  modalOwner: () => element.value,
  keys: workspaceKeys.close,
  when: (event) => {
    const root = element.value;
    const target = event.target as Node | null;
    if (!root?.getClientRects().length || typeof target?.nodeType !== 'number') return false;
    if (!root.contains(target)) return false;
    return !(
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') &&
      !target.matches('[data-node-browser-input]') &&
      !consoleKeyboardShortcutService.isWithin('pane', target)
    );
  },
  execute: (event) => {
    // Fixed tools and bulk/repeated closes must never fall through to Workspace.
    if (!event.repeat && !event.shiftKey && activeId.value !== undefined) {
      const active = props.state.active;
      if (active?.kind === 'session' || (active?.kind === 'tool' && active.id === 'node-browser')) {
        close(activeId.value);
        void nextTick(() => {
          const root = element.value;
          if (!root?.getClientRects().length) return;
          if (document.activeElement !== document.body) return;
          root
            .querySelector<HTMLElement>(
              '.workbench-aside-header [role="tab"][aria-selected="true"]'
            )
            ?.focus({ preventScroll: true });
        });
      }
    }
    return 'HANDLED';
  }
};
onMounted(() => {
  unregisterClose = consoleKeyboardShortcutService.register(closeBinding);
});
onBeforeUnmount(() => {
  unregisterClose?.();
});
</script>

<template>
  <aside ref="element" class="workbench-aside" :inert="inert" :style="{ width: `${width}px` }">
    <MarPanelResizeHandle
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
    <header class="workbench-aside-header mar-tab-header">
      <button
        v-if="mobile"
        type="button"
        class="workbench-aside-back mar-icon-action"
        v-tooltip="closeSurfaceLabel"
        :aria-label="closeSurfaceLabel"
        @click="emit('closeSurface')"
      >
        <MarIcon name="chevron-left" />
      </button>
      <MarTabs
        mode="strip"
        appearance="workbench"
        class="workbench-aside-tabs"
        :tabs="tabItems"
        :id-prefix="tabPrefix"
        :model-value="activeId"
        :label="tabLabel"
        @tab-activate="activate"
        @tab-close="close"
      >
        <template #label="{ tab }">
          <span class="workbench-aside-label mar-tab-label">{{ tab.label }}</span>
          <span
            v-if="entries.find((entry) => entry.id === tab.name)?.active"
            class="workbench-aside-activity mar-session-activity running"
            aria-hidden="true"
            ><i />
          </span>
        </template>
        <template v-if="browserTool && !inert" #action>
          <MarDropdown
            trigger="click"
            placement="bottom-end"
            @command="emit('selectTool', { ...workspace, id: 'node-browser' })"
          >
            <MarButton
              text
              icon="plus"
              :aria-label="t('browser.addAsideTab')"
              v-tooltip="t('browser.addAsideTab')"
            />
            <template #dropdown>
              <MarDropdownMenu :aria-label="t('browser.addAsideTab')">
                <MarDropdownItem command="browser" icon="web">{{
                  browserTool.label
                }}</MarDropdownItem>
              </MarDropdownMenu>
            </template>
          </MarDropdown>
        </template>
      </MarTabs>
    </header>
    <div class="workbench-aside-content">
      <div
        v-for="entry in entries.filter(
          (item) => item.target.kind === 'tool' && item.target.id !== 'terminal'
        )"
        v-show="entry.id === activeId"
        :id="tabStripIdentity(tabPrefix, entry.id).panel"
        :key="entry.id"
        class="workbench-aside-panel"
        role="tabpanel"
        :aria-labelledby="tabStripIdentity(tabPrefix, entry.id).tab"
      >
        <slot
          name="tool"
          :tool="entry.target.kind === 'tool' ? entry.target.id : undefined"
          :visible="entry.id === activeId"
        />
      </div>
      <div
        v-for="entry in entries.filter(
          (item) => item.target.kind !== 'tool' || item.target.id === 'terminal'
        )"
        v-show="entry.id === activeId"
        :id="tabStripIdentity(tabPrefix, entry.id).panel"
        :key="entry.id"
        class="workbench-aside-panel"
        :class="{ 'workbench-aside-session-panel': entry.target.kind === 'session' }"
        role="tabpanel"
        :tabindex="entry.target.kind === 'session' ? -1 : undefined"
        :aria-labelledby="tabStripIdentity(tabPrefix, entry.id).tab"
      >
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
        <span
          v-if="sessionLocation && sessionLocation.id === entry.id && entry.id === activeId"
          :key="sessionLocation.sequence"
          class="workbench-aside-session-location"
          aria-hidden="true"
          @animationend="sessionLocation = undefined"
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
  border-inline-start: 1px solid var(--mar-workbench-divider);
  background: var(--mar-bg-panel);
}
.workbench-aside-header {
  border-bottom-color: var(--mar-workbench-divider);
}
.workbench-aside-tabs :deep(.mar-tab-strip) {
  overscroll-behavior: contain;
}
.workbench-aside-back {
  display: grid;
  width: 30px;
  flex: 0 0 30px;
  place-items: center;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.workbench-aside-content {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  overscroll-behavior: contain;
}
.workbench-aside-panel {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}
.workbench-aside-session-panel {
  position: relative;
}
.workbench-aside-session-location {
  position: absolute;
  z-index: 4;
  inset: 0;
  border: 1px solid var(--mar-conversation-activity-fg);
  pointer-events: none;
  animation: aside-session-location 560ms ease-out both;
}
@keyframes aside-session-location {
  0%,
  100% {
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .workbench-aside-session-location {
    animation: aside-session-location-static 400ms step-end both;
  }
}
@keyframes aside-session-location-static {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
.workbench-aside-resize {
  z-index: 6;
  inset-inline-start: -4px;
}
@media (max-width: 767px) {
  .workbench-aside-resize {
    display: none;
  }
}
.workbench-aside-label {
  flex: 1;
  text-align: center;
}
</style>
