<script setup lang="ts">
import { MarCascader } from '@myagentroam/mar-ui/cascader';
import { MarDescriptionsItem } from '@myagentroam/mar-ui/descriptions';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarTableColumn } from '@myagentroam/mar-ui/table';
import { MarFormItem } from '@myagentroam/mar-ui/form';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';
import { MarButton } from '@myagentroam/mar-ui/button';
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
      <MarFormItem :label="translate('marAgentModels.modelOwnership')">
        <MarSelect
          v-model="modelOwnership.draft.ownerType"
          :disabled="editing"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <MarOption
            :label="translate('marAgentModels.codexCredentialScopePersonal')"
            value="PERSONAL"
          />
          <MarOption
            v-if="canSelectOrganization || modelOwnership.draft.ownerType === 'ORGANIZATION'"
            :label="translate('marAgentModels.codexCredentialScopeOrganizationOption')"
            value="ORGANIZATION"
          />
        </MarSelect>
      </MarFormItem>
      <MarFormItem
        v-if="modelOwnership.draft.ownerType === 'ORGANIZATION'"
        :label="translate('marAgentModels.organization')"
        prop="ownerOrganizationId"
      >
        <MarCascader
          v-model="modelOwnership.draft.ownerOrganizationId"
          :disabled="editing"
          style="width: 100%"
          filterable
          :options="modelOwnership.organizationOptions.value"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
        />
      </MarFormItem>
      <p v-if="!editing" class="ownership-hint">
        {{ translate('marAgentModels.modelOwnershipHint') }}
      </p>
    </template>
    <template #catalog-ownership>
      <MarFormItem :label="translate('marAgentModels.modelOwnership')">
        <MarSelect
          v-model="catalogOwnership.draft.ownerType"
          :disabled="!writable"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <MarOption
            :label="translate('marAgentModels.codexCredentialScopePersonal')"
            value="PERSONAL"
          />
          <MarOption
            v-if="canSelectOrganization"
            :label="translate('marAgentModels.codexCredentialScopeOrganizationOption')"
            value="ORGANIZATION"
          />
        </MarSelect>
      </MarFormItem>
      <MarFormItem
        v-if="catalogOwnership.draft.ownerType === 'ORGANIZATION'"
        :label="translate('marAgentModels.organization')"
        prop="ownerOrganizationId"
      >
        <MarCascader
          v-model="catalogOwnership.draft.ownerOrganizationId"
          :disabled="!writable"
          style="width: 100%"
          filterable
          :options="catalogOwnership.organizationOptions.value"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
        />
      </MarFormItem>
      <p class="ownership-hint">{{ translate('marAgentModels.modelOwnershipHint') }}</p>
    </template>
    <template #credential-ownership>
      <MarFormItem :label="translate('marAgentModels.codexCredentialScope')">
        <MarSelect
          v-model="credentialDraft.ownerType"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <MarOption
            :label="translate('marAgentModels.codexCredentialScopePersonal')"
            value="PERSONAL"
          />
          <MarOption
            v-if="edition === 'ENTERPRISE' && (role === 'ADMIN' || role === 'ORG_ADMIN')"
            :label="translate('marAgentModels.codexCredentialScopeOrganizationOption')"
            value="ORGANIZATION"
          />
        </MarSelect>
      </MarFormItem>
      <MarFormItem
        v-if="credentialDraft.ownerType === 'ORGANIZATION'"
        :label="translate('marAgentModels.organization')"
        prop="ownerOrganizationId"
      >
        <MarCascader
          v-model="credentialDraft.ownerOrganizationId"
          style="width: 100%"
          filterable
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
        />
      </MarFormItem>
    </template>
    <template #model-access-column>
      <MarTableColumn :label="translate('marAgentModels.access')" width="110">
        <template #default="{ row }">
          <MarTag :type="row.access === 'PUBLIC' ? 'success' : 'warning'" effect="plain">{{
            accessLabel(row.access)
          }}</MarTag>
        </template>
      </MarTableColumn>
    </template>
    <template #model-actions="{ model }"
      ><MarButton
        v-if="model.ownership?.ownerType !== 'PERSONAL'"
        link
        :icon="marIcon('share')"
        @click="grants?.open(model)"
        >{{ translate('common.grant') }}</MarButton
      ></template
    >
    <template #model-access-details="{ model }">
      <MarDescriptionsItem
        v-if="model.ownership"
        :label="translate('marAgentModels.modelOwnership')"
      >
        {{ ownership.label(model.ownership) }}
      </MarDescriptionsItem>
      <MarDescriptionsItem :label="translate('marAgentModels.access')">
        <MarTag :type="model.access === 'PUBLIC' ? 'success' : 'warning'" effect="plain">{{
          accessLabel(model.access)
        }}</MarTag>
      </MarDescriptionsItem>
    </template>
    <template #model-extensions="{ refresh }"
      ><ModelGrantExtension ref="grants" :request="request" :writable="writable" :refresh="refresh"
    /></template>
  </CorePage>
</template>

<style scoped>
.ownership-hint {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  margin: 0 0 1rem;
}
</style>
