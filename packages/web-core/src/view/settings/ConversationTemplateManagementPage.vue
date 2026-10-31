<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessageBox } from '../../service/message-box-service.js';
import type {
  ConversationTemplateDraft,
  ConversationTemplatePublishJob
} from '@myagentroam/protocol';
import type { FormInstance, FormRules, TagProps } from 'element-plus';
import type { NodeSummary, Workspace } from '../../model/workbench.js';
import {
  conversationTemplateBytesToMiB,
  conversationTemplateErrorMessageKey,
  conversationTemplateModelReferences,
  conversationTemplateModelSelectionIsAvailable,
  conversationTemplateMiBToBytes,
  createConversationTemplateService,
  reconcileConversationTemplateModelSelection,
  sameConversationTemplateRequestContext,
  type AdminConversationTemplateSummary,
  type ConversationTemplateDetail,
  type ConversationTemplateMcpOption,
  type ConversationTemplateModelOption,
  type ConversationTemplateRequestContext
} from '../../service/conversation-template-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { errorCode } from '../../util/api-error.js';
import { errorMessage, fileSizeLabel } from '../../util/workbench-presentation.js';
import { createManagementPageService } from '../../service/management-page-service.js';
import ManagementPagination from '@myagentroam/web-core/ManagementPagination.vue';

interface DraftForm {
  nodeId: string;
  workspaceId: string;
  name: string;
  description: string;
  allowedModels: string[];
  defaultModelId: string;
  mcpIds: string[];
  networkMode: 'NONE' | 'UNRESTRICTED';
  maxStorageMiB: number;
  maxUploadMiB: number;
  draftRevision?: number;
}

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly nodes: readonly NodeSummary[];
  readonly eligibleNode?: (node: NodeSummary) => boolean;
}>();

const service = createConversationTemplateService(props.request);
const sortBy = ref<string>();
const sortOrder = ref<string>();
const pagination = createManagementPageService<AdminConversationTemplateSummary>({
  read: (page) => service.listAdminPage(page, sortBy.value, sortOrder.value),
  key: (template) => template.id,
  context: () => JSON.stringify([sortBy.value, sortOrder.value])
});
const templates = pagination.items;
const models = ref<readonly ConversationTemplateModelOption[]>([]);
const workspaces = ref<readonly Workspace[]>([]);
const mcpOptions = ref<readonly ConversationTemplateMcpOption[]>([]);
const detailWorkspaces = ref<readonly Workspace[]>([]);
const operationLoading = ref(false);
const loading = computed(() => operationLoading.value || pagination.loading.value);
const pageReady = ref(false);
const refreshLoading = ref(false);
const modelLoading = ref(false);
const mcpLoading = ref(false);
const saving = ref(false);
const testing = ref(false);
const publishingIds = ref(new Set<string>());
const editDialogOpen = ref(false);
const detailDialogOpen = ref(false);
const editingTemplateId = ref<string>();
const detail = ref<ConversationTemplateDetail>();
const formRef = ref<FormInstance>();
let disposed = false;
let loadingOperations = 0;
let workspaceRequestContext: ConversationTemplateRequestContext = { sequence: 0 };
let modelRequestContext: ConversationTemplateRequestContext = { sequence: 0 };
let mcpRequestContext: ConversationTemplateRequestContext = { sequence: 0 };
let editRequestContext: ConversationTemplateRequestContext = { sequence: 0 };
let detailRequestContext: ConversationTemplateRequestContext = { sequence: 0 };

const draft = reactive<DraftForm>(emptyDraft());

const eligibleNodes = computed(() =>
  props.nodes.filter(
    (node) =>
      node.connected &&
      !node.disabled &&
      (props.eligibleNode?.(node) ?? true) &&
      node.capabilities.conversationHosting?.state === 'AVAILABLE'
  )
);
const availableModels = computed(() => models.value);
const displayedTemplates = templates;
watch(pagination.result, (result) => {
  if (result !== undefined) pageReady.value = true;
});
const modelSelectionAvailable = computed(
  () =>
    !modelLoading.value &&
    conversationTemplateModelSelectionIsAvailable(
      draft.allowedModels,
      draft.defaultModelId,
      models.value
    )
);
const rules = computed<FormRules>(() => ({
  nodeId: [{ required: true, message: translate('conversationTemplates.nodeRequired') }],
  workspaceId: [{ required: true, message: translate('conversationTemplates.workspaceRequired') }],
  name: [
    { required: true, whitespace: true, message: translate('conversationTemplates.nameRequired') }
  ],
  allowedModels: [
    {
      validator: (_rule, _value, callback) =>
        modelSelectionAvailable.value
          ? callback()
          : callback(new Error(translate('conversationTemplates.modelRequired')))
    }
  ],
  defaultModelId: [
    { required: true, message: translate('conversationTemplates.defaultModelRequired') }
  ],
  maxStorageMiB: [
    {
      validator: (_rule, value, callback) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 1
          ? callback()
          : callback(new Error(translate('conversationTemplates.quotaRequired')))
    }
  ],
  maxUploadMiB: [
    {
      validator: (_rule, value, callback) =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 1 &&
        value <= draft.maxStorageMiB
          ? callback()
          : callback(new Error(translate('conversationTemplates.uploadQuotaInvalid')))
    }
  ]
}));

watch(
  () => [...draft.allowedModels],
  (modelIds) => {
    if (!modelIds.includes(draft.defaultModelId)) draft.defaultModelId = modelIds[0] ?? '';
  }
);

function nextRequestContext(
  current: ConversationTemplateRequestContext,
  resourceId?: string
): ConversationTemplateRequestContext {
  return {
    sequence: current.sequence + 1,
    ...(resourceId === undefined ? {} : { resourceId })
  };
}

function beginLoading(): void {
  loadingOperations += 1;
  operationLoading.value = true;
}

function endLoading(): void {
  loadingOperations = Math.max(0, loadingOperations - 1);
  operationLoading.value = loadingOperations > 0;
}

async function load(_showLoading = true): Promise<void> {
  await pagination.load(true);
}
async function refresh(): Promise<void> {
  refreshLoading.value = true;
  try {
    await load();
  } finally {
    refreshLoading.value = false;
  }
}
function sortTemplates(input: { prop?: string; order?: string | null }): void {
  sortBy.value = input.order ? input.prop : undefined;
  sortOrder.value = input.order === 'descending' ? 'desc' : input.order ? 'asc' : undefined;
  void pagination.load(true);
}

function applyModelOptions(nextOptions: readonly ConversationTemplateModelOption[]): void {
  models.value = nextOptions;
  const selection = reconcileConversationTemplateModelSelection(
    draft.allowedModels,
    draft.defaultModelId,
    nextOptions
  );
  draft.allowedModels = selection.allowedModels;
  draft.defaultModelId = selection.defaultModelId;
}

async function loadModelOptions(nodeId: string): Promise<void> {
  const context = (modelRequestContext = nextRequestContext(modelRequestContext, nodeId));
  modelLoading.value = true;
  try {
    const nextOptions = await service.listModelOptions(nodeId);
    if (
      disposed ||
      draft.nodeId !== nodeId ||
      !sameConversationTemplateRequestContext(modelRequestContext, context)
    )
      return;
    applyModelOptions(nextOptions);
  } catch (error) {
    if (
      disposed ||
      draft.nodeId !== nodeId ||
      !sameConversationTemplateRequestContext(modelRequestContext, context)
    )
      return;
    applyModelOptions([]);
    showMessage(templateError(error, 'conversationTemplates.modelsLoadFailed'), 'error', error);
  } finally {
    if (sameConversationTemplateRequestContext(modelRequestContext, context))
      modelLoading.value = false;
  }
}

async function loadWorkspaces(nodeId: string): Promise<void> {
  const context = (workspaceRequestContext = nextRequestContext(workspaceRequestContext, nodeId));
  try {
    const nextWorkspaces = (
      await props.request<{ workspaces: readonly Workspace[] }>(
        `/api/workspaces?nodeId=${encodeURIComponent(nodeId)}`
      )
    ).workspaces;
    if (
      disposed ||
      draft.nodeId !== nodeId ||
      !sameConversationTemplateRequestContext(workspaceRequestContext, context)
    )
      return;
    workspaces.value = nextWorkspaces;
  } catch (error) {
    if (
      disposed ||
      draft.nodeId !== nodeId ||
      !sameConversationTemplateRequestContext(workspaceRequestContext, context)
    )
      return;
    workspaces.value = [];
    showMessage(templateError(error, 'conversationTemplates.workspacesLoadFailed'), 'error', error);
  }
}

async function loadMcpOptions(nodeId: string, workspaceId: string): Promise<void> {
  const target = `${nodeId}:${workspaceId}`;
  const context = (mcpRequestContext = nextRequestContext(mcpRequestContext, target));
  mcpLoading.value = true;
  try {
    const nextOptions = await service.listMcpOptions(nodeId, workspaceId);
    if (
      disposed ||
      draft.nodeId !== nodeId ||
      draft.workspaceId !== workspaceId ||
      !sameConversationTemplateRequestContext(mcpRequestContext, context)
    )
      return;
    mcpOptions.value = nextOptions;
  } catch (error) {
    if (
      disposed ||
      draft.nodeId !== nodeId ||
      draft.workspaceId !== workspaceId ||
      !sameConversationTemplateRequestContext(mcpRequestContext, context)
    )
      return;
    mcpOptions.value = [];
    showMessage(templateError(error, 'conversationTemplates.mcpLoadFailed'), 'error', error);
  } finally {
    if (sameConversationTemplateRequestContext(mcpRequestContext, context))
      mcpLoading.value = false;
  }
}

function changeNode(nodeId: string): void {
  workspaceRequestContext = nextRequestContext(workspaceRequestContext);
  modelRequestContext = nextRequestContext(modelRequestContext);
  mcpRequestContext = nextRequestContext(mcpRequestContext);
  draft.workspaceId = '';
  draft.mcpIds = [];
  workspaces.value = [];
  models.value = [];
  mcpOptions.value = [];
  modelLoading.value = false;
  mcpLoading.value = false;
  if (nodeId !== '') {
    void loadWorkspaces(nodeId);
    void loadModelOptions(nodeId);
  } else {
    applyModelOptions([]);
  }
}

function changeWorkspace(workspaceId: string): void {
  mcpRequestContext = nextRequestContext(mcpRequestContext);
  draft.mcpIds = [];
  mcpOptions.value = [];
  mcpLoading.value = false;
  if (draft.nodeId !== '' && workspaceId !== '') void loadMcpOptions(draft.nodeId, workspaceId);
}

function emptyDraft(): DraftForm {
  return {
    nodeId: '',
    workspaceId: '',
    name: '',
    description: '',
    allowedModels: [],
    defaultModelId: '',
    mcpIds: [],
    networkMode: 'NONE',
    maxStorageMiB: 512,
    maxUploadMiB: 128
  };
}

function resetDraft(next: DraftForm): void {
  Object.assign(draft, next);
}

function openCreate(): void {
  editRequestContext = nextRequestContext(editRequestContext);
  editingTemplateId.value = undefined;
  saving.value = false;
  testing.value = false;
  const nodeId = eligibleNodes.value[0]?.id ?? '';
  resetDraft({ ...emptyDraft(), nodeId });
  workspaces.value = [];
  models.value = [];
  mcpOptions.value = [];
  editDialogOpen.value = true;
  if (nodeId !== '') {
    void loadWorkspaces(nodeId);
    void loadModelOptions(nodeId);
  }
}

async function openEdit(row: AdminConversationTemplateSummary): Promise<void> {
  const context = (editRequestContext = nextRequestContext(editRequestContext, row.id));
  editingTemplateId.value = row.id;
  saving.value = false;
  testing.value = false;
  beginLoading();
  try {
    const current = await service.detail(row.id);
    if (disposed || !sameConversationTemplateRequestContext(editRequestContext, context)) return;
    resetDraft(formFromDraft(current.draft));
    workspaces.value = [];
    models.value = [];
    mcpOptions.value = [];
    await Promise.all([
      loadWorkspaces(current.draft.nodeId),
      loadModelOptions(current.draft.nodeId),
      loadMcpOptions(current.draft.nodeId, current.draft.workspaceId)
    ]);
    if (disposed || !sameConversationTemplateRequestContext(editRequestContext, context)) return;
    editDialogOpen.value = true;
  } catch (error) {
    if (disposed || !sameConversationTemplateRequestContext(editRequestContext, context)) return;
    showMessage(templateError(error, 'conversationTemplates.detailLoadFailed'), 'error', error);
  } finally {
    endLoading();
  }
}

async function openDetail(row: AdminConversationTemplateSummary): Promise<void> {
  const context = (detailRequestContext = nextRequestContext(detailRequestContext, row.id));
  beginLoading();
  try {
    const current = await service.detail(row.id);
    if (disposed || !sameConversationTemplateRequestContext(detailRequestContext, context)) return;
    let nextWorkspaces: readonly Workspace[] = [];
    try {
      nextWorkspaces = (
        await props.request<{ workspaces: readonly Workspace[] }>(
          `/api/workspaces?nodeId=${encodeURIComponent(current.draft.nodeId)}`
        )
      ).workspaces;
    } catch (error) {
      if (disposed || !sameConversationTemplateRequestContext(detailRequestContext, context))
        return;
      showMessage(
        templateError(error, 'conversationTemplates.workspacesLoadFailed'),
        'error',
        error
      );
    }
    if (disposed || !sameConversationTemplateRequestContext(detailRequestContext, context)) return;
    detail.value = current;
    detailWorkspaces.value = nextWorkspaces;
    detailDialogOpen.value = true;
  } catch (error) {
    if (disposed || !sameConversationTemplateRequestContext(detailRequestContext, context)) return;
    showMessage(templateError(error, 'conversationTemplates.detailLoadFailed'), 'error', error);
  } finally {
    endLoading();
  }
}

function closeEditDialog(): void {
  editRequestContext = nextRequestContext(editRequestContext);
  workspaceRequestContext = nextRequestContext(workspaceRequestContext);
  modelRequestContext = nextRequestContext(modelRequestContext);
  mcpRequestContext = nextRequestContext(mcpRequestContext);
  editingTemplateId.value = undefined;
  workspaces.value = [];
  models.value = [];
  mcpOptions.value = [];
  modelLoading.value = false;
  mcpLoading.value = false;
  saving.value = false;
  testing.value = false;
}

function closeDetailDialog(): void {
  detailRequestContext = nextRequestContext(detailRequestContext);
  detail.value = undefined;
  detailWorkspaces.value = [];
}

function formFromDraft(value: ConversationTemplateDraft): DraftForm {
  return {
    nodeId: value.nodeId,
    workspaceId: value.workspaceId,
    name: value.name,
    description: value.description,
    allowedModels: value.allowedModels.map((model) => model.modelId),
    defaultModelId: value.defaultModelId,
    mcpIds: [...value.mcpIds],
    networkMode: value.networkMode,
    maxStorageMiB: conversationTemplateBytesToMiB(value.quotas.maxStorageBytes),
    maxUploadMiB: conversationTemplateBytesToMiB(value.quotas.maxUploadBytes),
    draftRevision: value.revision
  };
}

function draftInput(): Record<string, unknown> {
  return {
    nodeId: draft.nodeId,
    workspaceId: draft.workspaceId,
    name: draft.name,
    description: draft.description,
    allowedModels: conversationTemplateModelReferences(draft.allowedModels, models.value),
    defaultModelId: draft.defaultModelId,
    mcpIds: [...draft.mcpIds],
    networkMode: draft.networkMode,
    quotas: {
      maxStorageBytes: conversationTemplateMiBToBytes(draft.maxStorageMiB),
      maxUploadBytes: conversationTemplateMiBToBytes(draft.maxUploadMiB)
    },
    ...(draft.draftRevision === undefined ? {} : { draftRevision: draft.draftRevision })
  };
}

async function save(): Promise<void> {
  if (!(await formRef.value?.validate().catch(() => false))) return;
  const context = editRequestContext;
  const input = draftInput();
  saving.value = true;
  try {
    if (context.resourceId === undefined) await service.create(input);
    else await service.update(context.resourceId, input);
    if (disposed || !sameConversationTemplateRequestContext(editRequestContext, context)) return;
    editDialogOpen.value = false;
    showMessage(translate('conversationTemplates.saved'), 'success');
    await load(false);
  } catch (error) {
    if (disposed || !sameConversationTemplateRequestContext(editRequestContext, context)) return;
    showMessage(templateError(error, 'conversationTemplates.saveFailed'), 'error', error);
  } finally {
    if (sameConversationTemplateRequestContext(editRequestContext, context)) saving.value = false;
  }
}

async function testDraft(): Promise<void> {
  const context = editRequestContext;
  const templateId = context.resourceId;
  if (templateId === undefined || !(await formRef.value?.validate().catch(() => false))) return;
  const input = draftInput();
  testing.value = true;
  try {
    const inspection = await service.test(templateId, input);
    if (disposed || !sameConversationTemplateRequestContext(editRequestContext, context)) return;
    showMessage(
      inspection.valid
        ? translate('conversationTemplates.testSucceeded')
        : translate('conversationTemplates.testFailed', {
            message: templateFailureMessage(inspection.code, inspection.message)
          }),
      inspection.valid ? 'success' : 'error'
    );
  } catch (error) {
    if (disposed || !sameConversationTemplateRequestContext(editRequestContext, context)) return;
    showMessage(templateError(error, 'conversationTemplates.testFailedFallback'), 'error', error);
  } finally {
    if (sameConversationTemplateRequestContext(editRequestContext, context)) testing.value = false;
  }
}

async function publish(row: AdminConversationTemplateSummary): Promise<void> {
  try {
    const [draftDetail, options] = await Promise.all([
      service.detail(row.id),
      service.listModelOptions(row.nodeId)
    ]);
    if (
      !conversationTemplateModelSelectionIsAvailable(
        draftDetail.draft.allowedModels.map((model) => model.modelId),
        draftDetail.draft.defaultModelId,
        options
      )
    ) {
      showMessage(translate('conversationTemplates.errorModelInvalid'), 'error');
      return;
    }
    await ElMessageBox.confirm(
      translate('conversationTemplates.publishConfirmation', { name: row.name }),
      translate('conversationTemplates.publish'),
      { closeIcon: marIcon('close'), ...confirmationOptions('conversationTemplates.publish') }
    );
    if (disposed) return;
    publishingIds.value = new Set(publishingIds.value).add(row.id);
    let job = await service.publish(row.id, row.draftRevision, crypto.randomUUID());
    job = await awaitPublish(row.id, job);
    if (disposed) return;
    if (job.status === 'SUCCEEDED')
      showMessage(translate('conversationTemplates.publishSucceeded'), 'success');
    else if (job.status === 'FAILED')
      showMessage(
        templateFailureMessage(
          job.errorCode,
          translate('conversationTemplates.publishFailed', {
            code: job.errorCode ?? 'CONVERSATION_TEMPLATE_PUBLISH_FAILED'
          })
        ),
        'error'
      );
    else showMessage(translate('conversationTemplates.publishStillRunning'), 'info');
    await load(false);
    if (disposed || detail.value?.template.id !== row.id) return;
    const context = detailRequestContext;
    const current = await service.detail(row.id);
    if (!disposed && sameConversationTemplateRequestContext(detailRequestContext, context))
      detail.value = current;
  } catch (error) {
    if (!disposed && error !== 'cancel')
      showMessage(
        templateError(error, 'conversationTemplates.publishFailedFallback'),
        'error',
        error
      );
  } finally {
    const next = new Set(publishingIds.value);
    next.delete(row.id);
    publishingIds.value = next;
  }
}

async function awaitPublish(
  templateId: string,
  initial: ConversationTemplatePublishJob
): Promise<ConversationTemplatePublishJob> {
  let job = initial;
  for (let attempt = 0; attempt < 120 && !disposed; attempt += 1) {
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return job;
    await delay(1000);
    if (disposed) return job;
    job = await service.publishStatus(templateId, job.id);
  }
  return job;
}

async function disable(row: AdminConversationTemplateSummary): Promise<void> {
  await confirmedMutation(
    row,
    'conversationTemplates.disable',
    'conversationTemplates.disableConfirmation',
    () => service.disable(row.id),
    'conversationTemplates.disabled',
    'conversationTemplates.disableFailed'
  );
}

async function archiveTemplate(row: AdminConversationTemplateSummary): Promise<void> {
  await confirmedMutation(
    row,
    'conversationTemplates.archive',
    'conversationTemplates.archiveConfirmation',
    () => service.archive(row.id),
    'conversationTemplates.archived',
    'conversationTemplates.archiveFailed'
  );
}

async function remove(row: AdminConversationTemplateSummary): Promise<void> {
  await confirmedMutation(
    row,
    'conversationTemplates.remove',
    'conversationTemplates.removeConfirmation',
    () => service.remove(row.id),
    'conversationTemplates.removed',
    'conversationTemplates.removeFailed',
    'danger'
  );
}

async function confirmedMutation(
  row: AdminConversationTemplateSummary,
  actionKey: string,
  confirmationKey: string,
  action: () => Promise<void>,
  successKey: string,
  fallbackKey: string,
  type: 'warning' | 'danger' = 'warning'
): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate(confirmationKey, { name: row.name }),
      translate(actionKey),
      { closeIcon: marIcon('close'), ...confirmationOptions(actionKey, type) }
    );
    if (disposed) return;
    await action();
    if (disposed) return;
    showMessage(translate(successKey), 'success');
    await load(false);
  } catch (error) {
    if (!disposed && error !== 'cancel')
      showMessage(templateError(error, fallbackKey), 'error', error);
  }
}

function templateFailureMessage(code: string | null | undefined, fallback: string): string {
  const key = conversationTemplateErrorMessageKey(code ?? '');
  return key === undefined ? fallback : translate(key);
}

function templateError(error: unknown, fallbackKey: string): string {
  const key = conversationTemplateErrorMessageKey(errorCode(error) ?? '');
  if (key !== undefined) return translate(key);
  return error instanceof Error ? errorMessage(error) : translate(fallbackKey);
}

function confirmationOptions(
  actionKey: string,
  type: 'warning' | 'danger' = 'warning'
): {
  readonly type: 'warning' | 'error';
  readonly confirmButtonText: string;
  readonly cancelButtonText: string;
} {
  return {
    type: type === 'danger' ? 'error' : 'warning',
    confirmButtonText: translate(actionKey),
    cancelButtonText: translate('conversationTemplates.cancel')
  };
}

function templateStatusLabel(row: AdminConversationTemplateSummary): string {
  if (row.status === 'ARCHIVED') return translate('conversationTemplates.statusArchived');
  if (row.status === 'DELETED') return translate('conversationTemplates.statusDeleted');
  return row.available
    ? translate('conversationTemplates.statusPublished')
    : translate('conversationTemplates.statusDraft');
}

function templateStatusType(row: AdminConversationTemplateSummary): TagProps['type'] {
  if (row.status === 'ARCHIVED' || row.status === 'DELETED') return 'info';
  return row.available ? 'success' : 'warning';
}

function nodeLabel(nodeId: string): string {
  const node = props.nodes.find((candidate) => candidate.id === nodeId);
  return node?.displayName || node?.registeredAddress || nodeId;
}

function workspaceLabel(workspaceId: string): string {
  const workspace = detailWorkspaces.value.find((candidate) => candidate.id === workspaceId);
  return workspace?.displayName || workspace?.path || workspaceId;
}

function mcpOptionLabel(option: ConversationTemplateMcpOption): string {
  return option.displayName === option.serverName
    ? option.displayName
    : `${option.displayName} (${option.serverName})`;
}

function formatDate(value: number): string {
  return managementDateTime(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

onBeforeUnmount(() => {
  disposed = true;
  pagination.dispose();
});

onMounted(() => {
  pagination.start();
  void load();
});
</script>

<template>
  <section
    v-loading="pagination.loading.value && !pageReady && !pagination.failure.value"
    element-loading-custom-class="mar-page-loading"
    class="management-page conversation-template-management"
    :aria-busy="pagination.loading.value && !pageReady"
  >
    <div class="table-actions">
      <el-button
        :icon="marIcon('refresh')"
        :loading="refreshLoading && pageReady"
        @click="refresh"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('conversationTemplates.refresh') }}</el-button
      >
      <el-button
        v-if="writable"
        type="primary"
        :icon="marIcon('plus')"
        :disabled="eligibleNodes.length === 0"
        @click="openCreate"
        >{{ translate('conversationTemplates.add') }}</el-button
      >
    </div>
    <el-alert
      v-if="eligibleNodes.length === 0"
      type="warning"
      :closable="false"
      show-icon
      :title="translate('conversationTemplates.noEligibleNode')"
      ><template #icon><MarIcon name="warning" /></template
    ></el-alert>
    <el-table
      v-loading="
        pagination.loading.value &&
        pageReady &&
        !pagination.loadingMore.value &&
        !refreshLoading &&
        !pagination.failure.value
      "
      class="clickable-rows"
      :data="displayedTemplates"
      row-key="id"
      @row-click="openDetail"
      @sort-change="sortTemplates"
    >
      <el-table-column
        prop="name"
        sortable="custom"
        :label="translate('conversationTemplates.name')"
        min-width="180"
      />
      <el-table-column :label="translate('conversationTemplates.source')" min-width="180">
        <template #default="{ row }">{{ nodeLabel(row.nodeId) }}</template>
      </el-table-column>
      <el-table-column :label="translate('conversationTemplates.version')" width="110">
        <template #default="{ row }">{{
          row.publishedVersion ?? translate('conversationTemplates.none')
        }}</template>
      </el-table-column>
      <el-table-column :label="translate('conversationTemplates.status')" width="130">
        <template #default="{ row }">
          <el-tag :type="templateStatusType(row)" effect="plain">{{
            templateStatusLabel(row)
          }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column
        prop="updatedAt"
        sortable="custom"
        :label="translate('conversationTemplates.updatedAt')"
        width="190"
      >
        <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column :label="translate('conversationTemplates.actions')" width="490">
        <template #default="{ row }">
          <div class="row-actions" @click.stop>
            <el-button
              v-if="writable && row.status !== 'DELETED'"
              link
              :icon="marIcon('edit')"
              @click="openEdit(row)"
              >{{ translate('conversationTemplates.edit') }}</el-button
            >
            <slot name="row-actions" :row="row" />
            <el-button
              v-if="writable && row.status === 'ACTIVE'"
              link
              :icon="marIcon('upload')"
              :loading="publishingIds.has(row.id)"
              @click="publish(row)"
              :loading-icon="marIcon('loading-action')"
              >{{ translate('conversationTemplates.publish') }}</el-button
            >
            <el-button
              v-if="writable && row.available"
              link
              :icon="marIcon('success')"
              @click="disable(row)"
              >{{ translate('conversationTemplates.disable') }}</el-button
            >
            <el-button
              v-if="writable && row.status === 'ACTIVE'"
              link
              :icon="marIcon('skill-source')"
              @click="archiveTemplate(row)"
              >{{ translate('conversationTemplates.archive') }}</el-button
            >
            <el-button
              v-if="writable && row.status !== 'DELETED'"
              link
              type="danger"
              :icon="marIcon('delete')"
              @click="remove(row)"
              >{{ translate('conversationTemplates.remove') }}</el-button
            >
          </div>
        </template>
      </el-table-column>
    </el-table>
    <ManagementPagination
      :total="pagination.total.value"
      :has-more="pagination.hasMore.value"
      :page="pagination.page.value"
      :mobile="pagination.mobileViewport.value"
      :mobile-visible-count="pagination.mobileVisibleCount.value"
      :loading="loading"
      :loading-more="pagination.loadingMore.value"
      @page="pagination.setPage"
      :failed="pagination.failure.value !== undefined"
      :error="pagination.failure.value?.error"
      :context-key="pagination.contextKey.value"
      @retry="pagination.retry"
      @load-more="pagination.loadMore"
    />

    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="editDialogOpen"
      v-model="editDialogOpen"
      :title="
        editingTemplateId === undefined
          ? translate('conversationTemplates.add')
          : translate('conversationTemplates.edit')
      "
      width="min(880px, calc(100vw - 32px))"
      destroy-on-close
      @closed="closeEditDialog"
      :close-icon="marIcon('close')"
    >
      <el-form ref="formRef" :model="draft" :rules="rules" label-position="top">
        <div class="form-grid">
          <el-form-item :label="translate('conversationTemplates.node')" prop="nodeId">
            <el-select
              v-model="draft.nodeId"
              filterable
              :disabled="editingTemplateId !== undefined"
              @change="changeNode(String($event))"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <el-option
                v-for="node in eligibleNodes"
                :key="node.id"
                :label="nodeLabel(node.id)"
                :value="node.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="translate('conversationTemplates.workspace')" prop="workspaceId">
            <el-select
              v-model="draft.workspaceId"
              filterable
              :disabled="editingTemplateId !== undefined"
              @change="changeWorkspace(String($event))"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <el-option
                v-for="workspace in workspaces"
                :key="workspace.id"
                :label="workspace.displayName || workspace.path"
                :value="workspace.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="translate('conversationTemplates.name')" prop="name">
            <el-input v-model="draft.name" maxlength="128" show-word-limit />
          </el-form-item>
        </div>
        <el-form-item :label="translate('conversationTemplates.description')">
          <el-input
            v-model="draft.description"
            type="textarea"
            :rows="2"
            maxlength="2000"
            show-word-limit
          />
        </el-form-item>
        <div class="form-grid">
          <el-form-item
            :label="translate('conversationTemplates.allowedModels')"
            prop="allowedModels"
          >
            <el-select
              v-model="draft.allowedModels"
              multiple
              filterable
              :loading="modelLoading"
              :disabled="draft.nodeId === ''"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <el-option
                v-for="model in availableModels"
                :key="model.modelId"
                :label="model.name"
                :value="model.modelId"
              />
            </el-select>
          </el-form-item>
          <el-form-item
            :label="translate('conversationTemplates.defaultModel')"
            prop="defaultModelId"
          >
            <el-select
              v-model="draft.defaultModelId"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <el-option
                v-for="model in availableModels.filter((item) =>
                  draft.allowedModels.includes(item.modelId)
                )"
                :key="model.modelId"
                :label="model.name"
                :value="model.modelId"
              />
            </el-select>
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item :label="translate('conversationTemplates.mcpIds')">
            <el-select
              v-model="draft.mcpIds"
              multiple
              filterable
              :loading="mcpLoading"
              :disabled="draft.workspaceId === ''"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <el-option
                v-for="option in mcpOptions"
                :key="option.catalogEntryId"
                :label="mcpOptionLabel(option)"
                :value="option.catalogEntryId"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="translate('conversationTemplates.networkMode')">
            <el-select
              v-model="draft.networkMode"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <el-option :label="translate('conversationTemplates.networkNone')" value="NONE" />
              <el-option
                :label="translate('conversationTemplates.networkUnrestricted')"
                value="UNRESTRICTED"
              />
            </el-select>
          </el-form-item>
        </div>
        <div class="quota-grid">
          <el-form-item
            :label="translate('conversationTemplates.maxStorageBytes')"
            prop="maxStorageMiB"
          >
            <el-input-number v-model="draft.maxStorageMiB" :min="1" :step="1"
              ><template #decrease-icon><MarIcon name="subtract" /></template
              ><template #increase-icon><MarIcon name="plus" /></template
            ></el-input-number>
          </el-form-item>
          <el-form-item
            :label="translate('conversationTemplates.maxUploadBytes')"
            prop="maxUploadMiB"
          >
            <el-input-number v-model="draft.maxUploadMiB" :min="1" :step="1"
              ><template #decrease-icon><MarIcon name="subtract" /></template
              ><template #increase-icon><MarIcon name="plus" /></template
            ></el-input-number>
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="editDialogOpen = false">{{
          translate('conversationTemplates.cancel')
        }}</el-button>
        <el-button
          v-if="editingTemplateId !== undefined"
          :loading="testing"
          :disabled="!writable || !modelSelectionAvailable"
          @click="testDraft"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('conversationTemplates.testDraft') }}</el-button
        >
        <el-button
          type="primary"
          :loading="saving"
          :disabled="!writable || !modelSelectionAvailable"
          @click="save"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('conversationTemplates.save') }}</el-button
        >
      </template>
    </el-dialog>

    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="detailDialogOpen && detail"
      v-model="detailDialogOpen"
      :title="detail.template.name"
      width="min(720px, calc(100vw - 32px))"
      @closed="closeDetailDialog"
      :close-icon="marIcon('close')"
    >
      <el-descriptions :column="2" border>
        <el-descriptions-item :label="translate('conversationTemplates.templateId')">
          <code>{{ detail.template.id }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('conversationTemplates.sourceNode')">{{
          nodeLabel(detail.draft.nodeId)
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('conversationTemplates.sourceWorkspace')">{{
          workspaceLabel(detail.draft.workspaceId)
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('conversationTemplates.currentVersion')">{{
          detail.template.publishedVersion ?? translate('conversationTemplates.none')
        }}</el-descriptions-item>
      </el-descriptions>
      <h3>{{ translate('conversationTemplates.versions') }}</h3>
      <el-table :data="detail.versions" max-height="240">
        <el-table-column
          prop="version"
          :label="translate('conversationTemplates.version')"
          width="90"
        />
        <el-table-column
          prop="fileCount"
          :label="translate('conversationTemplates.fileCount')"
          width="100"
        />
        <el-table-column :label="translate('conversationTemplates.totalBytes')" width="130">
          <template #default="{ row }">{{ fileSizeLabel(row.totalBytes) }}</template>
        </el-table-column>
        <el-table-column :label="translate('conversationTemplates.publishedAt')" min-width="180">
          <template #default="{ row }">{{ formatDate(row.publishedAt) }}</template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="detailDialogOpen = false">{{ translate('common.close') }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.conversation-template-management {
  overflow: auto;
}

.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}

.form-grid,
.quota-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}

.quota-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.form-grid :deep(.el-select),
.quota-grid :deep(.el-input-number) {
  width: 100%;
}

.conversation-template-management h3 {
  margin: 22px 0 8px;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-title);
}

@media (max-width: 767px) {
  .form-grid,
  .quota-grid {
    grid-template-columns: 1fr;
  }
}
</style>
