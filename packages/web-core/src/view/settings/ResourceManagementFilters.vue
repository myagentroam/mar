<script setup lang="ts">
import { translate } from '../../service/LocalePreferenceService';

defineProps<{
  resourceType: 'NODE' | 'WORKSPACE';
}>();

const keyword = defineModel<string>('keyword', { required: true });
const status = defineModel<'' | 'online' | 'offline' | 'disabled'>('status', { required: true });
</script>

<template>
  <div class="resource-filters">
    <label class="filter-field">
      <span>{{
        resourceType === 'NODE'
          ? translate('generated.resourceSharingPage.node5')
          : translate('generated.resourceSharingPage.workspace4')
      }}</span>
      <el-input
        v-model="keyword"
        :aria-label="translate('generated.resourceSharingPage.keyword')"
        clearable
        :placeholder="translate('generated.resourceSharingPage.enterANameOrID')"
      />
    </label>
    <label v-if="resourceType === 'NODE'" class="filter-field">
      <span>{{ translate('generated.resourceSharingPage.status') }}</span>
      <el-select
        v-model="status"
        :aria-label="translate('generated.resourceSharingPage.status')"
        clearable
        :placeholder="translate('generated.resourceSharingPage.selectAStatus')"
      >
        <el-option :label="translate('generated.resourceSharingPage.online2')" value="online" />
        <el-option :label="translate('generated.resourceSharingPage.offline2')" value="offline" />
        <el-option :label="translate('generated.resourceSharingPage.disabled2')" value="disabled" />
      </el-select>
    </label>
  </div>
</template>

<style scoped>
.resource-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-block: 1px solid var(--mar-border-subtle);
}

.resource-filters > .filter-field {
  width: 260px;
  min-width: 0;
  flex: 0 0 260px;
}

.resource-filters > .filter-field > :last-child {
  min-width: 0;
  width: auto;
  flex: 1 1 auto;
}

@media (max-width: 767px) {
  .resource-filters > .filter-field {
    width: 100%;
    flex-basis: 100%;
  }
}
</style>
