<script
  setup
  lang="ts"
  generic="Secret extends EnvironmentSecretSummary<string> = EnvironmentSecretSummary<string>"
>
import { showMessage } from '../../service/MessageFeedbackService.js';
import { marIcon } from '../../util/mar-icons.js';
import { tooltipOptions } from '../../util/tooltip.js';
import { ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import {
  createEnvironmentSecretService,
  environmentSecretNameError,
  environmentSecretValueError,
  type EnvironmentSecretSummary,
  type EnvironmentSecretInput
} from '../../service/EnvironmentSecretService';
import {
  managementUrlValues,
  replaceManagementUrlValues
} from '../../service/ManagementUrlService';
import { translate } from '../../service/LocalePreferenceService';
import { errorMessage } from '../../util/workbench-presentation';
import { createManagementPageService } from '../../service/ManagementPageService';
import ManagementPagination from './ManagementPagination.vue';
import LoadingPanel from '../common/LoadingPanel.vue';

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly scopes: readonly string[];
  readonly nodeId?: string;
  readonly workspaceId?: string;
  readonly active?: boolean;
  readonly writable?: boolean;
  readonly scopeLabel?: (scope: string) => string;
  readonly ownerLabel?: (secret: Secret) => string;
  readonly visibilityLabel?: (secret: Secret) => string;
  readonly showOwnership?: boolean;
  readonly formContext?: Readonly<Record<string, unknown>>;
  readonly formRules?: FormRules;
  readonly submitCreate?: (input: EnvironmentSecretInput<string>) => Promise<void>;
}>();

const emit = defineEmits<{ create: []; clearForm: [] }>();
const service = createEnvironmentSecretService<Secret, EnvironmentSecretInput<string>>(
  props.request
);
const secrets = shallowRef<readonly Secret[]>([]);
const operationLoading = ref(false);
const refreshLoading = ref(false);
const dialogOpen = ref(false);
const editing = shallowRef<Secret>();
const secretDetailsOpen = ref(false);
const secretDetails = shallowRef<Secret>();
const scope = ref<string>(props.scopes[0] ?? 'PERSONAL');
const name = ref('');
const value = ref('');
const keyword = ref('');
const formRef = ref<FormInstance>();
const urlNamespace =
  props.workspaceId !== undefined
    ? `workspace-secret-${props.workspaceId}`
    : props.nodeId === undefined
      ? 'secrets'
      : `node-secret-${props.nodeId}`;
keyword.value = managementUrlValues(urlNamespace, ['keyword']).keyword ?? '';
watch(keyword, () => replaceManagementUrlValues(urlNamespace, { keyword: keyword.value }));
const rules = computed<FormRules>(() => ({
  ...props.formRules,
  name: [
    {
      validator: (_rule, input, callback) => {
        const error = environmentSecretNameError(String(input ?? '').trim());
        error === undefined ? callback() : callback(new Error(error));
      },
      trigger: 'blur'
    }
  ],
  value: [
    {
      validator: (_rule, input, callback) => {
        const error = environmentSecretValueError(String(input ?? ''));
        error === undefined ? callback() : callback(new Error(error));
      },
      trigger: 'blur'
    }
  ]
}));
const visibleSecrets = computed(() =>
  secrets.value.filter(
    (secret) =>
      props.scopes.includes(secret.scope) &&
      (secret.scope !== 'NODE' || secret.nodeId === props.nodeId) &&
      (secret.scope !== 'WORKSPACE' ||
        (secret.nodeId === props.nodeId && secret.workspaceId === props.workspaceId)) &&
      (keyword.value.trim() === '' ||
        secret.name.toLowerCase().includes(keyword.value.trim().toLowerCase()))
  )
);
// Node/Workspace secret tabs must show the complete target configuration.
const targetScoped = computed(() => props.nodeId !== undefined || props.workspaceId !== undefined);
const sortBy = ref<string>();
const sortOrder = ref<string>();
const pagination = createManagementPageService<Secret>({
  read: (page) =>
    service.listPage(page, {
      keyword: keyword.value,
      scopes: props.scopes.join(','),
      sortBy: sortBy.value,
      sortOrder: sortOrder.value
    }),
  key: (secret) => secret.id,
  context: () =>
    JSON.stringify([
      props.nodeId,
      props.workspaceId,
      props.scopes,
      keyword.value,
      sortBy.value,
      sortOrder.value
    ]),
  reportError: (error) => showMessage(message(error), 'error', error)
});
const loading = computed(
  () => operationLoading.value || (!targetScoped.value && pagination.loading.value)
);
const regionLoading = computed(
  () =>
    (operationLoading.value && !refreshLoading.value) ||
    (!targetScoped.value &&
      pagination.loading.value &&
      !pagination.loadingMore.value &&
      !refreshLoading.value)
);
const displayedSecrets = computed(() =>
  targetScoped.value ? visibleSecrets.value : pagination.items.value
);
watch([keyword, sortBy, sortOrder, () => props.scopes], () => {
  if (!targetScoped.value) void pagination.load(true);
});
function sortSecrets(input: { prop?: string; order?: string | null }): void {
  if (targetScoped.value) return;
  sortBy.value = input.order ? input.prop : undefined;
  sortOrder.value = input.order === 'descending' ? 'desc' : input.order ? 'asc' : undefined;
}

async function load(): Promise<void> {
  if (!targetScoped.value) {
    await pagination.load(true);
    return;
  }
  operationLoading.value = true;
  try {
    const result = await service.list(props.nodeId, props.workspaceId);
    secrets.value = result.secrets;
  } catch (caught) {
    showMessage(message(caught), 'error', caught);
  } finally {
    operationLoading.value = false;
  }
}
async function refresh(): Promise<void> {
  refreshLoading.value = true;
  try {
    await load();
  } finally {
    refreshLoading.value = false;
  }
}

function openCreate(): void {
  editing.value = undefined;
  scope.value = props.scopes[0] ?? 'PERSONAL';
  name.value = '';
  value.value = '';
  emit('create');
  dialogOpen.value = true;
}

function openReplace(secret: Secret): void {
  editing.value = secret;
  scope.value = secret.scope;
  name.value = secret.name;
  value.value = secret.value;
  dialogOpen.value = true;
}

function openSecretDetails(secret: Secret): void {
  secretDetails.value = secret;
  secretDetailsOpen.value = true;
}

function scopeLabel(scope: string): string {
  return (
    props.scopeLabel?.(scope) ??
    (scope === 'PERSONAL'
      ? translate('generated.environmentSecretManager.personal')
      : scope === 'NODE'
        ? translate('generated.environmentSecretManager.node')
        : scope === 'WORKSPACE'
          ? translate('generated.environmentSecretManager.workspace')
          : scope)
  );
}
function secretScopeLabel(secret: Secret): string {
  return scopeLabel(secret.scope);
}
function secretOwnerLabel(secret: Secret): string {
  return (
    props.ownerLabel?.(secret) ??
    (secret.scope === 'PERSONAL' ? translate('generated.environmentSecretManager.personal2') : '-')
  );
}
function secretVisibilityLabel(secret: Secret): string {
  return props.visibilityLabel?.(secret) ?? '-';
}

async function save(): Promise<void> {
  if (props.writable === false || loading.value) return;
  if (!(await formRef.value?.validate().catch(() => false))) return;
  operationLoading.value = true;
  try {
    if (editing.value === undefined)
      await (props.submitCreate ?? service.create)({
        scope: scope.value,
        name: name.value.trim(),
        value: value.value,
        ...((scope.value === 'NODE' || scope.value === 'WORKSPACE') && props.nodeId !== undefined
          ? { nodeId: props.nodeId }
          : {}),
        ...(scope.value === 'WORKSPACE' && props.workspaceId !== undefined
          ? { workspaceId: props.workspaceId }
          : {})
      });
    else await service.replace(editing.value.id, value.value);
    dialogOpen.value = false;
    clearForm();
    await load();
  } catch (caught) {
    showMessage(message(caught), 'error', caught);
  } finally {
    operationLoading.value = false;
  }
}

async function remove(secret: Secret): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate(
        'generated.environmentSecretManager.deleteEnvironmentSecretNewConversationRunsAnd',
        { value0: secret.name }
      ),
      translate('generated.environmentSecretManager.deleteSecret'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        confirmButtonText: translate('generated.environmentSecretManager.deleteSecret2'),
        cancelButtonText: translate('generated.environmentSecretManager.cancel'),
        type: 'warning'
      }
    );
  } catch {
    return;
  }
  operationLoading.value = true;
  try {
    await service.remove(secret.id);
    await load();
  } catch (caught) {
    showMessage(message(caught), 'error', caught);
  } finally {
    operationLoading.value = false;
  }
}

function clearForm(): void {
  editing.value = undefined;
  name.value = '';
  value.value = '';
  emit('clearForm');
}

watch(
  () => [props.nodeId, props.workspaceId] as const,
  () => {
    dialogOpen.value = false;
    secretDetailsOpen.value = false;
    secretDetails.value = undefined;
    clearForm();
    void load();
  }
);
watch(
  () => props.active,
  (active) => {
    if (active === false) {
      dialogOpen.value = false;
      secretDetailsOpen.value = false;
      secretDetails.value = undefined;
      clearForm();
    }
  }
);
onMounted(() => {
  pagination.start();
  void load();
});
onUnmounted(() => pagination.dispose());

function message(error: unknown): string {
  return errorMessage(error);
}
</script>

<template>
  <LoadingPanel
    :loading="regionLoading"
    variant="region"
    class="secret-manager"
    :aria-label="translate('generated.environmentSecretManager.environmentSecrets')"
  >
    <div class="secret-heading">
      <label class="filter-field"
        ><span>{{ translate('generated.environmentSecretManager.secretName') }}</span
        ><el-input
          v-model="keyword"
          clearable
          :placeholder="translate('generated.environmentSecretManager.enterASecretName')"
          :clear-icon="marIcon('clear-input')"
      /></label>
    </div>
    <div class="secret-toolbar">
      <el-button
        :icon="marIcon('refresh')"
        :loading="refreshLoading"
        @click="refresh"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('generated.environmentSecretManager.refresh') }}</el-button
      >
      <el-button
        v-if="writable !== false"
        type="primary"
        :icon="marIcon('plus')"
        @click="openCreate"
        >{{ translate('generated.environmentSecretManager.addSecret') }}</el-button
      >
    </div>
    <el-table
      :data="displayedSecrets"
      class="clickable-rows secret-table"
      :aria-label="translate('generated.environmentSecretManager.environmentSecretList')"
      row-key="id"
      @row-click="openSecretDetails"
      @sort-change="sortSecrets"
    >
      <el-table-column
        prop="name"
        :label="translate('generated.environmentSecretManager.name')"
        :sortable="targetScoped ? true : 'custom'"
        min-width="150"
      >
        <template #default="{ row }">
          <el-tooltip v-bind="tooltipOptions" :content="row.name"
            ><span>{{ row.name }}</span></el-tooltip
          >
        </template>
      </el-table-column>
      <el-table-column
        prop="value"
        :label="translate('generated.environmentSecretManager.value')"
        :sortable="targetScoped ? true : 'custom'"
        min-width="170"
      >
        <template #default="{ row }">
          <el-tooltip v-bind="tooltipOptions" :content="row.value"
            ><code class="secret-value">{{ row.value }}</code></el-tooltip
          >
        </template>
      </el-table-column>
      <el-table-column
        prop="scope"
        :label="translate('generated.environmentSecretManager.scope')"
        :sortable="targetScoped ? true : 'custom'"
        width="100"
      >
        <template #default="{ row }">{{ secretScopeLabel(row) }}</template>
      </el-table-column>
      <el-table-column
        v-if="showOwnership === true"
        :label="translate('generated.environmentSecretManager.owner')"
        min-width="150"
      >
        <template #default="{ row }">
          {{ secretOwnerLabel(row) }}
        </template>
      </el-table-column>
      <el-table-column
        v-if="showOwnership === true"
        :label="translate('generated.environmentSecretManager.visibility')"
        width="110"
      >
        <template #default="{ row }">
          {{ secretVisibilityLabel(row) }}
        </template>
      </el-table-column>
      <el-table-column
        :label="translate('generated.environmentSecretManager.actions')"
        :width="180"
      >
        <template #default="{ row }">
          <div class="row-actions" @click.stop>
            <el-button
              link
              :icon="marIcon('edit')"
              :disabled="writable === false"
              @click="openReplace(row)"
              >{{ translate('generated.environmentSecretManager.updateValue') }}</el-button
            >
            <el-button
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="writable === false"
              @click="remove(row)"
              >{{ translate('generated.environmentSecretManager.delete') }}</el-button
            >
          </div>
        </template>
      </el-table-column>
    </el-table>
    <ManagementPagination
      v-if="!targetScoped"
      :total="pagination.total.value"
      :has-more="pagination.hasMore.value"
      :page="pagination.page.value"
      :mobile="pagination.mobileViewport.value"
      :mobile-visible-count="pagination.mobileVisibleCount.value"
      :loading="loading"
      :loading-more="pagination.loadingMore.value"
      @page="pagination.setPage"
      @load-more="pagination.loadMore"
    />
    <el-dialog
      v-if="secretDetailsOpen && secretDetails"
      v-model="secretDetailsOpen"
      :title="secretDetails.name"
      width="min(720px, calc(100vw - 32px))"
      append-to-body
      @closed="secretDetails = undefined"
      :close-icon="marIcon('close')"
    >
      <el-descriptions :column="1" border>
        <el-descriptions-item :label="translate('generated.environmentSecretManager.name')">
          <code>{{ secretDetails.name }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.environmentSecretManager.scope')">
          {{ secretScopeLabel(secretDetails) }}
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.environmentSecretManager.owner')">
          {{ secretOwnerLabel(secretDetails) }}
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.environmentSecretManager.visibility')">
          {{ secretVisibilityLabel(secretDetails) }}
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="secretDetailsOpen = false">{{ translate('common.close') }}</el-button>
      </template>
    </el-dialog>
    <el-dialog
      v-if="dialogOpen"
      v-model="dialogOpen"
      :title="
        editing === undefined
          ? translate('generated.environmentSecretManager.addSecret2')
          : translate('generated.environmentSecretManager.updateSecretValue')
      "
      width="min(440px, calc(100vw - 32px))"
      append-to-body
      @closed="clearForm"
      :close-icon="marIcon('close')"
    >
      <el-form
        ref="formRef"
        :model="{ ...formContext, name, value }"
        :rules="rules"
        label-position="top"
        @submit.prevent="save"
      >
        <el-form-item
          v-if="editing === undefined && scopes.length > 1"
          :label="translate('generated.environmentSecretManager.scope2')"
        >
          <el-select
            v-model="scope"
            :placeholder="translate('generated.environmentSecretManager.selectAScope')"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><el-option v-for="item in scopes" :key="item" :value="item" :label="scopeLabel(item)"
          /></el-select>
        </el-form-item>
        <slot v-if="editing === undefined" name="create-fields" :scope="scope" />
        <el-form-item
          :label="translate('generated.environmentSecretManager.environmentVariableName')"
          prop="name"
          ><el-input
            v-model="name"
            :placeholder="
              translate('generated.environmentSecretManager.enterAnEnvironmentVariableName')
            "
            :disabled="editing !== undefined"
            autocomplete="off"
        /></el-form-item>
        <el-form-item
          :label="translate('generated.environmentSecretManager.secretValue')"
          prop="value"
          ><el-input
            v-model="value"
            :placeholder="translate('generated.environmentSecretManager.enterASecretValue')"
            type="text"
            name="environment-variable-value"
            autocomplete="off"
            :spellcheck="false"
        /></el-form-item>
      </el-form>
      <template #footer
        ><el-button @click="dialogOpen = false">{{
          translate('generated.environmentSecretManager.cancel2')
        }}</el-button
        ><el-button
          type="primary"
          :loading="loading"
          :disabled="writable === false"
          @click="save"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('generated.environmentSecretManager.save') }}</el-button
        ></template
      >
    </el-dialog>
  </LoadingPanel>
</template>

<style scoped>
.secret-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0 8px;
}
.secret-heading .el-input {
  width: min(240px, 100%);
}
.secret-toolbar {
  display: flex;
  min-height: 28px;
  justify-content: flex-start;
  margin-bottom: 8px;
}
.secret-heading h3 {
  margin: 0;
  font-size: var(--mar-font-size-title);
  line-height: 1.4;
}
.secret-heading p {
  margin: 3px 0 0;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
}
.secret-value {
  display: block;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  white-space: nowrap;
}
</style>
