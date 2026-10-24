<script setup lang="ts">
import { marIcon } from '@myagentroam/web-core/icons';
import type { OrganizationCascaderOption } from '@/service/enterprise-management-service';
import { translate } from '@/service/locale-preference-service';

defineProps<{
  resourceType: 'NODE' | 'WORKSPACE';
  organizationOptions: readonly OrganizationCascaderOption[];
  userOptions: readonly { readonly value: number; readonly label: string }[];
}>();

const keyword = defineModel<string>('keyword', { required: true });
const ownerType = defineModel<'' | 'PERSONAL' | 'ORGANIZATION'>('ownerType', { required: true });
const ownerOrganizationId = defineModel<number | undefined>('ownerOrganizationId');
const ownerUserId = defineModel<number | undefined>('ownerUserId');
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
        :clear-icon="marIcon('clear-input')"
      />
    </label>
    <label class="filter-field">
      <span>{{ translate('generated.resourceSharingPage.ownerType') }}</span>
      <el-select
        v-model="ownerType"
        :aria-label="translate('generated.resourceSharingPage.ownerType')"
        clearable
        :placeholder="translate('generated.resourceSharingPage.selectAnOwnerType')"
        :clear-icon="marIcon('clear-input')"
        :suffix-icon="marIcon('chevron-down')"
      >
        <el-option :label="translate('generated.resourceSharingPage.personal2')" value="PERSONAL" />
        <el-option
          :label="translate('generated.resourceSharingPage.organization')"
          value="ORGANIZATION"
        />
      </el-select>
    </label>
    <label v-if="ownerType === 'ORGANIZATION'" class="filter-field">
      <span>{{ translate('generated.resourceSharingPage.organization2') }}</span>
      <el-cascader
        v-model="ownerOrganizationId"
        :aria-label="translate('generated.resourceSharingPage.organization2')"
        clearable
        filterable
        :placeholder="translate('generated.resourceSharingPage.selectAnOwnerOrganization')"
        :options="organizationOptions"
        :props="{ checkStrictly: true, emitPath: false }"
        :clear-icon="marIcon('clear-input')"
      />
    </label>
    <label v-if="ownerType === 'PERSONAL'" class="filter-field">
      <span>{{ translate('generated.resourceSharingPage.user') }}</span>
      <el-select
        v-model="ownerUserId"
        :aria-label="translate('generated.resourceSharingPage.user')"
        clearable
        filterable
        :placeholder="translate('generated.resourceSharingPage.selectAnOwner')"
        :clear-icon="marIcon('clear-input')"
        :suffix-icon="marIcon('chevron-down')"
      >
        <el-option
          v-for="user in userOptions"
          :key="user.value"
          :label="user.label"
          :value="user.value"
        />
      </el-select>
    </label>
    <label v-if="resourceType === 'NODE'" class="filter-field">
      <span>{{ translate('generated.resourceSharingPage.status') }}</span>
      <el-select
        v-model="status"
        :aria-label="translate('generated.resourceSharingPage.status')"
        clearable
        :placeholder="translate('generated.resourceSharingPage.selectAStatus')"
        :clear-icon="marIcon('clear-input')"
        :suffix-icon="marIcon('chevron-down')"
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
