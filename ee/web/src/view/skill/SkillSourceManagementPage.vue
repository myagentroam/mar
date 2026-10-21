<script setup lang="ts">
import { computed } from 'vue';
import CorePage from '@myagentroam/web-core/SkillSourceManagementPage.vue';
import { createSkillCatalogSubmissions } from '@/service/SkillCenterService';
import { createCatalogOwnershipService } from '@/service/CatalogOwnershipService';
import { translate } from '@/service/LocalePreferenceService';
const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  edition: 'COMMUNITY' | 'ENTERPRISE';
  role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
  writable: boolean;
}>();
const ownership = createCatalogOwnershipService(props.request, () => props);
const { sourceDraft, catalogDraft, organizationOptions, canUseOrganizationScope } = ownership;
const ownershipRules = computed(() => ({
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
      <el-form-item :label="translate('generated.skillSourceManagementPage.scope2')" prop="scope"
        ><el-select v-model="sourceDraft.scope"
          ><el-option
            :label="translate('generated.skillSourceManagementPage.personal2')"
            value="PERSONAL" /><el-option
            v-if="canUseOrganizationScope"
            :label="translate('generated.skillSourceManagementPage.organization2')"
            value="ORGANIZATION" /></el-select
      ></el-form-item>
      <el-form-item
        v-if="sourceDraft.scope === 'ORGANIZATION'"
        :label="translate('generated.skillSourceManagementPage.organization3')"
        prop="organizationId"
        ><el-cascader
          v-model="sourceDraft.organizationId"
          style="width: 100%"
          filterable
          :placeholder="
            translate('generated.skillSourceManagementPage.selectAManageableOrganization')
          "
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
      /></el-form-item>
    </template>
    <template #catalog-ownership>
      <el-form-item
        :label="translate('generated.skillSourceManagementPage.availability')"
        prop="scope"
        ><el-select v-model="catalogDraft.scope"
          ><el-option
            :label="translate('generated.skillSourceManagementPage.personal3')"
            value="PERSONAL" /><el-option
            v-if="canUseOrganizationScope"
            :label="translate('generated.skillSourceManagementPage.organizationMembers')"
            value="ORGANIZATION" /></el-select
      ></el-form-item>
      <el-form-item
        v-if="catalogDraft.scope === 'ORGANIZATION'"
        :label="translate('generated.skillSourceManagementPage.organization4')"
        prop="organizationId"
        ><el-cascader
          v-model="catalogDraft.organizationId"
          style="width: 100%"
          filterable
          :placeholder="
            translate('generated.skillSourceManagementPage.selectAManageableOrganization2')
          "
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
      /></el-form-item>
    </template>
  </CorePage>
</template>
