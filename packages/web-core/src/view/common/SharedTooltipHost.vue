<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { ElTooltip, useZIndex } from 'element-plus';
import { TOOLTIP_SERVICE_KEY } from '../../service/tooltip-service.js';
import { tableTooltipOptions } from '../../util/tooltip.js';

const service = inject(TOOLTIP_SERVICE_KEY)!;
const active = service.active;
const descriptionId = `mar-tooltip-${useId()}`;
const { nextZIndex } = useZIndex();
const zIndex = ref(0);
const virtualReference = computed(() => {
  const target = active.value?.target;
  // A non-DOM reference keeps Element Plus from rewriting the real target's ARIA/menu state.
  return target
    ? { contextElement: target, getBoundingClientRect: () => target.getBoundingClientRect() }
    : undefined;
});
watch(
  () => active.value?.target,
  (target) => {
    if (target) zIndex.value = nextZIndex();
  },
  { flush: 'sync' }
);
let disconnect: (() => void) | undefined;
onMounted(() => {
  disconnect = service.connect(descriptionId);
});
onBeforeUnmount(() => disconnect?.());
</script>

<template>
  <ElTooltip
    v-if="active && virtualReference"
    v-bind="tableTooltipOptions"
    virtual-triggering
    :virtual-ref="virtualReference"
    :visible="true"
    :enterable="false"
    :placement="active.placement ?? 'bottom'"
    :popper-class="
      ['mar-tooltip', 'mar-tooltip-passive', active.popperClass].filter(Boolean).join(' ')
    "
    :z-index="zIndex"
    transition="none"
  >
    <template #content
      ><span :id="descriptionId">{{ active.content }}</span></template
    >
  </ElTooltip>
</template>
