<script setup lang="ts">
import { managementDateTime } from '@myagentroam/web-core/time-presentation';
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { Delete, Edit, Plus, Refresh } from '@element-plus/icons-vue';
import { organizationPath, type OrganizationSummary } from '@/service/EnterpriseManagementService';
import { managementUrlValues, replaceManagementUrlValues } from '@/service/ManagementUrlService';
import { translate } from '@/service/LocalePreferenceService';
import { errorMessage } from '@/util/workbench-presentation';

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
const organizationOpen = ref(false);
const editingOrganizationId = ref<number>();
const organizationDetail = ref<Organization>();
const organizationForm = ref({ name: '', parentOrganizationId: 1 });
const organizationFormRef = ref<FormInstance>();
const keyword = ref('');
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
async function load(): Promise<void> {
  loading.value = true;
  try {
    organizations.value = (
      await props.request<{ organizations: readonly Organization[] }>('/api/organizations')
    ).organizations;
  } catch (error) {
    ElMessage.error(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.organizationUserManagementPage.unableToLoadOrganizationsAndUsers')
    );
  } finally {
    loading.value = false;
  }
}
async function saveOrganization(): Promise<void> {
  if (!(await organizationFormRef.value?.validate().catch(() => false))) return;
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
    await load();
  } catch (error) {
    ElMessage.error(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.organizationUserManagementPage.unableToSaveOrganization')
    );
  }
}
async function removeOrganization(organization: Organization): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate(
        'generated.organizationUserManagementPage.deleteItsOrganizationResourcesWillBeTransferred',
        { value0: path(organization.id) }
      ),
      translate('generated.organizationUserManagementPage.deleteOrganization'),
      {
        type: 'warning',
        confirmButtonText: translate(
          'generated.organizationUserManagementPage.deleteOrganization2'
        ),
        cancelButtonText: translate('generated.organizationUserManagementPage.cancel3')
      }
    );
    await props.request(`/api/organizations/${organization.id}`, { method: 'DELETE' });
    await load();
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(errorMessage(error));
  }
}
onMounted(() => {
  void load();
});
</script>

<template>
  <section v-loading="loading" class="management-page organization-management">
    <div class="filter-row">
      <label class="filter-field"
        ><span>{{ translate('generated.organizationUserManagementPage.organization') }}</span
        ><el-input
          v-model="keyword"
          clearable
          :placeholder="
            translate('generated.organizationUserManagementPage.enterAnOrganizationNameOrID')
          "
      /></label>
    </div>
    <div class="table-actions">
      <el-button :icon="Refresh" @click="load">{{
        translate('generated.organizationUserManagementPage.refresh')
      }}</el-button>
    </div>
    <el-table
      class="organization-tree-table clickable-rows"
      :data="organizationTree"
      row-key="id"
      default-expand-all
      :tree-props="{ children: 'children' }"
      @row-click="openOrganizationDetail"
    >
      <el-table-column
        prop="name"
        :label="translate('generated.organizationUserManagementPage.organizationName')"
        min-width="240"
      />
      <el-table-column
        prop="id"
        :label="translate('generated.organizationUserManagementPage.organizationID')"
        width="120"
      />
      <el-table-column
        :label="translate('generated.organizationUserManagementPage.actions')"
        :width="280"
      >
        <template #default="{ row }">
          <div class="organization-actions" @click.stop>
            <el-button
              link
              type="primary"
              :icon="Edit"
              :disabled="!writable"
              @click="editOrganization(row)"
              >{{ translate('generated.organizationUserManagementPage.edit') }}</el-button
            >
            <el-button
              link
              type="primary"
              :icon="Plus"
              :disabled="!writable"
              @click="openOrganization(row)"
              >{{ translate('generated.organizationUserManagementPage.addChild') }}</el-button
            ><el-button
              v-if="row.id !== 1"
              link
              type="danger"
              :icon="Delete"
              :disabled="!writable"
              @click="removeOrganization(row)"
              >{{ translate('generated.organizationUserManagementPage.delete') }}</el-button
            >
          </div>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog
      v-if="organizationOpen"
      v-model="organizationOpen"
      :title="
        editingOrganizationId === undefined
          ? translate('generated.organizationUserManagementPage.createOrganization')
          : translate('generated.organizationUserManagementPage.editOrganization')
      "
      width="min(440px, calc(100vw - 32px))"
      ><el-form
        ref="organizationFormRef"
        :model="organizationForm"
        :rules="organizationRules"
        label-position="top"
        ><el-form-item
          :label="translate('generated.organizationUserManagementPage.name')"
          prop="name"
          ><el-input
            v-model="organizationForm.name"
            :placeholder="
              translate('generated.organizationUserManagementPage.enterAnOrganizationName2')
            " /></el-form-item
        ><el-form-item
          v-if="editingOrganizationId === undefined"
          :label="translate('generated.organizationUserManagementPage.parentOrganization')"
          ><el-input
            :model-value="path(organizationForm.parentOrganizationId)"
            disabled
            :placeholder="
              translate('generated.organizationUserManagementPage.parentOrganization2')
            " /></el-form-item></el-form
      ><template #footer
        ><el-button @click="organizationOpen = false">{{
          translate('generated.organizationUserManagementPage.cancel4')
        }}</el-button
        ><el-button type="primary" :disabled="!writable" @click="saveOrganization">{{
          editingOrganizationId === undefined
            ? translate('generated.organizationUserManagementPage.createOrganization2')
            : translate('generated.organizationUserManagementPage.save')
        }}</el-button></template
      ></el-dialog
    >
    <el-dialog
      v-if="organizationDetail !== undefined"
      :model-value="true"
      :title="translate('generated.organizationUserManagementPage.organizationDetails')"
      width="min(720px, calc(100vw - 32px))"
      @update:model-value="organizationDetail = undefined"
    >
      <el-descriptions class="mar-detail-descriptions" :column="1" border>
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.organizationID')"
          >{{ organizationDetail.id }}</el-descriptions-item
        >
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.organizationName')"
          >{{ organizationDetail.name }}</el-descriptions-item
        >
        <el-descriptions-item
          :label="translate('generated.organizationUserManagementPage.parentOrganization2')"
          >{{
            organizationDetail.parentOrganizationId === null
              ? translate('generated.organizationUserManagementPage.rootOrganization')
              : path(organizationDetail.parentOrganizationId)
          }}</el-descriptions-item
        >
        <el-descriptions-item :label="translate('common.createdAt')">{{
          formatTime(organizationDetail.createdAt)
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('common.updatedAt')">{{
          formatTime(organizationDetail.updatedAt)
        }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </section>
</template>

<style scoped>
.organization-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}
.organization-actions .el-button + .el-button {
  margin-left: 0;
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
</style>
