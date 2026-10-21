<script setup lang="ts">
import { currentLocale, translate } from '../../service/LocalePreferenceService.js';
export interface SkillDetails {
  readonly name: string;
  readonly description: string;
  readonly source?: string;
  readonly scope?: string;
  readonly path?: string;
  readonly version?: string;
  readonly updatedAt?: string;
  readonly status?: string;
  readonly installs?: number;
  readonly featured?: boolean;
  readonly tags?: readonly string[];
}

defineProps<{ modelValue: boolean; details: SkillDetails | undefined }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="details?.name || translate('generated.skillDetailsDialog.skillDetails')"
    width="min(720px, calc(100vw - 32px))"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="details" class="skill-details">
      <p class="skill-description">
        {{
          details.description ||
          translate('generated.skillDetailsDialog.noDescriptionIsAvailableForThisSkill')
        }}
      </p>
      <el-descriptions class="mar-detail-descriptions" :column="1" border>
        <el-descriptions-item
          v-if="details.source"
          :label="translate('generated.skillDetailsDialog.source')"
          >{{ details.source }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.scope"
          :label="translate('generated.skillDetailsDialog.availability')"
          >{{ details.scope }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.path"
          :label="translate('generated.skillDetailsDialog.skillPath')"
          >{{ details.path }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.version"
          :label="translate('generated.skillDetailsDialog.version')"
          >{{ details.version }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.updatedAt"
          :label="translate('generated.skillDetailsDialog.updated')"
          >{{ details.updatedAt }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.status"
          :label="translate('generated.skillDetailsDialog.status')"
          >{{ details.status }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.installs !== undefined"
          :label="translate('generated.skillDetailsDialog.installs')"
          >{{ details.installs.toLocaleString(currentLocale()) }}</el-descriptions-item
        >
        <el-descriptions-item
          v-if="details.featured || (details.tags?.length ?? 0) > 0"
          :label="translate('generated.skillDetailsDialog.tags')"
        >
          <div class="skill-tags">
            <el-tag v-if="details.featured" type="warning" effect="plain"
              >★ {{ translate('generated.skillDetailsDialog.featured') }}</el-tag
            >
            <el-tag v-for="tag in details.tags ?? []" :key="tag" effect="plain">{{ tag }}</el-tag>
          </div>
        </el-descriptions-item>
      </el-descriptions>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{
        translate('generated.skillDetailsDialog.close')
      }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.skill-details {
  display: grid;
  gap: 16px;
}
.skill-description {
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.skill-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
