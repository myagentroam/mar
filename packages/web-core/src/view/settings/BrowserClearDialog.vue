<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarCheckbox } from '@myagentroam/mar-ui/checkbox';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarOption, MarSelect } from '@myagentroam/mar-ui/select';
import type { BrowserDataClear, BrowserProfileTarget } from '@myagentroam/protocol';
import type { AsideWorkspace } from '../../service/workbench-aside-service.js';
import type { WorkbenchBrowserService } from '../../service/workbench-browser-service.js';
import { browserError, browserProfileLabel } from '../../service/browser-presentation.js';
import { translate as t } from '../../service/locale-preference-service.js';

/** Owns a single confirmation bound to the scope and Profile opened by the caller. */
const props = defineProps<{
  browser: WorkbenchBrowserService;
  scope: AsideWorkspace;
  connected: boolean;
  scopeLabel: string;
  expectedLiveId: string;
}>();
const emit = defineEmits<{ close: []; cleared: [] }>();
const range = ref<BrowserDataClear['range']>('hour');
const categories = {
  history: ['browser.history', 'browser.historyDetail'],
  'site-data': ['browser.siteData', 'browser.signout'],
  cache: ['browser.cachedFiles', 'browser.cacheDetail']
} as const;
const ranges = {
  hour: 'browser.hour',
  day: 'browser.day',
  week: 'browser.week',
  'four-weeks': 'browser.fourWeeks',
  all: 'browser.all'
} as const;
type Category = BrowserDataClear['categories'][number];
const selected = ref<Category[]>(['cache']);
const target = ref<BrowserProfileTarget>();
const busy = ref(false);
const loading = ref(false);
const failure = ref<string>();
const unknown = ref(false);
const scope = { nodeId: props.scope.nodeId, workspaceId: props.scope.workspaceId };
const targetLabel = computed(() => (target.value ? browserProfileLabel(target.value) : undefined));
const detailId = useId();
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});

watch(
  () => props.connected,
  (connected, _, onCleanup) => {
    if (!connected || target.value) return;
    let active = true;
    onCleanup(() => {
      active = false;
      loading.value = false;
    });
    loading.value = true;
    failure.value = undefined;
    void props.browser
      .profile(scope, { action: 'describe' })
      .then(
        (result) => {
          if (!active) return;
          const profile = (result as { profile?: BrowserProfileTarget }).profile;
          if (profile?.kind === 'live' && profile.id === props.expectedLiveId)
            target.value = profile;
          else failure.value = 'BROWSER_PROFILE_CHANGED';
        },
        (error: Error) => {
          if (active) failure.value = error.message;
        }
      )
      .finally(() => {
        if (active) loading.value = false;
      });
  },
  { immediate: true }
);

function toggle(category: Category, checked: boolean): void {
  selected.value = checked
    ? [...selected.value, category]
    : selected.value.filter((item) => item !== category);
}
async function clear(): Promise<void> {
  if (busy.value || unknown.value || !target.value || !selected.value.length || !props.connected)
    return;
  busy.value = true;
  failure.value = undefined;
  try {
    await props.browser.profile(scope, {
      action: 'clear',
      target: target.value,
      input: { range: range.value, categories: selected.value }
    });
    if (!disposed) {
      emit('cleared');
      emit('close');
    }
  } catch (error) {
    if (disposed) return;
    failure.value = error instanceof Error ? error.message : 'BROWSER_FAILED';
    unknown.value =
      failure.value === 'BROWSER_OUTCOME_UNKNOWN' || failure.value === 'BROWSER_PROFILE_CHANGED';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <MarDialog
    :model-value="true"
    :title="t('browser.clear')"
    width="min(480px, calc(100vw - 32px))"
    append-to-body
    :show-close="!busy"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    @update:model-value="(open) => !open && !busy && emit('close')"
  >
    <div class="browser-clear-fields">
      <p class="browser-clear-scope">
        {{ scopeLabel }}<template v-if="targetLabel"> · {{ targetLabel }}</template>
      </p>
      <div v-if="loading" role="status" :aria-label="t('common.loading')">
        <MarBusyIndicator class="mar-read-loading-indicator" />
      </div>
      <p v-else-if="!connected" role="status">{{ t('browser.disconnected') }}</p>
      <p v-if="failure" role="alert">{{ browserError(failure) }}</p>
      <div class="browser-clear-range">
        <span>{{ t('browser.timeRange') }}</span>
        <MarSelect
          v-model="range"
          :aria-label="t('browser.timeRange')"
          :disabled="busy || !target || !connected || unknown"
        >
          <MarOption
            v-for="(label, value) in ranges"
            :key="value"
            :value="value"
            :label="t(label)"
          />
        </MarSelect>
      </div>
      <div role="group" :aria-label="t('browser.clearCategories')" class="browser-clear-categories">
        <div
          v-for="([label, detail], category) in categories"
          :key="category"
          class="browser-clear-category"
        >
          <MarCheckbox
            :model-value="selected.includes(category)"
            :disabled="busy || !target || !connected || unknown"
            :aria-describedby="`${detailId}-${category}`"
            @update:model-value="(checked) => toggle(category, checked === true)"
            >{{ t(label) }}</MarCheckbox
          >
          <p :id="`${detailId}-${category}`">{{ t(detail) }}</p>
        </div>
      </div>
    </div>
    <template #footer>
      <MarButton :disabled="busy" @click="emit('close')">{{ t('browser.cancel') }}</MarButton>
      <MarButton
        type="danger"
        :loading="busy"
        :disabled="!target || !selected.length || !connected || unknown"
        @click="clear"
        >{{ t('browser.clear') }}</MarButton
      >
    </template>
  </MarDialog>
</template>

<style scoped>
.browser-clear-fields {
  display: grid;
  gap: 0.875rem;
}
.browser-clear-range {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
  align-items: center;
  gap: 0.75rem;
}
.browser-clear-categories {
  border-block: 1px solid var(--mar-ui-border-subtle);
  padding-block: 0.25rem;
}
.browser-clear-category {
  padding-block: 0.375rem;
}
.browser-clear-category p {
  padding-inline-start: 1.375rem;
}
.browser-clear-scope,
.browser-clear-category p {
  color: var(--mar-ui-text-secondary);
}
.browser-clear-fields p {
  margin: 0;
}
</style>
