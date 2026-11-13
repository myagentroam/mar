<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import MarTab from '../common/MarTab.vue';
import PanelResizeHandle from './PanelResizeHandle.vue';
import MarIcon from '../common/MarIcon.vue';
import { tabStripIdentity } from '../../util/tab-strip-identity.js';
import {
  consoleKeyboardShortcutService,
  type ConsoleShortcutBinding
} from '../../service/console-keyboard-shortcut-service.js';
import { workspaceKeys } from '../../service/console-shortcut-keys.js';
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
  readonly browserLabel: string;
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
  selectBrowser: [target: AsideWorkspace];
  closeBrowser: [target: AsideWorkspace];
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
  }),
  ...(props.state.htmlPath !== undefined && props.state.tools.includes('files')
    ? [
        {
          id: 'browser',
          label: props.browserLabel,
          closeLabel: props.closeLabel(props.browserLabel),
          separatorBefore: props.state.sessions.length === 0 && props.state.tools.length > 0,
          target: { kind: 'browser' } as AsideTarget,
          active: false
        }
      ]
    : [])
]);
const activeId = computed(() => {
  const target = props.state.active;
  return target?.kind === 'tool'
    ? `tool:${target.id}`
    : target?.kind === 'browser'
      ? 'browser'
      : target?.kind === 'session'
        ? `session:${target.sessionId}`
        : undefined;
});
function activate(id: string | number): void {
  const target = entries.value.find((entry) => entry.id === id)?.target;
  if (target?.kind === 'tool') emit('selectTool', { ...props.workspace, id: target.id });
  else if (target?.kind === 'browser') emit('selectBrowser', props.workspace);
  else if (target?.kind === 'session')
    emit('selectSession', { ...props.workspace, sessionId: target.sessionId });
}
function close(id: string | number): void {
  const target = entries.value.find((entry) => entry.id === id)?.target;
  if (target?.kind === 'browser') emit('closeBrowser', props.workspace);
  else if (target?.kind === 'session')
    emit('closeSession', { ...props.workspace, sessionId: target.sessionId });
}

// Aside owns only local close intents and frame listeners; its domain owners
// retain tab cleanup, session drafts, selection fallback, and Run lifecycles.
let browserDocument: Document | undefined;
let releaseBrowserFrame: (() => void) | undefined;
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
    if (browserDocument?.contains(target) && props.state.active?.kind === 'browser') return true;
    if (!root.contains(target)) return false;
    return !(
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') &&
      !consoleKeyboardShortcutService.isWithin('pane', target)
    );
  },
  execute: (event) => {
    // Fixed tools and bulk/repeated closes must never fall through to Workspace.
    if (!event.repeat && !event.shiftKey && activeId.value !== undefined) {
      const active = props.state.active;
      if (active?.kind === 'browser' || active?.kind === 'session') {
        close(activeId.value);
        void nextTick(() => {
          const root = element.value;
          if (!root?.getClientRects().length) return;
          if (document.activeElement !== document.body && !root.contains(document.activeElement))
            return;
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
function clearBrowserFrame(): void {
  releaseBrowserFrame?.();
  releaseBrowserFrame = undefined;
  browserDocument = undefined;
}
function bindBrowserFrame(event: Event): void {
  const frame = event.target;
  if (
    props.state.active?.kind !== 'browser' ||
    !(frame instanceof HTMLIFrameElement) ||
    !frame.matches('.html-preview-frame')
  )
    return;
  clearBrowserFrame();
  let frameDocument: Document | null;
  try {
    frameDocument = frame.contentDocument;
  } catch {
    // A separately configured preview origin intentionally isolates keyboard events.
    return;
  }
  if (frameDocument === null) return;
  browserDocument = frameDocument;
  const keydown = (event: KeyboardEvent): void => {
    // Never forward unrelated preview keys to background Workspace commands.
    if (consoleKeyboardShortcutService.invoke(closeBinding, event) !== 'HANDLED') return;
    event.preventDefault();
    event.stopPropagation();
  };
  frameDocument.addEventListener('keydown', keydown, { capture: true });
  releaseBrowserFrame = () =>
    frameDocument.removeEventListener('keydown', keydown, { capture: true });
}
watch(
  [
    () => props.workspace.nodeId,
    () => props.workspace.workspaceId,
    () => activeId.value,
    () => props.state.htmlPath
  ],
  clearBrowserFrame
);
onMounted(() => {
  unregisterClose = consoleKeyboardShortcutService.register(closeBinding);
});
onBeforeUnmount(() => {
  unregisterClose?.();
  clearBrowserFrame();
});
</script>

<template>
  <aside
    ref="element"
    class="workbench-aside"
    :style="{ width: `${width}px` }"
    @load.capture="bindBrowserFrame"
  >
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
        class="workbench-aside-back mar-icon-action"
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
            class="workbench-aside-activity mar-session-activity managed_active"
            aria-hidden="true"
            ><i />
          </span>
        </template>
      </MarTab>
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
        role="tabpanel"
        :aria-labelledby="tabStripIdentity(tabPrefix, entry.id).tab"
      >
        <slot v-if="entry.target.kind === 'browser' && entry.id === activeId" name="browser" />
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
html:not([data-theme]) .workbench-aside {
  border-inline-start-color: var(--mar-border-subtle);
}
html:not([data-theme]) .workbench-aside-header {
  border-bottom-color: var(--mar-border-subtle);
}
html:not([data-theme]) .workbench-aside-header :deep(.tab-strip-item) {
  border-color: var(--mar-border-default);
}
html:not([data-theme]) .workbench-aside-header :deep(.tab-strip-separator) {
  background: var(--mar-border-subtle);
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
