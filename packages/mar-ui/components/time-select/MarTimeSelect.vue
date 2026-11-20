<script setup lang="ts">
import { computed } from 'vue';
import MarSelect from '../select/MarSelect.vue';

const props = withDefaults(
  defineProps<{
    modelValue?: string | undefined;
    start?: string;
    end?: string;
    step?: string;
    clearable?: boolean;
  }>(),
  { start: '09:00', end: '18:00', step: '00:30', clearable: true }
);
const emit = defineEmits<{
  'update:modelValue': [value: string | undefined];
  change: [value: string | undefined];
}>();
function minutes(value: string) {
  const parts = /^(\d{2}):([0-5]\d)$/.exec(value);
  return parts ? Number(parts[1]) * 60 + Number(parts[2]) : NaN;
}
const options = computed(() => {
  const first = minutes(props.start);
  const last = minutes(props.end);
  const interval = minutes(props.step);
  if (!(interval > 0) || !(last < 1440)) return [];
  const entries = [];
  for (let time = first; time <= last; time += interval) {
    const value = `${String(Math.floor(time / 60)).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}`;
    entries.push({ value, label: value });
  }
  return entries;
});
</script>

<template>
  <MarSelect
    class="mar-ui-time-select"
    :model-value="modelValue || undefined"
    :options="options"
    :clearable="clearable"
    @update:model-value="(value) => emit('update:modelValue', value)"
    @change="(value) => emit('change', value)"
  />
</template>
