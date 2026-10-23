<script setup lang="ts">
import { marIcon } from '@myagentroam/web-core/icons';
import { computed } from 'vue';
import CorePage from '@myagentroam/web-core/McpSourceManagementPage.vue';
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
      message: translate('generated.mcpSourceManagementPage.selectAnOrganization'),
      trigger: 'change'
    }
  ]
}));
function scopeLabel(scope: string): string {
  return scope === 'ENTERPRISE'
    ? translate('generated.mcpSourceManagementPage.enterprise')
    : scope === 'ORGANIZATION'
      ? translate('generated.mcpSourceManagementPage.organization')
      : translate('generated.mcpSourceManagementPage.personal');
}
async function submitSource(input: {
  readonly name: string;
  readonly locator: string;
}): Promise<unknown> {
  return props.request('/api/mcp-sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, ...ownership.sourceTarget() })
  });
}
async function submitCatalog(input: {
  readonly sourceId: string;
  readonly candidate: unknown;
  readonly featured: boolean;
  readonly tags: readonly string[];
}): Promise<unknown> {
  return props.request('/api/mcp-catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, ...ownership.catalogTarget() })
  });
}
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
    :submit-catalog="submitCatalog"
    @open-source="ownership.resetSource"
    @open-catalog="ownership.resetCatalog"
  >
    <template #source-ownership>
      <el-form-item :label="translate('generated.mcpSourceManagementPage.scope2')"
        ><el-select
          v-model="sourceDraft.scope"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><el-option
            :label="translate('generated.mcpSourceManagementPage.personal2')"
            value="PERSONAL" /><el-option
            v-if="canUseOrganizationScope"
            :label="translate('generated.mcpSourceManagementPage.organization2')"
            value="ORGANIZATION" /></el-select></el-form-item
      ><el-form-item
        v-if="sourceDraft.scope === 'ORGANIZATION'"
        :label="translate('generated.mcpSourceManagementPage.organization3')"
        prop="organizationId"
        ><el-cascader
          v-model="sourceDraft.organizationId"
          style="width: 100%"
          filterable
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
      /></el-form-item>
    </template>
    <template #catalog-ownership>
      <el-form-item :label="translate('generated.mcpSourceManagementPage.scope3')"
        ><el-select
          v-model="catalogDraft.scope"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><el-option
            :label="translate('generated.mcpSourceManagementPage.personal3')"
            value="PERSONAL" /><el-option
            v-if="canUseOrganizationScope"
            :label="translate('generated.mcpSourceManagementPage.organization4')"
            value="ORGANIZATION" /></el-select></el-form-item
      ><el-form-item
        v-if="catalogDraft.scope === 'ORGANIZATION'"
        :label="translate('generated.mcpSourceManagementPage.organization5')"
        prop="organizationId"
        ><el-cascader
          v-model="catalogDraft.organizationId"
          style="width: 100%"
          filterable
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
      /></el-form-item>
    </template>
  </CorePage>
</template>
