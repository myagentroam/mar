<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarCheckbox } from '@myagentroam/mar-ui/checkbox';
import { MarOption, MarSelect } from '@myagentroam/mar-ui/select';
import {
  browserLinkStorageKey,
  readBrowserLinkPreferences
} from '../../service/browser-link-routing.js';
import { translate as t } from '../../service/locale-preference-service.js';
import {
  readBrowserUsePreference,
  writeBrowserUsePreference
} from '../../service/browser-use-preference.js';
import type { WorkbenchHttpService } from '../../service/workbench-http-service.js';

/** Browser Use is an account preference; link destinations are local to this device. */
const props = defineProps<{
  userId?: number | undefined;
  request: WorkbenchHttpService['request'];
}>();
const preferences = ref(readBrowserLinkPreferences(props.userId));
const saveFailed = ref(false);
const enabled = ref(true);
const useLoaded = ref(false);
const useBusy = ref(false);
const useError = ref<'load' | 'save'>();
const helpId = useId();
let requestLifetime = new AbortController();

async function loadBrowserUse(): Promise<void> {
  if (props.userId === undefined || useBusy.value) return;
  const { signal } = requestLifetime;
  useBusy.value = true;
  useError.value = undefined;
  try {
    const value = await readBrowserUsePreference(props.request, signal);
    if (!signal.aborted) {
      enabled.value = value;
      useLoaded.value = true;
    }
  } catch {
    if (!signal.aborted) useError.value = 'load';
  } finally {
    if (!signal.aborted) useBusy.value = false;
  }
}

async function saveBrowserUse(value: unknown): Promise<void> {
  if (!useLoaded.value || useBusy.value || typeof value !== 'boolean') return;
  const { signal } = requestLifetime;
  const previous = enabled.value;
  enabled.value = value;
  useBusy.value = true;
  useError.value = undefined;
  try {
    await writeBrowserUsePreference(props.request, value, signal);
  } catch {
    if (!signal.aborted) {
      enabled.value = previous;
      useError.value = 'save';
    }
  } finally {
    if (!signal.aborted) useBusy.value = false;
  }
}

function syncPreference(event?: StorageEvent): void {
  if (
    event &&
    event.key !== null &&
    (props.userId === undefined || event.key !== browserLinkStorageKey(props.userId))
  )
    return;
  preferences.value = readBrowserLinkPreferences(props.userId);
  saveFailed.value = false;
}
watch(
  () => props.userId,
  () => {
    syncPreference();
    requestLifetime.abort();
    requestLifetime = new AbortController();
    useLoaded.value = false;
    useBusy.value = false;
    useError.value = undefined;
    void loadBrowserUse();
  },
  { immediate: true }
);
onMounted(() => window.addEventListener('storage', syncPreference));
onBeforeUnmount(() => {
  requestLifetime.abort();
  window.removeEventListener('storage', syncPreference);
});
function save(kind: 'local' | 'web', value: unknown): void {
  if (props.userId === undefined || (value !== 'mar' && value !== 'external')) return;
  const next = { ...readBrowserLinkPreferences(props.userId), [kind]: value };
  try {
    localStorage.setItem(browserLinkStorageKey(props.userId), JSON.stringify(next));
    preferences.value = next;
    saveFailed.value = false;
  } catch {
    saveFailed.value = true;
  }
}
</script>

<template>
  <section class="browser-settings" :aria-label="t('browser.settings')">
    <header>
      <h1>{{ t('browser.settings') }}</h1>
      <p class="browser-settings-summary">{{ t('browser.settingsSummary') }}</p>
    </header>
    <section>
      <MarCheckbox
        :model-value="useLoaded ? enabled : false"
        :disabled="!useLoaded || useBusy"
        :aria-describedby="helpId"
        @update:model-value="saveBrowserUse"
        >{{ t('browser.use') }}</MarCheckbox
      >
      <p :id="helpId" class="browser-link-help">{{ t('browser.useHelp') }}</p>
      <p v-if="useError" role="alert">
        {{ t(useError === 'load' ? 'browser.useLoadFailed' : 'browser.useSaveFailed') }}
        <MarButton v-if="useError === 'load'" link @click="loadBrowserUse">{{
          t('browser.useRetry')
        }}</MarButton>
      </p>
    </section>
    <section>
      <h2>{{ t('browser.preferences') }}</h2>
      <div
        class="browser-form-row"
        v-for="(label, kind) in { web: 'browser.webLinks', local: 'browser.localLinks' } as const"
        :key="kind"
      >
        <span>{{ t(label) }}</span>
        <MarSelect
          :model-value="preferences[kind]"
          :aria-label="t(label)"
          @update:model-value="(value) => save(kind, value)"
        >
          <MarOption value="mar" :label="t('browser.mar')" /><MarOption
            value="external"
            :label="t('browser.device')"
          />
        </MarSelect>
      </div>
      <p class="browser-link-help">{{ t('browser.linkHelp') }}</p>
      <p v-if="saveFailed" role="alert">{{ t('browser.saveFailed') }}</p>
    </section>
  </section>
</template>

<style scoped>
.browser-settings {
  flex: 1;
  min-inline-size: 0;
  overflow: auto;
  padding: clamp(0.75rem, 3vw, 1.5rem);
}
.browser-settings > header {
  margin-block-end: 1rem;
}
.browser-settings h1 {
  margin: 0;
}
.browser-settings-summary,
.browser-link-help {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
}
.browser-settings-summary {
  margin: 0.35rem 0 0;
}
.browser-link-help {
  margin-block-start: 0.75rem;
}
.browser-settings > section {
  max-inline-size: 50rem;
  padding-block: 1rem;
  border-block-start: 1px solid var(--mar-ui-border);
}
.browser-form-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.browser-form-row {
  justify-content: space-between;
  margin-block: 0.5rem;
}
.browser-form-row > :last-child {
  inline-size: min(15rem, 100%);
}
</style>
