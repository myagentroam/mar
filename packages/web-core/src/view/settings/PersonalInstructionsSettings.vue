<script setup lang="ts">
import { Check, Delete, Document, QuestionFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import codexLogo from '../../assets/runner-codex.png';
import claudeCodeLogo from '../../assets/runner-claude-code.png';
import marAgentLogo from '../../assets/logo-icon.png';
import openCodeLogo from '../../assets/runner-opencode.svg';
import { translate } from '../../service/LocalePreferenceService.js';
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
    ElMessage.error(translate('personalInstructions.loadFailed'));
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  const valid = await form.value?.validate().catch(() => false);
  if (!valid) return;
  saving.value = true;
  try {
    instructions.value = (
      await props.request<{ instructions: Instructions }>(
        `/api/personal-instructions/${activeScope.value}`,
        { method: 'PUT', body: JSON.stringify({ content: formState.value.content }) }
      )
    ).instructions;
    formState.value.content = instructions.value[activeItem.value.property];
    ElMessage.success(translate('personalInstructions.saved'));
  } catch (error) {
    ElMessage.error(translate('personalInstructions.saveFailed', { value0: errorMessage(error) }));
  } finally {
    saving.value = false;
  }
}

async function clear(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('personalInstructions.clearConfirmation'),
      translate('personalInstructions.clear'),
      { type: 'warning' }
    );
    saving.value = true;
    instructions.value = (
      await props.request<{ instructions: Instructions }>(
        `/api/personal-instructions/${activeScope.value}`,
        { method: 'DELETE' }
      )
    ).instructions;
    formState.value.content = '';
    void form.value?.clearValidate();
    ElMessage.success(translate('personalInstructions.cleared'));
  } catch (error) {
    if (error !== 'cancel')
      ElMessage.error(
        translate('personalInstructions.clearFailed', { value0: errorMessage(error) })
      );
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section
    v-loading="loading"
    :element-loading-text="translate('common.loading')"
    class="personal-instructions settings-panel"
    :aria-busy="loading"
  >
    <header>
      <div class="title-row">
        <h2>{{ translate('personalInstructions.title') }}</h2>
        <el-tooltip :content="translate('personalInstructions.scopeHelp')" placement="right">
          <el-icon class="help-icon"><QuestionFilled /></el-icon>
        </el-tooltip>
      </div>
    </header>
    <div class="instruction-scopes" role="tablist">
      <el-check-tag
        v-for="item in scopeItems"
        :key="item.id"
        :checked="activeScope === item.id"
        role="tab"
        @change="select(item.id)"
      >
        <el-icon v-if="item.logo === undefined"><Document /></el-icon>
        <img
          v-else
          :src="item.logo"
          :data-runner="item.id === 'CODEX' ? 'codex' : undefined"
          class="runner-brand-icon"
          aria-hidden="true"
        />
        <span>{{ translate(item.label) }}</span>
      </el-check-tag>
    </div>
    <p v-if="!loading && failed" class="instruction-state">
      {{ translate('personalInstructions.loadFailed') }}
    </p>
    <el-form
      v-else
      ref="form"
      :model="formState"
      :rules="rules"
      :disabled="loading"
      label-position="top"
    >
      <el-form-item :label="translate('personalInstructions.prompt')" prop="content">
        <textarea
          v-model="formState.content"
          :disabled="loading"
          :maxlength="20000"
          :placeholder="translate('personalInstructions.placeholder')"
          @blur="validateContent"
        ></textarea>
      </el-form-item>
      <div class="instruction-actions">
        <el-button :icon="Delete" :loading="saving" @click="clear">{{
          translate('personalInstructions.clear')
        }}</el-button>
        <el-button :icon="Check" type="primary" :loading="saving" @click="save">{{
          translate('common.save')
        }}</el-button>
      </div>
    </el-form>
  </section>
</template>

<style scoped>
.personal-instructions > header {
  flex: 0 0 auto;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding-bottom: 0.9rem;
}

.title-row,
.instruction-scopes,
.instruction-actions {
  display: flex;
  align-items: center;
}

.title-row {
  gap: 0.45rem;
}

h2 {
  margin: 0;
  font-size: var(--mar-font-size-title);
  line-height: 1.4;
}

.help-icon {
  color: var(--mar-text-muted);
  cursor: help;
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
  border: 1px solid var(--mar-border-default);
  border-radius: 6px;
  background: var(--mar-bg-panel);
  color: var(--mar-text-secondary);
  font-weight: 500;
  padding: 0 0.65rem;
  transition:
    border-color 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}

.instruction-scopes :deep(.el-check-tag:hover) {
  border-color: var(--mar-border-medium);
  background: var(--mar-fill-muted);
  color: var(--mar-text-primary);
}

.instruction-scopes :deep(.el-check-tag.is-checked) {
  border-color: var(--mar-color-brand-border);
  background: var(--mar-color-brand-subtle);
  color: var(--mar-color-brand-text);
}

.instruction-scopes :deep(.el-check-tag.is-checked:hover) {
  border-color: var(--mar-color-brand);
  background: var(--mar-color-brand-selected);
}

.instruction-scopes img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}
.personal-instructions {
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto auto minmax(0, 1fr);
}
.personal-instructions :deep(.el-form) {
  display: grid;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) auto;
}
.personal-instructions :deep(.el-form-item),
.personal-instructions :deep(.el-form-item__content) {
  min-height: 0;
}
.personal-instructions :deep(.el-form-item) {
  display: grid;
  margin-bottom: 0;
  grid-template-rows: auto minmax(0, 1fr);
}
.personal-instructions :deep(.el-form-item__content) {
  display: grid;
}
.personal-instructions textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 0;
  height: 100%;
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
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.75rem;
}
</style>
