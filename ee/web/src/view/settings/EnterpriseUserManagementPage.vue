<script setup lang="ts">
import MarIcon from '@myagentroam/web-core/MarIcon.vue';
import { marIcon } from '@myagentroam/web-core/icons';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import {
  organizationCascaderOptions,
  organizationPath,
  roleLabel,
  type EnterpriseRole,
  type OrganizationSummary
} from '@/service/EnterpriseManagementService';
import { managementUrlValues, replaceManagementUrlValues } from '@/service/ManagementUrlService';
import { translate } from '@/service/LocalePreferenceService';
import { errorMessage } from '@/util/workbench-presentation';
import { createUserManagementService } from '@/service/UserManagementService';
import ManagementPagination from '@myagentroam/web-core/ManagementPagination.vue';

interface EnterpriseUser {
  id: number;
  username: string;
  email: string | null;
  nickname: string | null;
  role: EnterpriseRole;
  organizationId: number;
  fixedAdmin: boolean;
  enabled: boolean;
}
interface UserDeletionSummary {
  organizationId: number | null;
  role: string | null;
  sessions: number;
  externalIdentities: number;
  grants: number;
  personalNodes: number;
  personalWorkspaces: number;
}
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly admin: boolean;
}>();
const organizations = ref<readonly OrganizationSummary[]>([]);
const organizationsLoading = ref(false);
const userOpen = ref(false);
const editingUser = ref<EnterpriseUser>();
const userDetail = ref<EnterpriseUser>();
const userFormRef = ref<FormInstance>();
const userForm = ref<{
  username: string;
  email: string;
  nickname: string;
  role: EnterpriseRole;
  organizationId: number;
}>({ username: '', email: '', nickname: '', role: 'MEMBER', organizationId: 1 });
const credentials = ref<{ titleKey: string; username: string; password: string }>();
const keyword = ref('');
const roleFilter = ref<EnterpriseRole | ''>('');
const organizationFilter = ref<number>();
const enabledFilter = ref<boolean>();
const sortBy = ref<string>();
const sortOrder = ref<'asc' | 'desc'>();
const initialFilters = managementUrlValues('users', ['keyword', 'role', 'organization', 'status']);
keyword.value = initialFilters.keyword ?? '';
roleFilter.value = (initialFilters.role as EnterpriseRole | undefined) ?? '';
organizationFilter.value = initialFilters.organization
  ? Number(initialFilters.organization)
  : undefined;
enabledFilter.value =
  initialFilters.status === 'enabled'
    ? true
    : initialFilters.status === 'disabled'
      ? false
      : undefined;
const usersPage = createUserManagementService<EnterpriseUser>({
  request: props.request,
  endpoint: '/api/enterprise/users',
  query: () => ({
    keyword: keyword.value,
    role: roleFilter.value || undefined,
    organizationId: organizationFilter.value,
    status:
      enabledFilter.value === undefined ? undefined : enabledFilter.value ? 'enabled' : 'disabled',
    sortBy: sortBy.value,
    sortOrder: sortOrder.value
  }),
  reportError: (error) =>
    ElMessage.error({
      icon: marIcon('error'),
      message:
        error instanceof Error
          ? errorMessage(error)
          : translate('generated.organizationUserManagementPage.unableToLoadOrganizationsAndUsers')
    })
});
const loading = computed(() => organizationsLoading.value || usersPage.loading.value);
const organizationsReady = ref(false);
const usersReady = ref(false);
const pageReady = computed(() => organizationsReady.value && usersReady.value);
const refreshLoading = ref(false);
watch(usersPage.result, (result) => {
  if (result !== undefined) usersReady.value = true;
});
watch([keyword, roleFilter, organizationFilter, enabledFilter], () => {
  replaceManagementUrlValues('users', {
    keyword: keyword.value,
    role: roleFilter.value || undefined,
    organization: organizationFilter.value,
    status:
      enabledFilter.value === undefined ? undefined : enabledFilter.value ? 'enabled' : 'disabled'
  });
  void usersPage.load(true);
});
const userRules = computed<FormRules>(() => ({
  username: [
    {
      required: true,
      whitespace: true,
      message: translate('generated.organizationUserManagementPage.enterAUsername'),
      trigger: 'blur'
    },
    {
      max: 80,
      message: translate(
        'generated.organizationUserManagementPage.theUsernameCannotExceed80Characters'
      ),
      trigger: 'blur'
    }
  ],
  email: [
    {
      type: 'email',
      message: translate('generated.organizationUserManagementPage.enterAValidEmailAddress'),
      trigger: 'blur'
    },
    {
      max: 254,
      message: translate(
        'generated.organizationUserManagementPage.theEmailAddressCannotExceed254Characters'
      ),
      trigger: 'blur'
    }
  ],
  nickname: [
    {
      max: 80,
      message: translate(
        'generated.organizationUserManagementPage.theDisplayNameCannotExceed80Characters'
      ),
      trigger: 'blur'
    }
  ],
  role: [
    {
      required: true,
      message: translate('generated.organizationUserManagementPage.selectARole'),
      trigger: 'change'
    }
  ],
  organizationId: [
    {
      required: true,
      message: translate('generated.organizationUserManagementPage.selectAnOrganization'),
      trigger: 'change'
    }
  ]
}));
const roles = computed<readonly EnterpriseRole[]>(() =>
  props.admin ? ['ADMIN', 'ORG_ADMIN', 'MEMBER'] : ['ORG_ADMIN', 'MEMBER']
);
const path = (id: number) => organizationPath(organizations.value, id);
function openUserDetail(user: EnterpriseUser): void {
  userDetail.value = user;
}
const organizationOptions = computed(() => organizationCascaderOptions(organizations.value));
async function load(): Promise<void> {
  organizationsLoading.value = true;
  try {
    const organizationResult = await props.request<{
      organizations: readonly OrganizationSummary[];
    }>('/api/organizations');
    organizations.value = organizationResult.organizations;
    organizationsReady.value = true;
  } catch (error) {
    ElMessage.error({
      icon: marIcon('error'),
      message:
        error instanceof Error
          ? errorMessage(error)
          : translate('generated.organizationUserManagementPage.unableToLoadOrganizationsAndUsers')
    });
  } finally {
    organizationsLoading.value = false;
  }
  await usersPage.load(true);
}
async function refresh(): Promise<void> {
  refreshLoading.value = true;
  try {
    await load();
  } finally {
    refreshLoading.value = false;
  }
}
function changeSort(input: { readonly prop?: string; readonly order?: string | null }): void {
  sortBy.value = input.order ? input.prop : undefined;
  sortOrder.value =
    input.order === 'descending' ? 'desc' : input.order === 'ascending' ? 'asc' : undefined;
  void usersPage.load(true);
}
async function createUser(): Promise<void> {
  try {
    const result = await props.request<{ user: EnterpriseUser; temporaryPassword: string }>(
      '/api/enterprise/users',
      {
        method: 'POST',
        body: JSON.stringify({
          ...userForm.value,
          email: userForm.value.email || undefined,
          nickname: userForm.value.nickname || undefined
        })
      }
    );
    credentials.value = {
      titleKey: 'generated.organizationUserManagementPage.userCreated',
      username: result.user.username,
      password: result.temporaryPassword
    };
    userOpen.value = false;
    await load();
  } catch (error) {
    ElMessage.error({
      icon: marIcon('error'),
      message:
        error instanceof Error
          ? errorMessage(error)
          : translate('generated.organizationUserManagementPage.unableToCreateUser')
    });
  }
}
function openCreateUser(): void {
  editingUser.value = undefined;
  userForm.value = { username: '', email: '', nickname: '', role: 'MEMBER', organizationId: 1 };
  userOpen.value = true;
}
function openEditUser(user: EnterpriseUser): void {
  editingUser.value = user;
  userForm.value = {
    username: user.username,
    email: user.email ?? '',
    nickname: user.nickname ?? '',
    role: user.role,
    organizationId: user.organizationId
  };
  userOpen.value = true;
}
async function saveUser(): Promise<void> {
  if (!(await userFormRef.value?.validate().catch(() => false))) return;
  if (editingUser.value === undefined) return createUser();
  try {
    await props.request(`/api/enterprise/users/${editingUser.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        email: userForm.value.email || null,
        nickname: userForm.value.nickname || null,
        role: userForm.value.role,
        organizationId: userForm.value.organizationId
      })
    });
    userOpen.value = false;
    editingUser.value = undefined;
    ElMessage.success({
      icon: marIcon('success'),
      message: translate('generated.organizationUserManagementPage.userUpdated')
    });
    await load();
  } catch (error) {
    ElMessage.error({
      icon: marIcon('error'),
      message:
        error instanceof Error
          ? errorMessage(error)
          : translate('generated.organizationUserManagementPage.unableToUpdateUser')
    });
  }
}
async function resetPassword(user: EnterpriseUser): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate(
        'generated.organizationUserManagementPage.resetThePasswordForExistingSessionsWill',
        { value0: user.username }
      ),
      translate('generated.organizationUserManagementPage.resetPassword'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.organizationUserManagementPage.resetPassword2'),
        cancelButtonText: translate('generated.organizationUserManagementPage.cancel')
      }
    );
    const result = await props.request<{ temporaryPassword: string }>(
      `/api/management/users/${user.id}/reset-password`,
      { method: 'POST' }
    );
    credentials.value = {
      titleKey: 'generated.organizationUserManagementPage.passwordReset',
      username: user.username,
      password: result.temporaryPassword
    };
  } catch (error) {
    if (error !== 'cancel')
      ElMessage.error({ icon: marIcon('error'), message: errorMessage(error) });
  }
}
async function copyCredentials(): Promise<void> {
  if (credentials.value === undefined) return;
  try {
    if (navigator.clipboard?.writeText === undefined) throw new Error('CLIPBOARD_UNAVAILABLE');
    await navigator.clipboard.writeText(
      translate('generated.organizationUserManagementPage.usernamePassword', {
        value0: credentials.value.username,
        value1: credentials.value.password
      })
    );
    ElMessage.info({
      icon: marIcon('info'),
      message: translate('generated.organizationUserManagementPage.usernameAndPasswordCopied')
    });
  } catch {
    ElMessage.error({
      icon: marIcon('error'),
      message: translate(
        'generated.organizationUserManagementPage.unableToAccessTheClipboardCopyThe'
      )
    });
  }
}
async function removeUser(user: EnterpriseUser): Promise<void> {
  try {
    const { summary } = await props.request<{ summary: UserDeletionSummary }>(
      `/api/management/users/${user.id}/deletion-summary`
    );
    await ElMessageBox.confirm(
      translate(
        'generated.organizationUserManagementPage.deletingRemovesPersonalNodesPersonalWorkspacesSessions',
        {
          value0: user.username,
          value1: summary.personalNodes,
          value2: summary.personalWorkspaces,
          value3: summary.sessions,
          value4: summary.externalIdentities,
          value5: summary.grants
        }
      ),
      translate('generated.organizationUserManagementPage.deleteUser'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.organizationUserManagementPage.deleteUser2'),
        cancelButtonText: translate('generated.organizationUserManagementPage.cancel2')
      }
    );
    await props.request(`/api/management/users/${user.id}`, { method: 'DELETE' });
    await load();
  } catch (error) {
    if (error !== 'cancel')
      ElMessage.error({ icon: marIcon('error'), message: errorMessage(error) });
  }
}
onMounted(() => {
  usersPage.start();
  void load();
});
onUnmounted(() => usersPage.dispose());
</script>

<template>
  <section
    v-loading="loading && !pageReady"
    element-loading-custom-class="mar-page-loading"
    class="management-page"
  >
    <div class="filter-row">
      <label class="filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.user') }}</span
        ><el-input
          v-model="keyword"
          clearable
          :placeholder="
            translate('generated.organizationUserManagementPage.enterAUsernameEmailOrDisplayName')
          "
          :clear-icon="marIcon('clear-input')"
      /></label>
      <label class="filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.role') }}</span
        ><el-select
          v-model="roleFilter"
          :placeholder="translate('generated.organizationUserManagementPage.selectARole2')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><el-option
            :label="translate('generated.organizationUserManagementPage.allRoles')"
            value="" /><el-option
            v-for="role in roles"
            :key="role"
            :label="roleLabel(role)"
            :value="role" /></el-select
      ></label>
      <label class="filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.organization2') }}</span
        ><el-cascader
          v-model="organizationFilter"
          clearable
          filterable
          :placeholder="translate('generated.organizationUserManagementPage.selectAnOrganization2')"
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
      /></label>
      <label class="filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.status') }}</span
        ><el-select
          v-model="enabledFilter"
          clearable
          :placeholder="translate('generated.organizationUserManagementPage.selectAStatus')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
          ><el-option
            :label="translate('generated.organizationUserManagementPage.enabled')"
            :value="true" /><el-option
            :label="translate('generated.organizationUserManagementPage.disabled')"
            :value="false" /></el-select
      ></label>
    </div>
    <div class="table-actions">
      <el-button
        :icon="marIcon('refresh')"
        :loading="refreshLoading && pageReady"
        @click="refresh"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('generated.organizationUserManagementPage.refresh') }}</el-button
      >
      <el-button
        type="primary"
        :icon="marIcon('plus')"
        :disabled="!writable"
        @click="openCreateUser"
        >{{ translate('generated.organizationUserManagementPage.createUser') }}</el-button
      >
    </div>
    <el-table
      v-loading="
        usersPage.loading.value && pageReady && !usersPage.loadingMore.value && !refreshLoading
      "
      class="clickable-rows"
      :data="usersPage.items.value"
      row-key="id"
      @row-click="openUserDetail"
      @sort-change="changeSort"
    >
      <el-table-column
        prop="username"
        :label="translate('generated.organizationUserManagementPage.user2')"
        sortable="custom"
        min-width="120"
      />
      <el-table-column
        prop="email"
        :label="translate('generated.organizationUserManagementPage.email')"
        sortable="custom"
        min-width="160"
      />
      <el-table-column
        prop="nickname"
        :label="translate('generated.organizationUserManagementPage.displayName')"
        sortable="custom"
        min-width="140"
      />
      <el-table-column
        :label="translate('generated.organizationUserManagementPage.role2')"
        width="190"
        ><template #default="{ row }">{{ roleLabel(row.role) }}</template></el-table-column
      >
      <el-table-column
        :label="translate('generated.organizationUserManagementPage.organization3')"
        min-width="210"
        ><template #default="{ row }">{{ path(row.organizationId) }}</template></el-table-column
      >
      <el-table-column
        :label="translate('generated.organizationUserManagementPage.status2')"
        width="100"
        ><template #default="{ row }"
          ><el-tag :type="row.enabled ? 'success' : 'info'" effect="plain">{{
            row.enabled
              ? translate('generated.organizationUserManagementPage.enabled2')
              : translate('generated.organizationUserManagementPage.disabled2')
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column
        :label="translate('generated.organizationUserManagementPage.actions2')"
        :width="320"
        ><template #default="{ row }"
          ><div class="row-actions" @click.stop>
            <el-button
              link
              type="primary"
              :icon="marIcon('edit')"
              :disabled="!writable"
              @click="openEditUser(row)"
              >{{ translate('generated.organizationUserManagementPage.edit2') }}</el-button
            ><el-button
              link
              type="primary"
              :icon="marIcon('key')"
              :disabled="!writable || row.fixedAdmin"
              @click="resetPassword(row)"
              >{{ translate('generated.organizationUserManagementPage.resetPassword3') }}</el-button
            ><el-button
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="!writable || row.fixedAdmin"
              @click="removeUser(row)"
              >{{ translate('generated.organizationUserManagementPage.delete2') }}</el-button
            >
          </div></template
        ></el-table-column
      >
    </el-table>
    <ManagementPagination
      :total="usersPage.total.value"
      :has-more="usersPage.hasMore.value"
      :loading="usersPage.loading.value"
      :loading-more="usersPage.loadingMore.value"
      :page="usersPage.page.value"
      :mobile="usersPage.mobileViewport.value"
      :mobile-visible-count="usersPage.mobileVisibleCount.value"
      @page="usersPage.setPage"
      @load-more="usersPage.loadMore"
    />
    <el-dialog
      v-if="userOpen"
      v-model="userOpen"
      :title="
        editingUser === undefined
          ? translate('generated.organizationUserManagementPage.createUser2')
          : translate('generated.organizationUserManagementPage.editUser')
      "
      width="min(480px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
      ><el-form ref="userFormRef" :model="userForm" :rules="userRules" label-position="top"
        ><el-form-item
          :label="translate('generated.organizationUserManagementPage.username')"
          prop="username"
          ><el-input
            v-model="userForm.username"
            :placeholder="translate('generated.organizationUserManagementPage.enterAUsername2')"
            :disabled="editingUser !== undefined" /></el-form-item
        ><el-form-item
          :label="translate('generated.organizationUserManagementPage.email2')"
          prop="email"
          ><el-input
            v-model="userForm.email"
            :placeholder="
              translate('generated.organizationUserManagementPage.enterAnEmailAddressOptional')
            " /></el-form-item
        ><el-form-item
          :label="translate('generated.organizationUserManagementPage.displayName2')"
          prop="nickname"
          ><el-input
            v-model="userForm.nickname"
            :placeholder="
              translate('generated.organizationUserManagementPage.enterADisplayNameOptional')
            " /></el-form-item
        ><el-form-item
          :label="translate('generated.organizationUserManagementPage.role3')"
          prop="role"
          ><el-select
            v-model="userForm.role"
            :disabled="editingUser?.fixedAdmin"
            :placeholder="translate('generated.organizationUserManagementPage.selectARole3')"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><el-option
              v-for="role in roles"
              :key="role"
              :label="roleLabel(role)"
              :value="role" /></el-select></el-form-item
        ><el-form-item
          :label="translate('generated.organizationUserManagementPage.organization4')"
          prop="organizationId"
          ><el-cascader
            v-model="userForm.organizationId"
            style="width: 100%"
            :disabled="userForm.role === 'ADMIN'"
            filterable
            :placeholder="
              translate('generated.organizationUserManagementPage.selectAnOrganization3')
            "
            :options="organizationOptions"
            :props="{ checkStrictly: true, emitPath: false }"
            :clear-icon="marIcon('clear-input')" /></el-form-item></el-form
      ><template #footer
        ><el-button @click="userOpen = false">{{
          translate('generated.organizationUserManagementPage.cancel5')
        }}</el-button
        ><el-button type="primary" :disabled="!writable" @click="saveUser">{{
          editingUser === undefined
            ? translate('generated.organizationUserManagementPage.createUser3')
            : translate('generated.organizationUserManagementPage.save2')
        }}</el-button></template
      ></el-dialog
    >
    <el-dialog
      v-if="credentials !== undefined"
      :model-value="credentials !== undefined"
      :title="translate(credentials.titleKey)"
      width="min(440px, calc(100vw - 32px))"
      @update:model-value="credentials = undefined"
      :close-icon="marIcon('close')"
      ><el-alert
        :title="
          translate(
            'generated.organizationUserManagementPage.temporaryCredentialsAreShownOnlyOnceThe'
          )
        "
        type="warning"
        :closable="false"
        show-icon
        ><template #icon><MarIcon name="warning" /></template
      ></el-alert>
      <el-descriptions
        v-if="credentials"
        class="credential-details mar-detail-descriptions"
        :column="1"
        border
      >
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.username2')"
          ><code>{{ credentials.username }}</code></el-descriptions-item
        >
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.temporaryPassword')"
          ><code>{{ credentials.password }}</code></el-descriptions-item
        >
      </el-descriptions>
      <template #footer
        ><el-button @click="copyCredentials">{{
          translate('generated.organizationUserManagementPage.copyUsernameAndPassword')
        }}</el-button
        ><el-button type="primary" @click="credentials = undefined">{{
          translate('generated.organizationUserManagementPage.done')
        }}</el-button></template
      >
    </el-dialog>
    <el-dialog
      v-if="userDetail !== undefined"
      :model-value="true"
      :title="translate('generated.organizationUserManagementPage.userDetails')"
      width="min(720px, calc(100vw - 32px))"
      @update:model-value="userDetail = undefined"
      :close-icon="marIcon('close')"
    >
      <el-descriptions class="mar-detail-descriptions" :column="1" border>
        <el-descriptions-item :label="translate('common.userId')">{{
          userDetail.id
        }}</el-descriptions-item>
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.user2')"
          >{{ userDetail.username }}</el-descriptions-item
        >
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.email2')"
          >{{ userDetail.email ?? '-' }}</el-descriptions-item
        >
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.displayName')"
          >{{ userDetail.nickname ?? '-' }}</el-descriptions-item
        >
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.role2')"
          >{{ roleLabel(userDetail.role) }}</el-descriptions-item
        >
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.organization3')"
          >{{ path(userDetail.organizationId) }}</el-descriptions-item
        >
        <el-descriptions-item :label="translate('generated.organizationUserManagementPage.status2')"
          ><el-tag :type="userDetail.enabled ? 'success' : 'info'" effect="plain">{{
            userDetail.enabled
              ? translate('generated.organizationUserManagementPage.enabled2')
              : translate('generated.organizationUserManagementPage.disabled2')
          }}</el-tag></el-descriptions-item
        >
      </el-descriptions>
    </el-dialog>
  </section>
</template>

<style scoped>
.credential-details {
  margin-top: 12px;
}
.credential-details code {
  font-size: var(--mar-font-size-meta);
  overflow-wrap: anywhere;
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
</style>
