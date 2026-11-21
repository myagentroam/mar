<script setup lang="ts">
import { MarOption, MarSelect } from '@myagentroam/mar-ui/select';
import { MarInput } from '@myagentroam/mar-ui/input';
import { marIcon } from '@myagentroam/mar-ui/icons';
import { translate } from '../../service/locale-preference-service';

defineProps<{
  resourceType: 'NODE' | 'WORKSPACE';
}>();

const keyword = defineModel<string>('keyword', { required: true });
const status = defineModel<'' | 'online' | 'offline' | 'disabled'>('status', { required: true });
</script>

<template>
  <div class="mar-resource-filters">
    <label class="mar-filter-field">
      <span>{{
        resourceType === 'NODE'
          ? translate('generated.resourceSharingPage.node5')
          : translate('generated.resourceSharingPage.workspace4')
      }}</span>
      <MarInput
        v-model="keyword"
        :aria-label="translate('generated.resourceSharingPage.keyword')"
        clearable
        :placeholder="translate('generated.resourceSharingPage.enterANameOrID')"
        :clear-icon="marIcon('clear-input')"
      />
    </label>
    <label v-if="resourceType === 'NODE'" class="mar-filter-field">
      <span>{{ translate('generated.resourceSharingPage.status') }}</span>
      <MarSelect
        v-model="status"
        :aria-label="translate('generated.resourceSharingPage.status')"
        clearable
        :placeholder="translate('generated.resourceSharingPage.selectAStatus')"
      >
        <MarOption :label="translate('generated.resourceSharingPage.online2')" value="online" />
        <MarOption :label="translate('generated.resourceSharingPage.offline2')" value="offline" />
        <MarOption :label="translate('generated.resourceSharingPage.disabled2')" value="disabled" />
      </MarSelect>
    </label>
  </div>
</template>

<style scoped>
.mar-resource-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-block: 1px solid var(--mar-border-subtle);
}

.mar-resource-filters > .mar-filter-field {
  width: 260px;
  min-width: 0;
  flex: 0 0 260px;
}

.mar-resource-filters > .mar-filter-field > :last-child {
  min-width: 0;
  width: auto;
  flex: 1 1 auto;
}

@media (max-width: 767px) {
  .mar-resource-filters > .mar-filter-field {
    width: 100%;
    flex-basis: 100%;
  }
}
</style>
