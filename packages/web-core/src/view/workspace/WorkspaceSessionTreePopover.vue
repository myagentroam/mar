<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createMobileLayerHistoryService } from '../../service/mobile-layer-history-service.js';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';
import WorkspaceSessionTree from './WorkspaceSessionTree.vue';

const props = defineProps<{
  nodeId: string;
  workspaceId: string;
  sessionId: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  anchor?: HTMLElement;
}>();
const emit = defineEmits<{ open: [sessionId: string]; close: [] }>();
const trigger = ref<HTMLElement>();
const virtualReference = computed(() => {
  const target = props.anchor ?? trigger.value;
  return target
    ? { contextElement: target, getBoundingClientRect: () => target.getBoundingClientRect() }
    : undefined;
});
const mode = ref<'hover' | 'explicit' | undefined>(props.anchor ? 'explicit' : undefined);
const snapshotKey = ref(0);
let timer: ReturnType<typeof setTimeout> | undefined;
const history = createMobileLayerHistoryService({ isOpen: () => mode.value !== undefined, close });
onMounted(() => {
  history.start();
  window.addEventListener('keydown', onEscape);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  window.removeEventListener('keydown', onEscape);
  history.dispose();
});
watch(() => [props.nodeId, props.workspaceId, props.sessionId], close);

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  clearTimeout(timer);
  if (!mode.value) return;
  event.stopPropagation();
  close();
}
function close(): void {
  clearTimeout(timer);
  mode.value = undefined;
}
function open(nextMode: 'hover' | 'explicit'): void {
  if (!mode.value) snapshotKey.value++;
  mode.value = nextMode;
}
function enter(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return;
  clearTimeout(timer);
  if (!mode.value)
    timer = setTimeout(() => {
      open('hover');
    }, 200);
}
function leave(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return;
  clearTimeout(timer);
  if (mode.value === 'hover') timer = setTimeout(close, 150);
}
function toggle(): void {
  clearTimeout(timer);
  if (mode.value === 'explicit') close();
  else open('explicit');
}
function select(id: string): void {
  close();
  emit('open', id);
}
</script>

<template>
  <button
    v-if="!anchor"
    ref="trigger"
    type="button"
    class="icon-button utility-control conversation-tree-button"
    :aria-label="translate('sessionGroups.tree')"
    :aria-expanded="mode !== undefined"
    aria-haspopup="dialog"
    @pointerenter="enter"
    @pointerleave="leave"
    @click="toggle"
  >
    <MarIcon name="session-tree" />
  </button>
  <el-popover
    v-if="virtualReference"
    :visible="mode !== undefined"
    virtual-triggering
    :virtual-ref="virtualReference"
    role="group"
    trigger="click"
    :trigger-keys="[]"
    :hide-after="0"
    placement="bottom-start"
    width="min(520px, calc(100vw - 32px))"
    :persistent="false"
    popper-class="session-tree-popover"
    :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 8 } }] }"
    @update:visible="!$event && close()"
    @after-leave="emit('close')"
  >
    <div
      class="session-tree-popover-content"
      :inert="mode === undefined"
      role="dialog"
      :aria-label="translate('sessionGroups.tree')"
      @pointerenter="enter"
      @pointerleave="leave"
    >
      <WorkspaceSessionTree
        :key="snapshotKey"
        :active="mode !== undefined"
        :node-id="nodeId"
        :workspace-id="workspaceId"
        :session-id="sessionId"
        :request="request"
        @close="close"
        @open="select"
      />
    </div>
  </el-popover>
</template>

<style scoped>
.conversation-tree-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--mar-utility-control-size);
  height: var(--mar-utility-control-size);
}
</style>

<style>
.session-tree-popover.el-popper {
  padding: 0;
}
.session-tree-popover-content {
  padding: 0.75rem;
}
@media (prefers-reduced-motion: reduce) {
  .session-tree-popover.el-popper {
    transition: none;
  }
}
</style>
