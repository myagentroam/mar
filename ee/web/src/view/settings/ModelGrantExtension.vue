<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '@myagentroam/web-core/MobileDialogReturnService';
import { showMessage } from '@myagentroam/web-core/message-feedback';

import MarIcon from '@myagentroam/web-core/MarIcon.vue';
import { marIcon } from '@myagentroam/web-core/icons';
import { computed, ref } from 'vue';
import { ElMessageBox } from '@myagentroam/web-core/MessageBoxService';
import { type FormInstance, type FormRules } from 'element-plus';
import type { MarAgentModelSummary as ModelSummary } from '@myagentroam/protocol';
import {
  organizationCascaderOptions,
  organizationDisplayLabel,
  type OrganizationSummary
} from '@/service/enterprise-management-service';
import { translate } from '@/service/locale-preference-service';
import { errorMessage } from '@/util/workbench-presentation';
const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  writable: boolean;
  refresh: () => Promise<readonly ModelSummary[]>;
}>();
const selectedModel = ref<ModelSummary>();
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

const grants = ref<readonly Grant[]>([]);
const organizations = ref<readonly OrganizationSummary[]>([]);
const organizationOptions = computed(() => organizationCascaderOptions(organizations.value));
const users = ref<readonly User[]>([]);
const grantLoading = ref(false);
const grantSaving = ref(false);
const revokingGrantIds = ref(new Set<string>());
const grantFormRef = ref<FormInstance>();
const targetType = ref<'USER' | 'ORGANIZATION'>('ORGANIZATION');
const targetUserId = ref<number>();
const targetOrganizationId = ref<number>();
const grantRules = computed<FormRules>(() => ({
  targetOrganizationId: [
    {
      validator: (_rule, _value, callback) =>
        targetType.value !== 'ORGANIZATION' || targetOrganizationId.value !== undefined
          ? callback()
          : callback(new Error(translate('marAgentModels.selectOrganization'))),
      trigger: 'change'
    }
  ],
  targetUserId: [
    {
      validator: (_rule, _value, callback) =>
        targetType.value !== 'USER' || targetUserId.value !== undefined
          ? callback()
          : callback(new Error(translate('marAgentModels.selectUser'))),
      trigger: 'change'
    }
  ]
}));
const grantOpen = computed({
  get: () => selectedModel.value !== undefined,
  set: (value) => {
    if (!value) selectedModel.value = undefined;
  }
});
async function openGrants(row: ModelSummary): Promise<void> {
  selectedModel.value = row;
  targetType.value = 'ORGANIZATION';
  targetUserId.value = undefined;
  targetOrganizationId.value = undefined;
  grantLoading.value = true;
  const query = new URLSearchParams({ resourceType: 'MODEL', modelId: row.id });
  try {
    const [grantResult, organizationResult, userResult] = await Promise.all([
      props.request<{ grants: readonly Grant[] }>(`/api/resource-grants?${query}`),
      props
        .request<{ organizations: readonly OrganizationSummary[] }>('/api/organizations')
        .catch(() => ({ organizations: [] as readonly OrganizationSummary[] })),
      props
        .request<{ users: readonly User[] }>('/api/enterprise/users')
        .catch(() => ({ users: [] as readonly User[] }))
    ]);
    grants.value = grantResult.grants;
    organizations.value = organizationResult.organizations;
    users.value = userResult.users;
  } catch (error) {
    selectedModel.value = undefined;
    showMessage(
      error instanceof Error ? errorMessage(error) : translate('marAgentModels.grantsLoadFailed'),
      'error',
      error
    );
  } finally {
    grantLoading.value = false;
  }
}

async function refreshGrantState(modelId: string): Promise<void> {
  const query = new URLSearchParams({ resourceType: 'MODEL', modelId });
  const grantResult = await props.request<{ grants: readonly Grant[] }>(
    `/api/resource-grants?${query}`
  );
  grants.value = grantResult.grants;
  const models = await props.refresh();
  selectedModel.value = models.find((model) => model.id === modelId);
}

async function createGrant(): Promise<void> {
  const row = selectedModel.value;
  if (row === undefined || !(await grantFormRef.value?.validate().catch(() => false))) return;
  grantSaving.value = true;
  try {
    await props.request('/api/resource-grants', {
      method: 'POST',
      body: JSON.stringify({
        resourceType: 'MODEL',
        modelId: row.id,
        targetType: targetType.value,
        targetUserId: targetType.value === 'USER' ? targetUserId.value : undefined,
        targetOrganizationId:
          targetType.value === 'ORGANIZATION' ? targetOrganizationId.value : undefined
      })
    });
    await refreshGrantState(row.id);
    showMessage(translate('marAgentModels.grantCreated'), 'success');
  } catch (error) {
    showMessage(
      error instanceof Error ? errorMessage(error) : translate('marAgentModels.grantCreateFailed'),
      'error',
      error
    );
  } finally {
    grantSaving.value = false;
  }
}

async function removeGrant(grant: Grant): Promise<void> {
  const model = selectedModel.value;
  if (model === undefined) return;
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
    revokingGrantIds.value = new Set(revokingGrantIds.value).add(grant.id);
    await props.request(`/api/resource-grants/${encodeURIComponent(grant.id)}`, {
      method: 'DELETE'
    });
    await refreshGrantState(model.id);
    showMessage(translate('marAgentModels.grantRemoved'), 'success');
  } catch (error) {
    if (error !== 'cancel')
      showMessage(
        error instanceof Error
          ? errorMessage(error)
          : translate('marAgentModels.grantRemoveFailed'),
        'error',
        error
      );
  } finally {
    const next = new Set(revokingGrantIds.value);
    next.delete(grant.id);
    revokingGrantIds.value = next;
  }
}

function organizationLabel(organizationId: number | undefined): string {
  if (organizationId === undefined) return '—';
  return organizationDisplayLabel(organizations.value, organizationId);
}

function grantTargetLabel(grant: Grant): string {
  if (grant.targetType === 'USER')
    return users.value.find((user) => user.id === grant.targetUserId)?.username ?? '—';
  return organizationLabel(grant.targetOrganizationId);
}

defineExpose({ open: openGrants });
</script>
<template>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="grantOpen"
    v-model="grantOpen"
    :title="translate('marAgentModels.accessDialogTitle')"
    width="min(640px, calc(100vw - 32px))"
    :close-icon="marIcon('close')"
  >
    <div v-if="selectedModel" class="model-access-context">
      <strong>{{ selectedModel.name }}</strong>
      <code>{{ selectedModel.modelId }}</code>
    </div>
    <el-alert
      :title="translate('marAgentModels.publicHint')"
      type="info"
      :closable="false"
      show-icon
      ><template #icon><MarIcon name="info" /></template
    ></el-alert>
    <div v-loading="grantLoading">
      <el-form
        ref="grantFormRef"
        :model="{ targetType, targetOrganizationId, targetUserId }"
        :rules="grantRules"
        class="grant-create"
        label-position="top"
      >
        <el-form-item :label="translate('marAgentModels.targetType')">
          <el-select
            v-model="targetType"
            :disabled="!writable"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option :label="translate('marAgentModels.organization')" value="ORGANIZATION" />
            <el-option :label="translate('marAgentModels.user')" value="USER" />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="targetType === 'ORGANIZATION'"
          :label="translate('marAgentModels.targetOrganization')"
          prop="targetOrganizationId"
        >
          <el-cascader
            v-model="targetOrganizationId"
            style="width: 100%"
            :disabled="!writable"
            :placeholder="translate('marAgentModels.selectOrganization')"
            filterable
            :options="organizationOptions"
            :props="{ checkStrictly: true, emitPath: false }"
            :clear-icon="marIcon('clear-input')"
          />
        </el-form-item>
        <el-form-item
          v-else-if="targetType === 'USER'"
          :label="translate('marAgentModels.targetUser')"
          prop="targetUserId"
        >
          <el-select
            v-model="targetUserId"
            :disabled="!writable"
            :placeholder="translate('marAgentModels.selectUser')"
            filterable
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option
              v-for="user in users"
              :key="user.id"
              :label="`${user.username} · ${organizationLabel(user.organizationId)}`"
              :value="user.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <el-table :data="grants" row-key="id" :empty-text="translate('marAgentModels.noGrants')">
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
          <template #default="{ row }">{{ grantTargetLabel(row) }}</template>
        </el-table-column>
        <el-table-column :label="translate('marAgentModels.actions')" width="100">
          <template #default="{ row }">
            <el-button
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="!writable"
              :loading="revokingGrantIds.has(row.id)"
              @click="removeGrant(row)"
              :loading-icon="marIcon('loading-action')"
            >
              {{ translate('marAgentModels.revoke') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button @click="grantOpen = false">{{ translate('marAgentModels.close') }}</el-button>
      <el-button
        type="primary"
        :icon="marIcon('share')"
        :disabled="!writable || grantLoading"
        :loading="grantSaving"
        @click="createGrant"
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
