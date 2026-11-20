<script setup lang="ts">
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarDescriptions, MarDescriptionsItem } from '@myagentroam/mar-ui/descriptions';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarButton } from '@myagentroam/mar-ui/button';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { currentLocale, translate } from '../../service/locale-preference-service.js';
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
  <MarDialog
    v-if="modelValue"
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    :model-value="modelValue"
    :title="translate('generated.skillDetailsDialog.skillDetails')"
    width="min(720px, calc(100vw - 32px))"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="details" class="skill-details">
      <strong class="skill-name">{{ details.name }}</strong>
      <p class="skill-description">
        {{
          details.description ||
          translate('generated.skillDetailsDialog.noDescriptionIsAvailableForThisSkill')
        }}
      </p>
      <MarDescriptions class="mar-detail-descriptions" :column="1" border>
        <MarDescriptionsItem
          v-if="details.source"
          :label="translate('generated.skillDetailsDialog.source')"
          >{{ details.source }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.scope"
          :label="translate('generated.skillDetailsDialog.availability')"
          >{{ details.scope }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.path"
          :label="translate('generated.skillDetailsDialog.skillPath')"
          >{{ details.path }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.version"
          :label="translate('generated.skillDetailsDialog.version')"
          >{{ details.version }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.updatedAt"
          :label="translate('generated.skillDetailsDialog.updated')"
          >{{ details.updatedAt }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.status"
          :label="translate('generated.skillDetailsDialog.status')"
          >{{ details.status }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.installs !== undefined"
          :label="translate('generated.skillDetailsDialog.installs')"
          >{{ details.installs.toLocaleString(currentLocale()) }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          v-if="details.featured || (details.tags?.length ?? 0) > 0"
          :label="translate('generated.skillDetailsDialog.tags')"
        >
          <div class="skill-tags">
            <MarTag v-if="details.featured" type="warning" effect="plain"
              >★ {{ translate('generated.skillDetailsDialog.featured') }}</MarTag
            >
            <MarTag v-for="tag in details.tags ?? []" :key="tag" type="info" effect="plain">{{
              tag
            }}</MarTag>
          </div>
        </MarDescriptionsItem>
      </MarDescriptions>
    </div>
    <template #footer>
      <MarButton @click="emit('update:modelValue', false)">{{
        translate('generated.skillDetailsDialog.close')
      }}</MarButton>
    </template>
  </MarDialog>
</template>

<style scoped>
.skill-details {
  display: grid;
  gap: 16px;
}
.skill-name {
  overflow-wrap: anywhere;
}
.skill-description {
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.7;
  white-space: pre-wrap;
}
.skill-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
