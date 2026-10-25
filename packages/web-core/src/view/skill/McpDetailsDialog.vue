<script setup lang="ts">
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
      <el-descriptions class="mar-detail-descriptions" :column="1" border>
        <el-descriptions-item
          v-if="details.serverName"
          :label="translate('generated.mcpDetailsDialog.serverName')"
          >{{ details.serverName }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.source"
          :label="translate('generated.mcpDetailsDialog.source')"
          >{{ details.source }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.scope"
          :label="translate('generated.mcpDetailsDialog.availability')"
          >{{ details.scope }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.version"
          :label="translate('generated.mcpDetailsDialog.version')"
          >{{ details.version }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.transport"
          :label="translate('generated.mcpDetailsDialog.transport')"
          >{{ details.transport }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.updatedAt"
          :label="translate('generated.mcpDetailsDialog.updated')"
          >{{ details.updatedAt }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.status"
          :label="translate('generated.mcpDetailsDialog.status')"
          >{{ details.status }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.featured || (details.tags?.length ?? 0) > 0"
          :label="translate('generated.mcpDetailsDialog.tags')"
        >
          <div class="mcp-tags">
            <el-tag v-if="details.featured" type="warning" effect="plain"
              >★ {{ translate('generated.mcpDetailsDialog.featured') }}</el-tag
            >
            <el-tag v-for="tag in details.tags ?? []" :key="tag" type="info" effect="plain">{{
              tag
            }}</el-tag>
          </div>
        </el-descriptions-item>
      </el-descriptions>
    </div>
    <template #footer
      ><el-button @click="emit('update:modelValue', false)">{{
        translate('generated.mcpDetailsDialog.close')
      }}</el-button></template
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
