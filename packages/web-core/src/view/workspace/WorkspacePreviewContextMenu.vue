<script setup lang="ts">
import { CopyDocument, DocumentCopy, Refresh } from '@element-plus/icons-vue';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';

const props = defineProps<{ readonly pasteEnabled: boolean }>();
const emit = defineEmits<{ copy: []; paste: []; reload: [] }>();
const trigger = ref<HTMLButtonElement>();
const visible = ref(false);
const x = ref(0);
const y = ref(0);

async function open(event: MouseEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  visible.value = false;
  x.value = Math.max(6, Math.min(event.clientX, window.innerWidth - 180));
  y.value = Math.max(6, Math.min(event.clientY, window.innerHeight - 118));
  await nextTick();
  visible.value = true;
  await nextTick();
  trigger.value?.click();
}

function command(value: 'copy' | 'paste' | 'reload'): void {
  if (value === 'copy') emit('copy');
  else if (value === 'paste') emit('paste');
  else emit('reload');
  visible.value = false;
}

function closeOnEscape(event: KeyboardEvent): void {
  if (!visible.value || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  visible.value = false;
}

onMounted(() => window.addEventListener('keydown', closeOnEscape, { capture: true }));
onBeforeUnmount(() => window.removeEventListener('keydown', closeOnEscape, { capture: true }));
defineExpose({ open, close: () => (visible.value = false) });
</script>

<template>
  <div v-if="visible" class="preview-context-anchor" :style="{ left: `${x}px`, top: `${y}px` }">
    <el-dropdown trigger="click" placement="bottom-start" @command="command">
      <button ref="trigger" class="preview-context-trigger" type="button" tabindex="-1" />
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="copy">
            <el-icon><CopyDocument /></el-icon>{{ translate('filePreviewContext.copy') }}
          </el-dropdown-item>
          <el-dropdown-item command="paste" :disabled="!props.pasteEnabled">
            <el-icon><DocumentCopy /></el-icon>{{ translate('filePreviewContext.paste') }}
          </el-dropdown-item>
          <el-dropdown-item command="reload">
            <el-icon><Refresh /></el-icon>{{ translate('filePreviewContext.reload') }}
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
