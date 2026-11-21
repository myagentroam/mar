<script setup lang="ts">
import '../../styles/region-retry-action.css';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarButton } from '@myagentroam/mar-ui/button';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '@myagentroam/mar-ui/icons';
import { MarMessageBox } from '../../service/message-box-service.js';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { QuickPrompt } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import { MarLoadingPanel } from '@myagentroam/mar-ui/loading-panel';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarRegionStatus } from '@myagentroam/mar-ui/region-status';

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
const editorGeneration = ref(0);
const saving = ref(false);
const ready = ref(false);
const retrying = ref(false);
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

onMounted(() => void loadInitial());
onBeforeUnmount(close);

async function loadInitial(): Promise<void> {
  await props.refresh();
  await nextTick();
  if (!props.failed) ready.value = true;
}

async function retry(): Promise<void> {
  if (retrying.value || props.loading) return;
  retrying.value = true;
  try {
    await loadInitial();
  } finally {
    retrying.value = false;
  }
}

function openCreate(): void {
  editorGeneration.value += 1;
  saving.value = false;
  editing.value = undefined;
  draft.value = { phrase: '', prompt: '' };
  dialogOpen.value = true;
}
function openEdit(prompt: QuickPrompt): void {
  editorGeneration.value += 1;
  saving.value = false;
  editing.value = prompt;
  draft.value = { phrase: prompt.phrase, prompt: prompt.prompt };
  dialogOpen.value = true;
}
function close(): void {
  editorGeneration.value += 1;
  saving.value = false;
  dialogOpen.value = false;
  editing.value = undefined;
}
async function save(): Promise<void> {
  if (!dialogOpen.value || saving.value) return;
  const generation = editorGeneration.value;
  const valid = await form.value?.validate().catch(() => false);
  if (!valid || generation !== editorGeneration.value || saving.value) return;
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
    if (generation !== editorGeneration.value) return;
    await props.refresh();
    if (generation !== editorGeneration.value) return;
    showMessage(translate('quickPrompts.saved'), 'success');
    close();
  } catch (error) {
    if (generation === editorGeneration.value)
      showMessage(
        translate('quickPrompts.saveFailed', { value0: errorMessage(error) }),
        'error',
        error
      );
  } finally {
    if (generation === editorGeneration.value) saving.value = false;
  }
}
async function remove(prompt: QuickPrompt): Promise<void> {
  try {
    await MarMessageBox.confirm(
      translate('quickPrompts.removeConfirmation', { value0: `#${prompt.phrase}` }),
      translate('quickPrompts.remove'),
      { icon: marIcon('warning'), type: 'warning' }
    );
    await props.request(`/api/quick-prompts/${encodeURIComponent(prompt.id)}`, {
      method: 'DELETE'
    });
    await props.refresh();
    showMessage(translate('quickPrompts.removed'), 'success');
  } catch (error) {
    if (error !== 'cancel')
      showMessage(
        translate('quickPrompts.removeFailed', { value0: errorMessage(error) }),
        'error',
        error
      );
  }
}
</script>

<template>
  <MarLoadingPanel
    :loading="loading && !ready && !retrying"
    variant="page"
    class="quick-prompts settings-panel"
  >
    <div class="quick-prompts-content">
      <header>
        <div>
          <h2>{{ translate('quickPrompts.title') }}</h2>
          <p>{{ translate('quickPrompts.summary') }}</p>
        </div>
      </header>
      <div class="prompt-list-toolbar">
        <MarButton :icon="marIcon('plus')" type="primary" :disabled="loading" @click="openCreate">
          {{ translate('quickPrompts.add') }}
        </MarButton>
      </div>
      <MarRegionStatus v-if="retrying || (!loading && failed)" class="prompt-status">
        <span v-if="!retrying" role="status">{{ translate('quickPrompts.readFailed') }}</span>
        <MarButton
          class="mar-region-retry-action"
          link
          :aria-disabled="retrying || undefined"
          :aria-busy="retrying || undefined"
          :aria-label="retrying ? translate('common.loading') : undefined"
          @click="retry"
        >
          <MarBusyIndicator v-if="retrying" class="mar-read-loading-indicator" />
          <template v-else>{{ translate('common.retry') }}</template>
        </MarButton>
      </MarRegionStatus>
      <MarRegionStatus v-else-if="ready && !loading && prompts.length === 0" class="prompt-status">
        {{ translate('quickPrompts.empty') }}
      </MarRegionStatus>
      <div v-if="prompts.length > 0" class="prompt-list">
        <article v-for="prompt in prompts" :key="prompt.id" class="prompt-item">
          <div class="prompt-heading">
            <code>#{{ prompt.phrase }}</code>
          </div>
          <p>{{ prompt.prompt }}</p>
          <div class="prompt-actions">
            <MarButton :icon="marIcon('edit')" link :disabled="loading" @click="openEdit(prompt)">{{
              translate('quickPrompts.edit')
            }}</MarButton>
            <MarButton
              :icon="marIcon('delete')"
              link
              type="danger"
              :disabled="loading"
              @click="remove(prompt)"
              >{{ translate('quickPrompts.remove') }}</MarButton
            >
          </div>
        </article>
      </div>
    </div>
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="dialogOpen"
      :key="editorGeneration"
      :model-value="dialogOpen"
      :title="translate(isNew ? 'quickPrompts.add' : 'quickPrompts.edit')"
      width="min(560px, calc(100vw - 32px))"
      append-to-body
      :before-close="close"
    >
      <MarForm ref="form" :model="draft" :rules="rules" label-position="top" @submit.prevent="save">
        <MarFormItem :label="translate('quickPrompts.phrase')" prop="phrase">
          <MarInput
            v-model="draft.phrase"
            maxlength="80"
            :placeholder="translate('quickPrompts.phraseHint')"
          >
            <template #prepend>#</template>
          </MarInput>
        </MarFormItem>
        <MarFormItem :label="translate('quickPrompts.prompt')" prop="prompt">
          <MarInput
            v-model="draft.prompt"
            maxlength="10000"
            :rows="7"
            resize="vertical"
            type="textarea"
          />
        </MarFormItem>
      </MarForm>
      <template #footer>
        <MarButton @click="close">{{ translate('common.cancel') }}</MarButton>
        <MarButton type="primary" :loading="saving" @click="save">{{
          translate('common.save')
        }}</MarButton>
      </template>
    </MarDialog>
  </MarLoadingPanel>
</template>

<style scoped>
.quick-prompts-content {
  box-sizing: border-box;
  padding: var(--mar-settings-page-padding, 0.875rem 1rem);
}

.quick-prompts-content > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.quick-prompts h2 {
  margin: 0;
  font-size: var(--mar-font-size-title);
  line-height: 1.4;
}

.quick-prompts header p {
  margin: 0.35rem 0 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
}

.prompt-status {
  padding-block: 0.5rem;
}

.prompt-list-toolbar {
  display: flex;
  align-items: center;
  min-height: 32px;
  margin-bottom: 0.7rem;
}

.prompt-list {
  border-top: 1px solid var(--mar-border-subtle);
}

.prompt-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.25rem 1rem;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 0.75rem 0;
}

.prompt-heading,
.prompt-actions {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.prompt-heading code {
  color: var(--mar-text-primary);
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.prompt-item p {
  grid-column: 1 / -1;
  grid-row: 2;
  min-width: 0;
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.prompt-actions {
  grid-column: 2;
  grid-row: 1;
  align-self: start;
  gap: 0.625rem;
  white-space: nowrap;
}

.prompt-actions :deep(.mar-ui-button) {
  min-height: var(--mar-compact-control-size);
  padding-inline: 2px;
  font-size: var(--mar-font-size-body);
}

.prompt-actions :deep(.mar-ui-button + .mar-ui-button) {
  margin-left: 0;
}
</style>
