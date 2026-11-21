<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, useId } from 'vue';
import { MarTooltip } from '@myagentroam/mar-ui/tooltip';
import { TOOLTIP_SERVICE_KEY } from '../../service/tooltip-service.js';

const service = inject(TOOLTIP_SERVICE_KEY)!;
const active = service.active;
const descriptionId = 'mar-tooltip-' + useId();
const anchor = computed(() => {
  const target = active.value?.target;
  return target
    ? { contextElement: target, getBoundingClientRect: () => target.getBoundingClientRect() }
    : undefined;
});
const outlet = computed(() => active.value?.target.closest('dialog[open]') ?? 'body');
let disconnect: (() => void) | undefined;
onMounted(() => {
  disconnect = service.connect(descriptionId);
});
onBeforeUnmount(() => disconnect?.());
</script>

<template>
  <Teleport v-if="active" :to="outlet">
    <MarTooltip
      v-if="active"
      :anchor="anchor"
      :placement="active.placement ?? 'bottom'"
      :class="active.popperClass"
    >
      <span :id="descriptionId">{{ active.content }}</span>
    </MarTooltip>
  </Teleport>
</template>
