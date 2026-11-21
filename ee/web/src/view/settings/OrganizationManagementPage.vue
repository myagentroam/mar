<script setup lang="ts">
import '@myagentroam/web-core/management-detail.css';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarDescriptions, MarDescriptionsItem } from '@myagentroam/mar-ui/descriptions';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarButton } from '@myagentroam/mar-ui/button';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '@myagentroam/web-core/MobileDialogReturnService';
import { showMessage } from '@myagentroam/web-core/message-feedback';

import { marIcon } from '@myagentroam/mar-ui/icons';
import { MOBILE_WORKBENCH_VIEWPORT_QUERY } from '@myagentroam/web-core/mobile-workbench';
import { managementDateTime } from '@myagentroam/web-core/time-presentation';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { MarMessageBox } from '@myagentroam/web-core/MessageBoxService';
import {
  organizationPath,
  type OrganizationSummary
} from '@/service/enterprise-management-service';
import {
  managementUrlValues,
  replaceManagementUrlValues
} from '@myagentroam/web-core/management-url';
import { translate } from '@/service/locale-preference-service';
import { errorMessage } from '@myagentroam/web-core/workbench-presentation';

interface Organization extends OrganizationSummary {
  createdAt: number;
  updatedAt: number;
}
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
}>();
const organizations = ref<readonly Organization[]>([]);
const loading = ref(false);
const saving = ref(false);
let organizationLoadSequence = 0;
const organizationOpen = ref(false);
const editingOrganizationId = ref<number>();
const organizationDetail = ref<Organization>();
const organizationForm = ref({ name: '', parentOrganizationId: 1 });
const organizationFormRef = ref<FormInstance>();
const keyword = ref('');
const viewport = window.matchMedia(MOBILE_WORKBENCH_VIEWPORT_QUERY);
const mobileViewport = ref(viewport.matches);
function updateMobileViewport(event: MediaQueryListEvent): void {
  mobileViewport.value = event.matches;
}
const initialFilters = managementUrlValues('organizations', ['keyword']);
keyword.value = initialFilters.keyword ?? '';
watch(keyword, () => replaceManagementUrlValues('organizations', { keyword: keyword.value }));
const organizationRules = computed<FormRules>(() => ({
  name: [
    {
      required: true,
      whitespace: true,
      message: translate('generated.organizationUserManagementPage.enterAnOrganizationName'),
      trigger: 'blur'
    },
    {
      max: 128,
      message: translate(
        'generated.organizationUserManagementPage.theOrganizationNameCannotExceed128Characters'
      ),
      trigger: 'blur'
    }
  ]
}));
const path = (id: number) => organizationPath(organizations.value, id);
const formatTime = (value: number) => managementDateTime(value);
function openOrganizationDetail(organization: Organization): void {
  organizationDetail.value = organization;
}
interface OrganizationTreeNode extends Organization {
  children: OrganizationTreeNode[];
}
// Organization administration uses the full authorized tree so filtering can retain matching ancestors.
const organizationTree = computed<readonly OrganizationTreeNode[]>(() => {
  const nodes = new Map(
    organizations.value.map((organization) => [
      organization.id,
      { ...organization, children: [] as OrganizationTreeNode[] }
    ])
  );
  const roots: OrganizationTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent =
      node.parentOrganizationId === null ? undefined : nodes.get(node.parentOrganizationId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const needle = keyword.value.trim().toLowerCase();
  if (needle === '') return roots;
  const retain = (node: OrganizationTreeNode): OrganizationTreeNode | undefined => {
    const children = node.children.map(retain).filter((item) => item !== undefined);
    return `${node.name} ${node.id}`.toLowerCase().includes(needle) || children.length > 0
      ? { ...node, children }
      : undefined;
  };
  return roots.map(retain).filter((item) => item !== undefined);
});
function openOrganization(parent: Organization): void {
  editingOrganizationId.value = undefined;
  organizationForm.value = { name: '', parentOrganizationId: parent.id };
  organizationOpen.value = true;
}
function editOrganization(organization: Organization): void {
  editingOrganizationId.value = organization.id;
  organizationForm.value = {
    name: organization.name,
    parentOrganizationId: organization.parentOrganizationId ?? organization.id
  };
  organizationOpen.value = true;
}
async function load(preserveOnFailure = false): Promise<void> {
  const sequence = ++organizationLoadSequence;
  loading.value = true;
  try {
    const result = await props.request<{ organizations: readonly Organization[] }>(
      '/api/organizations'
    );
    if (sequence !== organizationLoadSequence) return;
    organizations.value = result.organizations;
  } catch (error) {
    if (sequence !== organizationLoadSequence) return;
    if (!preserveOnFailure) organizations.value = [];
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.organizationUserManagementPage.unableToLoadOrganizationsAndUsers'),
      'error',
      error
    );
  } finally {
    if (sequence === organizationLoadSequence) {
      loading.value = false;
    }
  }
}
async function saveOrganization(): Promise<void> {
  if (!props.writable || saving.value || loading.value) return;
  if (!(await organizationFormRef.value?.validate().catch(() => false))) return;
  if (!props.writable || saving.value || loading.value) return;
  saving.value = true;
  try {
    if (editingOrganizationId.value === undefined)
      await props.request('/api/organizations', {
        method: 'POST',
        body: JSON.stringify(organizationForm.value)
      });
    else
      await props.request(`/api/organizations/${editingOrganizationId.value}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: organizationForm.value.name })
      });
    organizationOpen.value = false;
    editingOrganizationId.value = undefined;
    organizationForm.value.name = '';
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.organizationUserManagementPage.unableToSaveOrganization'),
      'error',
      error
    );
    return;
  } finally {
    saving.value = false;
  }
  await load(true);
}
function requestOrganizationClose(done: () => void): void {
  if (!saving.value) done();
}
async function removeOrganization(organization: Organization): Promise<void> {
  try {
    await MarMessageBox.confirm(
      translate(
        'generated.organizationUserManagementPage.deleteItsOrganizationResourcesWillBeTransferred',
        { value0: path(organization.id) }
      ),
      translate('generated.organizationUserManagementPage.deleteOrganization'),
      {
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate(
          'generated.organizationUserManagementPage.deleteOrganization2'
        ),
        cancelButtonText: translate('generated.organizationUserManagementPage.cancel3')
      }
    );
    await props.request(`/api/organizations/${organization.id}`, { method: 'DELETE' });
    await load(true);
  } catch (error) {
    if (error !== 'cancel') showMessage(errorMessage(error), 'error', error);
  }
}
onMounted(() => {
  viewport.addEventListener('change', updateMobileViewport);
  void load();
});
onUnmounted(() => {
  organizationLoadSequence += 1;
  viewport.removeEventListener('change', updateMobileViewport);
});
</script>

<template>
  <section class="mar-management-page organization-management">
    <div class="mar-filter-row">
      <label class="mar-filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.organization') }}</span
        ><MarInput
          v-model="keyword"
          clearable
          :placeholder="
            translate('generated.organizationUserManagementPage.enterAnOrganizationNameOrID')
          "
          :clear-icon="marIcon('clear-input')"
      /></label>
    </div>
    <div class="mar-table-actions">
      <MarButton :icon="marIcon('refresh')" :disabled="loading" @click="load()">{{
        translate('generated.organizationUserManagementPage.refresh')
      }}</MarButton>
    </div>
    <MarTable
      :aria-busy="loading"
      class="organization-tree-table clickable-rows"
      :data="organizationTree"
      row-key="id"
      default-expand-all
      :tree-props="{ children: 'children' }"
      @row-click="openOrganizationDetail"
    >
      <template v-if="loading" #loading
        ><span role="progressbar" :aria-label="translate('common.loading')"
          ><i class="mar-busy-indicator mar-read-loading-indicator" aria-hidden="true" /></span
      ></template>
      <MarTableColumn
        prop="name"
        :label="translate('generated.organizationUserManagementPage.organizationName')"
        min-width="240"
      />
      <MarTableColumn
        prop="id"
        :label="translate('generated.organizationUserManagementPage.organizationID')"
        width="120"
      />
      <MarTableColumn
        :label="translate('generated.organizationUserManagementPage.actions')"
        :width="mobileViewport ? undefined : 280"
        :min-width="mobileViewport ? 144 : undefined"
      >
        <template #default="{ row }">
          <div class="organization-actions mar-row-actions--wrap" @click.stop>
            <MarButton
              link
              :icon="marIcon('edit')"
              :disabled="!writable"
              @click="editOrganization(row)"
              >{{ translate('generated.organizationUserManagementPage.edit') }}</MarButton
            >
            <MarButton
              link
              :icon="marIcon('plus')"
              :disabled="!writable"
              @click="openOrganization(row)"
              >{{ translate('generated.organizationUserManagementPage.addChild') }}</MarButton
            ><MarButton
              v-if="row.id !== 1"
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="!writable"
              @click="removeOrganization(row)"
              >{{ translate('generated.organizationUserManagementPage.delete') }}</MarButton
            >
          </div>
        </template>
      </MarTableColumn>
    </MarTable>
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="organizationOpen"
      v-model="organizationOpen"
      :before-close="requestOrganizationClose"
      :show-close="!saving"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :title="
        editingOrganizationId === undefined
          ? translate('generated.organizationUserManagementPage.createOrganization')
          : translate('generated.organizationUserManagementPage.editOrganization')
      "
      width="min(440px, calc(100vw - 32px))"
      ><MarForm
        ref="organizationFormRef"
        :model="organizationForm"
        :rules="organizationRules"
        :disabled="saving || !writable"
        label-position="top"
        ><MarFormItem
          :label="translate('generated.organizationUserManagementPage.name')"
          prop="name"
          ><MarInput
            v-model="organizationForm.name"
            :placeholder="
              translate('generated.organizationUserManagementPage.enterAnOrganizationName2')
            " /></MarFormItem
        ><MarFormItem
          v-if="editingOrganizationId === undefined"
          :label="translate('generated.organizationUserManagementPage.parentOrganization')"
          ><MarInput
            :model-value="path(organizationForm.parentOrganizationId)"
            disabled
            :placeholder="
              translate('generated.organizationUserManagementPage.parentOrganization2')
            " /></MarFormItem></MarForm
      ><template #footer
        ><MarButton :disabled="saving" @click="organizationOpen = false">{{
          translate('generated.organizationUserManagementPage.cancel4')
        }}</MarButton
        ><MarButton
          type="primary"
          :disabled="!writable"
          :loading="saving"
          @click="saveOrganization"
          >{{
            editingOrganizationId === undefined
              ? translate('generated.organizationUserManagementPage.createOrganization2')
              : translate('generated.organizationUserManagementPage.save')
          }}</MarButton
        ></template
      ></MarDialog
    >
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="organizationDetail !== undefined"
      :model-value="true"
      :title="translate('generated.organizationUserManagementPage.organizationDetails')"
      width="min(720px, calc(100vw - 32px))"
      @update:model-value="organizationDetail = undefined"
    >
      <MarDescriptions class="mar-detail-descriptions" :column="1" border>
        <MarDescriptionsItem
          :label="translate('generated.organizationUserManagementPage.organizationID')"
          >{{ organizationDetail.id }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          :label="translate('generated.organizationUserManagementPage.organizationName')"
          >{{ organizationDetail.name }}</MarDescriptionsItem
        >
        <MarDescriptionsItem
          :label="translate('generated.organizationUserManagementPage.parentOrganization2')"
          >{{
            organizationDetail.parentOrganizationId === null
              ? translate('generated.organizationUserManagementPage.rootOrganization')
              : path(organizationDetail.parentOrganizationId)
          }}</MarDescriptionsItem
        >
        <MarDescriptionsItem :label="translate('common.createdAt')">{{
          formatTime(organizationDetail.createdAt)
        }}</MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('common.updatedAt')">{{
          formatTime(organizationDetail.updatedAt)
        }}</MarDescriptionsItem>
      </MarDescriptions>
    </MarDialog>
  </section>
</template>

<style scoped>
.organization-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}
.organization-actions .mar-ui-button + .mar-ui-button {
  margin-left: 0;
}
.clickable-rows :deep(.mar-ui-table__row) {
  cursor: pointer;
}
</style>
