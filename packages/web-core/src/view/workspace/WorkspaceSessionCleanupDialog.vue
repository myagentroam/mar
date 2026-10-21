<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessage } from 'element-plus';
import { computed, reactive, ref } from 'vue';
import type { WorkspaceSessionCleanupResult } from '@myagentroam/protocol';
import { translate } from '../../service/LocalePreferenceService.js';
import { runnerLabel } from '../../util/workbench-presentation.js';

const props = defineProps<{
  readonly modelValue: boolean;
  readonly cleanup: (inactiveDays: number) => Promise<WorkspaceSessionCleanupResult | undefined>;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

interface CleanupForm {
  inactiveDays: number | undefined;
}

const formRef = ref<FormInstance>();
const form = reactive<CleanupForm>({ inactiveDays: 30 });
const loading = ref(false);
const result = ref<WorkspaceSessionCleanupResult>();

const rules: FormRules<CleanupForm> = {
  inactiveDays: [
    {
      validator: (_rule, value: unknown, callback) => {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365) {
          callback();
          return;
        }
        callback(
          new Error(translate('generated.workspaceSessionCleanupDialog.inactiveDaysInvalid'))
        );
      },
      trigger: 'change'
    }
  ]
};

const deletedByRunner = computed(() => {
  const current = result.value;
  if (current === undefined) return [];
  return Object.entries(current.deletedByRunner)
    .filter(
      (entry): entry is [keyof typeof current.deletedByRunner, number] => entry[1] !== undefined
    )
    .filter(([, count]) => count > 0)
    .map(([runner, count]) => `${runnerLabel(runner)} ${count}`);
});

function requestClose(done: () => void): void {
  if (!loading.value) done();
}

function close(): void {
  if (loading.value) return;
  emit('update:modelValue', false);
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid || form.inactiveDays === undefined) return;
  loading.value = true;
  try {
    const nextResult = await props.cleanup(form.inactiveDays);
    if (nextResult !== undefined) result.value = nextResult;
  } catch (error) {
    ElMessage.error(
      error instanceof Error
        ? error.message
        : translate('generated.workspaceSessionCleanupDialog.cleanupFailed')
    );
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <el-dialog
    class="workspace-session-cleanup-dialog"
    :before-close="requestClose"
    :close-on-click-modal="!loading"
    :close-on-press-escape="!loading"
    :model-value="modelValue"
    :title="translate('generated.workspaceSessionCleanupDialog.title')"
    width="min(480px, calc(100vw - 32px))"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-loading="loading" class="workspace-session-cleanup-content" :aria-busy="loading">
      <template v-if="result === undefined">
        <p class="workspace-session-cleanup-description">
          {{ translate('generated.workspaceSessionCleanupDialog.description') }}
        </p>
        <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
          <el-form-item
            :label="translate('generated.workspaceSessionCleanupDialog.inactiveDays')"
            prop="inactiveDays"
          >
            <el-input-number
              v-model="form.inactiveDays"
              :disabled="loading"
              :max="365"
              :min="1"
              :step="1"
              step-strictly
            />
          </el-form-item>
        </el-form>
      </template>

      <template v-else>
        <section
          class="workspace-session-cleanup-result"
          :aria-label="translate('generated.workspaceSessionCleanupDialog.completed')"
        >
          <h3>{{ translate('generated.workspaceSessionCleanupDialog.completed') }}</h3>
          <dl class="workspace-session-cleanup-statistics">
            <div>
              <dt>{{ translate('generated.workspaceSessionCleanupDialog.deleted') }}</dt>
              <dd>{{ result.deleted }}</dd>
            </div>
            <div>
              <dt>{{ translate('generated.workspaceSessionCleanupDialog.skipped') }}</dt>
              <dd>{{ result.skipped }}</dd>
            </div>
            <div :class="{ failed: result.failed > 0 }">
              <dt>{{ translate('generated.workspaceSessionCleanupDialog.failed') }}</dt>
              <dd>{{ result.failed }}</dd>
            </div>
          </dl>
          <dl v-if="deletedByRunner.length > 0" class="workspace-session-cleanup-by-runner">
            <dt>{{ translate('generated.workspaceSessionCleanupDialog.byRunner') }}</dt>
            <dd>{{ deletedByRunner.join(', ') }}</dd>
          </dl>
        </section>
      </template>
    </div>

    <template #footer>
      <template v-if="result === undefined">
        <el-button :disabled="loading" @click="close">{{
          translate('generated.workspaceSessionCleanupDialog.cancel')
        }}</el-button>
        <el-button type="danger" :loading="loading" @click="submit">{{
          loading
            ? translate('generated.workspaceSessionCleanupDialog.cleaning')
            : translate('generated.workspaceSessionCleanupDialog.cleanup')
        }}</el-button>
      </template>
      <el-button v-else @click="close">{{ translate('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.workspace-session-cleanup-content {
  display: grid;
  min-height: 112px;
  gap: 14px;
}

.workspace-session-cleanup-description {
  margin: 0;
  color: var(--mar-text-secondary);
  line-height: 1.55;
}

.workspace-session-cleanup-result {
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--mar-border-subtle);
  border-radius: var(--el-border-radius-base);
  background: var(--mar-bg-panel);
}

.workspace-session-cleanup-result h3 {
  margin: 0;
  padding: 12px 14px 8px;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-weight: 600;
}

.workspace-session-cleanup-statistics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  background: var(--mar-border-subtle);
}

.workspace-session-cleanup-statistics > div {
  min-width: 0;
  padding: 10px 12px;
  background: var(--mar-bg-panel);
}

.workspace-session-cleanup-result dt {
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}

.workspace-session-cleanup-result dd {
  margin: 3px 0 0;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-variant-numeric: tabular-nums;
}

.workspace-session-cleanup-statistics > .failed dd {
  color: var(--el-color-danger);
}

.workspace-session-cleanup-by-runner {
  margin: 0;
  padding: 10px 14px 12px;
  border-top: 1px solid var(--mar-border-subtle);
}

.workspace-session-cleanup-by-runner dd {
  margin-top: 3px;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

@media (max-width: 767px) {
  .workspace-session-cleanup-statistics {
    grid-template-columns: 1fr;
  }
}
</style>
