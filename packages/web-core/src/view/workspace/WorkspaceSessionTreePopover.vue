<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { NavigationSnapshot } from '../../service/session-navigation-projection.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { createMobileLayerHistoryService } from '../../service/mobile-layer-history-service.js';
import WorkspaceSessionTree from './WorkspaceSessionTree.vue';

const props = defineProps<{
  visible: boolean;
  anchor: HTMLElement;
  placement?: 'bottom-start' | 'bottom-end';
  sessionId: string;
  title: string;
  tree: NavigationSnapshot['tree'] | undefined;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  mainSessionId?: string | undefined;
  asideSessionIds: readonly string[];
  activeAsideId?: string | undefined;
}>();
const emit = defineEmits<{
  close: [restoreFocus: boolean];
  'after-leave': [];
  open: [sessionId: string, target: 'aside' | 'main'];
  retry: [];
}>();
// Element Plus must position against the anchor without owning the trigger's ARIA attributes.
const virtualReference = computed(() => {
  const anchor = props.anchor;
  return { getBoundingClientRect: () => anchor.getBoundingClientRect(), contextElement: anchor };
});
const root = ref<HTMLElement>();
const treeComponent = ref<InstanceType<typeof WorkspaceSessionTree>>();
const menuOpen = ref(false);
let unregister: (() => void) | undefined;
const mobileHistory = createMobileLayerHistoryService({
  isOpen: () => props.visible,
  close: () => emit('close', true)
});
function outside(event: PointerEvent): void {
  if (!props.visible) return;
  const path = event.composedPath();
  if (
    path.includes(props.anchor) ||
    (root.value && path.includes(root.value)) ||
    path.some((part) => part instanceof Element && part.classList.contains('session-tree-menu'))
  )
    return;
  emit('close', false);
}
onMounted(() => {
  document.addEventListener('pointerdown', outside, true);
  mobileHistory.start();
  unregister = consoleKeyboardShortcutService.register({
    command: 'sessionTree.dismiss',
    scope: 'overlay',
    priority: 140,
    keys: [{ key: 'Escape' }],
    when: () => props.visible,
    execute: () => {
      if (menuOpen.value) treeComponent.value?.closeMenu();
      else emit('close', true);
      return 'HANDLED';
    }
  });
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true);
  mobileHistory.dispose();
  unregister?.();
});
</script>

<template>
  <el-popover
    :visible="visible"
    :virtual-ref="virtualReference"
    virtual-triggering
    :placement="placement ?? 'bottom-start'"
    :show-arrow="false"
    :persistent="false"
    popper-class="session-tree-popover mar-content-popover"
    :popper-style="visible ? undefined : { pointerEvents: 'none' }"
    width="min(480px, calc(100vw - 24px))"
    :popper-options="{
      modifiers: [{ name: 'preventOverflow', options: { padding: 12, tether: false } }]
    }"
    @after-leave="!visible && emit('after-leave')"
  >
    <section
      ref="root"
      class="session-tree-popup"
      role="dialog"
      :aria-label="title"
      :inert="!visible"
    >
      <header class="session-tree-header">{{ title }}</header>
      <div class="session-tree-scroll">
        <WorkspaceSessionTree
          ref="treeComponent"
          :session-id="sessionId"
          :interactive="visible"
          :tree="tree"
          :status="status"
          :main-session-id="mainSessionId"
          :aside-session-ids="asideSessionIds"
          :active-aside-id="activeAsideId"
          @open="(id, target) => emit('open', id, target)"
          @menu="menuOpen = $event"
          @retry="emit('retry')"
        />
      </div>
    </section>
  </el-popover>
</template>

<style scoped>
:global(.session-tree-popover) {
  max-width: calc(100vw - 24px);
  box-sizing: border-box;
}
.session-tree-header {
  min-width: 0;
  margin-block-end: 0.5rem;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-tree-scroll {
  max-height: min(60vh, 32rem);
  overflow: auto;
}
</style>
