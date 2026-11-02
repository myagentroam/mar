<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '@myagentroam/web-core/MobileDialogReturnService';
import { watchManagementPageFailure } from '@myagentroam/web-core/management-page';
import { showMessage } from '@myagentroam/web-core/message-feedback';

import MarIcon from '@myagentroam/web-core/MarIcon.vue';
import { marIcon } from '@myagentroam/web-core/icons';
import type { TagProps } from 'element-plus';
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue';

import {
  managementUrlValues,
  replaceManagementUrlValues
} from '@myagentroam/web-core/management-url';
import { currentLocale, translate } from '@/service/locale-preference-service';
import { errorMessage } from '@myagentroam/web-core/workbench-presentation';
import {
  auditTimestamp,
  classifyAuditEvent,
  namedAuditIdentifier
} from '@/util/audit-presentation';
import { MANAGEMENT_PAGE_SIZE } from '@myagentroam/web-core/management-pagination';
import {
  createManagementPageService,
  parseManagementPage
} from '@myagentroam/web-core/management-page';
import ManagementPagination from '@myagentroam/web-core/ManagementPagination.vue';

interface AuditEvent {
  id: string;
  eventType: string;
  occurredAt: number;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  errorCode: string | null;
  actorUserId: number | null;
  actorUsername: string | null;
  authenticationMethod: string;
  providerId: string | null;
  requestId: string | null;
  operationId: string | null;
  sessionPublicId?: string | null;
  targetType: string | null;
  targetId: string | null;
  targetName?: string | null;
  organizationId: number | null;
  nodeId: string | null;
  workspaceId: string | null;
  agentSessionId: string | null;
  runId: string | null;
  clientMessageId: string | null;
  queueItemId?: string | null;
  inputMode: string | null;
  hasConversationPayload?: boolean;
  metadata?: Record<string, unknown>;
}
interface AuditEventDetail extends AuditEvent {
  conversationPayload?: {
    conversationId?: string;
    conversationTitle: string;
    userMessage: string;
    queueItemId?: string;
  };
}
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const now = Date.now();
const defaultRange: [Date, Date] = [new Date(now - 30 * 86_400_000), new Date(now)];
const initialRange = managementUrlValues('audit', ['from', 'to']);
const parsedFrom = Number(initialRange.from);
const parsedTo = Number(initialRange.to);
const range = ref<[Date, Date] | null>(
  Number.isSafeInteger(parsedFrom) && Number.isSafeInteger(parsedTo) && parsedFrom <= parsedTo
    ? [new Date(parsedFrom), new Date(parsedTo)]
    : defaultRange
);
const selected = ref<AuditEventDetail>();
const detailLoading = ref(false);
const refreshLoading = ref(false);
let detailGeneration = 0;
watch(range, (value) => {
  const [from, to] = value ?? defaultRange;
  replaceManagementUrlValues('audit', { from: from.getTime(), to: to.getTime() });
});
const resultLabels = computed(() => ({
  SUCCESS: translate('generated.auditManagementPage.success'),
  DENIED: translate('generated.auditManagementPage.denied'),
  FAILED: translate('generated.auditManagementPage.failed')
}));
const targetTypeLabels = computed<Record<string, string>>(() => ({
  USER: translate('generated.auditManagementPage.user2'),
  ORGANIZATION: translate('generated.auditManagementPage.organization2'),
  ENTERPRISE: translate('generated.auditManagementPage.enterprise'),
  NODE: translate('audit.business.node'),
  WORKSPACE: translate('audit.business.workspace'),
  SESSION: translate('audit.business.session'),
  MODEL: translate('audit.business.model'),
  IMAGE_MODEL: translate('audit.business.imageModel'),
  TEMPLATE: translate('audit.business.template'),
  SKILL: translate('audit.business.skill'),
  SKILL_SOURCE: translate('audit.targets.skillSource'),
  MCP: translate('audit.business.mcp'),
  MCP_SOURCE: translate('audit.targets.mcpSource'),
  ENVIRONMENT_SECRET: translate('audit.business.secret'),
  CREDENTIAL: translate('audit.business.credential'),
  SYSTEM_SETTING: translate('audit.business.setting'),
  MAIL_TEMPLATE: translate('audit.targets.mailTemplate'),
  LICENSE: translate('audit.business.license'),
  FILE: translate('audit.targets.file'),
  TERMINAL: translate('audit.targets.terminal'),
  RUN: translate('generated.auditManagementPage.run')
}));
const authenticationLabels = computed<Record<string, string>>(() => ({
  PASSWORD: translate('generated.auditManagementPage.password'),
  OAUTH2: 'OAuth 2.0',
  SYSTEM: translate('generated.auditManagementPage.system')
}));
const inputModeLabels = computed<Record<string, string>>(() => ({
  NEW_SESSION: translate('generated.auditManagementPage.inputModeNewSession'),
  SEND: translate('generated.auditManagementPage.inputModeSend'),
  CONTINUE: translate('generated.auditManagementPage.inputModeContinue'),
  STEER: translate('generated.auditManagementPage.inputModeSteer'),
  QUEUE: translate('generated.auditManagementPage.inputModeQueue'),
  REPLACE_CURRENT: translate('generated.auditManagementPage.inputModeReplaceCurrent'),
  RUN_NOW: translate('generated.auditManagementPage.inputModeRunNow'),
  USER_INPUT_RESPONSE: translate('generated.auditManagementPage.inputModeUserInputResponse'),
  EDIT_QUEUE: translate('generated.auditManagementPage.inputModeEditQueue'),
  DELETE_QUEUE: translate('generated.auditManagementPage.inputModeDeleteQueue'),
  REORDER_QUEUE: translate('generated.auditManagementPage.inputModeReorderQueue'),
  EXECUTE_QUEUE: translate('generated.auditManagementPage.inputModeExecuteQueue'),
  PAUSE_QUEUE: translate('generated.auditManagementPage.inputModePauseQueue'),
  RESUME_QUEUE: translate('generated.auditManagementPage.inputModeResumeQueue')
}));
const detailFields = computed(() => [
  { key: 'requestId', label: translate('generated.auditManagementPage.requestID') },
  { key: 'operationId', label: translate('generated.auditManagementPage.operationID') },
  { key: 'sessionPublicId', label: translate('generated.auditManagementPage.sessionPublicID') },
  { key: 'eventType', label: translate('audit.eventCode') },
  { key: 'targetType', label: translate('generated.auditManagementPage.targetType') },
  {
    key: 'targetId',
    label: targetTypeLabels.value[selected.value?.targetType ?? ''] ?? translate('audit.target')
  },
  { key: 'organizationId', label: translate('audit.business.organization') },
  { key: 'nodeId', label: translate('audit.business.node') },
  { key: 'workspaceId', label: translate('audit.business.workspace') },
  { key: 'agentSessionId', label: translate('audit.business.session') },
  { key: 'targetUserId', label: translate('audit.grantedUser') },
  { key: 'targetOrganizationId', label: translate('audit.grantedOrganization') },
  { key: 'runId', label: translate('generated.auditManagementPage.runID') },
  { key: 'clientMessageId', label: translate('generated.auditManagementPage.clientMessageID') },
  { key: 'queueItemId', label: translate('generated.auditManagementPage.queueItemID') },
  { key: 'inputMode', label: translate('generated.auditManagementPage.inputMode') }
]);
const errorLabels = computed<Record<string, string>>(() => ({
  RBAC_DENIED: translate('generated.auditManagementPage.insufficientPermissions'),
  LICENSE_MANAGEMENT_FROZEN: translate('generated.auditManagementPage.licenseManagementFrozen'),
  CSRF_INVALID: translate('generated.auditManagementPage.requestValidationFailed'),
  ORIGIN_NOT_ALLOWED: translate('generated.auditManagementPage.requestOriginNotAllowed')
}));
const query = computed(() => {
  const value = new URLSearchParams({ limit: String(MANAGEMENT_PAGE_SIZE) });
  const [from, to] = range.value ?? defaultRange;
  value.set('from', String(from.getTime()));
  value.set('to', String(to.getTime()));
  return value;
});
const pagination = createManagementPageService<AuditEvent>({
  context: () => query.value.toString(),
  key: (event) => event.id,
  read: async (page) => {
    const params = new URLSearchParams(query.value);
    params.set('page', String(page));
    return parseManagementPage<AuditEvent>(
      await props.request(`/api/audit-events?${params}`),
      'events'
    );
  }
});
watchManagementPageFailure(pagination);
const events = pagination.items;
const loading = pagination.loading;
const pageReady = computed(() => pagination.result.value !== undefined);
const exportUrl = computed(() => {
  const value = new URLSearchParams(query.value);
  value.delete('limit');
  value.set('format', 'csv');
  return `/api/audit-events/export?${value}`;
});
function operationLabel(event: AuditEvent): string {
  const [business, action] = classifyAuditEvent(event);
  return translate('audit.operation', {
    resource: translate(`audit.business.${business}`),
    action: translate(`audit.actions.${action}`)
  });
}
const changes = computed(() => {
  const before = selected.value?.metadata?.before;
  const after = selected.value?.metadata?.after;
  const oldValues =
    before && typeof before === 'object' && !Array.isArray(before)
      ? (before as Record<string, unknown>)
      : {};
  const newValues =
    after && typeof after === 'object' && !Array.isArray(after)
      ? (after as Record<string, unknown>)
      : {};
  return [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])].map((field) => ({
    field: changeFieldLabels.value[field] ?? field,
    before: displaySnapshot(oldValues[field], field),
    after: displaySnapshot(newValues[field], field)
  }));
});
const changeFieldLabels = computed<Record<string, string>>(() => ({
  name: translate('audit.fields.name'),
  parentOrganizationId: translate('audit.fields.parentOrganizationId'),
  organizationId: translate('audit.fields.organizationId'),
  role: translate('audit.fields.role'),
  enabled: translate('audit.fields.enabled'),
  ownerType: translate('audit.fields.ownerType'),
  ownerOrganizationId: translate('audit.fields.ownerOrganizationId'),
  targetUserId: translate('audit.fields.targetUserId'),
  targetOrganizationId: translate('audit.fields.targetOrganizationId'),
  groupName: translate('audit.fields.groupName'),
  version: translate('audit.fields.version'),
  preserveGitConfig: translate('audit.fields.preserveGitConfig'),
  model: translate('audit.fields.model'),
  effort: translate('audit.fields.effort'),
  runner: translate('audit.fields.runner'),
  permissionMode: translate('audit.fields.permissionMode'),
  featured: translate('audit.fields.featured'),
  provider: translate('audit.fields.provider')
}));
const roleSnapshotLabels = computed<Record<string, string>>(() => ({
  ADMIN: translate('audit.roleAdmin'),
  ORG_ADMIN: translate('audit.roleOrgAdmin'),
  MEMBER: translate('audit.roleMember')
}));
const ownershipSnapshotLabels = computed<Record<string, string>>(() => ({
  PERSONAL: translate('audit.scopePersonal'),
  ORGANIZATION: translate('audit.scopeOrganization'),
  SYSTEM: translate('audit.scopeSystem'),
  ENTERPRISE: translate('audit.scopeEnterprise')
}));
function displaySnapshot(value: unknown, field: string): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean')
    return translate(
      field === 'enabled'
        ? value
          ? 'audit.flagEnabled'
          : 'audit.flagDisabled'
        : value
          ? 'audit.yes'
          : 'audit.no'
    );
  if (typeof value === 'string' && field === 'role')
    return roleSnapshotLabels.value[value] ?? value;
  if (typeof value === 'string' && field === 'ownerType')
    return ownershipSnapshotLabels.value[value] ?? value;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function detailValue(event: AuditEvent, key: string): unknown {
  if (
    key === 'targetId' &&
    ((event.targetType === 'NODE' && event.targetId === event.nodeId) ||
      (event.targetType === 'WORKSPACE' && event.targetId === event.workspaceId) ||
      (event.targetType === 'SESSION' && event.targetId === event.agentSessionId) ||
      (event.targetType === 'ORGANIZATION' && event.targetId === String(event.organizationId)))
  )
    return undefined;
  const names: Record<string, unknown> = {
    targetId: event.targetName,
    nodeId:
      event.metadata?.nodeName ??
      (event.targetType === 'NODE' && event.targetId === event.nodeId
        ? event.targetName
        : undefined),
    workspaceId:
      event.metadata?.workspaceName ??
      (event.targetType === 'WORKSPACE' && event.targetId === event.workspaceId
        ? event.targetName
        : undefined),
    organizationId:
      event.metadata?.organizationName ??
      (event.targetType === 'ORGANIZATION' && event.targetId === String(event.organizationId)
        ? event.targetName
        : undefined),
    agentSessionId:
      event.metadata?.sessionName ??
      (event as AuditEventDetail).conversationPayload?.conversationTitle ??
      (event.targetType === 'SESSION' ? event.targetName : undefined),
    targetUserId: event.metadata?.targetUserName,
    targetOrganizationId: event.metadata?.targetOrganizationName
  };
  const value = (event as unknown as Record<string, unknown>)[key] ?? event.metadata?.[key];
  if (key in names) return namedAuditIdentifier(value, names[key]);
  if (key === 'targetType' && typeof value === 'string')
    return targetTypeLabels.value[value] ?? value;
  if (key === 'inputMode' && typeof value === 'string')
    return inputModeLabels.value[value] ?? value;
  return value ?? undefined;
}
function errorLabel(code: string | null): string {
  return code === null ? '' : (errorLabels.value[code] ?? code);
}
function resultLabel(result: AuditEvent['result']): string {
  return resultLabels.value[result];
}
function resultType(result: AuditEvent['result']): TagProps['type'] {
  return result === 'FAILED' ? 'danger' : result === 'DENIED' ? 'warning' : 'info';
}
async function openDetail(event: AuditEvent): Promise<void> {
  const generation = ++detailGeneration;
  selected.value = event;
  detailLoading.value = true;
  const isCurrent = () => generation === detailGeneration && selected.value?.id === event.id;
  try {
    const detail = await props.request<AuditEventDetail>(
      `/api/audit-events/${encodeURIComponent(event.id)}`,
      { cache: 'no-store' }
    );
    if (isCurrent()) selected.value = detail;
  } catch (error) {
    if (!isCurrent()) return;
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.auditManagementPage.unableToLoadAuditEvents'),
      'error',
      error
    );
  } finally {
    if (isCurrent()) detailLoading.value = false;
  }
}
function closeDetail(): void {
  detailGeneration += 1;
  selected.value = undefined;
  detailLoading.value = false;
}
function load(): Promise<void> {
  return pagination.load(true);
}
async function refresh(): Promise<void> {
  refreshLoading.value = true;
  try {
    await load();
  } finally {
    refreshLoading.value = false;
  }
}
onMounted(() => {
  pagination.start();
  void load();
});
onUnmounted(() => pagination.dispose());
onBeforeUnmount(closeDetail);
</script>

<template>
  <section
    v-loading="loading && !pageReady && !pagination.failure.value"
    element-loading-custom-class="mar-page-loading"
    class="management-page audit-management"
  >
    <div class="filter-row">
      <label class="filter-field"
        ><span>{{ translate('generated.auditManagementPage.timeRange') }}</span
        ><el-date-picker
          v-model="range"
          type="datetimerange"
          :clearable="false"
          :range-separator="translate('generated.auditManagementPage.to')"
          :start-placeholder="translate('generated.auditManagementPage.startTime')"
          :end-placeholder="translate('generated.auditManagementPage.endTime')"
          class="audit-range-picker"
          @change="load()"
          :prefix-icon="marIcon('calendar')"
          :clear-icon="marIcon('clear-input')"
          ><template #prev-month><MarIcon name="chevron-left" /></template
          ><template #next-month><MarIcon name="chevron-right" /></template
          ><template #prev-year><MarIcon name="chevrons-left" /></template
          ><template #next-year><MarIcon name="chevrons-right" /></template></el-date-picker
      ></label>
    </div>
    <div class="table-actions">
      <el-button
        :icon="marIcon('refresh')"
        :loading="refreshLoading && pageReady"
        @click="refresh"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('generated.auditManagementPage.refresh') }}</el-button
      >
      <el-button tag="a" :icon="marIcon('download')" :href="exportUrl">{{
        translate('generated.auditManagementPage.exportCSV')
      }}</el-button>
    </div>
    <el-table
      v-loading="
        loading &&
        pageReady &&
        !pagination.loadingMore.value &&
        !refreshLoading &&
        !pagination.failure.value
      "
      class="clickable-rows"
      :data="events"
      row-key="id"
      @row-click="openDetail"
    >
      <el-table-column :label="translate('generated.auditManagementPage.time')" min-width="180"
        ><template #default="{ row }">{{
          auditTimestamp(row.occurredAt)
        }}</template></el-table-column
      >
      <el-table-column :label="translate('audit.target')" min-width="180">
        <template #default="{ row }">{{ row.targetName || row.targetId || '—' }}</template>
      </el-table-column>
      <el-table-column :label="translate('generated.auditManagementPage.event')" min-width="220"
        ><template #default="{ row }">{{ operationLabel(row) }}</template></el-table-column
      >
      <el-table-column
        prop="actorUsername"
        :label="translate('generated.auditManagementPage.actor')"
        min-width="130"
      />
      <el-table-column :label="translate('generated.auditManagementPage.result')" width="100"
        ><template #default="{ row }">
          <el-tag :type="resultType(row.result)" effect="plain">{{
            resultLabel(row.result)
          }}</el-tag>
        </template></el-table-column
      >
    </el-table>
    <ManagementPagination
      :total="pagination.total.value"
      :page="pagination.page.value"
      :page-size="MANAGEMENT_PAGE_SIZE"
      :mobile="pagination.mobileViewport.value"
      :mobile-visible-count="events.length"
      :has-more="pagination.hasMore.value"
      :loading="loading"
      :loading-more="pagination.loadingMore.value"
      :failed="pagination.failure.value !== undefined"
      :incremental-failed="pagination.failure.value?.incremental === true"
      :error="pagination.failure.value?.error"
      :context-key="pagination.contextKey.value"
      @retry="pagination.retry"
      @page="pagination.setPage"
      @load-more="pagination.loadMore"
    />
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="selected !== undefined"
      :model-value="selected !== undefined"
      :title="translate('generated.auditManagementPage.auditDetails')"
      width="min(720px, calc(100vw - 32px))"
      @close="closeDetail"
      @update:model-value="closeDetail"
      :close-icon="marIcon('close')"
    >
      <el-descriptions
        v-if="selected"
        v-loading="detailLoading"
        class="mar-detail-descriptions"
        :column="1"
        border
      >
        <el-descriptions-item :label="translate('generated.auditManagementPage.auditEventId')">
          <code>{{ selected.id }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.auditManagementPage.event2')">{{
          operationLabel(selected)
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('generated.auditManagementPage.time2')">{{
          auditTimestamp(selected.occurredAt)
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('generated.auditManagementPage.actor2')">{{
          namedAuditIdentifier(selected.actorUserId, selected.actorUsername) ?? '—'
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('generated.auditManagementPage.authentication2')"
          >{{ authenticationLabels[selected.authenticationMethod] ?? selected.authenticationMethod
          }}{{ selected.providerId ? ` · ${selected.providerId}` : '' }}</el-descriptions-item
        >
        <el-descriptions-item :label="translate('generated.auditManagementPage.result2')">
          <el-tag :type="resultType(selected.result)" effect="plain">{{
            resultLabel(selected.result)
          }}</el-tag>
          <template v-if="selected.result !== 'SUCCESS' && selected.errorCode">
            · {{ translate('generated.auditManagementPage.errorCode') }}:
            <code>{{ errorLabel(selected.errorCode) }}</code>
          </template>
        </el-descriptions-item>
        <el-descriptions-item
          v-if="selected.conversationPayload"
          :label="translate('generated.auditManagementPage.userMessage')"
        >
          <pre>{{ selected.conversationPayload.userMessage }}</pre>
        </el-descriptions-item>
        <template v-for="field in detailFields" :key="field.key">
          <el-descriptions-item
            v-if="detailValue(selected, field.key) !== undefined"
            :label="field.label"
            >{{ detailValue(selected, field.key) }}</el-descriptions-item
          >
        </template>
        <el-descriptions-item v-if="changes.length" :label="translate('audit.changes')">
          <el-table :data="changes">
            <el-table-column prop="field" :label="translate('audit.field')" />
            <el-table-column prop="before" :label="translate('audit.before')" />
            <el-table-column prop="after" :label="translate('audit.after')" />
          </el-table>
        </el-descriptions-item>
        <el-descriptions-item
          v-if="Object.keys(selected.metadata || {}).length > 0"
          :label="translate('common.metadata')"
        >
          <pre>{{ JSON.stringify(selected.metadata || {}, null, 2) }}</pre>
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="closeDetail">{{ translate('common.close') }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-block: 1px solid var(--mar-border-subtle);
}
.management-page .filter-field > .audit-range-picker {
  width: min(430px, 100%);
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
pre {
  margin: 0;
  white-space: pre-wrap;
  font-size: var(--mar-font-size-meta);
}
:global(.audit-management .el-dialog .el-descriptions__label) {
  width: 150px;
}

@media (max-width: 767px) {
  .management-page .filter-field > .audit-range-picker {
    width: 100%;
  }
}
</style>
