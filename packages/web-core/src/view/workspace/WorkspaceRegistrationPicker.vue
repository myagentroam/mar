<script setup lang="ts">
import { MarCheckbox } from '@myagentroam/mar-ui/checkbox';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarDropdown, MarDropdownMenu, MarDropdownItem } from '@myagentroam/mar-ui/dropdown';
import { MarButton } from '@myagentroam/mar-ui/button';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import FileTypeIcon from '../workspace/FileTypeIcon.vue';
import { computed, reactive, ref, useId, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import { matchesWorkspaceDisplayFilter } from '../../service/workspace-file-tree-service.js';

interface DirectoryListing {
  readonly currentPath: string;
  readonly parentPath: string | null;
  readonly browseRoots: readonly string[];
  readonly selectable: boolean;
  readonly entries: readonly {
    readonly path: string;
    readonly name: string;
    readonly selectable: boolean;
  }[];
  readonly truncated: boolean;
}

const props = defineProps<{
  readonly open: boolean;
  readonly directory: DirectoryListing | undefined;
  readonly selectedPath: string;
  readonly pendingDirectoryName: string;
  readonly loadingDirectory: boolean;
  readonly loading: boolean;
  readonly nodeReady: boolean;
  readonly selectedPathValid: boolean;
  readonly registrationDisabled?: boolean;
  readonly preserveGitConfig?: boolean;
}>();

const emit = defineEmits<{
  'update:preserveGitConfig': [value: boolean];
  close: [];
  navigate: [path?: string];
  select: [path: string];
  'select-pending': [directoryName: string];
  'discard-pending': [];
  register: [];
}>();
const registrationForm = ref<FormInstance>();
const registrationFormId = useId();
const registrationFormValue = computed(() => ({ path: props.selectedPath }));
const registrationRules: FormRules<{ path: string }> = {
  path: {
    validator: (_rule, _value, callback) =>
      props.selectedPathValid
        ? callback()
        : callback(
            new Error(translate('generated.workspaceRegistrationPicker.selectADirectoryToRegister'))
          )
  }
};
const registrationUnavailable = computed(
  () => props.loading || props.loadingDirectory || !props.nodeReady || props.registrationDisabled
);
async function submitRegistration(): Promise<void> {
  const form = registrationForm.value;
  if (form === undefined || registrationUnavailable.value) return;
  if (!(await form.validate().catch(() => false))) return;
  if (registrationForm.value === form && !registrationUnavailable.value) emit('register');
}

function closeRegistration(): void {
  // The parent owns visibility and immediately unmounts the picker on close.
  if (!props.loading) emit('close');
}

const directoryForm = ref<FormInstance>();
const directoryFormId = useId();
const directoryDialogOpen = ref(false);
const displayFilter = ref('');
const directoryFormValue = reactive({ name: '' });
const directoryRules = computed<FormRules<typeof directoryFormValue>>(() => ({
  name: [
    {
      required: true,
      message: translate('generated.workspaceRegistrationPicker.enterADirectoryName'),
      trigger: 'blur'
    },
    {
      validator: (_rule, value: string, callback) => {
        const name = value.trim();
        if (
          name.length === 0 ||
          name.length > 255 ||
          name === '.' ||
          name === '..' ||
          /[\\/\0]/u.test(name)
        ) {
          callback(
            new Error(
              translate(
                'generated.workspaceRegistrationPicker.enterASingleDirectoryNameWithoutPath'
              )
            )
          );
          return;
        }
        callback();
      },
      trigger: ['blur', 'change']
    }
  ]
}));
const canCreateDirectory = computed(() => props.nodeReady && props.directory?.selectable === true);
const breadcrumbs = computed(() => directoryBreadcrumbs(props.directory));
const filteredEntries = computed(
  () =>
    props.directory?.entries.filter((entry) =>
      matchesWorkspaceDisplayFilter(entry.path, displayFilter.value)
    ) ?? []
);
watch(
  () => props.directory,
  (directory) => {
    if (directory !== undefined) return;
    directoryDialogOpen.value = false;
    displayFilter.value = '';
  }
);
function openDirectoryDialog(): void {
  directoryFormValue.name = '';
  directoryDialogOpen.value = true;
}
async function confirmDirectory(): Promise<void> {
  if (!(await directoryForm.value?.validate().catch(() => false))) return;
  emit('select-pending', directoryFormValue.name.trim());
  directoryDialogOpen.value = false;
}

function directoryBreadcrumbs(directory: DirectoryListing | undefined): readonly {
  label: string;
  path: string;
}[] {
  if (directory === undefined) return [];
  const windows = directory.currentPath.includes('\\');
  const separator = windows ? '\\' : '/';
  const comparable = (value: string) => (windows ? value.toLocaleLowerCase() : value);
  const current = comparable(directory.currentPath);
  const root = [...directory.browseRoots]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => {
      const normalized = comparable(candidate).replace(/[\\/]+$/u, '');
      return current === normalized || current.startsWith(`${normalized}${separator}`);
    });
  if (root === undefined) return [{ label: directory.currentPath, path: directory.currentPath }];
  const normalizedRoot = root.replace(/[\\/]+$/u, '');
  const relative = directory.currentPath.slice(normalizedRoot.length).replace(/^[\\/]+/u, '');
  const result = [{ label: root, path: root }];
  let path = normalizedRoot;
  for (const segment of relative.split(/[\\/]/u).filter(Boolean)) {
    path = `${path}${separator}${segment}`;
    result.push({ label: segment, path });
  }
  return result;
}
</script>

<template>
  <el-dialog
    v-if="open"
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    :model-value="open"
    :title="translate('generated.workspaceRegistrationPicker.registerWorkspace')"
    width="min(980px, calc(100vw - 32px))"
    :show-close="!loading"
    :close-icon="marIcon('close')"
    :before-close="closeRegistration"
  >
    <div class="workspace-picker">
      <slot name="ownership" />

      <div v-if="directory !== undefined" class="workspace-picker-toolbar">
        <MarButton
          v-tooltip="translate('generated.workspaceRegistrationPicker.goToParentDirectory2')"
          :aria-label="translate('generated.workspaceRegistrationPicker.goToParentDirectory')"
          :icon="marIcon('chevron-left')"
          :disabled="directory.parentPath === null || loadingDirectory"
          native-type="button"
          text
          @click="emit('navigate', directory.parentPath ?? undefined)"
        >
          {{ translate('generated.workspaceRegistrationPicker.up') }}
        </MarButton>
        <MarDropdown
          v-if="directory.browseRoots.length > 1"
          :disabled="loadingDirectory"
          trigger="click"
          @command="emit('navigate', $event as string)"
        >
          <MarButton native-type="button" text>
            {{ translate('generated.workspaceRegistrationPicker.roots')
            }}<MarIcon name="chevron-down" class="mar-icon--right" />
          </MarButton>
          <template #dropdown>
            <MarDropdownMenu>
              <MarDropdownItem v-for="root in directory.browseRoots" :key="root" :command="root">
                {{ root }}
              </MarDropdownItem>
            </MarDropdownMenu>
          </template>
        </MarDropdown>
        <nav
          class="workspace-picker-breadcrumbs"
          :aria-label="translate('generated.workspaceRegistrationPicker.currentDirectory')"
        >
          <template v-for="(breadcrumb, index) in breadcrumbs" :key="breadcrumb.path">
            <span v-if="index > 0">/</span>
            <MarButton
              v-tooltip="breadcrumb.path"
              v-if="index < breadcrumbs.length - 1"
              :disabled="loadingDirectory"
              text
              @click="emit('navigate', breadcrumb.path)"
            >
              {{ breadcrumb.label }}
            </MarButton>
            <strong v-tooltip="breadcrumb.path" v-else>{{ breadcrumb.label }}</strong>
          </template>
        </nav>
        <div class="workspace-picker-toolbar-actions">
          <MarButton
            v-tooltip="translate('generated.workspaceRegistrationPicker.refreshDirectory2')"
            class="mar-icon-action"
            :aria-label="translate('generated.workspaceRegistrationPicker.refreshDirectory')"
            :icon="marIcon('refresh')"
            :loading="loadingDirectory"
            :aria-busy="loadingDirectory || undefined"
            :disabled="loadingDirectory"
            native-type="button"
            text
            @click="emit('navigate', directory.currentPath)"
          />
          <MarButton
            :icon="marIcon('folder-add')"
            :disabled="!canCreateDirectory || loadingDirectory"
            native-type="button"
            @click="openDirectoryDialog"
          >
            {{ translate('generated.workspaceRegistrationPicker.newDirectory') }}
          </MarButton>
          <MarButton
            :class="{ selected: selectedPath === directory.currentPath }"
            :disabled="loadingDirectory || !directory.selectable"
            :icon="marIcon('check')"
            native-type="button"
            @click="emit('select', directory.currentPath)"
          >
            {{ translate('generated.workspaceRegistrationPicker.selectCurrentDirectory') }}
          </MarButton>
        </div>
      </div>

      <MarInput
        v-if="directory !== undefined"
        v-model="displayFilter"
        class="workspace-picker-filter"
        :aria-label="translate('workspaceDisplayFilter.label')"
        clearable
        :placeholder="translate('workspaceDisplayFilter.placeholder')"
        size="small"
        :clear-icon="marIcon('clear-input')"
      >
        <template #prefix><MarIcon name="search" /></template>
      </MarInput>

      <ul v-if="directory !== undefined" class="workspace-directory-list">
        <li v-if="pendingDirectoryName" class="workspace-directory-row selected">
          <div class="workspace-directory-entry">
            <FileTypeIcon :name="pendingDirectoryName" kind="DIRECTORY" />
            <span>{{ pendingDirectoryName }}</span>
            <MarTag type="warning">{{
              translate('generated.workspaceRegistrationPicker.pending')
            }}</MarTag>
          </div>
          <button
            v-tooltip="translate('generated.workspaceRegistrationPicker.cancelNewDirectory2')"
            class="mar-icon-action mar-icon-action--inline"
            :aria-label="translate('generated.workspaceRegistrationPicker.cancelNewDirectory')"
            type="button"
            @click="emit('discard-pending')"
          >
            <MarIcon name="close" />
          </button>
        </li>
        <li
          v-for="entry in filteredEntries"
          :key="entry.path"
          class="workspace-directory-row"
          :class="{ selected: !pendingDirectoryName && selectedPath === entry.path }"
        >
          <button
            class="workspace-directory-entry"
            :disabled="loadingDirectory || !entry.selectable"
            type="button"
            @click="emit('select', entry.path)"
            @dblclick="emit('navigate', entry.path)"
          >
            <FileTypeIcon :name="entry.name" kind="DIRECTORY" />
            <span>{{ entry.name }}</span>
            <small v-if="!entry.selectable">{{
              translate('generated.workspaceRegistrationPicker.outsideAllowedRoots')
            }}</small>
          </button>
          <button
            v-tooltip="
              translate('generated.workspaceRegistrationPicker.open2', { value0: entry.name })
            "
            class="mar-icon-action mar-icon-action--inline"
            :aria-label="
              translate('generated.workspaceRegistrationPicker.open', { value0: entry.name })
            "
            :disabled="loadingDirectory"
            type="button"
            @click="emit('navigate', entry.path)"
          >
            <MarIcon name="chevron-right" />
          </button>
        </li>
        <li
          v-if="
            displayFilter.trim().length > 0 &&
            filteredEntries.length === 0 &&
            pendingDirectoryName.length === 0
          "
          class="workspace-directory-empty"
        >
          {{ translate('workspaceDisplayFilter.empty') }}
        </li>
      </ul>
      <p v-else-if="loadingDirectory" class="workspace-picker-empty">
        {{ translate('generated.workspaceRegistrationPicker.loadingAllowedRoots') }}
      </p>
      <p v-else class="workspace-picker-empty">
        {{ translate('generated.workspaceRegistrationPicker.selectADirectoryToRegister') }}
      </p>
      <p v-if="directory?.truncated" class="workspace-picker-empty">
        {{ translate('generated.workspaceRegistrationPicker.onlyTheFirst200ChildDirectoriesAre') }}
      </p>
      <MarForm
        :id="registrationFormId"
        ref="registrationForm"
        :model="registrationFormValue"
        :rules="registrationRules"
        class="workspace-picker"
        @submit.prevent="submitRegistration"
      >
        <MarCheckbox
          :model-value="preserveGitConfig ?? false"
          :disabled="loading || !nodeReady"
          @update:model-value="emit('update:preserveGitConfig', $event === true)"
          >{{ translate('personalGit.preserve') }}</MarCheckbox
        >
        <MarFormItem prop="path" class="workspace-picker-selection">
          <code v-tooltip="selectedPath" v-if="selectedPath"
            >{{ translate('generated.workspaceRegistrationPicker.selected') }}
            {{ selectedPath }}</code
          >
        </MarFormItem>
      </MarForm>
    </div>

    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="directoryDialogOpen"
      v-model="directoryDialogOpen"
      :title="translate('generated.workspaceRegistrationPicker.newDirectory2')"
      width="min(460px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
      append-to-body
    >
      <MarForm
        :id="directoryFormId"
        ref="directoryForm"
        :model="directoryFormValue"
        :rules="directoryRules"
        label-position="top"
        @submit.prevent="confirmDirectory"
      >
        <MarFormItem
          :label="translate('generated.workspaceRegistrationPicker.directoryName')"
          prop="name"
        >
          <MarInput
            v-model="directoryFormValue.name"
            maxlength="255"
            :placeholder="translate('generated.workspaceRegistrationPicker.enterADirectoryName2')"
          />
        </MarFormItem>
      </MarForm>
      <template #footer>
        <MarButton native-type="button" @click="directoryDialogOpen = false">{{
          translate('generated.workspaceRegistrationPicker.cancel')
        }}</MarButton>
        <MarButton :form="directoryFormId" native-type="submit" type="primary">{{
          translate('generated.workspaceRegistrationPicker.confirm')
        }}</MarButton>
      </template>
    </el-dialog>
    <template #footer>
      <MarButton native-type="button" :disabled="loading" @click="closeRegistration">{{
        translate('generated.workspaceRegistrationPicker.cancel')
      }}</MarButton>
      <MarButton
        :form="registrationFormId"
        :disabled="registrationUnavailable || !selectedPathValid"
        :loading="loading"
        native-type="submit"
        type="primary"
      >
        {{
          pendingDirectoryName
            ? translate('generated.workspaceRegistrationPicker.createAndRegister')
            : translate('generated.workspaceRegistrationPicker.registerWorkspace')
        }}
      </MarButton>
    </template>
  </el-dialog>
</template>

<style scoped>
.workspace-picker {
  display: grid;
  gap: 0.65rem;
}

.workspace-picker-toolbar {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.55rem;
}

.workspace-picker-empty {
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.workspace-picker-toolbar {
  min-height: 34px;
  border-bottom: 1px solid var(--mar-border-medium);
  padding-bottom: 0.45rem;
}

.workspace-picker-toolbar-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.55rem;
}

.workspace-picker-breadcrumbs {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 0.15rem;
  overflow: hidden;
  color: var(--mar-text-secondary);
}

.workspace-picker-breadcrumbs .mar-ui-button,
.workspace-picker-breadcrumbs strong {
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  padding-inline: 0.2rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-directory-list {
  margin: 0;
  border: 1px solid var(--mar-border-medium);
  border-radius: 4px;
  padding: 0;
  list-style: none;
}

.workspace-picker-filter {
  width: 100%;
}

.workspace-directory-list > .workspace-directory-empty {
  display: block;
  border-bottom: 0;
  color: var(--mar-text-secondary);
  padding: 0.65rem;
  font-size: var(--mar-font-size-meta);
}

.workspace-directory-row {
  display: flex;
  min-width: 0;
  align-items: center;
  border-bottom: 1px solid var(--mar-fill-hover);
}

.workspace-directory-row:last-child {
  border-bottom: 0;
}

.workspace-directory-row:not(.selected):hover:has(> button:not(:disabled)) {
  background: var(--mar-fill-row-hover);
}

.workspace-directory-row.selected {
  background: var(--mar-fill-selection);
}

.workspace-directory-entry {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 0.45rem;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mar-text-primary);
  padding: 0.5rem 0.65rem;
  text-align: left;
}

button.workspace-directory-entry {
  cursor: pointer;
}

button.workspace-directory-entry:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.workspace-directory-list span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-directory-list small {
  margin-left: auto;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.workspace-directory-list .mar-ui-tag {
  margin-left: auto;
}

.workspace-directory-row > .mar-icon-action {
  display: inline-grid;
  width: 32px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  cursor: pointer;
}

.workspace-directory-row > .mar-icon-action:disabled {
  cursor: wait;
  opacity: 0.5;
}

.workspace-picker-selection {
  min-width: 0;
  margin: 0;
}

.workspace-picker-selection code {
  min-width: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 767px) {
  .workspace-picker {
    gap: 0.5rem;
  }

  .workspace-picker-toolbar {
    min-height: 0;
    flex-wrap: wrap;
    gap: 0.35rem;
    padding-bottom: 0.35rem;
  }

  .workspace-picker-toolbar-actions {
    width: 100%;
    flex-basis: 100%;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.35rem;
  }

  .workspace-picker-toolbar-actions :deep(.mar-ui-button) {
    padding-inline: 0.65rem;
  }
}
</style>
