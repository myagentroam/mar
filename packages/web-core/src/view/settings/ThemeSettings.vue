<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  Check,
  CopyDocument,
  Delete,
  Download,
  MoreFilled,
  RefreshLeft,
  SetUp,
  Upload,
  ZoomIn
} from '@element-plus/icons-vue';
import {
  type BuiltinTheme,
  type CustomTheme,
  type ThemePreference
} from '../../model/custom-theme.js';
import { themePreferenceService } from '../../service/ThemePreferenceService.js';
import { analyzeCustomTheme, createThemeSource } from '../../util/custom-theme.js';
import ThemePreview from './ThemePreview.vue';
import ThemeTokenHelp from './ThemeTokenHelp.vue';

const { t } = useI18n();
const service = themePreferenceService();
interface ThemeRow {
  id: ThemePreference;
  name: string;
  source?: string;
  builtin: boolean;
}
const themes = computed<ThemeRow[]>(() => [
  { id: 'vscode-dark-2026', name: t('settings.dark'), builtin: true },
  { id: 'daylight', name: t('settings.light'), builtin: true },
  ...service.customThemes.value.map((item) => ({
    ...item,
    name: analyzeCustomTheme(item.source).name ?? t('customThemes.untitled'),
    builtin: false
  }))
]);
const form = ref<FormInstance>();
const fileInput = ref<HTMLInputElement>();
const selectedId = ref<CustomTheme['id']>();
const selectedBuiltin = ref<BuiltinTheme | undefined>('vscode-dark-2026');
const isBuiltin = computed(() => selectedBuiltin.value !== undefined);
const paletteReady = ref(false);
const expandedPreview = ref(false);
const draft = reactive({
  source: createThemeSource(t('settings.dark'))
});
const baseline = ref(draft.source);
const dirty = computed(() => !isBuiltin.value && draft.source !== baseline.value);
const unsaved = computed(() => !isBuiltin.value && (!selectedId.value || dirty.value));
const analysis = computed(() => analyzeCustomTheme(draft.source));
const previewColors = computed(() =>
  paletteReady.value ? service.resolveColors(draft.source) : analysis.value.colors
);
const swatchTokens = [
  '--mar-bg-page',
  '--mar-bg-panel',
  '--mar-text-primary',
  '--mar-color-brand',
  '--mar-color-accent'
];
const themeOptions = computed<Array<ThemeRow & { colors: Record<string, string> }>>(() =>
  themes.value.map((item) => ({
    ...item,
    colors: paletteReady.value ? service.resolveColors(rowSource(item)) : {}
  }))
);
const rules = computed<FormRules>(() => ({
  source: [
    {
      validator: (_rule, value, callback) =>
        callback(
          analyzeCustomTheme(value).validJson ? undefined : new Error(t('customThemes.invalidJson'))
        ),
      trigger: ['blur', 'change']
    }
  ]
}));

async function confirmDiscard(): Promise<boolean> {
  if (!unsaved.value) return true;
  try {
    await ElMessageBox.confirm(t('customThemes.discard'), t('customThemes.title'), {
      type: 'warning',
      confirmButtonText: t('customThemes.discardAction'),
      cancelButtonText: t('customThemes.cancel')
    });
    return true;
  } catch {
    return false;
  }
}
async function load(source: string, id?: CustomTheme['id'], builtin?: BuiltinTheme): Promise<void> {
  if (!(await confirmDiscard())) return;
  selectedId.value = id;
  selectedBuiltin.value = builtin;
  draft.source = source;
  baseline.value = source;
  form.value?.clearValidate();
}
function rowSource(item: ThemeRow): string {
  return item.source ?? service.builtinSource(item.id as BuiltinTheme, item.name);
}
async function selectTheme(item: ThemeRow): Promise<void> {
  try {
    await load(
      rowSource(item),
      item.builtin ? undefined : (item.id as CustomTheme['id']),
      item.builtin ? (item.id as BuiltinTheme) : undefined
    );
  } catch {
    ElMessage.error(t('customThemes.paletteFailed'));
  }
}
async function reset(): Promise<void> {
  if (!dirty.value) return;
  try {
    await ElMessageBox.confirm(t('customThemes.resetConfirm'), t('customThemes.title'), {
      type: 'warning',
      confirmButtonText: t('customThemes.reset'),
      cancelButtonText: t('customThemes.cancel')
    });
  } catch {
    return;
  }
  draft.source = baseline.value;
  form.value?.clearValidate();
}
function applyTheme(item: ThemeRow): void {
  try {
    service.setTheme(item.id);
  } catch {
    ElMessage.error(t('customThemes.storageFailed'));
  }
}
function themeAction(item: ThemeRow, command: string): void {
  if (command === 'duplicate') duplicate(item);
  else if (command === 'remove' && !item.builtin) void remove({ id: item.id as CustomTheme['id'] });
}
async function save(): Promise<void> {
  if (isBuiltin.value) return;
  if (!(await form.value?.validate().catch(() => false))) return;
  try {
    const item = service.saveCustomTheme(draft.source, selectedId.value);
    selectedId.value = item.id;
    baseline.value = draft.source;
    ElMessage.success(t('customThemes.saved'));
  } catch {
    ElMessage.error(t('customThemes.storageFailed'));
  }
}
async function remove(item: Pick<CustomTheme, 'id'>): Promise<void> {
  try {
    await ElMessageBox.confirm(t('customThemes.deleteConfirm'), t('customThemes.title'), {
      type: 'warning',
      confirmButtonText: t('customThemes.remove'),
      cancelButtonText: t('customThemes.cancel')
    });
  } catch {
    return;
  }
  try {
    service.deleteCustomTheme(item.id);
    if (selectedId.value === item.id) {
      selectedId.value = undefined;
      baseline.value = draft.source;
    }
    ElMessage.success(t('customThemes.deleted'));
  } catch {
    ElMessage.error(t('customThemes.storageFailed'));
  }
}
function duplicate(item: ThemeRow): void {
  try {
    void load(
      service.duplicateSource(rowSource(item), t('customThemes.copyName', { name: item.name }))
    );
  } catch {
    ElMessage.error(t('customThemes.paletteFailed'));
  }
}
async function importFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    await load(await file.text());
  } catch {
    ElMessage.error(t('customThemes.importFailed'));
  }
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(draft.source);
    ElMessage.success(t('customThemes.copied'));
  } catch {
    ElMessage.error(t('customThemes.copyFailed'));
  }
}
async function exportFile(): Promise<void> {
  if (!(await form.value?.validate().catch(() => false))) return;
  const url = URL.createObjectURL(new Blob([draft.source], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(analysis.value.name ?? 'theme').replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 80)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function format(): void {
  if (isBuiltin.value) return;
  if (analysis.value.validJson) draft.source = JSON.stringify(JSON.parse(draft.source), null, 2);
  else void form.value?.validate().catch(() => false);
}
function beforeUnload(event: BeforeUnloadEvent): void {
  if (unsaved.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => {
  paletteReady.value = true;
  void selectTheme(themes.value[0]!);
  window.addEventListener('beforeunload', beforeUnload);
});
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
</script>

<template>
  <section class="theme-settings">
    <h2>{{ t('customThemes.title') }}</h2>
    <p class="summary">{{ t('customThemes.summary') }}</p>
    <div class="actions">
      <el-button :icon="Upload" @click="fileInput?.click()">{{
        t('customThemes.import')
      }}</el-button>
      <input
        ref="fileInput"
        class="file-input"
        type="file"
        accept=".json,application/json"
        :aria-label="t('customThemes.import')"
        @change="importFile"
      />
    </div>
    <ul class="theme-options" :aria-label="t('customThemes.title')">
      <li
        v-for="item in themeOptions"
        :key="item.id"
        class="theme-option"
        :class="{
          selected: item.id === (selectedBuiltin ?? selectedId),
          active: item.id === service.theme.value
        }"
      >
        <button
          type="button"
          class="theme-choice"
          :aria-label="t('customThemes.inspect', { name: item.name })"
          :aria-pressed="item.id === (selectedBuiltin ?? selectedId)"
          @click="selectTheme(item)"
        >
          <span class="theme-swatches" aria-hidden="true">
            <span
              v-for="token in swatchTokens"
              :key="token"
              :style="{ backgroundColor: item.colors[token] }"
            ></span>
          </span>
          <span class="theme-name">{{ item.name }}</span>
          <span v-if="item.builtin" class="theme-meta">{{ t('customThemes.builtin') }}</span>
        </button>
        <div class="theme-controls">
          <el-button
            link
            :icon="Check"
            :disabled="service.theme.value === item.id"
            @click="applyTheme(item)"
          >
            {{ t(service.theme.value === item.id ? 'customThemes.active' : 'customThemes.apply') }}
          </el-button>
          <el-dropdown trigger="click" @command="themeAction(item, $event)">
            <el-button
              text
              :icon="MoreFilled"
              :aria-label="t('customThemes.moreActions', { name: item.name })"
            />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="duplicate" :icon="CopyDocument">{{
                  t('customThemes.duplicate')
                }}</el-dropdown-item>
                <el-dropdown-item v-if="!item.builtin" command="remove" :icon="Delete" divided>{{
                  t('customThemes.remove')
                }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </li>
    </ul>
    <div class="editor-heading">
      <h3>
        {{
          isBuiltin
            ? t('customThemes.view')
            : selectedId
              ? t('customThemes.edit')
              : t('customThemes.newTheme')
        }}
      </h3>
      <el-tag v-if="unsaved" type="warning">{{ t('customThemes.unsaved') }}</el-tag>
    </div>
    <div class="editor-layout">
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" @submit.prevent="save">
        <div class="actions">
          <el-button v-if="!isBuiltin" :icon="Check" type="primary" native-type="submit">{{
            t('customThemes.save')
          }}</el-button>
          <el-button v-if="!isBuiltin" :icon="SetUp" @click="format">{{
            t('customThemes.format')
          }}</el-button>
          <el-button v-if="!isBuiltin" :icon="RefreshLeft" :disabled="!dirty" @click="reset">{{
            t('customThemes.reset')
          }}</el-button>
          <el-button :icon="CopyDocument" @click="copy">{{ t('customThemes.copyJson') }}</el-button>
          <el-button :icon="Download" @click="exportFile">{{ t('customThemes.export') }}</el-button>
        </div>
        <el-form-item :label="t('customThemes.json')" prop="source">
          <template #label>
            <span class="editor-label"
              >{{ t('customThemes.json') }}<ThemeTokenHelp :colors="previewColors"
            /></span>
          </template>
          <el-input
            v-model="draft.source"
            type="textarea"
            :rows="20"
            :readonly="isBuiltin"
            spellcheck="false"
            :aria-label="t('customThemes.json')"
            class="json-editor"
          />
        </el-form-item>
      </el-form>
      <aside :aria-label="t('customThemes.inspector')">
        <div class="validation" aria-live="polite">
          <el-alert
            v-if="!analysis.validJson"
            type="error"
            :closable="false"
            show-icon
            :title="t('customThemes.invalidJson')"
          />
          <el-alert
            v-else-if="analysis.warnings.length"
            type="warning"
            :closable="false"
            show-icon
            :title="t('customThemes.warningSummary', { count: analysis.warnings.length })"
          />
          <el-alert
            v-else
            type="success"
            :closable="false"
            show-icon
            :title="t('customThemes.valid')"
          />
          <ul v-if="analysis.warnings.length" class="warnings">
            <li v-for="(warning, index) in analysis.warnings" :key="index">
              {{ t(`customThemes.warnings.${warning.code}`, { field: warning.field }) }}
            </li>
          </ul>
        </div>
        <div class="preview-heading">
          <h3>{{ t('customThemes.preview') }}</h3>
          <el-button :icon="ZoomIn" @click="expandedPreview = true">{{
            t('customThemes.expandPreview')
          }}</el-button>
        </div>
        <p class="summary">{{ t('customThemes.previewHint') }}</p>
        <ThemePreview :name="analysis.name ?? t('customThemes.untitled')" :colors="previewColors" />
      </aside>
    </div>
    <el-dialog
      v-if="expandedPreview"
      v-model="expandedPreview"
      :title="t('customThemes.preview')"
      width="min(54rem, calc(100vw - 32px))"
      append-to-body
    >
      <ThemePreview
        :name="analysis.name ?? t('customThemes.untitled')"
        :colors="previewColors"
        expanded
      />
    </el-dialog>
  </section>
</template>

<style scoped>
.theme-settings {
  padding: 1.25rem;
  min-width: 0;
  overflow: auto;
}
h2 {
  font-size: 1.071rem;
  margin: 0 0 0.6rem;
}
h3 {
  font-size: 1rem;
  margin: 0;
}
.summary {
  color: var(--mar-text-secondary);
  font-size: 0.929rem;
  line-height: 1.6;
  margin: 0.5rem 0 1rem;
}
.actions,
.editor-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.preview-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.actions {
  margin-bottom: 1rem;
}
.actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.file-input {
  display: none;
}
.theme-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  gap: 0.75rem;
  max-height: 19rem;
  overflow: auto;
  margin: 0;
  padding: 2px;
  list-style: none;
}
.theme-option {
  min-width: 0;
  border: 1px solid var(--mar-border-default);
  border-radius: 6px;
  background: var(--mar-bg-panel);
}
.theme-option.selected {
  border-color: var(--mar-color-brand);
}
.theme-choice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.75rem;
  border: 0;
  border-radius: 5px;
  text-align: left;
  font: inherit;
  color: var(--mar-text-primary);
  background: transparent;
  cursor: pointer;
}
.theme-choice:hover {
  background: var(--mar-fill-row-hover);
}
.theme-choice:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}
.theme-swatches {
  display: flex;
  flex-basis: 100%;
  gap: 0.25rem;
}
.theme-swatches > span {
  width: 1.5rem;
  height: 0.75rem;
  border: 1px solid var(--mar-border-subtle);
  border-radius: 3px;
}
.theme-name {
  overflow-wrap: anywhere;
}
.theme-meta {
  font-size: 0.857rem;
  color: var(--mar-text-secondary);
}
.theme-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.5rem 0.5rem 0.75rem;
}
.theme-option.active .theme-controls :deep(.el-button.is-disabled) {
  color: var(--mar-color-success-text);
}
.editor-heading {
  margin: 1.25rem 0 0.75rem;
}
.editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(18rem, 1fr);
  gap: 1.5rem;
  align-items: start;
}
.editor-layout > * {
  min-width: 0;
}
.json-editor :deep(textarea) {
  font-family: var(--mar-font-mono);
  font-size: 0.929rem;
  line-height: 1.6;
  tab-size: 2;
}
aside {
  border-left: 1px solid var(--mar-border-default);
  padding-left: 1.5rem;
}
.validation {
  margin-bottom: 0.75rem;
}
.warnings {
  padding-left: 1.25rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
  max-height: 18rem;
  overflow: auto;
  color: var(--mar-color-warning-text);
}
.warnings li + li {
  margin-top: 0.5rem;
}
.editor-label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
@media (min-width: 1001px) {
  .editor-layout > :deep(.el-form) {
    display: flex;
    flex-direction: column;
    align-self: stretch;
  }
  .editor-layout :deep(.el-form-item) {
    display: flex;
    flex: 1;
    flex-direction: column;
    margin-bottom: 0;
  }
  .editor-layout :deep(.el-form-item__content) {
    align-items: stretch;
  }
  .json-editor {
    display: flex;
  }
  .json-editor :deep(textarea) {
    flex: 1;
    resize: none;
  }
}
@media (max-width: 1000px) {
  .editor-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  aside {
    border-left: 0;
    border-top: 1px solid var(--mar-border-default);
    padding: 1rem 0 0;
  }
}
</style>
