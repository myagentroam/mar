<script setup lang="ts">
import { MarDescriptions, MarDescriptionsItem } from '@myagentroam/mar-ui/descriptions';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarButton } from '@myagentroam/mar-ui/button';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { marIcon } from '../../util/mar-icons.js';
import { translate } from '../../service/locale-preference-service.js';
export interface McpDetails {
  readonly name: string;
  readonly serverName?: string;
  readonly description: string;
  readonly source?: string;
  readonly scope?: string;
  readonly version?: string;
  readonly transport?: string;
  readonly status?: string;
  readonly updatedAt?: string;
  readonly featured?: boolean;
  readonly tags?: readonly string[];
}

defineProps<{ modelValue: boolean; details: McpDetails | undefined }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <el-dialog
    v-if="modelValue"
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    :model-value="modelValue"
    :title="translate('generated.mcpDetailsDialog.mCPDetails')"
    width="min(720px, calc(100vw - 32px))"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
    :close-icon="marIcon('close')"
  >
    <div v-if="details" class="mcp-details">
      <strong class="mcp-name">{{ details.name }}</strong>
      <p>
        {{
          details.description ||
          translate('generated.mcpDetailsDialog.noDescriptionIsAvailableForThisMCP')
        }}
      </p>
      <MarDescriptions class="mar-detail-descriptions" :column="1" border>
        <MarDescriptionsItem
          v-if="details.serverName"
          :label="translate('generated.mcpDetailsDialog.serverName')"
          >{{ details.serverName }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.source"
          :label="translate('generated.mcpDetailsDialog.source')"
          >{{ details.source }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.scope"
          :label="translate('generated.mcpDetailsDialog.availability')"
          >{{ details.scope }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.version"
          :label="translate('generated.mcpDetailsDialog.version')"
          >{{ details.version }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.transport"
          :label="translate('generated.mcpDetailsDialog.transport')"
          >{{ details.transport }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.updatedAt"
          :label="translate('generated.mcpDetailsDialog.updated')"
          >{{ details.updatedAt }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.status"
          :label="translate('generated.mcpDetailsDialog.status')"
          >{{ details.status }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.featured || (details.tags?.length ?? 0) > 0"
          :label="translate('generated.mcpDetailsDialog.tags')"
        >
          <div class="mcp-tags">
            <MarTag v-if="details.featured" type="warning" effect="plain"
              >★ {{ translate('generated.mcpDetailsDialog.featured') }}</MarTag
            >
            <MarTag v-for="tag in details.tags ?? []" :key="tag" type="info" effect="plain">{{
              tag
            }}</MarTag>
          </div>
        </MarDescriptionsItem>
      </MarDescriptions>
    </div>
    <template #footer
      ><MarButton @click="emit('update:modelValue', false)">{{
        translate('generated.mcpDetailsDialog.close')
      }}</MarButton></template
    >
  </el-dialog>
</template>

<style scoped>
.mcp-details {
  display: grid;
  gap: 16px;
}
.mcp-name {
  overflow-wrap: anywhere;
}
.mcp-details > p {
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.7;
  white-space: pre-wrap;
}
.mcp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
