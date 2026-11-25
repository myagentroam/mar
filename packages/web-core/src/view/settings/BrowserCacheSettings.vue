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
import { showMessage } from '../../service/message-feedback-service.js';
import type { WorkbenchHttpService } from '../../service/workbench-http-service.js';
import { errorMessage } from '../../util/error-presentation.js';

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
const loadFailed = ref(false);
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
  try {
    const value = browserSettingsSnapshotSchema.parse(await props.request(endpoint, { signal }));
    if (!signal.aborted) {
      draft.cacheCleanupDays = saved.value = value.cacheCleanupDays;
      loadFailed.value = false;
    }
  } catch (error) {
    if (!signal.aborted) {
      loadFailed.value = true;
      showMessage(errorMessage(error, t('browser.cacheCycleLoadFailed')), 'error', error);
    }
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
  try {
    await props.request(endpoint, { method: 'PUT', body: JSON.stringify(input.data), signal });
    if (!signal.aborted) {
      saved.value = input.data.cacheCleanupDays;
      showMessage(t('browser.cacheCycleSaved'), 'success');
    }
  } catch (error) {
    if (!signal.aborted)
      showMessage(errorMessage(error, t('browser.cacheCycleSaveFailed')), 'error', error);
  } finally {
    if (!signal.aborted) pending.value = undefined;
  }
}

watch(
  () => props.userId,
  () => {
    lifetime.abort();
    lifetime = new AbortController();
    pending.value = undefined;
    loadFailed.value = false;
    draft.cacheCleanupDays = saved.value = undefined;
    void load();
  },
  { immediate: true }
);
onBeforeUnmount(() => lifetime.abort());
</script>

<template>
  <h2 class="browser-setting-heading">{{ t('browser.cacheCycleSection') }}</h2>
  <p class="browser-setting-help">{{ t('browser.cacheCycleHelp', { min, max }) }}</p>
  <MarForm
    v-if="saved !== undefined"
    ref="form"
    class="browser-cache-form"
    :model="draft"
    :rules="rules"
    label-position="top"
    @submit.prevent="save"
  >
    <MarFormItem
      class="browser-cache-field"
      :label="t('browser.cacheCycleDays')"
      prop="cacheCleanupDays"
    >
      <div class="browser-cache-controls">
        <MarInputNumber
          v-model="draft.cacheCleanupDays"
          :min="min"
          :max="max"
          :step="1"
          step-strictly
          :disabled="pending !== undefined"
        />
        <MarButton
          icon="check"
          type="primary"
          native-type="submit"
          :disabled="!dirty"
          :loading="pending === 'save'"
        >
          {{ t('common.save') }}
        </MarButton>
      </div>
    </MarFormItem>
  </MarForm>
  <MarButton v-else-if="loadFailed" link :loading="pending === 'load'" @click="load">
    {{ t('browser.useRetry') }}
  </MarButton>
</template>

<style scoped>
.browser-cache-form {
  margin-block-start: 0.65rem;
}
.browser-cache-field {
  margin-block-end: 0;
}
.browser-cache-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  min-inline-size: 0;
}
</style>
