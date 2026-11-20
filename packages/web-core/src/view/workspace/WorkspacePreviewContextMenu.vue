<script setup lang="ts">
import {
  MarDropdown,
  MarDropdownItem,
  MarDropdownMenu,
  type MarDropdownInstance
} from '@myagentroam/mar-ui/dropdown';
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';

const props = defineProps<{
  readonly pasteEnabled: boolean;
  readonly selectAllEnabled?: boolean;
  readonly quoteEnabled?: boolean;
}>();
const emit = defineEmits<{ copy: []; paste: []; reload: []; selectAll: []; quote: [] }>();
const menu = ref<MarDropdownInstance>();
const actions = ref<HTMLElement>();
const visible = ref(false);
const anchor = shallowRef<DOMRect>();
const virtualReference = { getBoundingClientRect: () => anchor.value ?? new DOMRect() };

async function open(event: MouseEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  anchor.value = new DOMRect(event.clientX, event.clientY);
  visible.value = true;
  await nextTick();
  menu.value?.handleOpen();
}

type PreviewCommand = 'copy' | 'paste' | 'reload' | 'selectAll' | 'quote';

function command(value: PreviewCommand): void {
  if (value === 'copy') emit('copy');
  else if (value === 'paste') emit('paste');
  else if (value === 'selectAll') emit('selectAll');
  else if (value === 'quote') emit('quote');
  else emit('reload');
}

let unregisterEscape: (() => void) | undefined;
onMounted(() => {
  unregisterEscape = consoleKeyboardShortcutService.register({
    command: 'filePreview.dismissMenu',
    priority: 150,
    scope: 'overlay',
    modalOwner: () => actions.value,
    allowedInBlockedScopes: ['file-preview'],
    keys: [{ key: 'Escape' }],
    when: () => visible.value,
    execute: () => {
      menu.value?.handleClose();
      return 'HANDLED';
    }
  });
});
onBeforeUnmount(() => unregisterEscape?.());
defineExpose({ open, close: () => (visible.value = false) });
</script>

<template>
  <!-- @vue-generic {PreviewCommand} -->
  <MarDropdown
    v-if="visible"
    ref="menu"
    trigger="contextmenu"
    virtual-triggering
    :virtual-ref="virtualReference"
    placement="bottom-start"
    @command="command"
    @visible-change="!$event && (visible = false)"
  >
    <template #dropdown>
      <div ref="actions" class="preview-context-actions" @pointerdown.stop.prevent>
        <MarDropdownMenu>
          <MarDropdownItem command="copy" icon="copy">{{
            translate('filePreviewContext.copy')
          }}</MarDropdownItem>
          <MarDropdownItem command="paste" icon="paste" :disabled="!props.pasteEnabled">{{
            translate('filePreviewContext.paste')
          }}</MarDropdownItem>
          <MarDropdownItem command="selectAll" icon="menu" :disabled="!props.selectAllEnabled">{{
            translate('composer.selectAll')
          }}</MarDropdownItem>
          <MarDropdownItem command="quote" icon="quote" :disabled="!props.quoteEnabled">{{
            translate('composer.quote')
          }}</MarDropdownItem>
          <MarDropdownItem command="reload" icon="refresh">{{
            translate('filePreviewContext.reload')
          }}</MarDropdownItem>
        </MarDropdownMenu>
      </div>
    </template>
  </MarDropdown>
</template>

<style scoped>
.preview-context-actions {
  display: contents;
}
</style>
