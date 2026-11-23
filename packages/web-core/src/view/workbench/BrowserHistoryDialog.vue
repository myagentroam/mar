<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarCheckbox } from '@myagentroam/mar-ui/checkbox';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarInput } from '@myagentroam/mar-ui/input';
import type {
  BrowserHistoryItem,
  BrowserHistoryQuery,
  BrowserHistoryResult,
  BrowserProfileTarget
} from '@myagentroam/protocol';
import type { AsideWorkspace } from '../../service/workbench-aside-service.js';
import type { WorkbenchBrowserService } from '../../service/workbench-browser-service.js';
import { browserError, browserProfileLabel } from '../../service/browser-presentation.js';
import { translate as t, i18n } from '../../service/locale-preference-service.js';

/** Owns history search and deletion for one dialog's Workspace and pinned profile. */
const props = defineProps<{
  scope: AsideWorkspace;
  scopeLabel: string;
  expectedLiveId: string;
  browser: WorkbenchBrowserService;
  connected: boolean;
}>();
const emit = defineEmits<{ open: [url: string]; close: [] }>();
const profile = ref<BrowserProfileTarget>();
const loading = ref(false);
const failure = ref<string>();
const search = ref('');
const from = ref('');
const through = ref('');
const query = ref<BrowserHistoryQuery>({ text: '', startTime: 0 });
const queryInvalid = ref(false);
const history = ref<BrowserHistoryResult>();
const index = ref(0);
const checkedUrls = ref<string[]>([]);
const removal = ref<{ scope: AsideWorkspace; target: BrowserProfileTarget; urls: string[] }>();
const removing = ref(false);
const removalFailure = ref<string>();
const PAGE_SIZE = 30;
const pageCount = computed(() =>
  Math.max(1, Math.ceil((history.value?.items.length ?? 0) / PAGE_SIZE))
);
const page = computed(
  () => history.value?.items.slice(index.value * PAGE_SIZE, (index.value + 1) * PAGE_SIZE) ?? []
);
const groups = computed(() => {
  const grouped = new Map<string, BrowserHistoryItem[]>();
  for (const item of page.value) {
    const date = new Intl.DateTimeFormat(i18n.global.locale.value, { dateStyle: 'medium' }).format(
      item.visitedAt
    );
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date)!.push(item);
  }
  return [...grouped];
});

watch(
  () => props.connected,
  (connected, _, onCleanup) => {
    if (!connected || profile.value) return;
    let active = true;
    onCleanup(() => {
      active = false;
      loading.value = false;
    });
    loading.value = true;
    failure.value = undefined;
    void props.browser
      .profile(props.scope, { action: 'describe' })
      .then(
        (result) => {
          if (!active) return;
          const target = (result as { profile?: BrowserProfileTarget }).profile;
          if (target?.kind !== 'live' || target.id !== props.expectedLiveId) {
            failure.value = 'BROWSER_PROFILE_CHANGED';
          } else profile.value = target;
        },
        (error: Error) => {
          if (active) failure.value = error.message;
        }
      )
      .finally(() => {
        if (active && !profile.value) loading.value = false;
      });
  },
  { immediate: true }
);

function refresh(): void {
  query.value = { ...query.value };
}
watch([profile, query, () => props.connected], ([target, input, connected], _, onCleanup) => {
  const selectedScope = props.scope;
  if (!target || !connected) {
    loading.value = false;
    return;
  }
  let active = true;
  onCleanup(() => {
    active = false;
  });
  loading.value = true;
  failure.value = undefined;
  index.value = 0;
  checkedUrls.value = [];
  history.value = undefined;
  void props.browser
    .profile(selectedScope, { action: 'history', target, input })
    .then(
      (result) => {
        if (active) history.value = result as BrowserHistoryResult;
      },
      (error: Error) => {
        if (active) failure.value = error.message;
      }
    )
    .finally(() => {
      if (active) loading.value = false;
    });
});
function searchHistory(): void {
  const startTime = from.value ? new Date(`${from.value}T00:00:00`).getTime() : 0;
  const nextDay = through.value ? new Date(`${through.value}T00:00:00`) : undefined;
  nextDay?.setDate(nextDay.getDate() + 1);
  const endTime = nextDay?.getTime();
  queryInvalid.value =
    !Number.isFinite(startTime) ||
    startTime < 0 ||
    (endTime !== undefined && (!Number.isFinite(endTime) || endTime <= startTime));
  if (!queryInvalid.value)
    query.value = { text: search.value, startTime, ...(endTime !== undefined ? { endTime } : {}) };
}
function paginate(offset: number): void {
  index.value += offset;
  checkedUrls.value = [];
}
function toggle(url: string, value: boolean): void {
  checkedUrls.value = value
    ? [...checkedUrls.value, url]
    : checkedUrls.value.filter((item) => item !== url);
}
function confirmRemoval(urls: string[]): void {
  if (!profile.value || !urls.length) return;
  removalFailure.value = undefined;
  removal.value = { scope: props.scope, target: profile.value, urls: [...urls] };
}
async function remove(): Promise<void> {
  const operation = removal.value;
  if (!operation || removing.value || removalFailure.value || !props.connected) return;
  removing.value = true;
  try {
    await props.browser.profile(operation.scope, {
      action: 'delete',
      target: operation.target,
      input: operation.urls
    });
    if (removal.value !== operation) return;
    removal.value = undefined;
    refresh();
  } catch (error) {
    if (removal.value === operation)
      removalFailure.value = error instanceof Error ? error.message : 'BROWSER_FAILED';
  } finally {
    removing.value = false;
  }
}
</script>

<template>
  <MarDialog
    :model-value="true"
    :title="t('browser.history')"
    width="min(720px, calc(100vw - 32px))"
    append-to-body
    :show-close="!removal"
    :close-on-press-escape="!removal"
    :close-on-click-modal="false"
    @update:model-value="(open) => !open && emit('close')"
  >
    <div class="browser-history-content">
      <p class="browser-history-scope">
        {{ scopeLabel }}<template v-if="profile"> · {{ browserProfileLabel(profile) }}</template>
      </p>
      <form class="browser-search" @submit.prevent="searchHistory">
        <MarInput
          v-model="search"
          maxlength="512"
          :aria-label="t('browser.search')"
          :placeholder="t('browser.search')"
          :disabled="!profile"
        />
        <label
          >{{ t('browser.from') }} <input v-model="from" type="date" :disabled="!profile"
        /></label>
        <label
          >{{ t('browser.to') }} <input v-model="through" type="date" :disabled="!profile"
        /></label>
        <MarButton native-type="submit" icon="search" :disabled="!profile">{{
          t('browser.search')
        }}</MarButton>
      </form>
      <p v-if="queryInvalid" role="alert">{{ t('browser.invalidDates') }}</p>
      <div
        v-if="loading"
        class="browser-history-loading"
        role="status"
        :aria-label="t('common.loading')"
      >
        <MarBusyIndicator class="mar-read-loading-indicator" />
      </div>
      <p v-else-if="!connected" role="status">{{ t('browser.disconnected') }}</p>
      <p v-else-if="failure" role="alert">{{ browserError(failure) }}</p>
      <p v-else-if="!profile">{{ t('browser.noProfile') }}</p>
      <p v-else-if="history && !page.length">{{ t('browser.noHistory') }}</p>
      <p v-if="history?.capped">{{ t('browser.capped') }}</p>
      <MarButton
        v-if="page.length"
        text
        icon="delete"
        :disabled="!checkedUrls.length || !connected"
        @click="confirmRemoval(checkedUrls)"
        >{{ t('browser.deleteSelected') }}</MarButton
      >
      <div v-for="[date, items] in groups" :key="date">
        <h3>{{ date }}</h3>
        <ul class="browser-history-list">
          <li v-for="item in items" :key="item.url">
            <MarCheckbox
              :model-value="checkedUrls.includes(item.url)"
              :aria-label="t('browser.selectHistory', { title: item.title || item.url })"
              @update:model-value="(value) => toggle(item.url, value === true)"
            />
            <MarButton
              text
              class="browser-history-entry"
              :disabled="!connected"
              @click="emit('open', item.url)"
            >
              <span>{{ item.title || item.url }}</span
              ><small v-if="item.title">{{ item.url }}</small>
            </MarButton>
            <MarButton
              text
              icon="delete"
              :aria-label="t('browser.delete')"
              v-tooltip="t('browser.delete')"
              :disabled="!connected"
              @click="confirmRemoval([item.url])"
            />
          </li>
        </ul>
      </div>
      <div class="browser-inline-actions" v-if="pageCount > 1">
        <MarButton :disabled="index === 0" @click="paginate(-1)">{{
          t('browser.previous')
        }}</MarButton>
        <span>{{ index + 1 }} / {{ pageCount }}</span>
        <MarButton :disabled="index + 1 >= pageCount" @click="paginate(1)">{{
          t('browser.next')
        }}</MarButton>
      </div>
    </div>
  </MarDialog>
  <MarDialog
    v-if="removal"
    :model-value="true"
    :title="t('browser.deleteHistory')"
    append-to-body
    :show-close="!removing"
    :close-on-press-escape="!removing"
    :close-on-click-modal="false"
    @update:model-value="(open) => !open && !removing && (removal = undefined)"
  >
    <p>{{ t('browser.deleteConfirm') }}</p>
    <p v-if="removalFailure" role="alert">{{ browserError(removalFailure) }}</p>
    <template #footer>
      <MarButton
        :disabled="removing"
        @click="
          removal = undefined;
          refresh();
        "
        >{{ t('browser.cancel') }}</MarButton
      >
      <MarButton
        type="danger"
        :loading="removing"
        :disabled="!!removalFailure || !connected"
        @click="remove"
        >{{ t('browser.delete') }}</MarButton
      >
    </template>
  </MarDialog>
</template>

<style scoped>
.browser-history-content {
  display: grid;
  gap: 0.75rem;
}
.browser-history-content :is(p, h3) {
  margin-block: 0;
}
.browser-history-scope {
  color: var(--mar-ui-text-secondary);
}
.browser-history-loading {
  display: flex;
  justify-content: center;
  padding-block: 0.75rem;
}
.browser-inline-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.browser-search {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: end;
}
.browser-search label {
  display: grid;
  gap: 0.25rem;
}
.browser-history-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.browser-history-list li {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-inline-size: 0;
}
.browser-history-entry {
  min-inline-size: 0;
  flex: 1;
  justify-content: start;
  text-align: start;
}
.browser-history-entry span,
.browser-history-entry small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.browser-history-entry small {
  color: var(--mar-ui-text-secondary);
}
</style>
