<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import { MANAGEMENT_PAGE_SIZE } from '../../service/management-pagination-service.js';
import BusyIndicator from '../common/BusyIndicator.vue';
import { errorMessage } from '../../util/error-presentation.js';

const props = withDefaults(
  defineProps<{
    readonly total?: number;
    readonly page: number;
    readonly pageSize?: number;
    readonly mobile: boolean;
    readonly mobileVisibleCount: number;
    readonly loading?: boolean;
    readonly loadingMore?: boolean;
    readonly failed?: boolean;
    readonly contextKey?: string;
    readonly error?: unknown;
    readonly hasMore: boolean;
  }>(),
  {
    total: 0,
    pageSize: MANAGEMENT_PAGE_SIZE,
    loading: false,
    loadingMore: false,
    failed: false
  }
);
const emit = defineEmits<{
  page: [value: number];
  loadMore: [automatic?: boolean];
  retry: [];
}>();
const hasMore = computed(() => props.hasMore);
const sentinel = ref<HTMLElement>();
let observer: IntersectionObserver | undefined;
let armed = true;
let visible = false;

function maybeLoad(): void {
  if (!visible || !armed || !props.mobile || !hasMore.value || props.loading || props.failed)
    return;
  armed = false;
  emit('loadMore', true);
}

function observe(): void {
  observer?.disconnect();
  visible = false;
  if (!props.mobile || sentinel.value === undefined || typeof IntersectionObserver === 'undefined')
    return;
  observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    if (!visible) {
      if (!props.loading) armed = true;
      return;
    }
    maybeLoad();
  });
  observer.observe(sentinel.value);
}

watch(() => [props.mobile, sentinel.value], observe, { flush: 'post' });
watch(
  () => [hasMore.value, props.loading, props.failed],
  () => {
    if (!hasMore.value && !props.loading) armed = true;
    if (!props.loading) observe();
  },
  { flush: 'post' }
);
watch(
  () => props.contextKey,
  () => {
    armed = true;
    maybeLoad();
  },
  { flush: 'post' }
);
onMounted(observe);
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div :class="['management-pagination', { 'is-desktop': !mobile }]">
    <el-pagination
      v-if="!mobile"
      :current-page="page"
      :page-size="pageSize"
      :total="total"
      :disabled="loading"
      layout="total, prev, pager, next"
      background
      @current-change="emit('page', $event)"
      :prev-icon="marIcon('chevron-left')"
      :next-icon="marIcon('chevron-right')"
    />
    <div v-else class="management-mobile-status">
      <span ref="sentinel" aria-hidden="true" />
      <button
        v-if="failed"
        v-tooltip="!loading && error !== undefined ? errorMessage(error) : ''"
        :aria-description="!loading && error !== undefined ? errorMessage(error) : undefined"
        type="button"
        :aria-label="loading ? translate('common.loading') : undefined"
        :aria-disabled="loading"
        :aria-busy="loading || undefined"
        @click="!loading && emit('retry')"
      >
        <BusyIndicator v-if="loading" class="read-loading-indicator" />
        <template v-else>{{ translate('common.loadFailedRetry') }}</template>
      </button>
      <span
        v-else-if="loading && loadingMore"
        class="management-mobile-loading"
        role="status"
        :aria-label="translate('common.loading')"
      >
        <BusyIndicator class="read-loading-indicator" />
      </span>
    </div>
    <button
      v-if="!mobile && failed"
      v-tooltip="!loading && error !== undefined ? errorMessage(error) : ''"
      :aria-description="!loading && error !== undefined ? errorMessage(error) : undefined"
      type="button"
      :aria-label="loading ? translate('common.loading') : undefined"
      :aria-disabled="loading"
      :aria-busy="loading || undefined"
      @click="!loading && emit('retry')"
    >
      <BusyIndicator v-if="loading" class="read-loading-indicator" />
      <template v-else>{{ translate('common.loadFailedRetry') }}</template>
    </button>
  </div>
</template>

<style scoped>
.management-pagination {
  display: flex;
  justify-content: center;
  min-height: 32px;
  padding: 4px 0;
}

.management-pagination.is-desktop {
  align-self: stretch;
  justify-content: flex-end;
  border-top: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-panel);
}

.management-mobile-status {
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  line-height: 20px;
  text-align: center;
}
.management-mobile-loading {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  color: var(--mar-color-brand-text);
}
</style>
