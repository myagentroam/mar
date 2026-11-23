<script setup lang="ts">
import { MarDatePicker } from '@myagentroam/mar-ui/date-picker';
import { MarRadioButton, MarRadioGroup } from '@myagentroam/mar-ui/radio';
import { MarTag, type TagProps } from '@myagentroam/mar-ui/tag';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';

import { MarButton } from '@myagentroam/mar-ui/button';
import { watchManagementPageFailure } from '../../service/management-page-feedback.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { MarIcon } from '@myagentroam/mar-ui/icons';
import { MarSegmented } from '@myagentroam/mar-ui/segmented';
import { marIcon } from '@myagentroam/mar-ui/icons';
import { MarTooltip } from '@myagentroam/mar-ui/tooltip';
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  personalUsageQuerySchema,
  type PersonalUsageQuery,
  type PersonalUsageRecords,
  type PersonalUsageOverview,
  type UsageGroup
} from '@myagentroam/protocol';
import { UsageStatisticsService } from '../../service/usage-statistics-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import { absoluteMessageTime } from '../../util/time-presentation.js';
import { cacheHitRate } from '../../util/usage-statistics-presentation.js';
import ManagementPagination from './ManagementPagination.vue';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';

const props = defineProps<{ request: <T>(path: string, init?: RequestInit) => Promise<T> }>();
const { t, locale } = useI18n();
const trendId = useId();
const service = new UsageStatisticsService(props.request, (error) =>
  showMessage(errorMessage(error), 'error', error)
);
const state = service.state;
const pagination = service.pagination;
const recordsLoading = computed(
  () => state.loading || (state.loadingPage && !pagination.loadingMore.value)
);
watchManagementPageFailure(pagination);
watch(pagination.mobileViewport, () => void refresh(true));
const form = ref<FormInstance>();
const purposes = ['conversation', 'compact', 'prompt_completion', 'title', 'other'] as const;
type UsagePurpose = (typeof purposes)[number];
const draft = reactive({
  period: '24h',
  range: null as [Date, Date] | null,
  runner: '',
  model: '',
  mode: '',
  purpose: 'conversation' as UsagePurpose
});
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const runners = ['mar-agent', 'codex', 'claude-code', 'opencode'] as const;
const selectedPurpose = ref(draft.purpose);
const purposeOptions = computed(() =>
  purposes.map((value) => ({ value, label: t(`usageStatistics.purposes.${value}`) }))
);
const metric = ref<'totalTokens' | 'requests'>('totalTokens');
const tokenColumns = ['inputTokens', 'cacheReadTokens', 'outputTokens', 'totalTokens'] as const;
const usageStateTypes: Record<PersonalUsageRecords['records'][number]['state'], TagProps['type']> =
  {
    running: 'primary',
    succeeded: 'info',
    failed: 'danger',
    cancelled: 'info',
    interrupted: 'warning'
  };
// The chart is one tab stop; pointer and keyboard inspection share its tooltip.
type UsageBucket = PersonalUsageOverview['buckets'][number];
const activeBucket = shallowRef<{ index: number; anchor: SVGGElement }>();
const focusedBucketIndex = ref(0);
const activeBucketDetails = computed(() => {
  const active = activeBucket.value;
  const bucket = active && state.overview?.buckets[active.index];
  return bucket ? bucketDetails(bucket) : [];
});
const bucketReference = computed(() => {
  const target = activeBucket.value?.anchor;
  return target
    ? { contextElement: target, getBoundingClientRect: () => target.getBoundingClientRect() }
    : undefined;
});
function showBucket(index: number, event: Event): void {
  activeBucket.value = { index, anchor: event.currentTarget as SVGGElement };
}
function hideBucket(event: Event): void {
  if (activeBucket.value?.anchor === event.currentTarget) activeBucket.value = undefined;
}
function navigateBuckets(event: KeyboardEvent): void {
  if (event.key === 'Escape' && activeBucket.value) {
    event.preventDefault();
    event.stopPropagation();
    activeBucket.value = undefined;
    return;
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const current = event.currentTarget as SVGGElement;
  const target =
    event.key === 'ArrowLeft' ? current.previousElementSibling : current.nextElementSibling;
  if (target instanceof SVGElement && target.classList.contains('trend-bucket')) target.focus();
}
const modelOptions = computed(() =>
  state.availableModels.length > 0 ? state.availableModels : (state.overview?.models ?? [])
);
const query = (): PersonalUsageQuery => {
  const now = Date.now();
  return personalUsageQuerySchema.parse({
    from:
      draft.period === 'custom'
        ? draft.range?.[0]?.getTime()
        : now - (draft.period === '24h' ? 86_400_000 : 7 * 86_400_000),
    to: draft.period === 'custom' ? draft.range?.[1]?.getTime() : now,
    timeZone,
    ...(draft.runner ? { runner: draft.runner } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.mode ? { mode: draft.mode } : {}),
    ...(draft.purpose ? { purpose: draft.purpose } : {})
  });
};
const rules = computed<FormRules>(() => ({
  range: [
    {
      validator: (_rule: unknown, _value: unknown, done: (error?: Error) => void) => {
        try {
          query();
          done();
        } catch {
          done(new Error(t('usageStatistics.invalidRange')));
        }
      }
    }
  ]
}));
async function refresh(reset = false, purpose?: UsagePurpose): Promise<void> {
  const valid = await form.value?.validate().catch(() => false);
  if (purpose !== undefined && purpose !== selectedPurpose.value) return;
  if (!valid) {
    if (purpose !== undefined) selectedPurpose.value = draft.purpose;
    return;
  }
  if (purpose !== undefined) draft.purpose = purpose;
  if (reset) recordsSorted = false;
  const loaded = await service.load(query(), { reset, rolling: draft.period !== 'custom' });
  if (loaded) {
    expandedRecords.value = [];
    service.setRecordsInteracting(recordsSorted);
  }
}
function change(): void {
  form.value?.clearValidate('range');
  if (draft.period !== 'custom' || draft.range) void refresh(true);
}
let recordsSorted = false;
const expandedRecords = ref<string[]>([]);
function sortChanged({ order }: { order: string | null }): void {
  recordsSorted = order !== null;
  service.setRecordsInteracting(recordsSorted || expandedRecords.value.length > 0);
}
function expandChanged(
  _row: unknown,
  rows: boolean | { recordId: string; ledgerId?: string }[]
): void {
  if (!Array.isArray(rows)) return;
  expandedRecords.value = rows.map(recordKey);
  service.setRecordsInteracting(recordsSorted || expandedRecords.value.length > 0);
}
watch(
  () => state.overview,
  (overview) => {
    const active = activeBucket.value;
    const length = overview?.buckets.length ?? 0;
    if (
      active &&
      (active.anchor.ownerDocument.activeElement !== active.anchor ||
        active.index >= length ||
        overview?.selected.requests === '0')
    )
      activeBucket.value = undefined;
    focusedBucketIndex.value = Math.min(focusedBucketIndex.value, Math.max(0, length - 1));
  }
);
watch(
  () => state.records,
  (records) => {
    const identities = new Set(records.map(recordKey));
    expandedRecords.value = expandedRecords.value.filter((key) => identities.has(key));
    service.setRecordsInteracting(recordsSorted || expandedRecords.value.length > 0);
  }
);
function number(value: string | null | undefined, compact = false): string {
  return new Intl.NumberFormat(locale.value, {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: 1
  }).format(BigInt(value ?? '0'));
}
function time(value: number | null | undefined): string {
  return value == null ? t('usageStatistics.unknown') : absoluteMessageTime(value);
}
function countDetail(value: string): string {
  const compact = number(value, true);
  const exact = number(value);
  return compact === exact ? exact : `${compact} (${exact})`;
}
function fraction(value: string, maximum: string): number {
  return BigInt(maximum) === 0n ? 0 : Number((BigInt(value) * 10_000n) / BigInt(maximum)) / 10_000;
}
function cacheLabel(
  value: { cacheReadTokens?: string | null; inputTokens?: string | null },
  compact = false
): string {
  return t('usageStatistics.cacheWithRate', {
    tokens: number(value.cacheReadTokens, compact),
    rate: cacheHitRate(value.cacheReadTokens, value.inputTokens, locale.value)
  });
}
function cacheTooltip(value: {
  cacheReadTokens?: string | null;
  cacheWriteTokens?: string | null;
  inputTokens?: string | null;
}): string {
  return `${t('usageStatistics.cacheReadTokens')}: ${cacheLabel(value)} · ${t('usageStatistics.cacheWriteTokens')}: ${number(value.cacheWriteTokens)}`;
}
function bucketDetails(bucket: UsageBucket): string[] {
  return [
    `${time(bucket.from)} – ${time(bucket.to)}`,
    `${t('usageStatistics.inputTokens')}: ${countDetail(bucket.inputTokens)}`,
    `${t('usageStatistics.cache')}: ${cacheLabel(bucket, true)}`,
    cacheTooltip(bucket),
    `${t('usageStatistics.outputTokens')}: ${countDetail(bucket.outputTokens)}`,
    `${t('usageStatistics.totalTokens')}: ${countDetail(bucket.totalTokens)}`
  ];
}
function hasCacheDetails(value: {
  cacheReadTokens?: string | null;
  cacheWriteTokens?: string | null;
}): boolean {
  return value.cacheReadTokens != null || value.cacheWriteTokens != null;
}
const chartMax = computed(() =>
  (state.overview?.buckets ?? []).reduce(
    (max, bucket) => (BigInt(bucket.totalTokens) > BigInt(max) ? bucket.totalTokens : max),
    '0'
  )
);
const sorted = (values: UsageGroup[]) =>
  [...values].sort((a, b) =>
    BigInt(a[metric.value]) === BigInt(b[metric.value])
      ? a.key.localeCompare(b.key)
      : BigInt(a[metric.value]) > BigInt(b[metric.value])
        ? -1
        : 1
  );
const distributions = computed(() => [
  { kind: 'runners', groups: sorted(state.overview?.runners ?? []) },
  { kind: 'models', groups: sorted(state.overview?.models ?? []) }
]);
const overviewCards = computed(() =>
  state.overview
    ? [
        { label: 'last24Hours', value: state.overview.last24Hours },
        { label: 'last7Days', value: state.overview.last7Days }
      ]
    : []
);
const runnerName = (runner: string) => t(`usageStatistics.runnerNames.${runner}`);
const recordKey = (record: { recordId: string; ledgerId?: string }) =>
  record.ledgerId ?? record.recordId;
function compareCount(a: Record<string, unknown>, b: Record<string, unknown>, key: string): number {
  if (a[key] == null) return b[key] == null ? 0 : -1;
  if (b[key] == null) return 1;
  const left = BigInt(String(a[key])),
    right = BigInt(String(b[key]));
  return left === right ? 0 : left > right ? 1 : -1;
}
onMounted(() => {
  pagination.start();
  void refresh();
  service.startAutoRefresh(document);
});
onUnmounted(() => {
  service.dispose();
});
</script>

<template>
  <section class="usage settings-panel" data-testid="usage-statistics">
    <div class="usage-content">
      <header>
        <div>
          <h2>{{ t('usageStatistics.title') }}</h2>
          <p class="usage-summary">{{ t('usageStatistics.accountScope') }}</p>
        </div>
        <div class="refresh-actions">
          <span class="metadata" role="status">
            {{ state.refreshFailed ? t('usageStatistics.refreshDelayed') : '' }}
          </span>
          <MarButton
            v-tooltip="t('usageStatistics.refresh')"
            class="mar-icon-action"
            text
            circle
            :icon="marIcon('refresh')"
            :disabled="state.loading"
            :aria-label="t('usageStatistics.refresh')"
            @click="refresh()"
          />
        </div>
      </header>
      <MarSelect
        v-if="pagination.mobileViewport.value"
        v-model="selectedPurpose"
        class="usage-purpose-select"
        :options="purposeOptions"
        :aria-label="t('usageStatistics.purpose')"
        @change="refresh(true, selectedPurpose)"
      />
      <div v-else class="usage-purpose-scroll">
        <MarSegmented
          v-model="selectedPurpose"
          :options="purposeOptions"
          :label="t('usageStatistics.purpose')"
          @change="refresh(true, $event)"
        />
      </div>
      <p v-if="state.overview" class="metadata">{{ t('usageStatistics.overviewScope') }}</p>
      <div v-if="state.overview" class="overview">
        <section v-for="card in overviewCards" :key="card.label" class="overview-cell">
          <h3>{{ t(`usageStatistics.${card.label}`) }}</h3>
          <p>
            {{ t('usageStatistics.input') }}
            <span
              v-tooltip="{ content: number(card.value.inputTokens), touch: true }"
              class="usage-count"
              tabindex="0"
              >{{ number(card.value.inputTokens, true) }}</span
            >
            · {{ t('usageStatistics.cache') }}
            <span
              v-tooltip="{
                touch: true,
                content: cacheTooltip(card.value),
                disabled: !hasCacheDetails(card.value)
              }"
              :class="{ 'usage-count': hasCacheDetails(card.value) }"
              :tabindex="hasCacheDetails(card.value) ? 0 : undefined"
              >{{ cacheLabel(card.value, true) }}</span
            >
            · {{ t('usageStatistics.output') }}
            <span
              v-tooltip="{ content: number(card.value.outputTokens), touch: true }"
              class="usage-count"
              tabindex="0"
              >{{ number(card.value.outputTokens, true) }}</span
            >
          </p>
          <strong
            v-tooltip="{ content: number(card.value.totalTokens), touch: true }"
            class="usage-count"
            tabindex="0"
            >{{ number(card.value.totalTokens, true) }}</strong
          ><span>{{ t('usageStatistics.totalTokens') }}</span>
          <span class="metadata">
            · {{ t('usageStatistics.requests') }} {{ number(card.value.requests) }}</span
          >
        </section>
      </div>
      <MarForm
        ref="form"
        :model="draft"
        :rules="rules"
        class="filters"
        label-position="top"
        @submit.prevent="refresh()"
      >
        <div class="filter-selects">
          <MarFormItem :label="t('usageStatistics.range')"
            ><MarSelect
              v-model="draft.period"
              :aria-label="t('usageStatistics.range')"
              @change="change"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <MarOption :label="t('usageStatistics.last24Hours')" value="24h" /><MarOption
                :label="t('usageStatistics.last7Days')"
                value="7d"
              /><MarOption :label="t('usageStatistics.custom')" value="custom" /> </MarSelect
          ></MarFormItem>
          <MarFormItem :label="t('usageStatistics.runner')"
            ><MarSelect
              v-model="draft.runner"
              clearable
              :placeholder="t('usageStatistics.all')"
              :aria-label="t('usageStatistics.runner')"
              @change="
                draft.model = '';
                change();
              "
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
              ><MarOption
                v-for="runner in runners"
                :key="runner"
                :label="runnerName(runner)"
                :value="runner" /></MarSelect
          ></MarFormItem>
          <MarFormItem :label="t('usageStatistics.model')"
            ><MarSelect
              v-model="draft.model"
              clearable
              :placeholder="t('usageStatistics.all')"
              :aria-label="t('usageStatistics.model')"
              @change="change"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
              ><MarOption
                v-for="model in modelOptions"
                :key="model.key"
                :label="model.label || t('usageStatistics.unknown')"
                :value="model.key" /></MarSelect
          ></MarFormItem>
          <MarFormItem :label="t('usageStatistics.mode')"
            ><MarSelect
              v-model="draft.mode"
              clearable
              :placeholder="t('usageStatistics.all')"
              :aria-label="t('usageStatistics.mode')"
              @change="change"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
              ><MarOption
                v-for="mode in ['work', 'conversation']"
                :key="mode"
                :label="t(`usageStatistics.modes.${mode}`)"
                :value="mode" /></MarSelect
          ></MarFormItem>
        </div>
        <MarFormItem
          v-if="draft.period === 'custom'"
          prop="range"
          :label="t('usageStatistics.custom')"
          :validate-event="false"
          class="custom-range"
          ><MarDatePicker
            v-model="draft.range"
            type="datetimerange"
            single-panel
            :validate-event="false"
            :start-placeholder="t('usageStatistics.from')"
            :end-placeholder="t('usageStatistics.to')"
            @change="change"
            :prefix-icon="marIcon('calendar')"
            :clear-icon="marIcon('clear-input')"
            ><template #prev-month><MarIcon name="chevron-left" /></template
            ><template #next-month><MarIcon name="chevron-right" /></template
            ><template #prev-year><MarIcon name="chevrons-left" /></template
            ><template #next-year><MarIcon name="chevrons-right" /></template></MarDatePicker
        ></MarFormItem>
      </MarForm>
      <template v-if="state.overview">
        <div class="section-heading">
          <h3>{{ t('usageStatistics.trend') }}</h3>
          <span
            :id="`${trendId}-summary`"
            v-tooltip="{
              content: t('usageStatistics.selected', {
                tokens: number(state.overview.selected.totalTokens),
                input: number(state.overview.selected.inputTokens),
                cache: cacheLabel(state.overview.selected),
                output: number(state.overview.selected.outputTokens),
                requests: number(state.overview.selected.requests)
              }),
              touch: true
            }"
            class="usage-count"
            tabindex="0"
            >{{
              t('usageStatistics.selected', {
                tokens: number(state.overview.selected.totalTokens, true),
                input: number(state.overview.selected.inputTokens, true),
                cache: cacheLabel(state.overview.selected, true),
                output: number(state.overview.selected.outputTokens, true),
                requests: number(state.overview.selected.requests)
              })
            }}</span
          >
        </div>
        <p class="metadata">
          {{ t('usageStatistics.timeZone', { zone: timeZone }) }}
        </p>
        <p v-if="state.overview.selected.requests === '0'" class="mar-empty">
          {{ t('usageStatistics.empty') }}
        </p>
        <div v-else class="trend">
          <div class="legend">
            <span class="input-key" />{{ t('usageStatistics.input') }}
            <span class="cache-key" />
            <span
              v-tooltip="{
                touch: true,
                content: cacheTooltip(state.overview.selected),
                disabled: !hasCacheDetails(state.overview.selected)
              }"
              :class="{ 'usage-count': hasCacheDetails(state.overview.selected) }"
              :tabindex="hasCacheDetails(state.overview.selected) ? 0 : undefined"
              >{{ t('usageStatistics.cache') }}</span
            >
            <span class="output-key" />{{ t('usageStatistics.output') }}
          </div>
          <svg
            class="usage-trend-chart"
            viewBox="0 0 800 170"
            role="group"
            :aria-label="t('usageStatistics.trend')"
            :aria-describedby="`${trendId}-range ${trendId}-summary`"
            preserveAspectRatio="none"
          >
            <line x1="0" y1="155" x2="800" y2="155" class="axis" />
            <g
              v-for="(bucket, index) in state.overview.buckets"
              :key="index"
              class="trend-bucket"
              role="img"
              :aria-label="bucketDetails(bucket).join(' · ')"
              :tabindex="index === focusedBucketIndex ? 0 : -1"
              :transform="`translate(${(index * 800) / state.overview.buckets.length},0)`"
              @pointerenter="$event.pointerType !== 'touch' && showBucket(index, $event)"
              @pointerleave="
                $event.pointerType !== 'touch' &&
                !($event.currentTarget as SVGGElement).matches(':focus-visible') &&
                hideBucket($event)
              "
              @click="showBucket(index, $event)"
              @focus="
                focusedBucketIndex = index;
                showBucket(index, $event);
              "
              @blur="hideBucket"
              @keydown="navigateBuckets"
            >
              <rect
                class="input-bar"
                :x="2"
                :y="155 - fraction(bucket.inputTokens, chartMax) * 140"
                :width="Math.max(1, 800 / state.overview.buckets.length - 4)"
                :height="fraction(bucket.inputTokens, chartMax) * 140"
              />
              <rect
                class="cache-bar"
                :x="2"
                :y="155 - fraction(bucket.inputTokens, chartMax) * 140"
                :width="Math.max(1, 800 / state.overview.buckets.length - 4)"
                :height="
                  Math.min(
                    fraction(bucket.cacheReadTokens ?? '0', chartMax),
                    fraction(bucket.inputTokens, chartMax)
                  ) * 140
                "
              />
              <rect
                class="output-bar"
                :x="2"
                :y="155 - fraction(bucket.totalTokens, chartMax) * 140"
                :width="Math.max(1, 800 / state.overview.buckets.length - 4)"
                :height="fraction(bucket.outputTokens, chartMax) * 140"
              />
              <rect
                class="bucket-hit-area"
                :width="800 / state.overview.buckets.length"
                y="15"
                height="140"
              />
            </g>
          </svg>
          <MarTooltip
            v-if="activeBucketDetails.length"
            :anchor="bucketReference"
            placement="bottom"
          >
            <div
              v-for="(detail, index) in activeBucketDetails"
              :key="index"
              class="usage-tooltip-detail"
            >
              {{ detail }}
            </div>
          </MarTooltip>
          <div :id="`${trendId}-range`" class="axis-labels">
            <span>{{ time(state.overview.buckets[0]?.from) }}</span
            ><span>{{ time(state.overview.buckets.at(-1)?.to) }}</span>
          </div>
        </div>
        <div class="section-heading">
          <h3>{{ t('usageStatistics.distribution') }}</h3>
          <MarRadioGroup v-model="metric" :aria-label="t('usageStatistics.metric')"
            ><MarRadioButton value="totalTokens">{{ t('usageStatistics.tokens') }}</MarRadioButton
            ><MarRadioButton value="requests">{{
              t('usageStatistics.requests')
            }}</MarRadioButton></MarRadioGroup
          >
        </div>
        <div class="distributions">
          <section v-for="distribution in distributions" :key="distribution.kind">
            <h4>{{ t(`usageStatistics.${distribution.kind}`) }}</h4>
            <p v-if="!distribution.groups.length" class="mar-empty">
              {{ t('usageStatistics.empty') }}
            </p>
            <ol v-else>
              <li v-for="group in distribution.groups" :key="group.key">
                <div>
                  <span>{{
                    distribution.kind === 'runners'
                      ? runnerName(group.key)
                      : group.label || t('usageStatistics.unknown')
                  }}</span>
                </div>
                <div class="distribution-cache metadata">
                  {{ t('usageStatistics.cache') }}
                  <span
                    v-tooltip="{
                      touch: true,
                      content: cacheTooltip(group),
                      disabled: !hasCacheDetails(group)
                    }"
                    :class="{ 'usage-count': hasCacheDetails(group) }"
                    :tabindex="hasCacheDetails(group) ? 0 : undefined"
                    >{{ cacheLabel(group, true) }}</span
                  >
                  ·
                  {{
                    t(
                      metric === 'totalTokens'
                        ? 'usageStatistics.totalTokens'
                        : 'usageStatistics.requests'
                    )
                  }}
                  <strong
                    v-tooltip="{ content: number(group[metric]), touch: true }"
                    class="usage-count"
                    tabindex="0"
                    >{{ number(group[metric], true) }}</strong
                  >
                </div>
                <div class="bar-track" aria-hidden="true">
                  <span
                    :style="{
                      width: `${fraction(group[metric], distribution.groups[0]![metric]) * 100}%`
                    }"
                  />
                </div>
              </li>
            </ol>
          </section>
        </div>
      </template>
      <template v-if="state.overview || state.failed || state.loading">
        <div class="section-heading">
          <h3>{{ t('usageStatistics.records') }}</h3>
        </div>
        <div v-if="state.recordsStale" class="records-update">
          <span class="metadata">{{ t('usageStatistics.recordsSnapshot') }}</span>
          <MarButton link :disabled="state.loading" @click="refresh()">{{
            t('usageStatistics.updateRecords')
          }}</MarButton>
        </div>
        <MarTable
          :data="state.records"
          :row-key="recordKey"
          :expand-row-keys="expandedRecords"
          class="records"
          :aria-busy="recordsLoading"
          @sort-change="sortChanged"
          @expand-change="expandChanged"
        >
          <template v-if="recordsLoading" #loading>
            <span role="progressbar" :aria-label="t('common.loading')">
              <MarBusyIndicator class="mar-read-loading-indicator" />
            </span>
          </template>
          <MarTableColumn type="expand"
            ><template #default="{ row }"
              ><dl class="record-detail">
                <template
                  v-for="key in [
                    'requestedModel',
                    'actualModel',
                    'sessionId',
                    'runId',
                    'requestId',
                    'responseId',
                    'cacheReadTokens',
                    'cacheWriteTokens',
                    'reasoningTokens'
                  ]"
                  :key="key"
                  ><dt>{{ t(`usageStatistics.${key}`) }}</dt>
                  <dd>
                    <span
                      v-tooltip="{
                        touch: true,
                        content: key === 'cacheReadTokens' ? cacheTooltip(row) : number(row[key]),
                        disabled:
                          key === 'cacheReadTokens' ? !hasCacheDetails(row) : row[key] == null
                      }"
                      v-if="key.endsWith('Tokens')"
                      :class="{
                        'usage-count':
                          key === 'cacheReadTokens' ? hasCacheDetails(row) : row[key] != null
                      }"
                      :tabindex="
                        (key === 'cacheReadTokens' ? hasCacheDetails(row) : row[key] != null)
                          ? 0
                          : undefined
                      "
                      >{{
                        key === 'cacheReadTokens' ? cacheLabel(row, true) : number(row[key], true)
                      }}</span
                    >
                    <template v-else>{{ row[key] ?? t('usageStatistics.unknown') }}</template>
                  </dd></template
                >
                <dt>{{ t('usageStatistics.coverageLabel') }}</dt>
                <dd>
                  {{ t(`usageStatistics.coverages.${row.coverage}`) }} ·
                  {{ t(`usageStatistics.roles.${row.agentRole}`) }}
                </dd>
              </dl></template
            ></MarTableColumn
          >
          <MarTableColumn prop="endedAt" :label="t('usageStatistics.time')" sortable min-width="180"
            ><template #default="{ row }">{{ time(row.endedAt) }}</template></MarTableColumn
          >
          <MarTableColumn
            prop="runner"
            :label="t('usageStatistics.runner')"
            sortable
            min-width="110"
            ><template #default="{ row }">{{ runnerName(row.runner) }}</template></MarTableColumn
          >
          <MarTableColumn :label="t('usageStatistics.model')" min-width="160"
            ><template #default="{ row }">{{
              row.actualModel ?? row.requestedModel ?? t('usageStatistics.unknown')
            }}</template></MarTableColumn
          >
          <MarTableColumn :label="t('usageStatistics.purpose')" min-width="100"
            ><template #default="{ row }">{{
              t(`usageStatistics.purposes.${row.purpose}`)
            }}</template></MarTableColumn
          >
          <MarTableColumn
            v-for="key in tokenColumns"
            :key="key"
            :prop="key"
            :label="
              key === 'cacheReadTokens' ? t('usageStatistics.cache') : t(`usageStatistics.${key}`)
            "
            sortable
            :sort-method="
              (a: Record<string, unknown>, b: Record<string, unknown>) => compareCount(a, b, key)
            "
            :min-width="key === 'cacheReadTokens' ? 170 : 110"
          >
            <template #default="{ row }">
              <span
                v-tooltip="{
                  touch: true,
                  content: key === 'cacheReadTokens' ? cacheTooltip(row) : number(row[key]),
                  disabled: key === 'cacheReadTokens' ? !hasCacheDetails(row) : row[key] == null
                }"
                :class="{
                  'usage-count': key === 'cacheReadTokens' ? hasCacheDetails(row) : row[key] != null
                }"
                :tabindex="
                  (key === 'cacheReadTokens' ? hasCacheDetails(row) : row[key] != null)
                    ? 0
                    : undefined
                "
                >{{
                  key === 'cacheReadTokens' ? cacheLabel(row, true) : number(row[key], true)
                }}</span
              >
            </template>
          </MarTableColumn>
          <MarTableColumn :label="t('usageStatistics.state')" min-width="105"
            ><template #default="{ row }"
              ><MarTag
                :type="usageStateTypes[row.state as keyof typeof usageStateTypes]"
                effect="plain"
                role="status"
                :aria-label="t(`usageStatistics.states.${row.state}`)"
                >{{ t(`usageStatistics.states.${row.state}`) }}</MarTag
              ></template
            ></MarTableColumn
          >
        </MarTable>
        <ManagementPagination
          :page="state.page"
          :page-size="20"
          :total="Number(state.total)"
          :mobile="pagination.mobileViewport.value"
          :mobile-visible-count="state.records.length"
          :has-more="pagination.hasMore.value"
          :loading="state.loading || state.loadingPage"
          :loading-more="pagination.loadingMore.value"
          :failed="pagination.failure.value !== undefined"
          :incremental-failed="pagination.failure.value?.incremental === true"
          :error="pagination.failure.value?.error"
          :context-key="pagination.contextKey.value"
          :aria-label="t('usageStatistics.pagination')"
          @page="service.goToPage($event)"
          @load-more="service.loadMore($event)"
          @retry="service.retryPage()"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
:where(.usage) :deep(.section-heading > span) {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
:where(.usage) :deep(.section-heading h2) {
  font-weight: 500;
}

.usage-purpose-select {
  width: min(100%, 24rem);
  margin-top: 0.5rem;
}
.usage-purpose-scroll {
  margin: 0.5rem -3px 0;
  padding: 3px;
  overflow-x: auto;
}

.usage {
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  box-sizing: border-box;
  color: var(--mar-text-primary);
}
.usage-content {
  padding: var(--mar-settings-page-padding, 0.875rem 1rem);
}
header,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
header {
  align-items: flex-start;
  row-gap: 0.5rem;
}
h2 {
  margin: 0;
  font-size: var(--mar-font-size-title);
  line-height: 1.4;
}
h3,
h4 {
  font-size: var(--mar-font-size-body);
  margin: 1rem 0 0.6rem;
}
p {
  margin: 0.5rem 0;
}
.usage-summary {
  margin: 5px 0 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
}
.metadata,
.mar-empty {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.6;
}
.refresh-actions,
.records-update {
  display: flex;
  align-items: center;
  gap: 0.5rem 1rem;
  flex-wrap: wrap;
}
.overview {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-bottom: 1px solid var(--mar-border-default);
  margin-bottom: 1rem;
}
.overview-cell {
  padding: 0 1rem 0.75rem 0;
}
.overview-cell + .overview-cell {
  border-left: 1px solid var(--mar-border-default);
  padding-left: 1rem;
}
.overview-cell strong {
  display: inline-block;
  font-size: var(--mar-font-size-display);
  font-weight: 600;
  margin-right: 0.4rem;
  font-variant-numeric: tabular-nums;
}
.overview-cell p {
  font-size: var(--mar-font-size-meta);
  line-height: 1.6;
}
.filters {
  container: usage-filters / inline-size;
}
.filter-selects {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 12rem));
  gap: 0.75rem;
}
@container usage-filters (width >= 44.25rem) {
  .filter-selects {
    grid-template-columns: 10rem 10rem 14rem 8rem;
  }
}
.filters :deep(.mar-ui-form-item) {
  margin-bottom: 0.5rem;
  min-width: 0;
}
.filter-selects :deep(.mar-ui-form-item__label) {
  line-height: 1.5;
}
.filters :deep(.mar-ui-select) {
  width: 100%;
}
.filters .custom-range {
  margin-top: 0.75rem;
  width: 100%;
  max-width: 38rem;
}
.custom-range :deep(.mar-ui-form-item__content) {
  display: block;
}
.custom-range :deep(.mar-ui-form-item__error) {
  position: static;
  line-height: 1.5;
}
.custom-range :deep(.mar-ui-date-picker) {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.section-heading > span {
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-secondary);
}
.section-heading :deep(.mar-ui-radio--button label) {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.section-heading :deep(.mar-ui-radio--button input:checked + label) {
  color: var(--mar-text-primary);
}
.trend {
  padding: 0.5rem 0 1rem;
}
.usage-count,
.trend-bucket {
  cursor: pointer;
}
.bucket-hit-area {
  fill: transparent;
}
.trend-bucket:focus-visible .bucket-hit-area {
  stroke: var(--mar-text-secondary);
  stroke-dasharray: 3 2;
  vector-effect: non-scaling-stroke;
}
.usage-trend-chart {
  width: 100%;
  height: 8rem;
}
.axis {
  stroke: var(--mar-border-default);
}
.input-bar {
  fill: var(--mar-color-accent);
}
.output-bar {
  fill: var(--mar-text-secondary);
}
.cache-bar {
  fill: var(--mar-control-color-success);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  font-size: var(--mar-font-size-meta);
}
.legend .input-key,
.legend .output-key,
.legend .cache-key {
  width: 0.6rem;
  height: 0.6rem;
  margin-left: 0.6rem;
}
.input-key {
  background: var(--mar-color-accent);
}
.output-key {
  background: var(--mar-text-secondary);
}
.cache-key {
  background: var(--mar-control-color-success);
}
.axis-labels {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-secondary);
}
.distributions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--mar-border-default);
}
ol {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 18rem;
  overflow: auto;
}
li {
  margin-bottom: 0.8rem;
}
li > div:first-child {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  font-size: var(--mar-font-size-meta);
}
li span {
  overflow-wrap: anywhere;
}
li strong {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bar-track {
  height: 0.35rem;
  background: var(--mar-fill-subtle);
  margin-top: 0.3rem;
}
.bar-track span {
  display: block;
  height: 100%;
  background: var(--mar-conversation-activity-fg);
}
.records {
  width: 100%;
}
.record-detail {
  display: grid;
  grid-template-columns: minmax(7rem, auto) 1fr;
  gap: 0.5rem 1rem;
  padding: 0.75rem 1rem;
  margin: 0;
  font-size: var(--mar-font-size-meta);
}
dt {
  color: var(--mar-text-secondary);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 640px) {
  .overview,
  .distributions {
    grid-template-columns: 1fr;
  }
  .overview-cell + .overview-cell {
    border-left: 0;
    border-top: 1px solid var(--mar-border-default);
    padding-left: 0;
  }
  .record-detail {
    grid-template-columns: 1fr;
    gap: 0.2rem;
  }
  dd {
    margin-bottom: 0.5rem;
  }
}
</style>
