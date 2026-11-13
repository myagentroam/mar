<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { ElMessageBox } from '../../service/message-box-service.js';
import { type FormInstance, type FormRules } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import codexLogo from '../../assets/runner-codex.png';
import claudeCodeLogo from '../../assets/runner-claude-code.png';
import marAgentLogo from '../../assets/logo-icon.png';
import openCodeLogo from '../../assets/runner-opencode.svg';
import { translate } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/error-presentation.js';

type Scope = 'COMMON' | 'CODEX' | 'CLAUDE_CODE' | 'OPENCODE' | 'MAR_AGENT';
interface Instructions {
  common: string;
  codex: string;
  claudeCode: string;
  openCode: string;
  marAgent: string;
}

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();

const form = ref<FormInstance>();
const activeScope = ref<Scope>('COMMON');
const loading = ref(true);
const saving = ref(false);
const failed = ref(false);
const instructions = ref<Instructions>({
  common: '',
  codex: '',
  claudeCode: '',
  openCode: '',
  marAgent: ''
});
const formState = ref({ content: '' });
const scopeItems = [
  { id: 'COMMON' as const, label: 'personalInstructions.common', property: 'common' as const },
  {
    id: 'MAR_AGENT' as const,
    label: 'personalInstructions.marAgent',
    property: 'marAgent' as const,
    logo: marAgentLogo
  },
  {
    id: 'CODEX' as const,
    label: 'personalInstructions.codex',
    property: 'codex' as const,
    logo: codexLogo
  },
  {
    id: 'CLAUDE_CODE' as const,
    label: 'personalInstructions.claudeCode',
    property: 'claudeCode' as const,
    logo: claudeCodeLogo
  },
  {
    id: 'OPENCODE' as const,
    label: 'personalInstructions.openCode',
    property: 'openCode' as const,
    logo: openCodeLogo
  }
];
const activeItem = computed(() => scopeItems.find((item) => item.id === activeScope.value)!);
const rules: FormRules = {
  content: [
    {
      required: true,
      message: () => translate('personalInstructions.promptRequired'),
      trigger: 'blur'
    },
    {
      validator: (_rule, value, callback) =>
        typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 20_000
          ? callback()
          : callback(new Error(translate('personalInstructions.promptInvalid'))),
      trigger: 'blur'
    }
  ]
};

onMounted(() => void load());

function saveDraft(): void {
  instructions.value[activeItem.value.property] = formState.value.content;
}

function select(scope: Scope): void {
  if (activeScope.value === scope) return;
  saveDraft();
  activeScope.value = scope;
  formState.value.content = instructions.value[activeItem.value.property];
  void form.value?.clearValidate();
}

function navigateScopes(event: KeyboardEvent, index: number): void {
  let next = index;
  switch (event.key) {
    case 'ArrowRight':
      next = (index + 1) % scopeItems.length;
      break;
    case 'ArrowLeft':
      next = (index + scopeItems.length - 1) % scopeItems.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = scopeItems.length - 1;
      break;
    case 'Enter':
    case ' ':
      break;
    default:
      return;
  }
  event.preventDefault();
  select(scopeItems[next]!.id);
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelectorAll<HTMLElement>('[role="tab"]')
    [next]?.focus();
}

function validateContent(): void {
  void form.value?.validateField('content').catch(() => undefined);
}

async function load(): Promise<void> {
  loading.value = true;
  failed.value = false;
  try {
    instructions.value = (
      await props.request<{ instructions: Instructions }>('/api/personal-instructions')
    ).instructions;
    formState.value.content = instructions.value[activeItem.value.property];
  } catch (error) {
    failed.value = true;
    showMessage(translate('personalInstructions.loadFailed'), 'error', error);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (saving.value) return;
  const scope = activeScope.value;
  const property = activeItem.value.property;
  const content = formState.value.content;
  saving.value = true;
  try {
    const valid = await form.value?.validate().catch(() => false);
    if (!valid) return;
    const response = await props.request<{ instructions: Instructions }>(
      `/api/personal-instructions/${scope}`,
      { method: 'PUT', body: JSON.stringify({ content }) }
    );
    mergeSubmittedScope(property, content, response.instructions);
    showMessage(translate('personalInstructions.saved'), 'success');
  } catch (error) {
    showMessage(
      translate('personalInstructions.saveFailed', { value0: errorMessage(error) }),
      'error',
      error
    );
  } finally {
    saving.value = false;
  }
}

function mergeSubmittedScope(
  property: keyof Instructions,
  submittedContent: string,
  response: Instructions
): void {
  const active = activeItem.value.property === property;
  const draft = active ? formState.value.content : instructions.value[property];
  // A response owns only its submitted scope, not other or more recent drafts.
  if (draft !== submittedContent) return;
  instructions.value[property] = response[property];
  if (active) formState.value.content = response[property];
}

async function clear(): Promise<void> {
  if (saving.value) return;
  const scope = activeScope.value;
  const property = activeItem.value.property;
  const content = formState.value.content;
  saving.value = true;
  try {
    await ElMessageBox.confirm(
      translate('personalInstructions.clearConfirmation'),
      translate('personalInstructions.clear'),
      { closeIcon: marIcon('close'), icon: marIcon('warning'), type: 'warning' }
    );
    const response = await props.request<{ instructions: Instructions }>(
      `/api/personal-instructions/${scope}`,
      { method: 'DELETE' }
    );
    mergeSubmittedScope(property, content, response.instructions);
    if (activeScope.value === scope) void form.value?.clearValidate();
    showMessage(translate('personalInstructions.cleared'), 'success');
  } catch (error) {
    if (error !== 'cancel')
      showMessage(
        translate('personalInstructions.clearFailed', { value0: errorMessage(error) }),
        'error',
        error
      );
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section
    v-loading="loading"
    element-loading-custom-class="mar-page-loading"
    class="personal-instructions settings-panel"
    :aria-busy="loading"
  >
    <header>
      <h2>{{ translate('personalInstructions.title') }}</h2>
      <p>{{ translate('personalInstructions.scopeHelp') }}</p>
    </header>
    <div
      class="instruction-scopes"
      role="tablist"
      :aria-label="translate('personalInstructions.title')"
    >
      <el-check-tag
        v-for="(item, index) in scopeItems"
        :key="item.id"
        :id="`instruction-scope-${item.id}`"
        :checked="activeScope === item.id"
        :aria-selected="activeScope === item.id"
        :tabindex="activeScope === item.id ? 0 : -1"
        aria-controls="personal-instructions-panel"
        role="tab"
        @change="select(item.id)"
        @keydown="navigateScopes($event, index)"
      >
        <MarIcon name="document" v-if="item.logo === undefined" />
        <img
          v-else
          :src="item.logo"
          :data-runner="item.id === 'CODEX' ? 'codex' : undefined"
          class="mar-runner-brand-icon"
          aria-hidden="true"
        />
        <span>{{ translate(item.label) }}</span>
      </el-check-tag>
    </div>
    <p
      v-if="!loading && failed"
      id="personal-instructions-panel"
      role="tabpanel"
      :aria-labelledby="`instruction-scope-${activeScope}`"
      class="instruction-state"
    >
      {{ translate('personalInstructions.loadFailed') }}
    </p>
    <el-form
      v-else
      id="personal-instructions-panel"
      role="tabpanel"
      :aria-labelledby="`instruction-scope-${activeScope}`"
      ref="form"
      :model="formState"
      :rules="rules"
      :disabled="loading"
      label-position="top"
    >
      <el-form-item :label="translate('personalInstructions.prompt')" prop="content">
        <textarea
          v-model="formState.content"
          :aria-label="translate('personalInstructions.prompt')"
          :disabled="loading"
          :maxlength="20000"
          :placeholder="translate('personalInstructions.placeholder')"
          @blur="validateContent"
        ></textarea>
      </el-form-item>
      <div class="instruction-actions">
        <el-button
          :icon="marIcon('delete')"
          :loading="saving"
          @click="clear"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('personalInstructions.clear') }}</el-button
        >
        <el-button
          :icon="marIcon('check')"
          type="primary"
          :loading="saving"
          @click="save"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('common.save') }}</el-button
        >
      </div>
    </el-form>
  </section>
</template>

<style scoped>
.personal-instructions > header {
  flex: 0 0 auto;
  margin-bottom: 1rem;
}

.instruction-scopes,
.instruction-actions {
  display: flex;
  align-items: center;
}

h2 {
  margin: 0;
  font-size: var(--mar-font-size-title);
  line-height: 1.4;
}

.personal-instructions > header p {
  margin: 0.35rem 0 0;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
}

.instruction-scopes {
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.instruction-scopes :deep(.el-check-tag) {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 30px;
  border: 1px solid transparent;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-secondary);
  font-weight: 500;
  padding: 0 0.65rem;
  transition:
    border-color 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}

.instruction-scopes :deep(.el-check-tag:hover) {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.instruction-scopes :deep(.el-check-tag.is-checked) {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}

.instruction-scopes :deep(.el-check-tag.is-checked:hover) {
  background: var(--mar-fill-selection);
}

.instruction-scopes :deep(.el-check-tag:focus-visible) {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 2px;
}

.instruction-scopes img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}
.personal-instructions {
  box-sizing: border-box;
  width: 100%;
  align-self: flex-start;
}
.personal-instructions :deep(.el-form-item) {
  margin-bottom: 1.5rem;
}
.personal-instructions textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 12rem;
  height: clamp(12rem, 40vh, 28rem);
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  outline: none;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  padding: 0.5rem 0.7rem;
  font-family: inherit;
  font-size: var(--mar-font-size-input);
  line-height: 1.5;
  resize: vertical;
}
.personal-instructions textarea::placeholder {
  color: var(--el-text-color-placeholder);
}
.personal-instructions textarea:focus {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-8);
}
.personal-instructions :deep(.is-error) textarea {
  border-color: var(--el-color-danger);
}
.instruction-state {
  flex: 1 1 auto;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-body);
}
.instruction-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.75rem;
}
.instruction-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
</style>
