<script setup lang="ts">
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarAlert } from '@myagentroam/mar-ui/alert';
import { MarCascader } from '@myagentroam/mar-ui/cascader';
import { MarDescriptions, MarDescriptionsItem } from '@myagentroam/mar-ui/descriptions';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';

import { MarInput } from '@myagentroam/mar-ui/input';
import { MarButton } from '@myagentroam/mar-ui/button';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '@myagentroam/web-core/MobileDialogReturnService';
import { watchManagementPageFailure } from '@myagentroam/web-core/management-page';
import { showMessage } from '@myagentroam/web-core/message-feedback';

import MarIcon from '@myagentroam/web-core/MarIcon.vue';
import { marIcon } from '@myagentroam/web-core/icons';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { MarMessageBox } from '@myagentroam/web-core/MessageBoxService';
import {
  organizationCascaderOptions,
  organizationPath,
  roleLabel,
  type EnterpriseRole,
  type OrganizationSummary
} from '@/service/enterprise-management-service';
import {
  managementUrlValues,
  replaceManagementUrlValues
} from '@myagentroam/web-core/management-url';
import { translate } from '@/service/locale-preference-service';
import { errorMessage } from '@myagentroam/web-core/workbench-presentation';
import { createUserManagementService } from '@/service/user-management-service';
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
const createUserTrigger = ref<InstanceType<typeof MarButton>>();
const creatingUser = ref(false);
let userGeneration = 0;
let disposed = false;
let returningFromCreation = false;
watch(
  userOpen,
  (open) => {
    if (open) returningFromCreation = editingUser.value === undefined;
    userGeneration += 1;
    creatingUser.value = false;
  },
  { flush: 'sync' }
);
function isCurrentUserDialog(generation: number): boolean {
  return !disposed && userOpen.value && generation === userGeneration;
}
function restoreCreateFocus(): void {
  if (!returningFromCreation) return;
  void nextTick(() => {
    if (!disposed && !userOpen.value && credentials.value === undefined)
      createUserTrigger.value?.focus();
  });
}
const userForm = ref<{
  username: string;
  email: string;
  nickname: string;
  role: EnterpriseRole;
  organizationId: number;
}>({ username: '', email: '', nickname: '', role: 'MEMBER', organizationId: 1 });
const credentialResults = ref<{ titleKey: string; username: string; password: string }[]>([]);
const credentials = computed(() => credentialResults.value[0]);
const credentialSequence = ref(0);
function dismissCredentials(): void {
  credentialResults.value.shift();
  credentialSequence.value += 1;
}
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
  })
});
watchManagementPageFailure(usersPage);
const tableLoading = computed(
  () => organizationsLoading.value || (usersPage.loading.value && !usersPage.loadingMore.value)
);
let loadSequence = 0;
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
  if (disposed) return;
  const current = ++loadSequence;
  organizationsLoading.value = true;
  let organizationFailure: { error: unknown } | undefined;
  try {
    const organizationResult = await props.request<{
      organizations: readonly OrganizationSummary[];
    }>('/api/organizations');
    if (current === loadSequence) organizations.value = organizationResult.organizations;
  } catch (error) {
    organizationFailure = { error };
  } finally {
    if (current === loadSequence) organizationsLoading.value = false;
  }
  if (current !== loadSequence) return;
  await usersPage.load(true);
  if (current === loadSequence && organizationFailure && !usersPage.failure.value) {
    const { error } = organizationFailure;
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.organizationUserManagementPage.unableToLoadOrganizationsAndUsers'),
      'error',
      error
    );
  }
}
function changeSort(input: { readonly prop?: string; readonly order?: string | null }): void {
  sortBy.value = input.order ? input.prop : undefined;
  sortOrder.value =
    input.order === 'descending' ? 'desc' : input.order === 'ascending' ? 'asc' : undefined;
  void usersPage.load(true);
}
async function createUser(draft: typeof userForm.value, generation: number): Promise<void> {
  try {
    const result = await props.request<{ user: EnterpriseUser; temporaryPassword: string }>(
      '/api/enterprise/users',
      {
        method: 'POST',
        body: JSON.stringify({
          ...draft,
          email: draft.email || undefined,
          nickname: draft.nickname || undefined
        })
      }
    );
    if (disposed) return;
    // UI cancellation cannot revoke a successful write or discard its one-time credentials.
    credentialResults.value.push({
      titleKey: 'generated.organizationUserManagementPage.userCreated',
      username: result.user.username,
      password: result.temporaryPassword
    });
    if (isCurrentUserDialog(generation)) userOpen.value = false;
    await load();
  } catch (error) {
    if (!isCurrentUserDialog(generation)) return;
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.organizationUserManagementPage.unableToCreateUser'),
      'error',
      error
    );
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
  if (!userOpen.value || disposed) return;
  const generation = userGeneration;
  const target = editingUser.value;
  if (target === undefined) {
    if (creatingUser.value) return;
    const draft = { ...userForm.value };
    creatingUser.value = true;
    try {
      const valid = await userFormRef.value?.validate().catch(() => false);
      if (valid && isCurrentUserDialog(generation)) await createUser(draft, generation);
    } finally {
      if (isCurrentUserDialog(generation)) creatingUser.value = false;
    }
    return;
  }
  const userId = target.id;
  const draft = userForm.value;
  const valid = await userFormRef.value?.validate().catch(() => false);
  if (!valid || !isCurrentUserDialog(generation)) return;
  try {
    await props.request(`/api/enterprise/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        email: draft.email || null,
        nickname: draft.nickname || null,
        role: draft.role,
        organizationId: draft.organizationId
      })
    });
  } catch (error) {
    if (!isCurrentUserDialog(generation)) return;
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.organizationUserManagementPage.unableToUpdateUser'),
      'error',
      error
    );
    return;
  }
  if (isCurrentUserDialog(generation)) {
    userOpen.value = false;
    editingUser.value = undefined;
    showMessage(translate('generated.organizationUserManagementPage.userUpdated'), 'success');
  }
  // A completed write still changes the list, even if its dialog is gone.
  if (!disposed) await load();
}
async function resetPassword(user: EnterpriseUser): Promise<void> {
  try {
    await MarMessageBox.confirm(
      translate(
        'generated.organizationUserManagementPage.resetThePasswordForExistingSessionsWill',
        { value0: user.username }
      ),
      translate('generated.organizationUserManagementPage.resetPassword'),
      {
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
    credentialResults.value.push({
      titleKey: 'generated.organizationUserManagementPage.passwordReset',
      username: user.username,
      password: result.temporaryPassword
    });
  } catch (error) {
    if (error !== 'cancel') showMessage(errorMessage(error), 'error', error);
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
    showMessage(
      translate('generated.organizationUserManagementPage.usernameAndPasswordCopied'),
      'info'
    );
  } catch {
    showMessage(
      translate('generated.organizationUserManagementPage.unableToAccessTheClipboardCopyThe'),
      'error'
    );
  }
}
async function removeUser(user: EnterpriseUser): Promise<void> {
  try {
    const { summary } = await props.request<{ summary: UserDeletionSummary }>(
      `/api/management/users/${user.id}/deletion-summary`
    );
    await MarMessageBox.confirm(
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
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.organizationUserManagementPage.deleteUser2'),
        cancelButtonText: translate('generated.organizationUserManagementPage.cancel2')
      }
    );
    await props.request(`/api/management/users/${user.id}`, { method: 'DELETE' });
    await load();
  } catch (error) {
    if (error !== 'cancel') showMessage(errorMessage(error), 'error', error);
  }
}
onMounted(() => {
  usersPage.start();
  void load();
});
onUnmounted(() => {
  disposed = true;
  loadSequence += 1;
  userGeneration += 1;
  usersPage.dispose();
});
</script>

<template>
  <section class="mar-management-page">
    <div class="mar-filter-row">
      <label class="mar-filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.user') }}</span
        ><MarInput
          v-model="keyword"
          clearable
          :placeholder="
            translate('generated.organizationUserManagementPage.enterAUsernameEmailOrDisplayName')
          "
          :clear-icon="marIcon('clear-input')"
      /></label>
      <label class="mar-filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.role') }}</span
        ><MarSelect
          v-model="roleFilter"
          :placeholder="translate('generated.organizationUserManagementPage.selectARole2')"
          ><MarOption
            :label="translate('generated.organizationUserManagementPage.allRoles')"
            value="" /><MarOption
            v-for="role in roles"
            :key="role"
            :label="roleLabel(role)"
            :value="role" /></MarSelect
      ></label>
      <label class="mar-filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.organization2') }}</span
        ><MarCascader
          v-model="organizationFilter"
          clearable
          filterable
          :placeholder="translate('generated.organizationUserManagementPage.selectAnOrganization2')"
          :options="organizationOptions"
          :props="{ checkStrictly: true, emitPath: false }"
          :clear-icon="marIcon('clear-input')"
      /></label>
      <label class="mar-filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.status') }}</span
        ><MarSelect
          v-model="enabledFilter"
          clearable
          :placeholder="translate('generated.organizationUserManagementPage.selectAStatus')"
          ><MarOption
            :label="translate('generated.organizationUserManagementPage.enabled')"
            :value="true" /><MarOption
            :label="translate('generated.organizationUserManagementPage.disabled')"
            :value="false" /></MarSelect
      ></label>
    </div>
    <div class="mar-table-actions">
      <MarButton :icon="marIcon('refresh')" :disabled="tableLoading" @click="load">{{
        translate('generated.organizationUserManagementPage.refresh')
      }}</MarButton>
      <MarButton
        type="primary"
        :icon="marIcon('plus')"
        ref="createUserTrigger"
        :disabled="!writable"
        @click="openCreateUser"
        >{{ translate('generated.organizationUserManagementPage.createUser') }}</MarButton
      >
    </div>
    <MarTable
      :aria-busy="tableLoading"
      class="clickable-rows"
      :data="usersPage.items.value"
      row-key="id"
      @row-click="openUserDetail"
      @sort-change="changeSort"
    >
      <template v-if="tableLoading" #loading
        ><span role="progressbar" :aria-label="translate('common.loading')"
          ><i class="mar-busy-indicator mar-read-loading-indicator" aria-hidden="true" /></span
      ></template>
      <MarTableColumn
        prop="username"
        :label="translate('generated.organizationUserManagementPage.user2')"
        sortable="custom"
        min-width="120"
      />
      <MarTableColumn
        prop="email"
        :label="translate('generated.organizationUserManagementPage.email')"
        sortable="custom"
        min-width="160"
      />
      <MarTableColumn
        prop="nickname"
        :label="translate('generated.organizationUserManagementPage.displayName')"
        sortable="custom"
        min-width="140"
      />
      <MarTableColumn
        :label="translate('generated.organizationUserManagementPage.role2')"
        width="190"
        ><template #default="{ row }">{{ roleLabel(row.role) }}</template></MarTableColumn
      >
      <MarTableColumn
        :label="translate('generated.organizationUserManagementPage.organization3')"
        min-width="210"
        ><template #default="{ row }">{{ path(row.organizationId) }}</template></MarTableColumn
      >
      <MarTableColumn
        :label="translate('generated.organizationUserManagementPage.status2')"
        width="100"
        ><template #default="{ row }"
          ><MarTag :type="row.enabled ? 'success' : 'info'" effect="plain">{{
            row.enabled
              ? translate('generated.organizationUserManagementPage.enabled2')
              : translate('generated.organizationUserManagementPage.disabled2')
          }}</MarTag></template
        ></MarTableColumn
      >
      <MarTableColumn
        :label="translate('generated.organizationUserManagementPage.actions2')"
        :width="usersPage.mobileViewport.value ? undefined : 320"
        :min-width="usersPage.mobileViewport.value ? 144 : undefined"
        ><template #default="{ row }"
          ><div class="mar-row-actions mar-row-actions--wrap" @click.stop>
            <MarButton
              link
              :icon="marIcon('edit')"
              :disabled="!writable"
              @click="openEditUser(row)"
              >{{ translate('generated.organizationUserManagementPage.edit2') }}</MarButton
            ><MarButton
              link
              :icon="marIcon('key')"
              :disabled="!writable || row.fixedAdmin"
              @click="resetPassword(row)"
              >{{ translate('generated.organizationUserManagementPage.resetPassword3') }}</MarButton
            ><MarButton
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="!writable || row.fixedAdmin"
              @click="removeUser(row)"
              >{{ translate('generated.organizationUserManagementPage.delete2') }}</MarButton
            >
          </div></template
        ></MarTableColumn
      >
    </MarTable>
    <ManagementPagination
      :total="usersPage.total.value"
      :has-more="usersPage.hasMore.value"
      :loading="usersPage.loading.value"
      :loading-more="usersPage.loadingMore.value"
      :page="usersPage.page.value"
      :mobile="usersPage.mobileViewport.value"
      :mobile-visible-count="usersPage.mobileVisibleCount.value"
      @page="usersPage.setPage"
      :failed="usersPage.failure.value !== undefined"
      :incremental-failed="usersPage.failure.value?.incremental === true"
      :error="usersPage.failure.value?.error"
      :context-key="usersPage.contextKey.value"
      @retry="usersPage.retry"
      @load-more="usersPage.loadMore"
    />
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="userOpen"
      v-model="userOpen"
      @close="userOpen = false"
      @close-auto-focus="restoreCreateFocus"
      :title="
        editingUser === undefined
          ? translate('generated.organizationUserManagementPage.createUser2')
          : translate('generated.organizationUserManagementPage.editUser')
      "
      width="min(480px, calc(100vw - 32px))"
      ><MarForm ref="userFormRef" :model="userForm" :rules="userRules" label-position="top"
        ><MarFormItem
          :label="translate('generated.organizationUserManagementPage.username')"
          prop="username"
          ><MarInput
            v-model="userForm.username"
            :placeholder="translate('generated.organizationUserManagementPage.enterAUsername2')"
            :disabled="creatingUser || editingUser !== undefined" /></MarFormItem
        ><MarFormItem
          :label="translate('generated.organizationUserManagementPage.email2')"
          prop="email"
          ><MarInput
            v-model="userForm.email"
            :disabled="creatingUser"
            :placeholder="
              translate('generated.organizationUserManagementPage.enterAnEmailAddressOptional')
            " /></MarFormItem
        ><MarFormItem
          :label="translate('generated.organizationUserManagementPage.displayName2')"
          prop="nickname"
          ><MarInput
            v-model="userForm.nickname"
            :disabled="creatingUser"
            :placeholder="
              translate('generated.organizationUserManagementPage.enterADisplayNameOptional')
            " /></MarFormItem
        ><MarFormItem
          :label="translate('generated.organizationUserManagementPage.role3')"
          prop="role"
          ><MarSelect
            v-model="userForm.role"
            :disabled="creatingUser || editingUser?.fixedAdmin"
            :placeholder="translate('generated.organizationUserManagementPage.selectARole3')"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><MarOption
              v-for="role in roles"
              :key="role"
              :label="roleLabel(role)"
              :value="role" /></MarSelect></MarFormItem
        ><MarFormItem
          :label="translate('generated.organizationUserManagementPage.organization4')"
          prop="organizationId"
          ><label class="user-form-organization">
            <span class="user-form-organization__name">{{
              translate('generated.organizationUserManagementPage.organization4')
            }}</span>
            <MarCascader
              v-model="userForm.organizationId"
              style="width: 100%"
              :disabled="creatingUser || userForm.role === 'ADMIN'"
              filterable
              :placeholder="
                translate('generated.organizationUserManagementPage.selectAnOrganization3')
              "
              :options="organizationOptions"
              :props="{ checkStrictly: true, emitPath: false }"
              :clear-icon="marIcon('clear-input')"
            /> </label></MarFormItem></MarForm
      ><template #footer
        ><MarButton @click="userOpen = false">{{
          translate('generated.organizationUserManagementPage.cancel5')
        }}</MarButton
        ><MarButton
          type="primary"
          :disabled="!writable"
          :loading="creatingUser"
          @click="saveUser"
          >{{
            editingUser === undefined
              ? translate('generated.organizationUserManagementPage.createUser3')
              : translate('generated.organizationUserManagementPage.save2')
          }}</MarButton
        ></template
      ></MarDialog
    >
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="credentials !== undefined"
      :key="credentialSequence"
      :model-value="credentials !== undefined"
      :title="translate(credentials.titleKey)"
      width="min(440px, calc(100vw - 32px))"
      @close="dismissCredentials"
      ><MarAlert
        :title="
          translate(
            'generated.organizationUserManagementPage.temporaryCredentialsAreShownOnlyOnceThe'
          )
        "
        type="warning"
        :closable="false"
        show-icon
        ><template #icon><MarIcon name="warning" /></template
      ></MarAlert>
      <MarDescriptions
        v-if="credentials"
        class="credential-details mar-detail-descriptions"
        :column="1"
        border
      >
        <MarDescriptionsItem
          :label="translate('generated.organizationUserManagementPage.username2')"
          ><code>{{ credentials.username }}</code></MarDescriptionsItem
        >
        <MarDescriptionsItem
          :label="translate('generated.organizationUserManagementPage.temporaryPassword')"
          ><code>{{ credentials.password }}</code></MarDescriptionsItem
        >
      </MarDescriptions>
      <template #footer
        ><MarButton @click="copyCredentials">{{
          translate('generated.organizationUserManagementPage.copyUsernameAndPassword')
        }}</MarButton
        ><MarButton type="primary" @click="dismissCredentials">{{
          translate('generated.organizationUserManagementPage.done')
        }}</MarButton></template
      >
    </MarDialog>
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="userDetail !== undefined"
      :model-value="true"
      :title="translate('generated.organizationUserManagementPage.userDetails')"
      width="min(720px, calc(100vw - 32px))"
      @update:model-value="userDetail = undefined"
    >
      <MarDescriptions class="mar-detail-descriptions" :column="1" border>
        <MarDescriptionsItem :label="translate('common.userId')">{{
          userDetail.id
        }}</MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('generated.organizationUserManagementPage.user2')">{{
          userDetail.username
        }}</MarDescriptionsItem>
        <MarDescriptionsItem
          :label="translate('generated.organizationUserManagementPage.email2')"
          >{{ userDetail.email ?? '-' }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          :label="translate('generated.organizationUserManagementPage.displayName')"
          >{{ userDetail.nickname ?? '-' }}</MarDescriptionsItem
        >
        <MarDescriptionsItem :label="translate('generated.organizationUserManagementPage.role2')">{{
          roleLabel(userDetail.role)
        }}</MarDescriptionsItem>
        <MarDescriptionsItem
          :label="translate('generated.organizationUserManagementPage.organization3')"
          >{{ path(userDetail.organizationId) }}</MarDescriptionsItem
        >
        <MarDescriptionsItem :label="translate('generated.organizationUserManagementPage.status2')"
          ><MarTag :type="userDetail.enabled ? 'success' : 'info'" effect="plain">{{
            userDetail.enabled
              ? translate('generated.organizationUserManagementPage.enabled2')
              : translate('generated.organizationUserManagementPage.disabled2')
          }}</MarTag></MarDescriptionsItem
        >
      </MarDescriptions>
    </MarDialog>
  </section>
</template>

<style scoped>
.user-form-organization {
  width: 100%;
}

.user-form-organization__name {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.credential-details {
  margin-top: 12px;
}
.credential-details code {
  font-size: var(--mar-font-size-meta);
  overflow-wrap: anywhere;
}
.clickable-rows :deep(.mar-ui-table__row) {
  cursor: pointer;
}
</style>
