<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarCheckbox } from '@myagentroam/mar-ui/checkbox';
import { MarDatePicker } from '@myagentroam/mar-ui/date-picker';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { MarMessageBox } from '../../service/message-box-service.js';
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
const from = ref<Date | null>(null);
const through = ref<Date | null>(null);
const dateFields = useId();
const query = ref<BrowserHistoryQuery>({ text: '', startTime: 0 });
const queryInvalid = ref(false);
const history = ref<BrowserHistoryResult>();
const index = ref(0);
const checkedUrls = ref<string[]>([]);
const removing = ref(false);
const removalFailure = ref<string>();
const lifetime = new AbortController();
onBeforeUnmount(() => lifetime.abort());
const showDates = ref(false);
const PAGE_SIZE = 30;
const pageCount = computed(() =>
  Math.max(1, Math.ceil((history.value?.items.length ?? 0) / PAGE_SIZE))
);
const page = computed(
  () => history.value?.items.slice(index.value * PAGE_SIZE, (index.value + 1) * PAGE_SIZE) ?? []
);
const dateFormat = computed(
  () => new Intl.DateTimeFormat(i18n.global.locale.value, { dateStyle: 'full' })
);
const timeFormat = computed(
  () => new Intl.DateTimeFormat(i18n.global.locale.value, { timeStyle: 'short' })
);
const groups = computed(() => {
  const grouped = new Map<string, BrowserHistoryItem[]>();
  for (const item of page.value) {
    const date = dateFormat.value.format(item.visitedAt);
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
  const startTime = from.value?.getTime() ?? 0;
  const nextDay = through.value ? new Date(through.value) : undefined;
  nextDay?.setDate(nextDay.getDate() + 1);
  const endTime = nextDay?.setHours(0, 0, 0, 0);
  queryInvalid.value =
    !Number.isFinite(startTime) ||
    startTime < 0 ||
    (endTime !== undefined && (!Number.isFinite(endTime) || endTime <= startTime));
  if (queryInvalid.value) return;
  const text = search.value.trim();
  const previous = query.value;
  if (previous.text === text && previous.startTime === startTime && previous.endTime === endTime)
    return;
  removalFailure.value = undefined;
  query.value = { text, startTime, ...(endTime !== undefined ? { endTime } : {}) };
}
watch(search, (_, __, onCleanup) => {
  const timer = setTimeout(searchHistory, 250);
  onCleanup(() => clearTimeout(timer));
});
function paginate(offset: number): void {
  index.value += offset;
  checkedUrls.value = [];
}
function toggle(url: string, value: boolean): void {
  checkedUrls.value = value
    ? [...checkedUrls.value, url]
    : checkedUrls.value.filter((item) => item !== url);
}
async function confirmRemoval(urls: string[]): Promise<void> {
  const target = profile.value;
  if (!target || !urls.length || removing.value || !props.connected || loading.value) return;
  const selected = [...urls];
  try {
    await MarMessageBox.confirm(t('browser.deleteConfirm'), t('browser.deleteHistory'), {
      confirmButtonType: 'danger',
      confirmButtonText: t('browser.delete'),
      cancelButtonText: t('browser.cancel'),
      signal: lifetime.signal
    });
  } catch {
    return;
  }
  if (lifetime.signal.aborted || !props.connected) return;
  removing.value = true;
  removalFailure.value = undefined;
  try {
    await props.browser.profile(props.scope, {
      action: 'delete',
      target,
      input: selected
    });
    if (!lifetime.signal.aborted) refresh();
  } catch (error) {
    if (!lifetime.signal.aborted) {
      if (error instanceof Error && error.message === 'BROWSER_OUTCOME_UNKNOWN') refresh();
      removalFailure.value = error instanceof Error ? error.message : 'BROWSER_FAILED';
    }
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
    :show-close="!removing"
    :close-on-press-escape="!removing"
    :close-on-click-modal="false"
    @update:model-value="(open) => !open && !removing && emit('close')"
  >
    <div class="browser-history-content">
      <p class="browser-history-scope">
        {{ scopeLabel }}<template v-if="profile"> · {{ browserProfileLabel(profile) }}</template>
      </p>
      <form class="browser-search" @submit.prevent="searchHistory">
        <MarInput
          v-model="search"
          maxlength="512"
          autofocus
          prefix-icon="search"
          clearable
          :aria-label="t('browser.search')"
          :placeholder="t('browser.search')"
          :disabled="removing"
        />
        <MarButton
          icon="calendar"
          :aria-expanded="showDates"
          :disabled="removing"
          @click="showDates = !showDates"
        >
          {{ t('browser.dateFilter') }}
        </MarButton>
        <div v-if="showDates" class="browser-history-dates">
          <div class="browser-history-date">
            <label :for="`${dateFields}-from`">{{ t('browser.from') }}</label>
            <MarDatePicker
              :id="`${dateFields}-from`"
              v-model="from"
              type="date"
              placeholder="YYYY-MM-DD"
              :disabled="removing"
              @change="searchHistory"
            />
          </div>
          <div class="browser-history-date">
            <label :for="`${dateFields}-through`">{{ t('browser.to') }}</label>
            <MarDatePicker
              :id="`${dateFields}-through`"
              v-model="through"
              type="date"
              placeholder="YYYY-MM-DD"
              :disabled="removing"
              @change="searchHistory"
            />
          </div>
        </div>
      </form>
      <p v-if="queryInvalid" role="alert">{{ t('browser.invalidDates') }}</p>
      <p v-if="removalFailure" role="alert">{{ browserError(removalFailure) }}</p>
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
      <div v-if="checkedUrls.length" class="browser-history-selection">
        <span role="status">{{ t('browser.selectedHistory', { count: checkedUrls.length }) }}</span>
        <MarButton text :disabled="removing" @click="checkedUrls = []">{{
          t('browser.cancel')
        }}</MarButton>
        <MarButton
          type="danger"
          :loading="removing"
          :disabled="!connected"
          @click="confirmRemoval(checkedUrls)"
        >
          {{ t('browser.deleteSelected') }}
        </MarButton>
      </div>
      <section v-for="[date, items] in groups" :key="date" class="browser-history-day">
        <h3>{{ date }}</h3>
        <ul class="browser-history-list">
          <li v-for="item in items" :key="item.url">
            <MarCheckbox
              :model-value="checkedUrls.includes(item.url)"
              :aria-label="t('browser.selectHistory', { title: item.title || item.url })"
              :disabled="!connected || removing"
              @update:model-value="(value) => toggle(item.url, value === true)"
            />
            <time :datetime="new Date(item.visitedAt).toISOString()">{{
              timeFormat.format(item.visitedAt)
            }}</time>
            <MarButton
              text
              class="browser-history-entry"
              :disabled="!connected || removing"
              @click="emit('open', item.url)"
            >
              <span>{{ item.title || item.url }}</span
              ><small v-if="item.title">{{ item.url }}</small>
            </MarButton>
            <MarDropdown :disabled="!connected || removing" @command="confirmRemoval([item.url])">
              <MarButton
                text
                icon="more"
                :disabled="!connected || removing"
                :aria-label="t('browser.historyActions', { title: item.title || item.url })"
                v-tooltip="t('browser.historyActions', { title: item.title || item.url })"
              />
              <template #dropdown>
                <MarDropdownMenu
                  :aria-label="t('browser.historyActions', { title: item.title || item.url })"
                >
                  <MarDropdownItem command="remove" icon="delete">{{
                    t('browser.removeHistoryEntry')
                  }}</MarDropdownItem>
                </MarDropdownMenu>
              </template>
            </MarDropdown>
          </li>
        </ul>
      </section>
      <div class="browser-inline-actions" v-if="pageCount > 1">
        <MarButton :disabled="index === 0 || removing" @click="paginate(-1)">{{
          t('browser.previous')
        }}</MarButton>
        <span>{{ index + 1 }} / {{ pageCount }}</span>
        <MarButton :disabled="index + 1 >= pageCount || removing" @click="paginate(1)">{{
          t('browser.next')
        }}</MarButton>
      </div>
    </div>
  </MarDialog>
</template>

<style scoped>
.browser-history-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
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
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
  align-items: center;
}
.browser-history-dates {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.browser-history-date {
  display: grid;
  gap: 0.25rem;
  flex: 1 1 10rem;
  min-inline-size: 0;
  max-inline-size: 13rem;
}
.browser-history-selection {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.browser-history-selection span {
  margin-inline-end: auto;
}
.browser-history-day h3 {
  padding-block: 0.375rem;
  border-block-end: 1px solid var(--mar-ui-border-subtle);
  font-size: inherit;
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
  padding-block: 0.25rem;
}
.browser-history-list time {
  flex: none;
  min-inline-size: 5ch;
  color: var(--mar-ui-text-secondary);
  font-variant-numeric: tabular-nums;
}
.browser-history-entry {
  min-inline-size: 0;
  flex: 1;
  justify-content: start;
  text-align: start;
}
.browser-history-entry :deep(.mar-ui-button__label) {
  flex: 1;
}
.browser-history-entry span,
.browser-history-entry small {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.browser-history-entry small {
  color: var(--mar-ui-text-secondary);
}
</style>
