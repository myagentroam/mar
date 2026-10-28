<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '@myagentroam/web-core/MobileDialogReturnService';
import { showMessage } from '@myagentroam/web-core/message-feedback';

import { marIcon } from '@myagentroam/web-core/icons';
import { computed, ref } from 'vue';
import { ElMessageBox } from '@myagentroam/web-core/MessageBoxService';
import { type FormRules, type FormInstance } from 'element-plus';
import {
  organizationCascaderOptions,
  organizationDisplayLabel,
  type OrganizationSummary
} from '@/service/enterprise-management-service';
import type {
  EnterpriseResourceRow,
  ResourceOwnerUser
} from '@/service/resource-ownership-service';
import { translate } from '@/service/locale-preference-service';
import { errorMessage } from '@myagentroam/web-core/workbench-presentation';
const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  writable: boolean;
  organizations: readonly OrganizationSummary[];
  users: readonly ResourceOwnerUser[];
}>();
interface Grant {
  id: string;
  targetType: 'USER' | 'ORGANIZATION';
  targetUserId?: number;
  targetOrganizationId?: number;
}
const selected = ref<EnterpriseResourceRow>();
const grants = ref<readonly Grant[]>([]);
const targetType = ref<'USER' | 'ORGANIZATION'>('ORGANIZATION');
const targetUserId = ref<number>();
const targetOrganizationId = ref<number>();
const grantFormRef = ref<FormInstance>();
const organizationOptions = computed(() => organizationCascaderOptions(props.organizations));
const path = (id: number) => organizationDisplayLabel(props.organizations, id);
const shareOpen = computed({
  get: () => selected.value !== undefined,
  set: (value) => {
    if (!value) selected.value = undefined;
  }
});
const grantRules = computed<FormRules>(() => ({
  targetOrganizationId: [
    {
      validator: (_rule, _value, callback) =>
        targetType.value !== 'ORGANIZATION' || targetOrganizationId.value !== undefined
          ? callback()
          : callback(
              new Error(translate('generated.resourceSharingPage.selectATargetOrganization'))
            ),
      trigger: 'change'
    }
  ],
  targetUserId: [
    {
      validator: (_rule, _value, callback) =>
        targetType.value !== 'USER' || targetUserId.value !== undefined
          ? callback()
          : callback(new Error(translate('generated.resourceSharingPage.selectATargetUser'))),
      trigger: 'change'
    }
  ]
}));
async function openShare(row: EnterpriseResourceRow): Promise<void> {
  selected.value = row;
  const query = new URLSearchParams({ resourceType: row.resourceType, nodeId: row.nodeId });
  if (row.workspaceId) query.set('workspaceId', row.workspaceId);
  try {
    grants.value = (
      await props.request<{ grants: readonly Grant[] }>(`/api/resource-grants?${query}`)
    ).grants;
  } catch (error) {
    selected.value = undefined;
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.resourceSharingPage.unableToLoadGrants'),
      'error',
      error
    );
  }
}
async function createGrant(): Promise<void> {
  if (!selected.value) return;
  if (!(await grantFormRef.value?.validate().catch(() => false))) return;
  const body = {
    resourceType: selected.value.resourceType,
    nodeId: selected.value.nodeId,
    workspaceId: selected.value.workspaceId ?? undefined,
    targetType: targetType.value,
    targetUserId: targetType.value === 'USER' ? targetUserId.value : undefined,
    targetOrganizationId:
      targetType.value === 'ORGANIZATION' ? targetOrganizationId.value : undefined
  };
  try {
    await props.request('/api/resource-grants', { method: 'POST', body: JSON.stringify(body) });
    await openShare(selected.value);
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.resourceSharingPage.unableToCreateGrant'),
      'error',
      error
    );
  }
}
async function removeGrant(grant: Grant): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.resourceSharingPage.afterRevocationTheTargetImmediatelyLosesDirect'),
      translate('generated.resourceSharingPage.revokeGrant'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.resourceSharingPage.revoke'),
        cancelButtonText: translate('generated.resourceSharingPage.cancel3')
      }
    );
    await props.request(`/api/resource-grants/${encodeURIComponent(grant.id)}`, {
      method: 'DELETE'
    });
    await openShare(selected.value!);
  } catch (error) {
    if (error !== 'cancel') showMessage(errorMessage(error), 'error', error);
  }
}
defineExpose({ open: openShare });
</script>
<template>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="shareOpen"
    v-model="shareOpen"
    :title="translate('generated.resourceSharingPage.resourceGrants')"
    width="min(620px, calc(100vw - 32px))"
    :close-icon="marIcon('close')"
    ><div v-if="selected" class="resource-context">
      <strong>{{ selected.label }}</strong
      ><code
        >{{ selected.nodeId }}{{ selected.workspaceId ? ` / ${selected.workspaceId}` : '' }}</code
      >
    </div>
    <el-form
      ref="grantFormRef"
      :model="{ targetType, targetOrganizationId, targetUserId }"
      :rules="grantRules"
      class="grant-create"
      label-position="top"
    >
      <el-form-item :label="translate('generated.resourceSharingPage.targetType')">
        <el-select
          v-model="targetType"
          :placeholder="translate('generated.resourceSharingPage.selectATargetType')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><el-option
            :label="translate('generated.resourceSharingPage.organization3')"
            value="ORGANIZATION" /><el-option
            :label="translate('generated.resourceSharingPage.user')"
            value="USER"
        /></el-select>
      </el-form-item>
      <el-form-item
        v-if="targetType === 'ORGANIZATION'"
        :label="translate('generated.resourceSharingPage.targetOrganization')"
        prop="targetOrganizationId"
      >
        <el-cascader
          v-model="targetOrganizationId"
          style="width: 100%"
          filterable
          :placeholder="translate('generated.resourceSharingPage.selectATargetOrganization2')"
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
        />
      </el-form-item>
      <el-form-item
        v-else-if="targetType === 'USER'"
        :label="translate('generated.resourceSharingPage.targetUser')"
        prop="targetUserId"
      >
        <el-select
          v-model="targetUserId"
          :placeholder="translate('generated.resourceSharingPage.selectATargetUser2')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><el-option
            v-for="user in users"
            :key="user.id"
            :value="user.id"
            :label="`${user.username} · ${path(user.organizationId)}`"
        /></el-select>
      </el-form-item>
    </el-form>
    <el-table :data="grants" row-key="id"
      ><el-table-column :label="translate('generated.resourceSharingPage.targetType2')"
        ><template #default="{ row }">{{
          row.targetType === 'USER'
            ? translate('generated.resourceSharingPage.user2')
            : translate('generated.resourceSharingPage.organization4')
        }}</template></el-table-column
      ><el-table-column :label="translate('generated.resourceSharingPage.target')"
        ><template #default="{ row }">{{
          row.targetType === 'USER'
            ? users.find((user) => user.id === row.targetUserId)?.username
            : path(row.targetOrganizationId)
        }}</template></el-table-column
      ><el-table-column :label="translate('generated.resourceSharingPage.actions2')" :width="180"
        ><template #default="{ row }"
          ><el-button
            link
            type="danger"
            :icon="marIcon('delete')"
            :disabled="!writable"
            @click="removeGrant(row)"
            >{{ translate('generated.resourceSharingPage.revoke2') }}</el-button
          ></template
        ></el-table-column
      ></el-table
    >
    <template #footer>
      <el-button @click="shareOpen = false">{{
        translate('generated.resourceSharingPage.close4')
      }}</el-button>
      <el-button type="primary" :icon="marIcon('share')" :disabled="!writable" @click="createGrant">
        {{ translate('common.grant') }}
      </el-button>
    </template>
  </el-dialog>
</template>
<style scoped>
.resource-context {
  display: grid;
  gap: 3px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--mar-border-subtle);
}
.grant-create {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr) auto;
  gap: 8px;
  padding: 12px 0;
}
.resource-context code {
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-muted);
}
@media (max-width: 767px) {
  .grant-create {
    grid-template-columns: 1fr;
  }
}
</style>
