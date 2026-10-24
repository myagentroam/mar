<script setup lang="ts">
import { marIcon } from '@myagentroam/web-core/icons';
import { computed, onMounted, ref } from 'vue';
import type { MarAgentModelSummary } from '@myagentroam/protocol';
import type { NodeSummary } from '@/model/workbench';
import CorePage from '@myagentroam/web-core/MarAgentModelManagementPage.vue';
import ModelGrantExtension from './ModelGrantExtension.vue';
import { createModelCredentialOwnershipService } from '@/service/model-credential-ownership-service';
import { translate } from '@/service/locale-preference-service';
const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  writable: boolean;
  nodes: readonly NodeSummary[];
  edition: 'COMMUNITY' | 'ENTERPRISE';
  role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
  organizationId: number | null;
}>();
const canManageModels = computed(() => props.edition === 'COMMUNITY' || props.role !== null);
const ownership = createModelCredentialOwnershipService(props.request, () => props);
const modelOwnership = createModelCredentialOwnershipService(props.request, () => props, 'MODEL');
const catalogOwnership = createModelCredentialOwnershipService(props.request, () => props, 'MODEL');
const canSelectOrganization = computed(
  () => props.edition === 'ENTERPRISE' && (props.role === 'ADMIN' || props.role === 'ORG_ADMIN')
);
async function prepareCatalog(): Promise<void> {
  await catalogOwnership.prepare();
}
const { draft: credentialDraft, organizationOptions } = ownership;
onMounted(() => {
  void ownership.loadOrganizations();
});
const grants = ref<InstanceType<typeof ModelGrantExtension>>();
function accessLabel(access: MarAgentModelSummary['access']): string {
  return translate(access === 'PUBLIC' ? 'marAgentModels.public' : 'marAgentModels.restricted');
}
</script>
<template>
  <CorePage
    :request="request"
    :writable="writable"
    :nodes="nodes"
    :can-manage-models="canManageModels"
    :can-manage-compact="edition === 'COMMUNITY' || role === 'ADMIN'"
    :compact-preferred-organization-id="organizationOptions[0]?.value"
    :model-context="modelOwnership.draft"
    :model-ownership-rules="modelOwnership.rules.value"
    :prepare-model="modelOwnership.prepare"
    :model-ownership="modelOwnership.serializeModel"
    :catalog-context="catalogOwnership.draft"
    :catalog-ownership-rules="catalogOwnership.rules.value"
    :prepare-catalog="prepareCatalog"
    :catalog-ownership="catalogOwnership.serializeModel"
    :credential-context="credentialDraft"
    :credential-ownership-rules="ownership.rules.value"
    :prepare-credential="ownership.prepare"
    :credential-ownership="ownership.serialize"
    :credential-scope-label="ownership.label"
  >
    <template #model-ownership="{ editing }">
      <el-form-item :label="translate('marAgentModels.modelOwnership')">
        <el-select
          v-model="modelOwnership.draft.ownerType"
          :disabled="editing"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            :label="translate('marAgentModels.codexCredentialScopePersonal')"
            value="PERSONAL"
          />
          <el-option
            v-if="canSelectOrganization || modelOwnership.draft.ownerType === 'ORGANIZATION'"
            :label="translate('marAgentModels.codexCredentialScopeOrganizationOption')"
            value="ORGANIZATION"
          />
        </el-select>
      </el-form-item>
      <el-form-item
        v-if="modelOwnership.draft.ownerType === 'ORGANIZATION'"
        :label="translate('marAgentModels.organization')"
        prop="ownerOrganizationId"
      >
        <el-cascader
          v-model="modelOwnership.draft.ownerOrganizationId"
          :disabled="editing"
          style="width: 100%"
          filterable
          :options="modelOwnership.organizationOptions.value"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
        />
      </el-form-item>
      <p v-if="!editing" class="ownership-hint">
        {{ translate('marAgentModels.modelOwnershipHint') }}
      </p>
    </template>
    <template #catalog-ownership>
      <el-form-item :label="translate('marAgentModels.modelOwnership')">
        <el-select
          v-model="catalogOwnership.draft.ownerType"
          :disabled="!writable"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            :label="translate('marAgentModels.codexCredentialScopePersonal')"
            value="PERSONAL"
          />
          <el-option
            v-if="canSelectOrganization"
            :label="translate('marAgentModels.codexCredentialScopeOrganizationOption')"
            value="ORGANIZATION"
          />
        </el-select>
      </el-form-item>
      <el-form-item
        v-if="catalogOwnership.draft.ownerType === 'ORGANIZATION'"
        :label="translate('marAgentModels.organization')"
        prop="ownerOrganizationId"
      >
        <el-cascader
          v-model="catalogOwnership.draft.ownerOrganizationId"
          :disabled="!writable"
          style="width: 100%"
          filterable
          :options="catalogOwnership.organizationOptions.value"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
        />
      </el-form-item>
      <p class="ownership-hint">{{ translate('marAgentModels.modelOwnershipHint') }}</p>
    </template>
    <template #credential-ownership>
      <el-form-item :label="translate('marAgentModels.codexCredentialScope')">
        <el-select
          v-model="credentialDraft.ownerType"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            :label="translate('marAgentModels.codexCredentialScopePersonal')"
            value="PERSONAL"
          />
          <el-option
            v-if="edition === 'ENTERPRISE' && (role === 'ADMIN' || role === 'ORG_ADMIN')"
            :label="translate('marAgentModels.codexCredentialScopeOrganizationOption')"
            value="ORGANIZATION"
          />
        </el-select>
      </el-form-item>
      <el-form-item
        v-if="credentialDraft.ownerType === 'ORGANIZATION'"
        :label="translate('marAgentModels.organization')"
        prop="ownerOrganizationId"
      >
        <el-cascader
          v-model="credentialDraft.ownerOrganizationId"
          style="width: 100%"
          filterable
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
        />
      </el-form-item>
    </template>
    <template #model-access-column>
      <el-table-column :label="translate('marAgentModels.access')" width="110">
        <template #default="{ row }">
          <el-tag :type="row.access === 'PUBLIC' ? 'success' : 'warning'" effect="plain">{{
            accessLabel(row.access)
          }}</el-tag>
        </template>
      </el-table-column>
    </template>
    <template #model-actions="{ model }"
      ><el-button
        v-if="model.ownership?.ownerType !== 'PERSONAL'"
        link
        :icon="marIcon('share')"
        @click="grants?.open(model)"
        >{{ translate('common.grant') }}</el-button
      ></template
    >
    <template #model-access-details="{ model }">
      <el-descriptions-item
        v-if="model.ownership"
        :label="translate('marAgentModels.modelOwnership')"
      >
        {{ ownership.label(model.ownership) }}
      </el-descriptions-item>
      <el-descriptions-item :label="translate('marAgentModels.access')">
        <el-tag :type="model.access === 'PUBLIC' ? 'success' : 'warning'" effect="plain">{{
          accessLabel(model.access)
        }}</el-tag>
      </el-descriptions-item>
    </template>
    <template #model-extensions="{ refresh }"
      ><ModelGrantExtension ref="grants" :request="request" :writable="writable" :refresh="refresh"
    /></template>
  </CorePage>
</template>

<style scoped>
.ownership-hint {
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-body);
  margin: 0 0 1rem;
}
</style>
