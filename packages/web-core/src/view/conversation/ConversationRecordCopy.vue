<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { ConversationItem } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';

const props = defineProps<{ record: ConversationItem | readonly ConversationItem[] }>();
const emit = defineEmits<{ copy: [text: string, onSuccess: () => void] }>();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const label = computed(() =>
  translate(copied.value ? 'toolPresentation.detail.copied' : 'toolPresentation.detail.copy')
);
function copy() {
  emit('copy', JSON.stringify(props.record, null, 2), () => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    copied.value = true;
    timer = setTimeout(() => {
      copied.value = false;
      timer = undefined;
    }, 500);
  });
}
onBeforeUnmount(() => {
  disposed = true;
  if (timer !== undefined) clearTimeout(timer);
});
</script>

<template>
  <button
    v-tooltip="label"
    type="button"
    class="tool-detail-copy icon-button icon-action"
    :aria-label="label"
    @click.stop="copy"
  >
    <MarIcon :name="copied ? 'check' : 'copy'" />
  </button>
</template>

<style scoped>
.tool-detail-copy {
  position: absolute;
  top: 0.5rem;
  right: var(--conversation-copy-end, 0.5rem);
  display: inline-flex;
  width: var(--mar-utility-control-size);
  height: var(--mar-utility-control-size);
  align-items: center;
  justify-content: center;
  border-radius: var(--mar-radius-control);
  padding: 0;
}
</style>
