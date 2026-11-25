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
import BrowserCacheSettings from './BrowserCacheSettings.vue';
import './settings-layout.css';

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
const id = useId();
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
  <div class="settings-content">
    <section class="browser-settings" :aria-labelledby="`${id}-title`">
      <header>
        <h1 :id="`${id}-title`" class="mar-settings-page-title">{{ t('browser.settings') }}</h1>
        <p class="mar-settings-page-summary">{{ t('browser.settingsSummary') }}</p>
      </header>
      <section>
        <MarCheckbox
          :model-value="useLoaded ? enabled : false"
          :disabled="!useLoaded || useBusy"
          :aria-describedby="`${id}-use-help`"
          @update:model-value="saveBrowserUse"
          >{{ t('browser.use') }}</MarCheckbox
        >
        <p :id="`${id}-use-help`" class="browser-setting-help">{{ t('browser.useHelp') }}</p>
        <p v-if="useError" role="alert">
          {{ t(useError === 'load' ? 'browser.useLoadFailed' : 'browser.useSaveFailed') }}
          <MarButton v-if="useError === 'load'" link @click="loadBrowserUse">{{
            t('browser.useRetry')
          }}</MarButton>
        </p>
      </section>
      <section>
        <BrowserCacheSettings :user-id="userId" :request="request" />
      </section>
      <section>
        <h2 class="browser-setting-heading">{{ t('browser.preferences') }}</h2>
        <div
          v-for="(label, kind) in { web: 'browser.webLinks', local: 'browser.localLinks' } as const"
          :key="kind"
          class="mar-settings-option-row"
        >
          <label :id="`${id}-${kind}-label`" :for="`${id}-${kind}`">{{ t(label) }}</label>
          <MarSelect
            :id="`${id}-${kind}`"
            :model-value="preferences[kind]"
            :aria-labelledby="`${id}-${kind}-label`"
            @update:model-value="(value) => save(kind, value)"
          >
            <MarOption value="mar" :label="t('browser.mar')" />
            <MarOption value="external" :label="t('browser.device')" />
          </MarSelect>
        </div>
        <p class="browser-setting-help">{{ t('browser.linkHelp') }}</p>
        <p v-if="saveFailed" role="alert">{{ t('browser.saveFailed') }}</p>
      </section>
    </section>
  </div>
</template>

<style scoped>
.browser-settings {
  display: grid;
  gap: 0.65rem;
  padding: var(--mar-settings-page-padding);
}
.browser-settings > section {
  max-inline-size: 34rem;
  min-inline-size: 0;
}
.browser-settings > section + section {
  padding-block-start: 0.65rem;
  border-block-start: 1px solid var(--mar-border-subtle);
}
.browser-settings :deep(.browser-setting-heading) {
  margin: 0;
  font-size: var(--mar-font-size-body);
  font-weight: 600;
  line-height: 1.4;
}
.browser-settings :deep(.browser-setting-help) {
  margin: 0.35rem 0 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}
</style>
