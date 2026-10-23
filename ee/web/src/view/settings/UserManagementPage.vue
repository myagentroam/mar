<script setup lang="ts">
import MarIcon from '@myagentroam/web-core/MarIcon.vue';
import { marIcon } from '@myagentroam/web-core/icons';
import { managementDateTime } from '@myagentroam/web-core/time-presentation';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { translate } from '@/service/LocalePreferenceService';
import { errorMessage } from '@/util/workbench-presentation';
import { createUserManagementService } from '@/service/UserManagementService';
import ManagementPagination from '@myagentroam/web-core/ManagementPagination.vue';

interface ManagedUser {
  id: number;
  username: string;
  email: string | null;
  nickname: string | null;
  isAdmin: boolean;
  createdAt: number;
}
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const sortBy = ref<string>();
const sortOrder = ref<'asc' | 'desc'>();
const createOpen = ref(false);
const userDetail = ref<ManagedUser>();
const credentialResult = ref<{
  readonly titleKey: string;
  readonly username: string;
  readonly password: string;
}>();
const form = ref({ username: '', email: '', nickname: '' });
const usersPage = createUserManagementService<ManagedUser>({
  request: props.request,
  endpoint: '/api/management/users',
  query: () => ({ sortBy: sortBy.value, sortOrder: sortOrder.value }),
  reportError: (error) => ElMessage.error({ icon: marIcon('error'), message: errorMessage(error) })
});
const pageReady = ref(false);
watch(usersPage.result, (result) => {
  if (result !== undefined) pageReady.value = true;
});
const canCreate = () => form.value.username.trim().length > 0;
const formatTime = (value: number) => managementDateTime(value);
function openUserDetail(user: ManagedUser): void {
  userDetail.value = user;
}

async function load(): Promise<void> {
  await usersPage.load(true);
}
function changeSort(input: { readonly prop?: string; readonly order?: string | null }): void {
  sortBy.value = input.order ? input.prop : undefined;
  sortOrder.value =
    input.order === 'descending' ? 'desc' : input.order === 'ascending' ? 'asc' : undefined;
  void usersPage.load(true);
}
async function create(): Promise<void> {
  if (!canCreate()) return;
  try {
    const username = form.value.username.trim();
    const result = await props.request<{ temporaryPassword: string }>('/api/management/users', {
      method: 'POST',
      body: JSON.stringify(form.value)
    });
    credentialResult.value = {
      titleKey: 'generated.userManagementPage.userCreated',
      username,
      password: result.temporaryPassword
    };
    form.value = { username: '', email: '', nickname: '' };
    createOpen.value = false;
    await load();
  } catch (error) {
    ElMessage.error({
      icon: marIcon('error'),
      message:
        error instanceof Error
          ? errorMessage(error)
          : translate('generated.userManagementPage.unableToCreateUser')
    });
  }
}
async function reset(user: ManagedUser): Promise<void> {
  try {
    const result = await props.request<{ temporaryPassword: string }>(
      `/api/management/users/${user.id}/reset-password`,
      { method: 'POST' }
    );
    credentialResult.value = {
      titleKey: 'generated.userManagementPage.passwordReset',
      username: user.username,
      password: result.temporaryPassword
    };
  } catch (error) {
    ElMessage.error({
      icon: marIcon('error'),
      message:
        error instanceof Error
          ? errorMessage(error)
          : translate('generated.userManagementPage.unableToResetPassword')
    });
  }
}
async function confirmReset(user: ManagedUser): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.userManagementPage.resetThePasswordForTheUserMust', {
        value0: user.username
      }),
      translate('generated.userManagementPage.resetPassword'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        confirmButtonText: translate('generated.userManagementPage.resetPassword2'),
        cancelButtonText: translate('generated.userManagementPage.cancel'),
        type: 'warning'
      }
    );
    await reset(user);
  } catch {
    /* The user cancelled or closed the confirmation dialog. */
  }
}
async function remove(user: ManagedUser): Promise<void> {
  try {
    await props.request(`/api/management/users/${user.id}`, { method: 'DELETE' });
    await load();
  } catch (error) {
    ElMessage.error({
      icon: marIcon('error'),
      message:
        error instanceof Error
          ? errorMessage(error)
          : translate('generated.userManagementPage.unableToDeleteUser')
    });
  }
}
async function confirmRemove(user: ManagedUser): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.userManagementPage.deleteUserNodesRegisteredByThisUser', {
        value0: user.username
      }),
      translate('generated.userManagementPage.deleteUser'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        confirmButtonText: translate('generated.userManagementPage.deleteUser2'),
        cancelButtonText: translate('generated.userManagementPage.cancel2'),
        type: 'warning'
      }
    );
    await remove(user);
  } catch {
    /* The user cancelled or closed the confirmation dialog. */
  }
}
function copyCredential(value: string): void {
  void window.navigator.clipboard.writeText(value);
}
function copyCredentials(): void {
  if (credentialResult.value === undefined) return;
  copyCredential(
    translate('generated.userManagementPage.usernamePassword', {
      value0: credentialResult.value.username,
      value1: credentialResult.value.password
    })
  );
}
onMounted(() => {
  usersPage.start();
  void load();
});
onUnmounted(() => usersPage.dispose());
</script>
<template>
  <section
    v-loading="usersPage.loading.value && !pageReady"
    element-loading-custom-class="mar-page-loading"
    class="management-page"
  >
    <div class="table-actions">
      <el-button type="primary" @click="createOpen = true">{{
        translate('generated.userManagementPage.createUser')
      }}</el-button>
    </div>
    <el-table
      v-loading="usersPage.loading.value && pageReady && !usersPage.loadingMore.value"
      class="clickable-rows"
      :data="usersPage.items.value"
      row-key="id"
      @row-click="openUserDetail"
      @sort-change="changeSort"
      ><el-table-column
        prop="username"
        :label="translate('generated.userManagementPage.username')"
        sortable="custom"
      /><el-table-column
        prop="email"
        :label="translate('generated.userManagementPage.email')"
        sortable="custom"
      /><el-table-column
        prop="nickname"
        :label="translate('generated.userManagementPage.nickname')"
        sortable="custom"
      /><el-table-column
        prop="role"
        :label="translate('generated.userManagementPage.role')"
        sortable="custom"
        ><template #default="{ row }">{{
          row.isAdmin
            ? translate('generated.userManagementPage.administrator')
            : translate('generated.userManagementPage.user')
        }}</template></el-table-column
      ><el-table-column :label="translate('generated.userManagementPage.actions')" :width="180"
        ><template #default="{ row }"
          ><div class="row-actions" @click.stop>
            <el-button
              v-if="!row.isAdmin"
              link
              type="primary"
              :icon="marIcon('key')"
              @click="confirmReset(row)"
              >{{ translate('generated.userManagementPage.resetPassword3') }}</el-button
            ><el-button
              v-if="!row.isAdmin"
              link
              type="danger"
              :icon="marIcon('delete')"
              @click="confirmRemove(row)"
              >{{ translate('generated.userManagementPage.delete') }}</el-button
            >
          </div></template
        ></el-table-column
      ></el-table
    >
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
      v-model="createOpen"
      :title="translate('generated.userManagementPage.createUser2')"
      width="420"
      :close-icon="marIcon('close')"
      ><el-form label-position="top"
        ><el-form-item :label="translate('generated.userManagementPage.username2')" required
          ><el-input v-model="form.username" /></el-form-item
        ><el-form-item :label="translate('generated.userManagementPage.email2')"
          ><el-input v-model="form.email" /></el-form-item
        ><el-form-item :label="translate('generated.userManagementPage.nickname2')"
          ><el-input v-model="form.nickname" /></el-form-item></el-form
      ><template #footer
        ><el-button @click="createOpen = false">{{
          translate('generated.userManagementPage.cancel3')
        }}</el-button
        ><el-button type="primary" :disabled="!canCreate()" @click="create">{{
          translate('generated.userManagementPage.createUser3')
        }}</el-button></template
      ></el-dialog
    >
    <el-dialog
      :model-value="credentialResult !== undefined"
      :title="credentialResult === undefined ? '' : translate(credentialResult.titleKey)"
      width="420"
      class="credential-result-dialog"
      @close="credentialResult = undefined"
      :close-icon="marIcon('close')"
      ><el-alert
        :title="
          translate('generated.userManagementPage.copyAndSecurelyDeliverTheseCredentials', {
            value0: credentialResult === undefined ? '' : translate(credentialResult.titleKey)
          })
        "
        type="success"
        :closable="false"
        show-icon
        ><template #icon><MarIcon name="success" /></template
      ></el-alert>
      <dl class="credential-result">
        <div>
          <dt>{{ translate('generated.userManagementPage.username3') }}</dt>
          <dd>{{ credentialResult?.username }}</dd>
        </div>
        <div>
          <dt>{{ translate('generated.userManagementPage.temporaryPassword') }}</dt>
          <dd>
            <code>{{ credentialResult?.password }}</code>
          </dd>
        </div>
      </dl>
      <el-button class="credential-copy-button" type="primary" @click="copyCredentials">{{
        translate('generated.userManagementPage.copyUsernameAndPassword')
      }}</el-button>
      <p class="credential-hint">
        {{ translate('generated.userManagementPage.theUserMustChangeThePasswordAfter') }}
      </p></el-dialog
    >
    <el-dialog
      v-if="userDetail !== undefined"
      :model-value="true"
      :title="translate('generated.userManagementPage.userDetails')"
      width="min(720px, calc(100vw - 32px))"
      @update:model-value="userDetail = undefined"
      :close-icon="marIcon('close')"
    >
      <el-descriptions class="mar-detail-descriptions" :column="1" border>
        <el-descriptions-item :label="translate('common.userId')">{{
          userDetail.id
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('generated.userManagementPage.username')">{{
          userDetail.username
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('generated.userManagementPage.email')">{{
          userDetail.email ?? '-'
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('generated.userManagementPage.nickname')">{{
          userDetail.nickname ?? '-'
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('generated.userManagementPage.role')">{{
          userDetail.isAdmin
            ? translate('generated.userManagementPage.administrator')
            : translate('generated.userManagementPage.user')
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('common.createdAt')">{{
          formatTime(userDetail.createdAt)
        }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </section>
</template>

<style scoped>
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}

.row-actions .el-button + .el-button {
  margin-left: 0;
}

.credential-result {
  display: grid;
  gap: 18px;
  margin: 0 0 22px;
}

.credential-result > div {
  display: grid;
  gap: 7px;
}

.credential-result dt {
  color: var(--el-text-color-regular);
  font-size: var(--mar-font-size-body);
  font-weight: 600;
}

.credential-result dd {
  margin: 0;
  overflow-wrap: anywhere;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-fill-color-light);
  padding: 10px 12px;
  color: var(--el-text-color-primary);
  font-size: var(--mar-font-size-body);
  line-height: 1.45;
}

.credential-result dd code {
  font-family: var(--el-font-family);
  font-size: inherit;
}

.credential-copy-button {
  width: 100%;
}

.credential-hint {
  margin: 14px 0 0;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-body);
}
</style>

<style scoped>
:global(.credential-result-dialog .el-alert) {
  margin-bottom: 20px;
}
</style>
