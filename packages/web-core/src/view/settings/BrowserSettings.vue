<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { MarOption, MarSelect } from '@myagentroam/mar-ui/select';
import {
  browserLinkStorageKey,
  readBrowserLinkPreferences
} from '../../service/browser-link-routing.js';
import { translate as t } from '../../service/locale-preference-service.js';

/** Personal link preferences are stored per account on this device, without a Workspace attachment. */
const props = defineProps<{ userId?: number | undefined }>();
const preferences = ref(readBrowserLinkPreferences(props.userId));
const saveFailed = ref(false);

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
  () => syncPreference()
);
onMounted(() => window.addEventListener('storage', syncPreference));
onBeforeUnmount(() => window.removeEventListener('storage', syncPreference));
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
