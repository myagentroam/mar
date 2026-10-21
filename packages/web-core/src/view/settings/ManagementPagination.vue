<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';
import { MANAGEMENT_PAGE_SIZE } from '../../service/ManagementPaginationService.js';

const props = withDefaults(
  defineProps<{
    readonly total?: number;
    readonly page: number;
    readonly pageSize?: number;
    readonly mobile: boolean;
    readonly mobileVisibleCount: number;
    readonly loading?: boolean;
    readonly cursor?: { readonly hasNext: boolean };
    readonly hasMore?: boolean | undefined;
  }>(),
  { total: 0, pageSize: MANAGEMENT_PAGE_SIZE, loading: false, hasMore: undefined }
);
const emit = defineEmits<{
  page: [value: number];
  loadMore: [automatic?: boolean];
}>();
const hasMore = computed(() => props.hasMore ?? props.mobileVisibleCount < props.total);
const cursorPagination = computed(() => props.cursor !== undefined);
const sentinel = ref<HTMLElement>();
let observer: IntersectionObserver | undefined;
let triggered = false;

function observe(): void {
  observer?.disconnect();
  if (cursorPagination.value || !props.mobile || !hasMore.value || sentinel.value === undefined)
    return;
  observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting || props.loading || triggered) return;
    triggered = true;
    emit('loadMore', true);
  });
  observer.observe(sentinel.value);
}

watch(
  () => [
    props.mobile,
    props.mobileVisibleCount,
    props.total,
    props.hasMore,
    props.loading,
    cursorPagination.value
  ],
  async () => {
    if (!props.loading) triggered = false;
    await nextTick();
    observe();
  }
);
onMounted(observe);
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div :class="['management-pagination', { 'is-desktop': cursorPagination || !mobile }]">
    <el-pagination
      v-if="cursorPagination || !mobile"
      :current-page="page"
      :page-size="pageSize"
      :total="cursorPagination ? undefined : total"
      :page-count="cursorPagination ? page + (cursor?.hasNext ? 1 : 0) : undefined"
      :disabled="loading"
      :layout="cursorPagination ? 'prev, pager, next' : 'total, prev, pager, next'"
      background
      @current-change="emit('page', $event)"
    />
    <div v-else-if="total > pageSize" class="management-mobile-status">
      <span ref="sentinel" aria-hidden="true" />
      <el-button v-if="hasMore" link :disabled="loading" @click="emit('loadMore', false)">
        {{ loading ? translate('common.loading') : translate('common.loadMore') }}
      </el-button>
      <span v-else>{{ translate('common.noMore') }}</span>
    </div>
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
</style>
