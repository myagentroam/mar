<script setup lang="ts">
import { EditPen, Plus, Delete } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import type { QuickPrompt } from '../../model/workbench.js';
import { translate } from '../../service/LocalePreferenceService.js';
import { errorMessage } from '../../util/error-presentation.js';

const props = defineProps<{
  readonly prompts: readonly QuickPrompt[];
  readonly loading: boolean;
  readonly failed: boolean;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly refresh: () => Promise<void>;
}>();
const form = ref<FormInstance>();
const editing = ref<QuickPrompt>();
const dialogOpen = ref(false);
const saving = ref(false);
const draft = ref({ phrase: '', prompt: '' });
const isNew = computed(() => editing.value === undefined);
const rules: FormRules = {
  phrase: [
    { required: true, message: () => translate('quickPrompts.phraseRequired'), trigger: 'blur' },
    {
      validator: (_rule, value, callback) =>
        typeof value === 'string' && value.trim().length <= 80 && !/[\s#]/u.test(value)
          ? callback()
          : callback(new Error(translate('quickPrompts.phraseInvalid'))),
      trigger: 'blur'
    }
  ],
  prompt: [
    { required: true, message: () => translate('quickPrompts.promptRequired'), trigger: 'blur' }
  ]
};

onMounted(() => void props.refresh());

function openCreate(): void {
  editing.value = undefined;
  draft.value = { phrase: '', prompt: '' };
  dialogOpen.value = true;
}
function openEdit(prompt: QuickPrompt): void {
  editing.value = prompt;
  draft.value = { phrase: prompt.phrase, prompt: prompt.prompt };
  dialogOpen.value = true;
}
function close(): void {
  dialogOpen.value = false;
  editing.value = undefined;
}
async function save(): Promise<void> {
  if (saving.value) return;
  const valid = await form.value?.validate().catch(() => false);
  if (!valid || saving.value) return;
  saving.value = true;
  try {
    const body = JSON.stringify(draft.value);
    if (editing.value === undefined)
      await props.request('/api/quick-prompts', { method: 'POST', body });
    else
      await props.request(`/api/quick-prompts/${encodeURIComponent(editing.value.id)}`, {
        method: 'PATCH',
        body
      });
    await props.refresh();
    ElMessage.success(translate('quickPrompts.saved'));
    close();
  } catch (error) {
    ElMessage.error(translate('quickPrompts.saveFailed', { value0: errorMessage(error) }));
  } finally {
    saving.value = false;
  }
}
async function remove(prompt: QuickPrompt): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('quickPrompts.removeConfirmation', { value0: `#${prompt.phrase}` }),
      translate('quickPrompts.remove'),
      { type: 'warning' }
    );
    await props.request(`/api/quick-prompts/${encodeURIComponent(prompt.id)}`, {
      method: 'DELETE'
    });
    await props.refresh();
    ElMessage.success(translate('quickPrompts.removed'));
  } catch (error) {
    if (error !== 'cancel')
      ElMessage.error(translate('quickPrompts.removeFailed', { value0: errorMessage(error) }));
  }
}
</script>

<template>
  <section
    v-loading="loading"
    :element-loading-text="translate('common.loading')"
    class="quick-prompts settings-panel"
    :aria-busy="loading"
  >
    <header>
      <div>
        <h2>{{ translate('quickPrompts.title') }}</h2>
        <p>{{ translate('quickPrompts.summary') }}</p>
      </div>
    </header>
    <div class="prompt-list-toolbar">
      <el-button :icon="Plus" type="primary" :disabled="loading" @click="openCreate">
        {{ translate('quickPrompts.add') }}
      </el-button>
    </div>
    <p v-if="!loading && failed" class="prompt-state">{{ translate('quickPrompts.loadFailed') }}</p>
    <div v-else-if="!loading && prompts.length === 0" class="prompt-empty">
      <p>{{ translate('quickPrompts.empty') }}</p>
    </div>
    <div v-else-if="prompts.length > 0" class="prompt-list">
      <article v-for="prompt in prompts" :key="prompt.id" class="prompt-item">
        <div class="prompt-heading">
          <code>#{{ prompt.phrase }}</code>
        </div>
        <p>{{ prompt.prompt }}</p>
        <div class="prompt-actions">
          <el-button :icon="EditPen" text :disabled="loading" @click="openEdit(prompt)">{{
            translate('quickPrompts.edit')
          }}</el-button>
          <el-button
            :icon="Delete"
            text
            type="danger"
            :disabled="loading"
            @click="remove(prompt)"
            >{{ translate('quickPrompts.remove') }}</el-button
          >
        </div>
      </article>
    </div>
    <el-dialog
      v-if="dialogOpen"
      v-model="dialogOpen"
      :title="translate(isNew ? 'quickPrompts.add' : 'quickPrompts.edit')"
      width="min(560px, calc(100vw - 32px))"
      @closed="close"
    >
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" @submit.prevent="save">
        <el-form-item :label="translate('quickPrompts.phrase')" prop="phrase">
          <el-input
            v-model="draft.phrase"
            maxlength="80"
            :placeholder="translate('quickPrompts.phraseHint')"
          >
            <template #prepend>#</template>
          </el-input>
        </el-form-item>
        <el-form-item :label="translate('quickPrompts.prompt')" prop="prompt">
          <el-input
            v-model="draft.prompt"
            maxlength="10000"
            :rows="7"
            resize="vertical"
            type="textarea"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="close">{{ translate('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="save">{{
          translate('common.save')
        }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.quick-prompts > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding-bottom: 0.9rem;
}

.quick-prompts h2 {
  margin: 0;
  font-size: var(--mar-font-size-title);
  line-height: 1.4;
}

.quick-prompts header p,
.prompt-state {
  margin: 0.35rem 0 0;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
}

.prompt-state {
  padding: 0.25rem 0;
}

.prompt-list-toolbar {
  display: flex;
  align-items: center;
  min-height: 32px;
  margin-bottom: 0.7rem;
}

.prompt-empty {
  display: flex;
  min-height: 150px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.8rem;
  border: 1px dashed var(--mar-border-medium);
  border-radius: 6px;
  background: var(--mar-fill-subtle);
  color: var(--mar-text-secondary);
  text-align: center;
}

.prompt-empty p {
  margin: 0;
  font-size: var(--mar-font-size-body);
}

.prompt-list {
  display: grid;
  gap: 0.55rem;
}

.prompt-item {
  border: 1px solid var(--mar-border-subtle);
  border-radius: 6px;
  padding: 0.7rem 0.8rem;
}

.prompt-heading,
.prompt-actions {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.prompt-heading code {
  color: var(--mar-color-brand-text);
  font-size: var(--mar-font-size-body);
}

.prompt-item p {
  display: -webkit-box;
  margin: 0.4rem 0 0.55rem;
  overflow: hidden;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  white-space: pre-wrap;
}

.prompt-actions {
  justify-content: flex-end;
}
@media (max-width: 767px) {
  .quick-prompts > header {
    align-items: stretch;
    flex-direction: column;
  }
  .quick-prompts > header :deep(.el-button) {
    align-self: flex-start;
    min-height: 36px;
  }
}
</style>
