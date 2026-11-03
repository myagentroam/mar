<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { NavigationSnapshot } from '../../service/session-navigation-projection.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { createMobileLayerHistoryService } from '../../service/mobile-layer-history-service.js';
import { translate } from '../../service/locale-preference-service.js';
import WorkspaceSessionTree from './WorkspaceSessionTree.vue';

const props = defineProps<{
  anchor: HTMLElement;
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
  open: [sessionId: string, target: 'aside' | 'main'];
  retry: [];
}>();
const root = ref<HTMLElement>();
const treeComponent = ref<InstanceType<typeof WorkspaceSessionTree>>();
const menuOpen = ref(false);
let unregister: (() => void) | undefined;
const mobileHistory = createMobileLayerHistoryService({
  isOpen: () => true,
  close: () => emit('close', true)
});
function outside(event: PointerEvent): void {
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
    when: () => true,
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
    :visible="true"
    :virtual-ref="anchor"
    virtual-triggering
    placement="bottom-start"
    popper-class="session-tree-popover"
    width="min(480px, calc(100vw - 24px))"
  >
    <section ref="root" class="session-tree-popup" role="dialog" :aria-label="title">
      <header class="session-tree-header">
        <strong>{{ title }}</strong>
        <button type="button" :aria-label="translate('common.close')" @click="emit('close', true)">
          ×
        </button>
      </header>
      <div class="session-tree-scroll">
        <WorkspaceSessionTree
          ref="treeComponent"
          :session-id="sessionId"
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.session-tree-header strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-tree-scroll {
  max-height: min(60vh, 32rem);
  overflow: auto;
}
</style>
