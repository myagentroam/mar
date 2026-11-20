<script setup lang="ts">
import { vMarLoading } from '@myagentroam/mar-ui/loading';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarAlert } from '@myagentroam/mar-ui/alert';
import { MarDescriptions, MarDescriptionsItem } from '@myagentroam/mar-ui/descriptions';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import { MarForm, MarFormItem } from '@myagentroam/mar-ui/form';
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
import { managementDateTime } from '@myagentroam/web-core/time-presentation';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { MarMessageBox } from '@myagentroam/web-core/MessageBoxService';
import { translate } from '@/service/locale-preference-service';
import { errorMessage } from '@myagentroam/web-core/workbench-presentation';
import { createUserManagementService } from '@/service/user-management-service';
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
  query: () => ({ sortBy: sortBy.value, sortOrder: sortOrder.value })
});
watchManagementPageFailure(usersPage);
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
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.userManagementPage.unableToCreateUser'),
      'error',
      error
    );
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
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.userManagementPage.unableToResetPassword'),
      'error',
      error
    );
  }
}
async function confirmReset(user: ManagedUser): Promise<void> {
  try {
    await MarMessageBox.confirm(
      translate('generated.userManagementPage.resetThePasswordForTheUserMust', {
        value0: user.username
      }),
      translate('generated.userManagementPage.resetPassword'),
      {
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
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.userManagementPage.unableToDeleteUser'),
      'error',
      error
    );
  }
}
async function confirmRemove(user: ManagedUser): Promise<void> {
  try {
    await MarMessageBox.confirm(
      translate('generated.userManagementPage.deleteUserNodesRegisteredByThisUser', {
        value0: user.username
      }),
      translate('generated.userManagementPage.deleteUser'),
      {
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
async function copyCredentials(): Promise<void> {
  const credentials = credentialResult.value;
  if (credentials === undefined) return;
  try {
    const clipboard = window.navigator.clipboard;
    if (typeof clipboard?.writeText !== 'function') throw new Error('CLIPBOARD_UNAVAILABLE');
    await clipboard.writeText(
      translate('generated.userManagementPage.usernamePassword', {
        value0: credentials.username,
        value1: credentials.password
      })
    );
  } catch {
    showMessage(
      translate('generated.userManagementPage.unableToAccessTheClipboardCopyThe'),
      'error'
    );
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
    v-mar-loading:page="usersPage.loading.value && !pageReady && !usersPage.failure.value"
    class="mar-management-page"
  >
    <div class="mar-table-actions">
      <MarButton type="primary" @click="createOpen = true">{{
        translate('generated.userManagementPage.createUser')
      }}</MarButton>
    </div>
    <MarTable
      v-mar-loading:region="
        usersPage.loading.value &&
        pageReady &&
        !usersPage.loadingMore.value &&
        !usersPage.failure.value
      "
      class="clickable-rows"
      :data="usersPage.items.value"
      row-key="id"
      @row-click="openUserDetail"
      @sort-change="changeSort"
      ><MarTableColumn
        prop="username"
        :label="translate('generated.userManagementPage.username')"
        sortable="custom"
      /><MarTableColumn
        prop="email"
        :label="translate('generated.userManagementPage.email')"
        sortable="custom"
      /><MarTableColumn
        prop="nickname"
        :label="translate('generated.userManagementPage.nickname')"
        sortable="custom"
      /><MarTableColumn
        prop="role"
        :label="translate('generated.userManagementPage.role')"
        sortable="custom"
        ><template #default="{ row }">{{
          row.isAdmin
            ? translate('generated.userManagementPage.administrator')
            : translate('generated.userManagementPage.user')
        }}</template></MarTableColumn
      ><MarTableColumn
        :label="translate('generated.userManagementPage.actions')"
        :width="usersPage.mobileViewport.value ? undefined : 180"
        :min-width="usersPage.mobileViewport.value ? 144 : undefined"
        ><template #default="{ row }"
          ><div class="mar-row-actions mar-row-actions--wrap" @click.stop>
            <MarButton v-if="!row.isAdmin" link :icon="marIcon('key')" @click="confirmReset(row)">{{
              translate('generated.userManagementPage.resetPassword3')
            }}</MarButton
            ><MarButton
              v-if="!row.isAdmin"
              link
              type="danger"
              :icon="marIcon('delete')"
              @click="confirmRemove(row)"
              >{{ translate('generated.userManagementPage.delete') }}</MarButton
            >
          </div></template
        ></MarTableColumn
      ></MarTable
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
      v-model="createOpen"
      :title="translate('generated.userManagementPage.createUser2')"
      width="420"
      ><MarForm label-position="top"
        ><MarFormItem :label="translate('generated.userManagementPage.username2')" required
          ><MarInput v-model="form.username" /></MarFormItem
        ><MarFormItem :label="translate('generated.userManagementPage.email2')"
          ><MarInput v-model="form.email" /></MarFormItem
        ><MarFormItem :label="translate('generated.userManagementPage.nickname2')"
          ><MarInput v-model="form.nickname" /></MarFormItem></MarForm
      ><template #footer
        ><MarButton @click="createOpen = false">{{
          translate('generated.userManagementPage.cancel3')
        }}</MarButton
        ><MarButton type="primary" :disabled="!canCreate()" @click="create">{{
          translate('generated.userManagementPage.createUser3')
        }}</MarButton></template
      ></MarDialog
    >
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      :model-value="credentialResult !== undefined"
      :title="credentialResult === undefined ? '' : translate(credentialResult.titleKey)"
      width="420"
      class="credential-result-dialog"
      @close="credentialResult = undefined"
      ><MarAlert
        :title="
          translate('generated.userManagementPage.copyAndSecurelyDeliverTheseCredentials', {
            value0: credentialResult === undefined ? '' : translate(credentialResult.titleKey)
          })
        "
        type="success"
        :closable="false"
        show-icon
        ><template #icon><MarIcon name="success" /></template
      ></MarAlert>
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
      <MarButton class="credential-copy-button" type="primary" @click="copyCredentials">{{
        translate('generated.userManagementPage.copyUsernameAndPassword')
      }}</MarButton>
      <p class="credential-hint">
        {{ translate('generated.userManagementPage.theUserMustChangeThePasswordAfter') }}
      </p></MarDialog
    >
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="userDetail !== undefined"
      :model-value="true"
      :title="translate('generated.userManagementPage.userDetails')"
      width="min(720px, calc(100vw - 32px))"
      @update:model-value="userDetail = undefined"
    >
      <MarDescriptions class="mar-detail-descriptions" :column="1" border>
        <MarDescriptionsItem :label="translate('common.userId')">{{
          userDetail.id
        }}</MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('generated.userManagementPage.username')">{{
          userDetail.username
        }}</MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('generated.userManagementPage.email')">{{
          userDetail.email ?? '-'
        }}</MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('generated.userManagementPage.nickname')">{{
          userDetail.nickname ?? '-'
        }}</MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('generated.userManagementPage.role')">{{
          userDetail.isAdmin
            ? translate('generated.userManagementPage.administrator')
            : translate('generated.userManagementPage.user')
        }}</MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('common.createdAt')">{{
          formatTime(userDetail.createdAt)
        }}</MarDescriptionsItem>
      </MarDescriptions>
    </MarDialog>
  </section>
</template>

<style scoped>
.clickable-rows :deep(.mar-ui-table__row) {
  cursor: pointer;
}

.mar-row-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}

.mar-row-actions .mar-ui-button + .mar-ui-button {
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
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  font-weight: 600;
}

.credential-result dd {
  margin: 0;
  overflow-wrap: anywhere;
  border: 1px solid var(--mar-input-border);
  border-radius: 6px;
  background: var(--mar-action-hover-bg);
  padding: 10px 12px;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  line-height: 1.45;
}

.credential-result dd code {
  font-family: var(--mar-font-sans);
  font-size: inherit;
}

.credential-copy-button {
  width: 100%;
}

.credential-hint {
  margin: 14px 0 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
}
</style>

<style scoped>
:global(.credential-result-dialog .mar-ui-alert) {
  margin-bottom: 20px;
}
</style>
