<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import { computed, ref } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { translate } from '../../service/LocalePreferenceService';
import {
  createMailTemplateManagementService,
  type MailTemplate
} from '../../service/MailTemplateManagementService';
import { errorMessage } from '../../util/workbench-presentation';

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
}>();
const service = createMailTemplateManagementService(props.request);
const viewerOpen = ref(false);
const selectedId = ref('');
const selected = computed(() =>
  service.templates.value.find((item) => item.id === selectedId.value)
);
const rendered = ref<{ readonly subject: string; readonly text: string; readonly html: string }>();
const previewing = ref(false);
let previewSequence = 0;
const testOpen = ref(false);
const testForm = ref<FormInstance>();
const testAddress = ref('');
const testTemplateId = ref('');
const testTemplates = computed(() =>
  service.templates.value.filter((template) => template.kind === 'TEST')
);
const testModel = computed(() => ({ email: testAddress.value, templateId: testTemplateId.value }));
const testRules: FormRules = {
  email: [
    {
      required: true,
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/u,
      message: translate('generated.systemConfigurationPage.mailAddressInvalid'),
      trigger: 'blur'
    }
  ],
  templateId: [{ required: true, trigger: 'change' }]
};

function failure(error: unknown): string {
  return error instanceof Error
    ? errorMessage(error)
    : translate('generated.systemConfigurationPage.mailOperationFailed');
}
async function openViewer(): Promise<void> {
  viewerOpen.value = true;
  previewSequence += 1;
  selectedId.value = '';
  rendered.value = undefined;
  try {
    await service.load();
    selectedId.value = service.templates.value[0]?.id ?? '';
    if (selectedId.value !== '') await preview();
  } catch (error) {
    ElMessage.error({ icon: marIcon('error'), message: failure(error) });
  }
}
function select(template: MailTemplate): void {
  selectedId.value = template.id;
  rendered.value = undefined;
  void preview();
}
async function preview(): Promise<void> {
  const template = selected.value;
  if (template === undefined || !viewerOpen.value) return;
  const sequence = ++previewSequence;
  previewing.value = true;
  try {
    const result = await service.preview(
      template,
      translate('generated.systemConfigurationPage.mailPreviewMessage')
    );
    if (viewerOpen.value && sequence === previewSequence && selectedId.value === template.id)
      rendered.value = result;
  } catch (error) {
    if (sequence === previewSequence)
      ElMessage.error({ icon: marIcon('error'), message: failure(error) });
  } finally {
    if (sequence === previewSequence) previewing.value = false;
  }
}
function openTest(): void {
  testAddress.value = '';
  testTemplateId.value =
    (selected.value?.kind === 'TEST' ? selected.value.id : testTemplates.value[0]?.id) ?? '';
  testOpen.value = true;
}
async function sendTest(): Promise<void> {
  if (!props.writable) return;
  try {
    await testForm.value?.validate();
    await service.test(testAddress.value, testTemplateId.value);
    testOpen.value = false;
    ElMessage.success({
      icon: marIcon('success'),
      message: translate('generated.systemConfigurationPage.mailTestAccepted')
    });
  } catch (error) {
    if (error instanceof Error)
      ElMessage.error({ icon: marIcon('error'), message: failure(error) });
  }
}
</script>

<template>
  <el-button :icon="marIcon('mail')" @click="openViewer">
    {{ translate('generated.systemConfigurationPage.mailTemplateView') }}
  </el-button>
  <el-dialog
    v-if="viewerOpen"
    v-model="viewerOpen"
    append-to-body
    :title="translate('generated.systemConfigurationPage.mailTemplates')"
    width="min(780px, calc(100vw - 32px))"
    :close-icon="marIcon('close')"
  >
    <div v-loading="service.loading.value" class="template-viewer">
      <p class="template-description">
        {{ translate('generated.systemConfigurationPage.mailTemplateBuiltIn') }}
      </p>
      <div v-if="service.templates.value.length > 0" class="template-layout">
        <div
          class="template-choices"
          role="group"
          :aria-label="translate('generated.systemConfigurationPage.mailTemplates')"
        >
          <button
            v-for="template in service.templates.value"
            :key="template.id"
            type="button"
            class="template-choice"
            :class="{ 'is-selected': selectedId === template.id }"
            :aria-pressed="selectedId === template.id"
            @click="select(template)"
          >
            <span class="template-choice__meta">
              {{
                translate(
                  template.kind === 'TEST'
                    ? 'generated.systemConfigurationPage.mailKindTest'
                    : 'generated.systemConfigurationPage.mailKindNotification'
                )
              }}
              <span aria-hidden="true">·</span>
              {{ template.locale }}
            </span>
            <strong>{{ template.name }}</strong>
            <span class="template-choice__subject">{{ template.subject }}</span>
          </button>
        </div>
        <div v-if="selected" v-loading="previewing" class="template-preview">
          <div class="template-preview__header">
            <span>{{ translate('generated.systemConfigurationPage.mailPreviewSample') }}</span>
            <span class="template-preview__locale">{{ selected.locale }}</span>
          </div>
          <iframe
            v-if="rendered?.html"
            class="template-preview__document"
            :srcdoc="rendered.html"
            sandbox=""
            referrerpolicy="no-referrer"
            :title="translate('generated.systemConfigurationPage.mailPreviewSample')"
          />
          <div v-else class="template-preview__fallback">
            <span>
              {{ translate('generated.systemConfigurationPage.mailSubject') }}
            </span>
            <strong>
              {{ rendered?.subject ?? selected.subject }}
            </strong>
            <span>
              {{ translate('generated.systemConfigurationPage.mailBody') }}
            </span>
            <p>{{ rendered?.text ?? selected.body }}</p>
          </div>
        </div>
      </div>
      <p v-else-if="!service.loading.value" class="template-empty">
        {{ translate('generated.systemConfigurationPage.mailTemplateEmpty') }}
      </p>
    </div>
    <template #footer>
      <el-button
        :disabled="!writable || testTemplates.length === 0 || service.busy.value"
        @click="openTest"
      >
        {{ translate('generated.systemConfigurationPage.mailTest') }}
      </el-button>
      <el-button @click="viewerOpen = false">{{ translate('common.close') }}</el-button>
    </template>
  </el-dialog>
  <el-dialog
    v-if="testOpen"
    v-model="testOpen"
    append-to-body
    :title="translate('generated.systemConfigurationPage.mailTest')"
    width="min(480px, calc(100vw - 32px))"
    :close-icon="marIcon('close')"
  >
    <el-form ref="testForm" :model="testModel" :rules="testRules" label-position="top">
      <el-form-item
        :label="translate('generated.systemConfigurationPage.mailAddress')"
        prop="email"
      >
        <el-input v-model="testAddress" type="email" />
      </el-form-item>
      <el-form-item
        :label="translate('generated.systemConfigurationPage.mailTemplate')"
        prop="templateId"
      >
        <el-select
          v-model="testTemplateId"
          class="template-test-select"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            v-for="template in testTemplates"
            :key="template.id"
            :value="template.id"
            :label="template.name"
          />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="testOpen = false">{{ translate('common.cancel') }}</el-button>
      <el-button
        type="primary"
        :loading="service.busy.value"
        @click="sendTest"
        :loading-icon="marIcon('loading-action')"
      >
        {{ translate('generated.systemConfigurationPage.mailTestSend') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.template-description {
  margin: 0 0 14px;
  color: var(--el-text-color-secondary);
  line-height: 1.55;
  border-left: 2px solid var(--el-color-primary);
  padding-left: 12px;
}
.template-layout {
  display: grid;
  grid-template-columns: minmax(200px, 0.9fr) minmax(0, 1.6fr);
  gap: 18px;
  min-height: 360px;
}
.template-choices {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.template-choice {
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
  border: 1px solid var(--el-border-color);
  border-radius: var(--mar-radius-selection);
  padding: 13px 14px;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-primary);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
}
.template-choice.is-selected {
  border-color: var(--mar-border-medium);
  background: var(--mar-fill-selection);
}
.template-choice:hover {
  background: var(--mar-fill-hover);
}
.template-choice.is-selected:hover {
  background: var(--mar-fill-selection);
}
.template-choice:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.template-choice__meta,
.template-choice__subject {
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}
.template-choice__meta {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--el-color-primary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  letter-spacing: 0.035em;
}
.template-choice strong {
  font-size: var(--mar-font-size-body);
  line-height: 1.45;
}
.template-choice__subject {
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.template-preview {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 10px;
}
.template-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 25px;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}
.template-preview__locale {
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
}
.template-preview__document {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 410px;
  border: 0;
  background: transparent;
}
.template-preview__fallback {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 340px;
  padding: 18px;
  overflow-wrap: anywhere;
}
.template-preview__fallback span {
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}
.template-preview__fallback p {
  margin: 0;
  white-space: pre-wrap;
}
.template-test-select {
  width: 100%;
}
@media (max-width: 620px) {
  .template-layout {
    grid-template-columns: 1fr;
  }
  .template-preview__document {
    height: 360px;
  }
  .template-choices {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 420px) {
  .template-choices {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .template-choice {
    transition: none;
  }
}
</style>
