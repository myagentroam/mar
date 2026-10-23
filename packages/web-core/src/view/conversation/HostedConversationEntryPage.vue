<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { ChatDotRound, ChatLineSquare } from '@element-plus/icons-vue';
import type { HostedConversationSnapshot } from '@myagentroam/protocol';
import { createHostedConversationEntryService } from '../../service/HostedConversationEntryService.js';
import { translate } from '../../service/LocalePreferenceService.js';
import { errorMessage } from '../../util/error-presentation.js';

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{
  created: [snapshot: HostedConversationSnapshot];
}>();

const service = createHostedConversationEntryService(props.request);
const formRef = ref<FormInstance>();
const form = reactive({ templateId: '' });
const loading = ref(false);
const creating = ref(false);
const loaded = ref(false);
let loadSequence = 0;

const templates = service.templates;
const selected = computed(() =>
  templates.value.find((template) => template.id === form.templateId)
);
const createDisabled = computed(
  () => creating.value || selected.value === undefined || !selected.value.available
);
const rules = computed<FormRules>(() => ({
  templateId: [
    {
      required: true,
      message: translate('hostedConversations.templateRequired'),
      trigger: 'change'
    }
  ]
}));

async function load(): Promise<void> {
  const sequence = ++loadSequence;
  loading.value = true;
  try {
    await service.loadTemplates();
    if (sequence !== loadSequence) return;
    form.templateId = service.selectedTemplateId.value ?? '';
    loaded.value = true;
    formRef.value?.clearValidate();
  } catch (error) {
    if (sequence !== loadSequence) return;
    ElMessage.error(
      error instanceof Error ? errorMessage(error) : translate('hostedConversations.loadFailed')
    );
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

function selectTemplate(templateId: string): void {
  service.selectTemplate(templateId);
}

function refreshTemplatesOnOpen(visible: boolean): void {
  if (visible && !loading.value && !creating.value) void load();
}

async function create(): Promise<void> {
  if (creating.value) return;
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  if (createDisabled.value) return;
  creating.value = true;
  try {
    service.selectTemplate(form.templateId);
    emit('created', await service.create());
  } catch (error) {
    ElMessage.error(
      error instanceof Error ? errorMessage(error) : translate('hostedConversations.createFailed')
    );
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section
    v-loading="loading && !loaded"
    element-loading-custom-class="mar-page-loading"
    class="hosted-entry-page"
    :aria-busy="loading"
  >
    <div class="conversation-create-panel">
      <div class="conversation-create-heading">
        <el-icon class="conversation-create-icon" aria-hidden="true"><ChatDotRound /></el-icon>
        <h2>{{ translate('hostedConversations.temporaryTitle') }}</h2>
      </div>

      <p v-if="loaded && templates.length === 0" class="conversation-template-empty">
        {{ translate('hostedConversations.noTemplates') }}
      </p>

      <el-form
        v-else
        ref="formRef"
        class="temporary-conversation-composer"
        :model="form"
        :rules="rules"
        hide-required-asterisk
        @submit.prevent="create"
      >
        <el-form-item
          class="template-selection-row"
          :label="translate('hostedConversations.chooseTemplateLabel')"
          prop="templateId"
        >
          <el-select
            v-model="form.templateId"
            filterable
            :placeholder="translate('hostedConversations.templatePlaceholder')"
            :aria-label="translate('hostedConversations.chooseTemplate')"
            :disabled="creating"
            @change="selectTemplate"
            @visible-change="refreshTemplatesOnOpen"
          >
            <el-option
              v-for="template in templates"
              :key="template.id"
              :value="template.id"
              :label="template.name"
              :disabled="creating || !template.available"
            >
              <span class="template-option-copy">{{ template.name }}</span>
            </el-option>
          </el-select>
        </el-form-item>

        <el-button
          class="create-conversation-button"
          native-type="submit"
          type="primary"
          :loading="creating"
          :disabled="createDisabled"
        >
          <el-icon><ChatLineSquare /></el-icon>
          <span>{{ translate('hostedConversations.start') }}</span>
        </el-button>
      </el-form>
    </div>
  </section>
</template>

<style scoped>
.hosted-entry-page {
  box-sizing: border-box;
  display: grid;
  width: 100%;
  min-height: 100%;
  min-width: 0;
  flex: 1 1 auto;
  place-items: center;
  padding: 24px;
  text-align: center;
}

.conversation-create-panel {
  box-sizing: border-box;
  display: grid;
  width: min(400px, 100%);
  min-width: 0;
  gap: 18px;
  padding: 22px 24px 24px;
}

.conversation-create-heading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.conversation-create-icon {
  width: 22px;
  height: 22px;
  flex: none;
  color: var(--mar-color-brand);
  font-size: 22px;
}

.conversation-create-heading h2 {
  margin: 0;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-title);
  line-height: 1.35;
}

.conversation-template-empty {
  margin: 8px 0 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.6;
}

.temporary-conversation-composer {
  display: grid;
  width: 100%;
  grid-template-columns: auto minmax(0, 240px);
  justify-content: center;
  row-gap: 14px;
}

.temporary-conversation-composer :deep(.el-form-item) {
  margin: 0;
}

.template-selection-row {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: start;
}

.template-selection-row :deep(.el-form-item__label) {
  min-height: 36px;
  padding-right: 12px;
  color: var(--mar-text-secondary);
  font-weight: 600;
  line-height: 36px;
}

.template-selection-row :deep(.el-form-item__content) {
  width: 100%;
  min-width: 0;
}

.temporary-conversation-composer :deep(.el-select) {
  width: 100%;
}

.temporary-conversation-composer :deep(.el-select__wrapper) {
  min-height: 36px;
  border: 1px solid var(--mar-border-medium);
  border-radius: 6px;
  background: var(--mar-bg-page);
  box-shadow: none;
  padding-inline: 8px 28px;
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}

.temporary-conversation-composer :deep(.el-select__wrapper:hover),
.temporary-conversation-composer :deep(.el-select__wrapper.is-focused) {
  border-color: var(--mar-color-brand-border);
  background: var(--mar-bg-panel);
  box-shadow: none;
}

.template-option-copy {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.create-conversation-button {
  min-width: 132px;
  grid-column: 2;
  justify-self: start;
  padding-inline: 18px;
}

@media (max-width: 767px) {
  .hosted-entry-page {
    padding: 16px;
  }

  .conversation-create-panel {
    gap: 16px;
    padding: 20px;
  }

  .temporary-conversation-composer {
    grid-template-columns: minmax(0, 1fr);
  }

  .template-selection-row {
    gap: 4px;
  }

  .template-selection-row :deep(.el-form-item__label) {
    justify-content: flex-start;
    padding: 0;
  }

  .create-conversation-button {
    width: 100%;
    grid-column: 1;
  }
}
</style>
