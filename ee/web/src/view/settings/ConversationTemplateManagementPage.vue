<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Share } from '@element-plus/icons-vue';
import CorePage from '@myagentroam/web-core/ConversationTemplateManagementPage.vue';
import type { NodeSummary } from '@/model/workbench';
import {
  createConversationTemplateService,
  sameConversationTemplateRequestContext,
  conversationTemplateErrorMessageKey,
  type AdminConversationTemplateSummary,
  type ConversationTemplateGrant,
  type ConversationTemplateRequestContext
} from '@/service/ConversationTemplateService';
import { translate } from '@/service/LocalePreferenceService';
import { errorCode } from '@/util/api-error';
import { errorMessage } from '@/util/workbench-presentation';
import {
  organizationCascaderOptions,
  organizationDisplayLabel,
  type OrganizationSummary
} from '@/service/EnterpriseManagementService';
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly nodes: readonly NodeSummary[];
  readonly edition?: 'COMMUNITY' | 'ENTERPRISE';
}>();

const service = createConversationTemplateService(props.request);
const grantDialogOpen = ref(false);
const selectedTemplate = ref<AdminConversationTemplateSummary>();
const grants = ref<readonly ConversationTemplateGrant[]>([]);
const organizations = ref<readonly OrganizationSummary[]>([]);
const grantOrganizations = computed(() => {
  const ownership = props.nodes.find(
    (node) => node.id === selectedTemplate.value?.nodeId
  )?.ownership;
  return ownership?.ownerType === 'ORGANIZATION'
    ? organizations.value.filter((organization) =>
        organizationWithinSubtree(
          organizations.value,
          organization.id,
          ownership.ownerOrganizationId
        )
      )
    : [];
});
const organizationOptions = computed(() => organizationCascaderOptions(grantOrganizations.value));
const grantLoading = ref(false);
const grantSaving = ref(false);
const targetOrganizationId = ref<number>();
let disposed = false;
let grantRequestContext: ConversationTemplateRequestContext = { sequence: 0 };
async function openGrants(row: AdminConversationTemplateSummary): Promise<void> {
  const context = (grantRequestContext = nextRequestContext(grantRequestContext, row.id));
  selectedTemplate.value = row;
  grantDialogOpen.value = true;
  grantLoading.value = true;
  grantSaving.value = false;
  grants.value = [];
  organizations.value = [];
  targetOrganizationId.value = undefined;
  try {
    const [grantResult, organizationResult] = await Promise.all([
      service.listGrants(row.id),
      props
        .request<{ organizations: readonly OrganizationSummary[] }>('/api/organizations')
        .catch(() => ({ organizations: [] as readonly OrganizationSummary[] }))
    ]);
    if (
      disposed ||
      !grantDialogOpen.value ||
      !sameConversationTemplateRequestContext(grantRequestContext, context)
    )
      return;
    grants.value = grantResult;
    organizations.value = organizationResult.organizations;
    targetOrganizationId.value = grantOrganizations.value[0]?.id;
  } catch (error) {
    if (disposed || !sameConversationTemplateRequestContext(grantRequestContext, context)) return;
    grantDialogOpen.value = false;
    ElMessage.error(templateError(error, 'conversationTemplates.grantsLoadFailed'));
  } finally {
    if (sameConversationTemplateRequestContext(grantRequestContext, context))
      grantLoading.value = false;
  }
}

async function createGrant(): Promise<void> {
  const row = selectedTemplate.value;
  const context = grantRequestContext;
  if (
    row === undefined ||
    context.resourceId !== row.id ||
    targetOrganizationId.value === undefined
  )
    return;
  grantSaving.value = true;
  try {
    await service.createGrant(row.id, {
      targetType: 'ORGANIZATION',
      targetOrganizationId: targetOrganizationId.value
    });
    const nextGrants = await service.listGrants(row.id);
    if (
      disposed ||
      !grantDialogOpen.value ||
      !sameConversationTemplateRequestContext(grantRequestContext, context)
    )
      return;
    grants.value = nextGrants;
    ElMessage.success(translate('conversationTemplates.grantCreated'));
  } catch (error) {
    if (disposed || !sameConversationTemplateRequestContext(grantRequestContext, context)) return;
    ElMessage.error(templateError(error, 'conversationTemplates.grantCreateFailed'));
  } finally {
    if (sameConversationTemplateRequestContext(grantRequestContext, context))
      grantSaving.value = false;
  }
}

async function removeGrant(grant: ConversationTemplateGrant): Promise<void> {
  const row = selectedTemplate.value;
  const context = grantRequestContext;
  if (row === undefined || context.resourceId !== row.id) return;
  try {
    await ElMessageBox.confirm(
      translate('conversationTemplates.revokeConfirmation'),
      translate('conversationTemplates.revoke'),
      confirmationOptions('conversationTemplates.revoke')
    );
    if (
      disposed ||
      !grantDialogOpen.value ||
      !sameConversationTemplateRequestContext(grantRequestContext, context)
    )
      return;
    await service.removeGrant(grant.id);
    const nextGrants = await service.listGrants(row.id);
    if (
      disposed ||
      !grantDialogOpen.value ||
      !sameConversationTemplateRequestContext(grantRequestContext, context)
    )
      return;
    grants.value = nextGrants;
    ElMessage.success(translate('conversationTemplates.grantRemoved'));
  } catch (error) {
    if (
      !disposed &&
      error !== 'cancel' &&
      sameConversationTemplateRequestContext(grantRequestContext, context)
    )
      ElMessage.error(templateError(error, 'conversationTemplates.grantRemoveFailed'));
  }
}

function closeGrantDialog(): void {
  grantRequestContext = nextRequestContext(grantRequestContext);
  selectedTemplate.value = undefined;
  grants.value = [];
  organizations.value = [];
  grantLoading.value = false;
  grantSaving.value = false;
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

function grantTargetLabel(grant: ConversationTemplateGrant): string {
  if (grant.targetType !== 'ORGANIZATION') return '-';
  return grant.targetOrganizationId === undefined
    ? '-'
    : organizationDisplayLabel(organizations.value, grant.targetOrganizationId);
}

function organizationWithinSubtree(
  values: readonly OrganizationSummary[],
  organizationId: number,
  ancestorOrganizationId: number
): boolean {
  const byId = new Map(values.map((organization) => [organization.id, organization]));
  const visited = new Set<number>();
  let current = byId.get(organizationId);
  while (current !== undefined && !visited.has(current.id)) {
    if (current.id === ancestorOrganizationId) return true;
    visited.add(current.id);
    current =
      current.parentOrganizationId === null ? undefined : byId.get(current.parentOrganizationId);
  }
  return false;
}

function nextRequestContext(
  current: ConversationTemplateRequestContext,
  resourceId?: string
): ConversationTemplateRequestContext {
  return {
    sequence: current.sequence + 1,
    ...(resourceId === undefined ? {} : { resourceId })
  };
}

onBeforeUnmount(() => {
  disposed = true;
});
</script>
<template>
  <CorePage
    v-bind="props"
    :eligible-node="
      (node: NodeSummary) =>
        edition === 'COMMUNITY'
          ? node.ownership?.ownerType === 'PERSONAL'
          : node.ownership?.ownerType === 'ORGANIZATION'
    "
  >
    <template #row-actions="{ row }">
      <el-button
        v-if="edition !== 'COMMUNITY'"
        link
        type="primary"
        :icon="Share"
        @click="openGrants(row)"
        >{{ translate('common.grant') }}</el-button
      >
    </template>
  </CorePage>
  <el-dialog
    v-if="grantDialogOpen && selectedTemplate"
    v-model="grantDialogOpen"
    :title="translate('conversationTemplates.accessDialogTitle', { name: selectedTemplate.name })"
    width="min(720px, calc(100vw - 32px))"
    @closed="closeGrantDialog"
  >
    <div v-loading="grantLoading" class="grant-dialog">
      <el-alert
        type="info"
        :closable="false"
        :title="translate('conversationTemplates.accessHint')"
      />
      <div v-if="writable" class="grant-form">
        <el-cascader
          v-model="targetOrganizationId"
          style="width: 100%"
          filterable
          :placeholder="translate('conversationTemplates.selectOrganization')"
          :aria-label="translate('conversationTemplates.organization')"
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
        />
        <el-button type="primary" :loading="grantSaving" @click="createGrant">{{
          translate('common.grant')
        }}</el-button>
      </div>
      <el-table :data="grants" empty-text="">
        <el-table-column :label="translate('conversationTemplates.target')" min-width="220">
          <template #default="{ row }">{{ grantTargetLabel(row) }}</template>
        </el-table-column>
        <el-table-column
          v-if="writable"
          :label="translate('conversationTemplates.actions')"
          width="100"
        >
          <template #default="{ row }">
            <el-button link type="danger" @click="removeGrant(row)">{{
              translate('conversationTemplates.revoke')
            }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </el-dialog>
</template>
<style scoped>
.grant-dialog,
.grant-form {
  display: grid;
  gap: 12px;
}
.grant-form {
  grid-template-columns: minmax(220px, 1fr) auto;
  align-items: end;
}
@media (max-width: 767px) {
  .grant-form {
    grid-template-columns: 1fr;
  }
}
</style>
