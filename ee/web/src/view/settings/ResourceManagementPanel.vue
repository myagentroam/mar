<script setup lang="ts">
import { marIcon } from '@myagentroam/web-core/icons';
import { computed, ref } from 'vue';
import type { NodeSummary } from '@myagentroam/web-core/node-model';
import CorePanel from '@myagentroam/web-core/ResourceManagementPanel.vue';
import NodeDetailsDialogs from './NodeDetailsDialogs.vue';
import ResourceManagementFilters from './ResourceManagementFilters.vue';
import ResourceGrantExtension from './ResourceGrantExtension.vue';
import {
  createResourceOwnershipService,
  type EnterpriseResourceRow
} from '@/service/resource-ownership-service';
import { createResourceHostingService } from '@/service/resource-hosting-service';
import { translate } from '@/service/locale-preference-service';
const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  writable: boolean;
  nodes?: readonly NodeSummary[] | undefined;
  nodeUpgradeProgress?:
    Readonly<Record<string, NonNullable<NodeSummary['upgradeProgress']> | null>> | undefined;
  resourceType: 'NODE' | 'WORKSPACE';
  edition: 'COMMUNITY' | 'ENTERPRISE';
  role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
}>();
const emit = defineEmits<{ changed: [] }>();
const ownership = createResourceOwnershipService(props.request, () => props);
const hosting = createResourceHostingService(props.request, () => props);
const {
  organizations,
  users,
  organizationOptions,
  registrationOwnerOptions,
  ownerUserOptions,
  ownerType,
  ownerOrganizationId,
  ownerUserId,
  registrationOwner,
  editOrganizationId
} = ownership;
const enterpriseAdmin = computed(() => props.edition === 'ENTERPRISE' && props.role === 'ADMIN');
const grants = ref<InstanceType<typeof ResourceGrantExtension>>();
function detailsExtension(
  row: EnterpriseResourceRow | undefined,
  update: (transform: (row: EnterpriseResourceRow) => EnterpriseResourceRow) => void
) {
  return {
    ownership: row?.ownership,
    hosting: hosting.describe(row),
    hostingCapability: row?.capabilities?.conversationHosting,
    onEnableHosting: () => hosting.enable(row, update),
    onDisableHosting: () => hosting.disable(row, update)
  };
}
</script>
<template>
  <CorePanel
    :request="request"
    :writable="writable"
    :nodes="nodes"
    :node-upgrade-progress="nodeUpgradeProgress"
    :resource-type="resourceType"
    :resource-path="enterpriseAdmin ? '/api/resources?management=all' : '/api/resources'"
    :node-path="enterpriseAdmin ? '/api/management/nodes' : '/api/nodes'"
    :load-extension="ownership.load"
    :query-extension="{ ownerType: ownerType || undefined, ownerOrganizationId, ownerUserId }"
    :ownership-type-label="ownership.typeLabel"
    :ownership-type-tag="ownership.typeTag"
    :owner-label="ownership.label"
    :prepare-edit="ownership.prepareEdit"
    :resource-edit-body="ownership.editBody"
    :registration-body="ownership.registrationBody"
    :details-component="NodeDetailsDialogs"
    :details-extension="detailsExtension"
    @changed="emit('changed')"
  >
    <template #filters="{ keyword, status, setKeyword, setStatus }"
      ><ResourceManagementFilters
        :keyword="keyword"
        :status="status"
        @update:keyword="setKeyword"
        @update:status="setStatus"
        v-model:owner-type="ownerType"
        v-model:owner-organization-id="ownerOrganizationId"
        v-model:owner-user-id="ownerUserId"
        :resource-type="resourceType"
        :organization-options="organizationOptions"
        :user-options="ownerUserOptions"
    /></template>
    <template #edit-owner="{ resource: editing }">
      <el-form-item :label="translate('generated.resourceSharingPage.owner2')"
        ><el-input
          v-if="editing.ownership.ownerType === 'PERSONAL'"
          :model-value="translate('generated.resourceSharingPage.personal3')"
          disabled />
        <el-cascader
          v-else
          v-model="editOrganizationId"
          style="width: 100%"
          filterable
          :placeholder="translate('generated.resourceSharingPage.selectAnOrganization')"
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
      /></el-form-item>
    </template>
    <template #registration-owner>
      <el-form-item :label="translate('generated.resourceSharingPage.owner4')"
        ><el-input
          v-if="edition === 'COMMUNITY'"
          :model-value="translate('generated.resourceSharingPage.personal4')"
          disabled />
        <el-cascader
          v-else
          v-model="registrationOwner"
          style="width: 100%"
          filterable
          :placeholder="translate('generated.resourceSharingPage.selectAnOwner')"
          :options="registrationOwnerOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
      /></el-form-item>
    </template>
    <template #resource-actions="{ resource: row }">
      <el-button
        v-if="row.ownership.ownerType === 'ORGANIZATION'"
        link
        :icon="marIcon('share')"
        :disabled="!writable"
        @click="grants?.open(row)"
        >{{ translate('common.grant') }}</el-button
      >
    </template>
    <template #extensions
      ><ResourceGrantExtension
        ref="grants"
        :request="request"
        :writable="writable"
        :organizations="organizations"
        :users="users"
    /></template>
  </CorePanel>
</template>
