<script setup lang="ts">
import { MarCascader } from '@myagentroam/mar-ui/cascader';
import { MarFormItem, type FormRules } from '@myagentroam/mar-ui/form';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';
import { marIcon } from '@myagentroam/web-core/icons';
import { computed } from 'vue';
import CorePage from '@myagentroam/web-core/SkillSourceManagementPage.vue';
import { createSkillCatalogSubmissions } from '@/service/skill-center-service';
import { createCatalogOwnershipService } from '@/service/catalog-ownership-service';
import { translate } from '@/service/locale-preference-service';
const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  edition: 'COMMUNITY' | 'ENTERPRISE';
  role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
  writable: boolean;
}>();
const ownership = createCatalogOwnershipService(props.request, () => props);
const { sourceDraft, catalogDraft, organizationOptions, canUseOrganizationScope } = ownership;
const ownershipRules = computed<FormRules>(() => ({
  organizationId: [
    {
      required: true,
      message: translate('generated.skillSourceManagementPage.selectAnOrganization'),
      trigger: 'change'
    }
  ]
}));
function scopeLabel(scope: string): string {
  return scope === 'ENTERPRISE'
    ? translate('generated.skillSourceManagementPage.enterprise')
    : scope === 'ORGANIZATION'
      ? translate('generated.skillSourceManagementPage.organization')
      : translate('generated.skillSourceManagementPage.personal');
}
const submissions = createSkillCatalogSubmissions(props.request);
const submitSource = (input: Parameters<typeof submissions.submitSource>[0]) =>
  submissions.submitSource(input, ownership.sourceTarget());
const submitFavorite = (input: Parameters<typeof submissions.submitFavorite>[0]) =>
  submissions.submitFavorite(input, ownership.catalogTarget());
</script>
<template>
  <CorePage
    :request="request"
    :writable="writable"
    :scope-label="scopeLabel"
    :load-extension="ownership.load"
    :source-context="sourceDraft"
    :catalog-context="catalogDraft"
    :ownership-rules="ownershipRules"
    :submit-source="submitSource"
    :submit-favorite="submitFavorite"
    @open-source="ownership.resetSource"
    @open-catalog="ownership.resetCatalog"
  >
    <template #source-ownership>
      <MarFormItem :label="translate('generated.skillSourceManagementPage.scope2')" prop="scope"
        ><MarSelect
          v-model="sourceDraft.scope"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><MarOption
            :label="translate('generated.skillSourceManagementPage.personal2')"
            value="PERSONAL" /><MarOption
            v-if="canUseOrganizationScope"
            :label="translate('generated.skillSourceManagementPage.organization2')"
            value="ORGANIZATION" /></MarSelect
      ></MarFormItem>
      <MarFormItem
        v-if="sourceDraft.scope === 'ORGANIZATION'"
        :label="translate('generated.skillSourceManagementPage.organization3')"
        prop="organizationId"
        ><MarCascader
          v-model="sourceDraft.organizationId"
          style="width: 100%"
          filterable
          :placeholder="
            translate('generated.skillSourceManagementPage.selectAManageableOrganization')
          "
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
      /></MarFormItem>
    </template>
    <template #catalog-ownership>
      <MarFormItem
        :label="translate('generated.skillSourceManagementPage.availability')"
        prop="scope"
        ><MarSelect
          v-model="catalogDraft.scope"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><MarOption
            :label="translate('generated.skillSourceManagementPage.personal3')"
            value="PERSONAL" /><MarOption
            v-if="canUseOrganizationScope"
            :label="translate('generated.skillSourceManagementPage.organizationMembers')"
            value="ORGANIZATION" /></MarSelect
      ></MarFormItem>
      <MarFormItem
        v-if="catalogDraft.scope === 'ORGANIZATION'"
        :label="translate('generated.skillSourceManagementPage.organization4')"
        prop="organizationId"
        ><MarCascader
          v-model="catalogDraft.organizationId"
          style="width: 100%"
          filterable
          :placeholder="
            translate('generated.skillSourceManagementPage.selectAManageableOrganization2')
          "
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
      /></MarFormItem>
    </template>
  </CorePage>
</template>
