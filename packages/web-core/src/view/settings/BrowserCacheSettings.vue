<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarForm, MarFormItem } from '@myagentroam/mar-ui/form';
import { MarInputNumber } from '@myagentroam/mar-ui/input-number';
import {
  BROWSER_CACHE_CLEANUP_MIN_DAYS as min,
  BROWSER_CACHE_CLEANUP_MAX_DAYS as max,
  browserSettingsInputSchema,
  browserSettingsSnapshotSchema
} from '@myagentroam/protocol';
import { translate as t } from '../../service/locale-preference-service.js';
import type { WorkbenchHttpService } from '../../service/workbench-http-service.js';

const props = defineProps<{
  userId?: number | undefined;
  request: WorkbenchHttpService['request'];
}>();
const endpoint = '/api/auth/preferences/browser-settings';
const form = ref<InstanceType<typeof MarForm>>();
const draft = reactive<{ cacheCleanupDays: number | null | undefined }>({
  cacheCleanupDays: undefined
});
const saved = ref<number>();
const pending = ref<'load' | 'save'>();
const status = ref<'saved' | 'loadFailed' | 'saveFailed'>();
const dirty = computed(() => draft.cacheCleanupDays !== saved.value);
const rules = computed(() => ({
  cacheCleanupDays: [
    {
      validator: (_rule: unknown, value: unknown, done: (error?: Error) => void) => {
        if (browserSettingsInputSchema.safeParse({ cacheCleanupDays: value }).success) done();
        else done(new Error(t('browser.cacheCycleInvalid', { min, max })));
      }
    }
  ]
}));
let lifetime = new AbortController();

async function load(): Promise<void> {
  if (props.userId === undefined || pending.value) return;
  const { signal } = lifetime;
  pending.value = 'load';
  status.value = undefined;
  try {
    const value = browserSettingsSnapshotSchema.parse(await props.request(endpoint, { signal }));
    if (!signal.aborted) draft.cacheCleanupDays = saved.value = value.cacheCleanupDays;
  } catch {
    if (!signal.aborted) status.value = 'loadFailed';
  } finally {
    if (!signal.aborted) pending.value = undefined;
  }
}

async function save(): Promise<void> {
  if (!form.value || !dirty.value || pending.value) return;
  const { signal } = lifetime;
  const valid = await form.value.validate().catch(() => false);
  if (!valid || signal.aborted || pending.value) return;
  const input = browserSettingsInputSchema.safeParse(draft);
  if (!input.success) return;
  pending.value = 'save';
  status.value = undefined;
  try {
    await props.request(endpoint, { method: 'PUT', body: JSON.stringify(input.data), signal });
    if (!signal.aborted) {
      saved.value = input.data.cacheCleanupDays;
      status.value = 'saved';
    }
  } catch {
    if (!signal.aborted) status.value = 'saveFailed';
  } finally {
    if (!signal.aborted) pending.value = undefined;
  }
}

watch(
  () => props.userId,
  () => {
    lifetime.abort();
    lifetime = new AbortController();
    pending.value = status.value = undefined;
    draft.cacheCleanupDays = saved.value = undefined;
    void load();
  },
  { immediate: true }
);
onBeforeUnmount(() => lifetime.abort());
</script>

<template>
  <h2>{{ t('browser.cacheCycleSection') }}</h2>
  <p class="browser-cache-help">{{ t('browser.cacheCycleHelp', { min, max }) }}</p>
  <MarForm
    v-if="saved !== undefined"
    ref="form"
    :model="draft"
    :rules="rules"
    label-position="top"
    @submit.prevent="save"
  >
    <MarFormItem :label="t('browser.cacheCycleDays')" prop="cacheCleanupDays">
      <MarInputNumber
        v-model="draft.cacheCleanupDays"
        :min="min"
        :max="max"
        :step="1"
        step-strictly
        :disabled="pending !== undefined"
      />
    </MarFormItem>
    <MarButton native-type="submit" :disabled="!dirty" :loading="pending === 'save'">
      {{ t('browser.cacheCycleSave') }}
    </MarButton>
  </MarForm>
  <p v-if="status === 'loadFailed' || status === 'saveFailed'" role="alert">
    {{
      t(status === 'loadFailed' ? 'browser.cacheCycleLoadFailed' : 'browser.cacheCycleSaveFailed')
    }}
    <MarButton v-if="status === 'loadFailed'" link @click="load">{{
      t('browser.useRetry')
    }}</MarButton>
  </p>
  <p v-else-if="status === 'saved'" role="status">
    {{ t('browser.cacheCycleSaved') }}
  </p>
</template>

<style scoped>
.browser-cache-help {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}
</style>
