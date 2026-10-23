<script setup lang="ts">
import { showMessage } from '../../service/MessageFeedbackService.js';

import { marIcon } from '../../util/mar-icons.js';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { type FormInstance, type FormRules } from 'element-plus';
import {
  resolveMarAgentDefaultReasoningEffort,
  type MarAgentCompactConfiguration,
  type MarAgentModelSummary
} from '@myagentroam/protocol';
import { createMarAgentCompactService } from '../../service/MarAgentCompactService';
import { translate } from '../../service/LocalePreferenceService';
import { errorMessage } from '../../util/workbench-presentation';

const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  writable: boolean;
  preferredOrganizationId?: number | undefined;
}>();
const service = createMarAgentCompactService(props.request);
const lifetime = new AbortController();
const form = ref<FormInstance>();
const busy = ref(false);
const ready = ref(false);
const refreshing = ref(false);
const saving = ref(false);
const models = ref<MarAgentModelSummary[]>([]);
const draft = reactive<MarAgentCompactConfiguration>({
  enabled: false,
  modelId: null,
  reasoningEffort: null
});
const candidates = computed(() =>
  [...models.value].sort((left, right) => {
    const preferred = (model: MarAgentModelSummary) =>
      model.ownership?.ownerType === 'ORGANIZATION' &&
      model.ownership.ownerOrganizationId === props.preferredOrganizationId;
    return Number(preferred(right)) - Number(preferred(left));
  })
);
const selected = computed(() => models.value.find((model) => model.id === draft.modelId));
const efforts = computed(() =>
  selected.value === undefined
    ? []
    : selected.value.reasoningEfforts.length
      ? selected.value.reasoningEfforts
      : [
          resolveMarAgentDefaultReasoningEffort(
            selected.value.defaultReasoningEffort,
            selected.value.reasoningEfforts
          )
        ]
);
const rules: FormRules = {
  modelId: [
    {
      validator: (_rule, _value, done) =>
        !draft.enabled || selected.value?.enabled === true
          ? done()
          : done(new Error(translate('marAgentModels.compactModelRequired'))),
      trigger: 'change'
    }
  ],
  reasoningEffort: [
    {
      validator: (_rule, _value, done) =>
        !draft.enabled ||
        (draft.reasoningEffort !== null && efforts.value.includes(draft.reasoningEffort))
          ? done()
          : done(new Error(translate('marAgentModels.compactEffortRequired'))),
      trigger: 'change'
    }
  ]
};
function modelChanged() {
  draft.reasoningEffort =
    selected.value === undefined
      ? null
      : resolveMarAgentDefaultReasoningEffort(
          selected.value.defaultReasoningEffort,
          selected.value.reasoningEfforts
        );
}
async function load(showRefresh = false) {
  if (busy.value) return;
  if (showRefresh) refreshing.value = true;
  busy.value = true;
  try {
    const result = await service.load(lifetime.signal);
    if (lifetime.signal.aborted) return;
    models.value = result.models;
    Object.assign(draft, result.configuration);
    ready.value = true;
  } catch (error) {
    if (!lifetime.signal.aborted) showMessage(errorMessage(error), 'error', error);
  } finally {
    busy.value = false;
    if (showRefresh) refreshing.value = false;
  }
}
async function save() {
  if (!props.writable || busy.value || !ready.value || !form.value) return;
  if (!(await form.value.validate().catch(() => false))) return;
  saving.value = true;
  busy.value = true;
  try {
    const configuration = await service.save({ ...draft }, lifetime.signal);
    if (lifetime.signal.aborted) return;
    Object.assign(draft, configuration);
    showMessage(translate('marAgentModels.compactSaved'), 'success');
  } catch (error) {
    if (!lifetime.signal.aborted) showMessage(errorMessage(error), 'error', error);
  } finally {
    busy.value = false;
    saving.value = false;
  }
}
onMounted(() => {
  void load();
});
onBeforeUnmount(() => lifetime.abort());
</script>

<template>
  <section
    v-loading="busy && !ready"
    element-loading-custom-class="mar-page-loading"
    class="compact-settings"
  >
    <p class="compact-hint">{{ translate('marAgentModels.compactHint') }}</p>
    <el-form
      ref="form"
      :model="draft"
      :rules="rules"
      label-position="top"
      :disabled="!writable || busy || !ready"
    >
      <el-form-item :label="translate('marAgentModels.compactEnabled')" prop="enabled">
        <el-switch v-model="draft.enabled" />
      </el-form-item>
      <el-form-item :label="translate('marAgentModels.compactModel')" prop="modelId">
        <el-select
          v-model="draft.modelId"
          filterable
          clearable
          @change="modelChanged"
          @clear="draft.modelId = null"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            v-for="model in candidates"
            :key="model.id"
            :label="model.name"
            :value="model.id"
            :disabled="!model.enabled"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="translate('marAgentModels.compactEffort')" prop="reasoningEffort">
        <el-select
          v-model="draft.reasoningEffort"
          :disabled="!selected"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            v-for="effort in efforts"
            :key="effort"
            :label="translate(`marAgentModels.compactEffortOptions.${effort}`)"
            :value="effort"
          />
        </el-select>
      </el-form-item>
      <div class="compact-actions">
        <el-button
          type="primary"
          :icon="marIcon('check')"
          :loading="saving"
          @click="save"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('marAgentModels.compactSave') }}</el-button
        >
        <el-button
          :icon="marIcon('refresh')"
          :loading="refreshing && ready"
          @click="load(true)"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('marAgentModels.refresh') }}</el-button
        >
      </div>
    </el-form>
  </section>
</template>

<style scoped>
.compact-settings {
  max-width: 36rem;
}
.compact-hint {
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-body);
  line-height: 1.6;
  margin: 0 0 1rem;
}
.compact-settings :deep(.el-select) {
  width: 100%;
}
.compact-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.compact-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
</style>
