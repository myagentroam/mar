<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';

const props = defineProps<{
  readonly pasteEnabled: boolean;
  readonly selectAllEnabled?: boolean;
  readonly quoteEnabled?: boolean;
}>();
const emit = defineEmits<{ copy: []; paste: []; reload: []; selectAll: []; quote: [] }>();
const trigger = ref<HTMLButtonElement>();
const visible = ref(false);
const x = ref(0);
const y = ref(0);

async function open(event: MouseEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  visible.value = false;
  x.value = Math.max(6, Math.min(event.clientX, window.innerWidth - 180));
  y.value = Math.max(6, Math.min(event.clientY, window.innerHeight - 190));
  await nextTick();
  visible.value = true;
  await nextTick();
  trigger.value?.click();
}

function command(value: 'copy' | 'paste' | 'reload' | 'selectAll' | 'quote'): void {
  if (value === 'copy') emit('copy');
  else if (value === 'paste') emit('paste');
  else if (value === 'selectAll') emit('selectAll');
  else if (value === 'quote') emit('quote');
  else emit('reload');
  visible.value = false;
}

let unregisterEscape: (() => void) | undefined;
onMounted(() => {
  unregisterEscape = consoleKeyboardShortcutService.register({
    command: 'filePreview.dismissMenu',
    priority: 150,
    scope: 'overlay',
    modalOwner: () => trigger.value,
    allowedInBlockedScopes: ['file-preview'],
    keys: [{ key: 'Escape' }],
    when: () => visible.value,
    execute: () => {
      visible.value = false;
      return 'HANDLED';
    }
  });
});
onBeforeUnmount(() => unregisterEscape?.());
defineExpose({ open, close: () => (visible.value = false) });
</script>

<template>
  <div v-if="visible" class="preview-context-anchor" :style="{ left: `${x}px`, top: `${y}px` }">
    <el-dropdown trigger="click" placement="bottom-start" @command="command">
      <button ref="trigger" class="preview-context-trigger" type="button" tabindex="-1" />
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="copy">
            <MarIcon name="copy" />{{ translate('filePreviewContext.copy') }}
          </el-dropdown-item>
          <el-dropdown-item command="paste" :disabled="!props.pasteEnabled">
            <MarIcon name="paste" />{{ translate('filePreviewContext.paste') }}
          </el-dropdown-item>
          <el-dropdown-item command="selectAll" :disabled="!props.selectAllEnabled">
            <MarIcon name="menu" />{{ translate('composer.selectAll') }}
          </el-dropdown-item>
          <el-dropdown-item command="quote" :disabled="!props.quoteEnabled">
            <MarIcon name="quote" />{{ translate('composer.quote') }}
          </el-dropdown-item>
          <el-dropdown-item command="reload">
            <MarIcon name="refresh" />{{ translate('filePreviewContext.reload') }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<style scoped>
.preview-context-anchor {
  position: fixed;
  z-index: 5000;
  width: 1px;
  height: 1px;
}

.preview-context-trigger {
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  background: transparent;
}
</style>
