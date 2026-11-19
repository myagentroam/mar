<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '@myagentroam/web-core/MobileDialogReturnService';
import { showMessage } from '@myagentroam/web-core/message-feedback';

import MarIcon from '@myagentroam/web-core/MarIcon.vue';
import { marIcon } from '@myagentroam/web-core/icons';
import { computed, onBeforeUnmount, reactive, ref, shallowRef } from 'vue';
import { ElMessageBox } from '@myagentroam/web-core/MessageBoxService';
import { type FormInstance, type FormRules } from 'element-plus';
import type { MarAgentModelSummary as ModelSummary } from '@myagentroam/protocol';
import {
  organizationCascaderOptions,
  organizationDisplayLabel,
  type OrganizationSummary
} from '@/service/enterprise-management-service';
import { translate } from '@/service/locale-preference-service';
import { errorMessage } from '@myagentroam/web-core/workbench-presentation';
const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  writable: boolean;
  refresh: () => Promise<readonly ModelSummary[]>;
}>();
interface Grant {
  id: string;
  targetType: 'USER' | 'ORGANIZATION';
  targetUserId?: number;
  targetOrganizationId?: number;
}

interface User {
  id: number;
  username: string;
  organizationId: number;
}

interface GrantDraft {
  targetType: Grant['targetType'];
  targetOrganizationId?: number;
  targetUserId?: number;
}

interface GrantOpening {
  generation: number;
  model: ModelSummary;
  grants: readonly Grant[];
  organizations: readonly OrganizationSummary[];
  users: readonly User[];
  draft: GrantDraft;
  loading: boolean;
  saving: boolean;
  revokingGrantIds: Set<string>;
  refreshSequence: number;
  close: () => void;
}

// Each opening owns its selection, draft, rows and activity. The parent owns the
// shared model catalog refresh; closing an opening does not undo a submitted write.
const opening = shallowRef<GrantOpening>();
const organizationOptions = computed(() =>
  organizationCascaderOptions(opening.value?.organizations ?? [])
);
let generation = 0;
const grantFormRef = ref<FormInstance>();
const grantRules: FormRules<GrantDraft> = {
  targetOrganizationId: [
    {
      validator: (_rule, value, callback) =>
        value !== undefined
          ? callback()
          : callback(new Error(translate('marAgentModels.selectOrganization'))),
      trigger: 'change'
    }
  ],
  targetUserId: [
    {
      validator: (_rule, value, callback) =>
        value !== undefined
          ? callback()
          : callback(new Error(translate('marAgentModels.selectUser'))),
      trigger: 'change'
    }
  ]
};

function readGrants(modelId: string) {
  const query = new URLSearchParams({ resourceType: 'MODEL', modelId });
  return props.request<{ grants: readonly Grant[] }>(`/api/resource-grants?${query}`);
}

async function openGrants(row: ModelSummary): Promise<void> {
  const dialog: GrantOpening = reactive({
    generation: ++generation,
    model: row,
    grants: [],
    organizations: [],
    users: [],
    draft: { targetType: 'ORGANIZATION' },
    loading: true,
    saving: false,
    revokingGrantIds: new Set<string>(),
    refreshSequence: 0,
    close: () => {
      if (opening.value === dialog) opening.value = undefined;
    }
  });
  opening.value = dialog;
  try {
    const [grantResult, organizationResult, userResult] = await Promise.all([
      readGrants(row.id),
      props
        .request<{ organizations: readonly OrganizationSummary[] }>('/api/organizations')
        .catch(() => ({ organizations: [] as readonly OrganizationSummary[] })),
      props
        .request<{ users: readonly User[] }>('/api/enterprise/users')
        .catch(() => ({ users: [] as readonly User[] }))
    ]);
    if (opening.value !== dialog) return;
    dialog.grants = grantResult.grants;
    dialog.organizations = organizationResult.organizations;
    dialog.users = userResult.users;
  } catch (error) {
    if (opening.value !== dialog) return;
    dialog.close();
    showMessage(
      error instanceof Error ? errorMessage(error) : translate('marAgentModels.grantsLoadFailed'),
      'error',
      error
    );
  } finally {
    dialog.loading = false;
  }
}

async function refreshGrantState(dialog: GrantOpening): Promise<boolean> {
  const modelId = dialog.model.id;
  const sequence = ++dialog.refreshSequence;
  const isCurrent = () => opening.value === dialog && dialog.refreshSequence === sequence;
  try {
    const [models, result] = await Promise.all([
      props.refresh(),
      isCurrent() ? readGrants(modelId) : undefined
    ]);
    if (!isCurrent() || result === undefined) return true;
    const model = models.find((candidate) => candidate.id === modelId);
    if (model === undefined) {
      dialog.close();
      return true;
    }
    dialog.model = model;
    dialog.grants = result.grants;
  } catch (error) {
    if (isCurrent()) {
      showMessage(
        error instanceof Error ? errorMessage(error) : translate('marAgentModels.grantsLoadFailed'),
        'error',
        error
      );
      return false;
    }
  }
  return true;
}

function canWrite(dialog: GrantOpening): boolean {
  return opening.value === dialog && props.writable && !dialog.loading;
}

function writeResultMessage(dialog: GrantOpening, message: string): string {
  return opening.value === dialog
    ? message
    : translate('marAgentModels.grantResultForModel', { name: dialog.model.name, message });
}

async function createGrant(dialog: GrantOpening): Promise<void> {
  const form = grantFormRef.value;
  if (form === undefined || !canWrite(dialog) || dialog.saving) return;
  dialog.saving = true;
  try {
    if (!(await form.validate().catch(() => false)) || !canWrite(dialog)) return;
    const { targetType, targetUserId, targetOrganizationId } = dialog.draft;
    await props.request('/api/resource-grants', {
      method: 'POST',
      body: JSON.stringify({
        resourceType: 'MODEL',
        modelId: dialog.model.id,
        targetType,
        targetUserId: targetType === 'USER' ? targetUserId : undefined,
        targetOrganizationId: targetType === 'ORGANIZATION' ? targetOrganizationId : undefined
      })
    });
    if (await refreshGrantState(dialog))
      showMessage(writeResultMessage(dialog, translate('marAgentModels.grantCreated')), 'success');
  } catch (error) {
    showMessage(
      writeResultMessage(
        dialog,
        error instanceof Error ? errorMessage(error) : translate('marAgentModels.grantCreateFailed')
      ),
      'error',
      error
    );
  } finally {
    dialog.saving = false;
  }
}

async function removeGrant(dialog: GrantOpening, grant: Grant): Promise<void> {
  const grantId = grant.id;
  if (dialog.revokingGrantIds.has(grantId)) return;
  const canRevoke = () => canWrite(dialog) && dialog.grants.some((item) => item.id === grantId);
  if (!canRevoke()) return;
  dialog.revokingGrantIds.add(grantId);
  let submitted = false;
  try {
    await ElMessageBox.confirm(
      translate('marAgentModels.confirmRevoke'),
      translate('marAgentModels.revoke'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('marAgentModels.revoke'),
        cancelButtonText: translate('marAgentModels.cancel')
      }
    );
    if (!canRevoke()) return;
    submitted = true;
    await props.request(`/api/resource-grants/${encodeURIComponent(grantId)}`, {
      method: 'DELETE'
    });
    if (await refreshGrantState(dialog))
      showMessage(writeResultMessage(dialog, translate('marAgentModels.grantRemoved')), 'success');
  } catch (error) {
    if (submitted || (opening.value === dialog && error !== 'cancel' && error !== 'close'))
      showMessage(
        writeResultMessage(
          dialog,
          error instanceof Error
            ? errorMessage(error)
            : translate('marAgentModels.grantRemoveFailed')
        ),
        'error',
        error
      );
  } finally {
    dialog.revokingGrantIds.delete(grantId);
  }
}

function organizationLabel(dialog: GrantOpening, organizationId: number | undefined): string {
  if (organizationId === undefined) return '—';
  return organizationDisplayLabel(dialog.organizations, organizationId);
}

function grantTargetLabel(dialog: GrantOpening, grant: Grant): string {
  if (grant.targetType === 'USER')
    return dialog.users.find((user) => user.id === grant.targetUserId)?.username ?? '—';
  return organizationLabel(dialog, grant.targetOrganizationId);
}

onBeforeUnmount(() => opening.value?.close());
defineExpose({ open: openGrants });
</script>
<template>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="opening"
    :key="opening.generation"
    :model-value="true"
    :before-close="opening.close"
    :title="translate('marAgentModels.accessDialogTitle')"
    width="min(640px, calc(100vw - 32px))"
    :close-icon="marIcon('close')"
  >
    <div class="model-access-context">
      <strong>{{ opening.model.name }}</strong>
      <code>{{ opening.model.modelId }}</code>
    </div>
    <el-alert
      :title="translate('marAgentModels.publicHint')"
      type="info"
      :closable="false"
      show-icon
      ><template #icon><MarIcon name="info" /></template
    ></el-alert>
    <div v-loading="opening.loading">
      <el-form
        ref="grantFormRef"
        :model="opening.draft"
        :rules="grantRules"
        :disabled="!writable || opening.loading || opening.saving"
        class="grant-create"
        label-position="top"
      >
        <el-form-item :label="translate('marAgentModels.targetType')">
          <el-select
            v-model="opening.draft.targetType"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option :label="translate('marAgentModels.organization')" value="ORGANIZATION" />
            <el-option :label="translate('marAgentModels.user')" value="USER" />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="opening.draft.targetType === 'ORGANIZATION'"
          :label="translate('marAgentModels.targetOrganization')"
          prop="targetOrganizationId"
        >
          <el-cascader
            v-model="opening.draft.targetOrganizationId"
            style="width: 100%"
            :placeholder="translate('marAgentModels.selectOrganization')"
            filterable
            :options="organizationOptions"
            :props="{ checkStrictly: true, emitPath: false }"
            :clear-icon="marIcon('clear-input')"
          />
        </el-form-item>
        <el-form-item
          v-else-if="opening.draft.targetType === 'USER'"
          :label="translate('marAgentModels.targetUser')"
          prop="targetUserId"
        >
          <el-select
            v-model="opening.draft.targetUserId"
            :placeholder="translate('marAgentModels.selectUser')"
            filterable
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option
              v-for="user in opening.users"
              :key="user.id"
              :label="`${user.username} · ${organizationLabel(opening, user.organizationId)}`"
              :value="user.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <el-table
        :data="opening.grants"
        row-key="id"
        :empty-text="translate('marAgentModels.noGrants')"
      >
        <el-table-column :label="translate('marAgentModels.targetType')" width="140">
          <template #default="{ row }">
            {{
              row.targetType === 'USER'
                ? translate('marAgentModels.user')
                : translate('marAgentModels.organization')
            }}
          </template>
        </el-table-column>
        <el-table-column :label="translate('marAgentModels.target')" min-width="200">
          <template #default="{ row }">{{ grantTargetLabel(opening, row) }}</template>
        </el-table-column>
        <el-table-column :label="translate('marAgentModels.actions')" width="100">
          <template #default="{ row }">
            <el-button
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="!writable"
              :loading="opening.revokingGrantIds.has(row.id)"
              :onClick="removeGrant.bind(null, opening, row)"
              :loading-icon="marIcon('loading-action')"
            >
              {{ translate('marAgentModels.revoke') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button :onClick="opening.close">{{ translate('marAgentModels.close') }}</el-button>
      <el-button
        type="primary"
        :icon="marIcon('share')"
        :disabled="!writable || opening.loading"
        :loading="opening.saving"
        :onClick="createGrant.bind(null, opening)"
        :loading-icon="marIcon('loading-action')"
      >
        {{ translate('common.grant') }}
      </el-button>
    </template>
  </el-dialog>
</template>
<style scoped>
.model-access-context {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.model-access-context code {
  color: var(--mar-text-muted);
}
.grant-create {
  display: grid;
  grid-template-columns: minmax(160px, 0.8fr) minmax(220px, 1.2fr);
  gap: 12px;
  margin-top: 16px;
}
@media (max-width: 700px) {
  .grant-create {
    grid-template-columns: 1fr;
  }
  .model-access-context {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
