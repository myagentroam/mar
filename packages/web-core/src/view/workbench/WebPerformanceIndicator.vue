<script setup lang="ts">
import { formatDateTime } from '../../util/time-presentation.js';
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { CopyDocument } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import type { createWebPerformanceDiagnostics } from '../../service/WebPerformanceDiagnosticService.js';
import MarIcon from '../common/MarIcon.vue';

const props = defineProps<{
  readonly diagnostics: ReturnType<typeof createWebPerformanceDiagnostics>;
}>();
const { t, locale } = useI18n();
const snapshot = props.diagnostics.snapshot;

const categoryOrder = [
  'run',
  'conversation',
  'watch',
  'notification',
  'queue',
  'workspace',
  'session',
  'node',
  'control',
  'other'
] as const;
const visibleCategories = computed(() =>
  categoryOrder
    .map((category) => ({ category, count: snapshot.value.categories[category] ?? 0 }))
    .filter((entry) => entry.count > 0)
);
const healthLabel = computed(() => t(`performanceDiagnostics.health.${snapshot.value.health}`));
const connectionLabel = computed(() =>
  t(`performanceDiagnostics.connection.${snapshot.value.connectionState}`)
);

function decimal(value: number): string {
  return new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(value);
}

function memoryLabel(): string {
  const heap = snapshot.value.heap;
  if (heap === undefined) return t('common.unavailable');
  return t('performanceDiagnostics.heapValue', {
    used: decimal(heap.usedBytes / 1_048_576),
    limit: decimal(heap.limitBytes / 1_048_576),
    percentage: decimal(heap.limitBytes <= 0 ? 0 : (heap.usedBytes / heap.limitBytes) * 100)
  });
}

function pingLatencyLabel(): string {
  const value = snapshot.value.pingLatencyMs;
  return value === undefined
    ? t('common.unavailable')
    : t('performanceDiagnostics.pingLatencyValue', { duration: decimal(value) });
}

function lastMessageLabel(): string {
  if (snapshot.value.lastMessageAt === undefined) return t('common.unavailable');
  return formatDateTime(snapshot.value.lastMessageAt);
}

async function copyDiagnostics(): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(props.diagnostics.detail(), null, 2));
    ElMessage.info(t('performanceDiagnostics.copySucceeded'));
  } catch {
    ElMessage.error(t('performanceDiagnostics.copyFailed'));
  }
}

onMounted(props.diagnostics.start);
onBeforeUnmount(props.diagnostics.dispose);
</script>

<template>
  <el-popover placement="right-end" trigger="hover" :width="320" :show-after="180" :hide-after="80">
    <template #reference>
      <button
        class="web-performance-indicator"
        type="button"
        :aria-label="t('performanceDiagnostics.title')"
        :title="t('performanceDiagnostics.title')"
      >
        <el-icon aria-hidden="true"><MarIcon name="info" /></el-icon>
      </button>
    </template>
    <section class="web-performance-panel" :aria-label="t('performanceDiagnostics.title')">
      <header>
        <strong>{{ t('performanceDiagnostics.title') }}</strong>
        <div class="panel-heading-actions">
          <span :class="`is-${snapshot.health}`">{{ healthLabel }}</span>
          <el-button
            link
            :aria-label="t('performanceDiagnostics.copy')"
            :title="t('performanceDiagnostics.copy')"
            @click="copyDiagnostics"
          >
            <el-icon><CopyDocument /></el-icon>
          </el-button>
        </div>
      </header>
      <dl>
        <dt>{{ t('performanceDiagnostics.connectionLabel') }}</dt>
        <dd>{{ connectionLabel }}</dd>
        <dt>{{ t('performanceDiagnostics.pingLatency') }}</dt>
        <dd>{{ pingLatencyLabel() }}</dd>
        <dt>{{ t('performanceDiagnostics.lastMessage') }}</dt>
        <dd>{{ lastMessageLabel() }}</dd>
        <dt>{{ t('performanceDiagnostics.messageRate') }}</dt>
        <dd>
          {{
            t('performanceDiagnostics.rateValue', {
              current: snapshot.messagesPerSecond,
              peak: snapshot.peakMessagesPerSecond,
              kilobytes: decimal(snapshot.kilobytesPerSecond)
            })
          }}
        </dd>
        <dt>{{ t('performanceDiagnostics.categories') }}</dt>
        <dd class="category-values">
          <template v-if="visibleCategories.length">
            <span v-for="entry in visibleCategories" :key="entry.category">
              {{ t(`performanceDiagnostics.category.${entry.category}`) }} {{ entry.count }}/s
            </span>
          </template>
          <span v-else>{{ t('performanceDiagnostics.noRealtimeMessages') }}</span>
        </dd>
        <dt>{{ t('performanceDiagnostics.activeRunSessions') }}</dt>
        <dd>{{ snapshot.activeRunSessions }}</dd>
        <dt>{{ t('performanceDiagnostics.processing') }}</dt>
        <dd>
          {{
            t('performanceDiagnostics.processingValue', {
              average: decimal(snapshot.processing.averageMs),
              p95: decimal(snapshot.processing.p95Ms),
              maximum: decimal(snapshot.processing.maxMs)
            })
          }}
        </dd>
        <dt>{{ t('performanceDiagnostics.longTasks') }}</dt>
        <dd>
          {{
            snapshot.longTasks.available
              ? t('performanceDiagnostics.longTaskValue', {
                  count: snapshot.longTasks.count,
                  duration: decimal(snapshot.longTasks.totalDurationMs)
                })
              : t('common.unavailable')
          }}
        </dd>
        <dt>{{ t('performanceDiagnostics.mainThreadDelay') }}</dt>
        <dd>{{ decimal(snapshot.eventLoopDelayMs) }} ms</dd>
        <dt>{{ t('performanceDiagnostics.pageScale') }}</dt>
        <dd>
          {{
            t('performanceDiagnostics.pageScaleValue', {
              dom: snapshot.domNodes,
              messages: snapshot.messageCards
            })
          }}
        </dd>
        <dt>{{ t('performanceDiagnostics.jsHeap') }}</dt>
        <dd>{{ memoryLabel() }}</dd>
      </dl>
      <p>{{ t('performanceDiagnostics.scopeHint') }}</p>
    </section>
  </el-popover>
</template>

<style scoped>
.web-performance-indicator {
  position: absolute;
  left: 50%;
  bottom: 8px;
  width: 36px;
  min-width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--mar-text-secondary);
  padding: 3px;
  cursor: pointer;
  line-height: 1;
  transform: translateX(-50%);
}
.web-performance-indicator:hover,
.web-performance-indicator:focus-visible {
  background: transparent;
  color: var(--mar-color-brand);
  outline: none;
}
.web-performance-indicator .el-icon {
  transition:
    color 0.15s ease,
    transform 0.15s ease;
  font-size: 0.95rem;
}
.web-performance-indicator:hover .el-icon,
.web-performance-indicator:focus-visible .el-icon {
  transform: scale(1.12);
}
.web-performance-panel {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
}
.web-performance-panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--mar-border-medium);
  padding-bottom: 0.45rem;
}
.web-performance-panel header span {
  color: var(--mar-text-tertiary);
}
.web-performance-panel header span.is-healthy {
  color: var(--mar-color-success-text);
}
.web-performance-panel header span.is-warning {
  color: var(--mar-color-warning-text);
}
.web-performance-panel header span.is-critical {
  color: var(--mar-color-danger-text);
}
.panel-heading-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.web-performance-panel dl {
  display: grid;
  grid-template-columns: 6.3rem minmax(0, 1fr);
  margin: 0;
}
.web-performance-panel dt,
.web-performance-panel dd {
  min-width: 0;
  margin: 0;
  border-bottom: 1px solid var(--mar-border-medium);
  padding: 0.4rem 0;
}
.web-performance-panel dt {
  color: var(--mar-text-tertiary);
}
.web-performance-panel dd {
  overflow-wrap: anywhere;
}
.category-values {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.55rem;
}
.web-performance-panel p {
  margin: 0.5rem 0 0;
  color: var(--mar-text-tertiary);
  line-height: 1.45;
}
</style>
