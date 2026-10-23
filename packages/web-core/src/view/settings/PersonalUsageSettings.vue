<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import {
  personalUsageQuerySchema,
  type PersonalUsageQuery,
  type PersonalUsageOverview,
  type UsageGroup
} from '@myagentroam/protocol';
import { PersonalUsageService } from '../../service/PersonalUsageService.js';
import { errorMessage } from '../../util/error-presentation.js';
import { absoluteMessageTime } from '../../util/time-presentation.js';
import { cacheHitRate } from '../../util/personal-usage-presentation.js';
import ManagementPagination from './ManagementPagination.vue';
import LoadingPanel from '../common/LoadingPanel.vue';
import { createManagementPaginationService } from '../../service/ManagementPaginationService.js';

const props = defineProps<{ request: <T>(path: string, init?: RequestInit) => Promise<T> }>();
const { t, locale } = useI18n();
const service = new PersonalUsageService(props.request, (error) =>
  ElMessage.error(errorMessage(error))
);
const state = service.state;
const busy = computed(() => state.loading || state.loadingPage);
const initialized = ref(false);
const pageLoading = computed(() => busy.value && !initialized.value);
const pagination = createManagementPaginationService(20);
watch(pagination.mobileViewport, () => void refresh(true));
const form = ref<FormInstance>();
const draft = reactive({
  period: '24h',
  range: null as [Date, Date] | null,
  runner: '',
  model: '',
  mode: '',
  purpose: 'conversation'
});
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const runners = ['mar-agent', 'codex', 'claude-code', 'opencode'] as const;
const purposes = ['conversation', 'compact', 'prompt_completion', 'title', 'other'] as const;
function selectPurpose(purpose: (typeof purposes)[number]): void {
  void refresh(true, purpose);
}
const metric = ref<'totalTokens' | 'requests'>('totalTokens');
const tokenColumns = ['inputTokens', 'cacheReadTokens', 'outputTokens', 'totalTokens'] as const;
const activeBucket = ref<PersonalUsageOverview['buckets'][number]>();
const bucketAnchor = shallowRef<SVGElement>();
function showBucket(bucket: PersonalUsageOverview['buckets'][number], event: Event): void {
  bucketAnchor.value = event.currentTarget as SVGElement;
  activeBucket.value = bucket;
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
          const value = query();
          done(value.to > Date.now() ? new Error(t('modelUsage.invalidRange')) : undefined);
        } catch {
          done(new Error(t('modelUsage.invalidRange')));
        }
      }
    }
  ]
}));
async function refresh(reset = false, purpose?: (typeof purposes)[number]): Promise<void> {
  if (!(await form.value?.validate().catch(() => false))) return;
  if (purpose !== undefined) draft.purpose = purpose;
  if (reset) recordsSorted = false;
  const loaded = await service.load(query(), { reset, rolling: draft.period !== 'custom' });
  if (loaded) {
    initialized.value = true;
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
function expandChanged(_row: unknown, rows: { recordId: string; ledgerId?: string }[]): void {
  expandedRecords.value = rows.map(recordKey);
  service.setRecordsInteracting(recordsSorted || expandedRecords.value.length > 0);
}
watch(
  () => state.overview,
  () => (activeBucket.value = undefined)
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
  return value == null ? t('modelUsage.unknown') : absoluteMessageTime(value);
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
  return t('modelUsage.cacheWithRate', {
    tokens: number(value.cacheReadTokens, compact),
    rate: cacheHitRate(value.cacheReadTokens, value.inputTokens, locale.value)
  });
}
function cacheTooltip(value: {
  cacheReadTokens?: string | null;
  cacheWriteTokens?: string | null;
  inputTokens?: string | null;
}): string {
  return `${t('modelUsage.cacheReadTokens')}: ${cacheLabel(value)} · ${t('modelUsage.cacheWriteTokens')}: ${number(value.cacheWriteTokens)}`;
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
const runnerName = (runner: string) => t(`modelUsage.runnerNames.${runner}`);
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
  pagination.dispose();
  service.dispose();
});
</script>

<template>
  <LoadingPanel
    :loading="pageLoading"
    variant="page"
    class="usage settings-panel"
    data-testid="personal-usage"
  >
    <div class="usage-content">
      <header>
        <h2>{{ t('modelUsage.title') }}</h2>
        <div class="refresh-actions">
          <span class="metadata" role="status">
            {{
              state.refreshFailed
                ? t('modelUsage.refreshDelayed')
                : state.lastRefreshedAt
                  ? t('modelUsage.refreshed', { time: time(state.lastRefreshedAt) })
                  : ''
            }}
          </span>
          <el-button
            :icon="Refresh"
            :loading="state.loading && !pageLoading"
            :disabled="pageLoading"
            @click="refresh()"
            >{{ t('modelUsage.refresh') }}</el-button
          >
        </div>
      </header>
      <nav class="usage-purposes" :aria-label="t('modelUsage.purpose')">
        <button
          v-for="purpose in purposes"
          :key="purpose"
          type="button"
          :aria-pressed="draft.purpose === purpose"
          @click="selectPurpose(purpose)"
        >
          {{ t(`modelUsage.purposes.${purpose}`) }}
        </button>
      </nav>
      <p v-if="state.overview" class="metadata">{{ t('modelUsage.overviewScope') }}</p>
      <div v-if="state.overview" class="overview">
        <section v-for="card in overviewCards" :key="card.label" class="overview-cell">
          <h3>{{ t(`modelUsage.${card.label}`) }}</h3>
          <p>
            {{ t('modelUsage.input') }}
            <el-tooltip :content="number(card.value.inputTokens)" :trigger="['hover', 'focus']">
              <span class="usage-count" tabindex="0">{{
                number(card.value.inputTokens, true)
              }}</span>
            </el-tooltip>
            · {{ t('modelUsage.cache') }}
            <el-tooltip
              :content="cacheTooltip(card.value)"
              :disabled="!hasCacheDetails(card.value)"
              :trigger="['hover', 'focus']"
            >
              <span
                :class="{ 'usage-count': hasCacheDetails(card.value) }"
                :tabindex="hasCacheDetails(card.value) ? 0 : undefined"
                >{{ cacheLabel(card.value, true) }}</span
              >
            </el-tooltip>
            · {{ t('modelUsage.output') }}
            <el-tooltip :content="number(card.value.outputTokens)" :trigger="['hover', 'focus']">
              <span class="usage-count" tabindex="0">{{
                number(card.value.outputTokens, true)
              }}</span>
            </el-tooltip>
          </p>
          <el-tooltip :content="number(card.value.totalTokens)" :trigger="['hover', 'focus']">
            <strong class="usage-count" tabindex="0">{{
              number(card.value.totalTokens, true)
            }}</strong> </el-tooltip
          ><span>{{ t('modelUsage.totalTokens') }}</span>
          <span class="metadata">
            · {{ t('modelUsage.requests') }} {{ number(card.value.requests) }}</span
          >
        </section>
      </div>
      <el-form
        ref="form"
        :model="draft"
        :rules="rules"
        class="filters"
        label-position="top"
        @submit.prevent="refresh()"
      >
        <el-form-item :label="t('modelUsage.range')"
          ><el-select v-model="draft.period" :aria-label="t('modelUsage.range')" @change="change">
            <el-option :label="t('modelUsage.last24Hours')" value="24h" /><el-option
              :label="t('modelUsage.last7Days')"
              value="7d"
            /><el-option :label="t('modelUsage.custom')" value="custom" /> </el-select
        ></el-form-item>
        <el-form-item :label="t('modelUsage.runner')"
          ><el-select
            v-model="draft.runner"
            clearable
            :placeholder="t('modelUsage.all')"
            :aria-label="t('modelUsage.runner')"
            @change="
              draft.model = '';
              change();
            "
            ><el-option
              v-for="runner in runners"
              :key="runner"
              :label="runnerName(runner)"
              :value="runner" /></el-select
        ></el-form-item>
        <el-form-item :label="t('modelUsage.model')"
          ><el-select
            v-model="draft.model"
            clearable
            :placeholder="t('modelUsage.all')"
            :aria-label="t('modelUsage.model')"
            @change="change"
            ><el-option
              v-for="model in modelOptions"
              :key="model.key"
              :label="model.label || t('modelUsage.unknown')"
              :value="model.key" /></el-select
        ></el-form-item>
        <el-form-item :label="t('modelUsage.mode')"
          ><el-select
            v-model="draft.mode"
            clearable
            :placeholder="t('modelUsage.all')"
            :aria-label="t('modelUsage.mode')"
            @change="change"
            ><el-option
              v-for="mode in ['work', 'conversation']"
              :key="mode"
              :label="t(`modelUsage.modes.${mode}`)"
              :value="mode" /></el-select
        ></el-form-item>
        <el-form-item
          v-if="draft.period === 'custom'"
          prop="range"
          :label="t('modelUsage.custom')"
          class="custom-range"
          ><el-date-picker
            v-model="draft.range"
            type="datetimerange"
            single-panel
            :validate-event="false"
            :start-placeholder="t('modelUsage.from')"
            :end-placeholder="t('modelUsage.to')"
            @change="change"
        /></el-form-item>
      </el-form>
      <template v-if="state.overview">
        <div class="section-heading">
          <h3>{{ t('modelUsage.trend') }}</h3>
          <el-tooltip
            :content="
              t('modelUsage.selected', {
                tokens: number(state.overview.selected.totalTokens),
                input: number(state.overview.selected.inputTokens),
                cache: cacheLabel(state.overview.selected),
                output: number(state.overview.selected.outputTokens),
                requests: number(state.overview.selected.requests)
              })
            "
            :trigger="['hover', 'focus']"
          >
            <span class="usage-count" tabindex="0">{{
              t('modelUsage.selected', {
                tokens: number(state.overview.selected.totalTokens, true),
                input: number(state.overview.selected.inputTokens, true),
                cache: cacheLabel(state.overview.selected, true),
                output: number(state.overview.selected.outputTokens, true),
                requests: number(state.overview.selected.requests)
              })
            }}</span>
          </el-tooltip>
        </div>
        <p class="metadata">
          {{ t('modelUsage.timeZone', { zone: timeZone }) }}
        </p>
        <p v-if="state.overview.selected.requests === '0'" class="empty">
          {{ t('modelUsage.empty') }}
        </p>
        <div v-else class="trend">
          <div class="legend">
            <span class="input-key" />{{ t('modelUsage.input') }}
            <span class="cache-key" />
            <el-tooltip
              :content="cacheTooltip(state.overview.selected)"
              :disabled="!hasCacheDetails(state.overview.selected)"
              :trigger="['hover', 'focus']"
            >
              <span
                :class="{ 'usage-count': hasCacheDetails(state.overview.selected) }"
                :tabindex="hasCacheDetails(state.overview.selected) ? 0 : undefined"
                >{{ t('modelUsage.cache') }}</span
              >
            </el-tooltip>
            <span class="output-key" />{{ t('modelUsage.output') }}
          </div>
          <svg
            viewBox="0 0 800 170"
            role="img"
            :aria-label="t('modelUsage.trend')"
            preserveAspectRatio="none"
          >
            <line x1="0" y1="155" x2="800" y2="155" class="axis" />
            <g
              v-for="(bucket, index) in state.overview.buckets"
              :key="bucket.from"
              class="trend-bucket"
              tabindex="0"
              :aria-label="`${time(bucket.from)} – ${time(bucket.to)} · ${t('modelUsage.inputTokens')}: ${countDetail(bucket.inputTokens)} · ${t('modelUsage.cache')}: ${cacheLabel(bucket, true)} · ${t('modelUsage.outputTokens')}: ${countDetail(bucket.outputTokens)} · ${t('modelUsage.totalTokens')}: ${countDetail(bucket.totalTokens)}`"
              :transform="`translate(${(index * 800) / state.overview.buckets.length},0)`"
              @mouseenter="showBucket(bucket, $event)"
              @mouseleave="activeBucket = undefined"
              @focus="showBucket(bucket, $event)"
              @blur="activeBucket = undefined"
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
          <el-tooltip
            virtual-triggering
            :virtual-ref="bucketAnchor"
            :visible="!!activeBucket"
            :enterable="false"
          >
            <template v-if="activeBucket" #content>
              <div>{{ time(activeBucket.from) }} – {{ time(activeBucket.to) }}</div>
              <div>
                {{ t('modelUsage.inputTokens') }}: {{ countDetail(activeBucket.inputTokens) }}
              </div>
              <div>{{ t('modelUsage.cache') }}: {{ cacheLabel(activeBucket, true) }}</div>
              <div>{{ cacheTooltip(activeBucket) }}</div>
              <div>
                {{ t('modelUsage.outputTokens') }}: {{ countDetail(activeBucket.outputTokens) }}
              </div>
              <div>
                {{ t('modelUsage.totalTokens') }}: {{ countDetail(activeBucket.totalTokens) }}
              </div>
            </template>
          </el-tooltip>
          <div class="axis-labels">
            <span>{{ time(state.overview.buckets[0]?.from) }}</span
            ><span>{{ time(state.overview.buckets.at(-1)?.to) }}</span>
          </div>
          <details>
            <summary>{{ t('modelUsage.chartData') }}</summary>
            <el-table :data="state.overview.buckets" :empty-text="t('modelUsage.empty')"
              ><el-table-column :label="t('modelUsage.time')"
                ><template #default="{ row }"
                  >{{ time(row.from) }} – {{ time(row.to) }}</template
                ></el-table-column
              ><el-table-column
                v-for="key in tokenColumns"
                :key="key"
                :label="key === 'cacheReadTokens' ? t('modelUsage.cache') : t(`modelUsage.${key}`)"
                :min-width="key === 'cacheReadTokens' ? 170 : 110"
              >
                <template #default="{ row }">
                  <el-tooltip
                    :content="key === 'cacheReadTokens' ? cacheTooltip(row) : number(row[key])"
                    :disabled="key === 'cacheReadTokens' ? !hasCacheDetails(row) : row[key] == null"
                    :trigger="['hover', 'focus']"
                  >
                    <span
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
                  </el-tooltip>
                </template>
              </el-table-column></el-table
            >
          </details>
        </div>
        <div class="section-heading">
          <h3>{{ t('modelUsage.distribution') }}</h3>
          <el-radio-group v-model="metric" :aria-label="t('modelUsage.metric')"
            ><el-radio-button value="totalTokens">{{ t('modelUsage.tokens') }}</el-radio-button
            ><el-radio-button value="requests">{{
              t('modelUsage.requests')
            }}</el-radio-button></el-radio-group
          >
        </div>
        <div class="distributions">
          <section v-for="distribution in distributions" :key="distribution.kind">
            <h4>{{ t(`modelUsage.${distribution.kind}`) }}</h4>
            <p v-if="!distribution.groups.length" class="empty">{{ t('modelUsage.empty') }}</p>
            <ol v-else>
              <li v-for="group in distribution.groups" :key="group.key">
                <div>
                  <span>{{
                    distribution.kind === 'runners'
                      ? runnerName(group.key)
                      : group.label || t('modelUsage.unknown')
                  }}</span>
                </div>
                <div class="distribution-cache metadata">
                  {{ t('modelUsage.cache') }}
                  <el-tooltip
                    :content="cacheTooltip(group)"
                    :disabled="!hasCacheDetails(group)"
                    :trigger="['hover', 'focus']"
                  >
                    <span
                      :class="{ 'usage-count': hasCacheDetails(group) }"
                      :tabindex="hasCacheDetails(group) ? 0 : undefined"
                      >{{ cacheLabel(group, true) }}</span
                    >
                  </el-tooltip>
                  ·
                  {{
                    t(metric === 'totalTokens' ? 'modelUsage.totalTokens' : 'modelUsage.requests')
                  }}
                  <el-tooltip :content="number(group[metric])" :trigger="['hover', 'focus']">
                    <strong class="usage-count" tabindex="0">{{
                      number(group[metric], true)
                    }}</strong>
                  </el-tooltip>
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
        <div class="section-heading">
          <h3>{{ t('modelUsage.records') }}</h3>
          <span>{{ t('modelUsage.recordsHint') }}</span>
        </div>
        <div v-if="state.recordsStale" class="records-update">
          <span class="metadata">{{ t('modelUsage.recordsSnapshot') }}</span>
          <el-button link :disabled="state.loading" @click="refresh()">{{
            t('modelUsage.updateRecords')
          }}</el-button>
        </div>
        <el-table
          :data="state.records"
          :row-key="recordKey"
          :expand-row-keys="expandedRecords"
          :empty-text="t('modelUsage.empty')"
          class="records"
          :aria-busy="state.loadingPage"
          @sort-change="sortChanged"
          @expand-change="expandChanged"
        >
          <el-table-column type="expand"
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
                  ><dt>{{ t(`modelUsage.${key}`) }}</dt>
                  <dd>
                    <el-tooltip
                      v-if="key.endsWith('Tokens')"
                      :content="key === 'cacheReadTokens' ? cacheTooltip(row) : number(row[key])"
                      :disabled="
                        key === 'cacheReadTokens' ? !hasCacheDetails(row) : row[key] == null
                      "
                      :trigger="['hover', 'focus']"
                    >
                      <span
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
                    </el-tooltip>
                    <template v-else>{{ row[key] ?? t('modelUsage.unknown') }}</template>
                  </dd></template
                >
                <dt>{{ t('modelUsage.coverageLabel') }}</dt>
                <dd>
                  {{ t(`modelUsage.coverages.${row.coverage}`) }} ·
                  {{ t(`modelUsage.roles.${row.agentRole}`) }}
                </dd>
              </dl></template
            ></el-table-column
          >
          <el-table-column prop="endedAt" :label="t('modelUsage.time')" sortable min-width="180"
            ><template #default="{ row }">{{ time(row.endedAt) }}</template></el-table-column
          >
          <el-table-column prop="runner" :label="t('modelUsage.runner')" sortable min-width="110"
            ><template #default="{ row }">{{ runnerName(row.runner) }}</template></el-table-column
          >
          <el-table-column :label="t('modelUsage.model')" min-width="160"
            ><template #default="{ row }">{{
              row.actualModel ?? row.requestedModel ?? t('modelUsage.unknown')
            }}</template></el-table-column
          >
          <el-table-column :label="t('modelUsage.purpose')" min-width="100"
            ><template #default="{ row }">{{
              t(`modelUsage.purposes.${row.purpose}`)
            }}</template></el-table-column
          >
          <el-table-column
            v-for="key in tokenColumns"
            :key="key"
            :prop="key"
            :label="key === 'cacheReadTokens' ? t('modelUsage.cache') : t(`modelUsage.${key}`)"
            sortable
            :sort-method="
              (a: Record<string, unknown>, b: Record<string, unknown>) => compareCount(a, b, key)
            "
            :min-width="key === 'cacheReadTokens' ? 170 : 110"
          >
            <template #default="{ row }">
              <el-tooltip
                :content="key === 'cacheReadTokens' ? cacheTooltip(row) : number(row[key])"
                :disabled="key === 'cacheReadTokens' ? !hasCacheDetails(row) : row[key] == null"
                :trigger="['hover', 'focus']"
              >
                <span
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
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column :label="t('modelUsage.state')" min-width="105"
            ><template #default="{ row }"
              ><el-tag
                effect="plain"
                role="status"
                :aria-label="t(`modelUsage.states.${row.state}`)"
                >{{ t(`modelUsage.states.${row.state}`) }}</el-tag
              ></template
            ></el-table-column
          >
        </el-table>
        <ManagementPagination
          :page="state.page"
          :page-size="20"
          :total="Number(state.total)"
          :mobile="pagination.mobileViewport.value"
          :mobile-visible-count="state.records.length"
          :has-more="state.page < Math.ceil(Number(state.total) / 20)"
          :loading="state.loading || state.loadingPage"
          :loading-more="state.loadingPage"
          :aria-label="t('modelUsage.pagination')"
          @page="service.goToPage($event)"
          @load-more="service.loadMore($event)"
        />
      </template>
      <p v-else-if="state.failed">{{ t('modelUsage.retry') }}</p>
    </div>
  </LoadingPanel>
</template>

<style scoped>
.usage-purposes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-block: 0.5rem;
}
.usage-purposes button {
  padding: 0.25rem 0.5rem;
  border: 1px solid transparent;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-secondary);
  font: inherit;
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
  cursor: pointer;
}
.usage-purposes button:hover {
  color: var(--mar-text-primary);
  background: var(--mar-fill-muted);
}
.usage-purposes button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.usage-purposes button[aria-pressed='true'] {
  color: var(--mar-color-brand-text);
  background: var(--mar-color-brand-selected);
}

.usage {
  width: 100%;
  box-sizing: border-box;
  color: var(--mar-text-primary);
}
.usage-content {
  padding: 1rem;
}
header,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
h2 {
  margin: 0;
  font-size: var(--mar-font-size-title);
}
h3,
h4 {
  font-size: var(--mar-font-size-body);
  margin: 1rem 0 0.6rem;
}
p {
  margin: 0.5rem 0;
}
.metadata,
.empty {
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  line-height: 1.6;
}
.loading-status {
  position: absolute;
  overflow: hidden;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  margin: -1px;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
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
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0.75rem;
}
.filters :deep(.el-form-item) {
  margin-bottom: 0.5rem;
  min-width: 0;
}
.filters :deep(.el-select) {
  width: 100%;
}
.filters .custom-range {
  grid-column: 1 / -1;
  width: 100%;
  max-width: 38rem;
}
.custom-range :deep(.el-form-item__content) {
  display: block;
}
.custom-range :deep(.el-form-item__error) {
  position: static;
  line-height: 1.5;
}
.custom-range :deep(.el-date-editor) {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.section-heading > span {
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-muted);
}
.trend {
  padding: 0.5rem 0 1rem;
}
.usage-count,
.trend-bucket {
  cursor: pointer;
}
.usage-count:focus-visible,
.trend-bucket:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.bucket-hit-area {
  fill: transparent;
}
svg {
  width: 100%;
  height: 8rem;
}
.axis {
  stroke: var(--mar-border-default);
}
.input-bar {
  fill: var(--el-color-primary-light-5);
}
.output-bar {
  fill: var(--el-color-primary);
}
.cache-bar {
  fill: var(--el-color-success);
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
  background: var(--el-color-primary-light-5);
}
.output-key {
  background: var(--el-color-primary);
}
.cache-key {
  background: var(--el-color-success);
}
.axis-labels {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-muted);
}
details {
  margin-top: 0.6rem;
}
summary {
  cursor: pointer;
  color: var(--el-color-primary);
  font-size: var(--mar-font-size-meta);
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
  background: var(--el-color-primary);
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
  color: var(--mar-text-muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 640px) {
  .filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .usage-content {
    padding: 0.75rem;
  }
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
