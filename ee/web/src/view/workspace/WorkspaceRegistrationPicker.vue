<script setup lang="ts">
import { marIcon } from '@myagentroam/web-core/icons';
import { computed, ref, watch } from 'vue';
import CorePicker from '@myagentroam/web-core/WorkspaceRegistrationPicker.vue';
import type { WorkspaceDirectoryListing } from '@myagentroam/web-core/workspace-registration';
import {
  organizationDisplayLabel,
  type OrganizationSummary
} from '@/service/EnterpriseManagementService';
import { translate } from '@/service/LocalePreferenceService';
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  readonly modelValue: readonly string[];
  readonly directory: WorkspaceDirectoryListing | undefined;
  readonly selectedPath: string;
  readonly pendingDirectoryName: string;
  readonly loadingDirectory: boolean;
  readonly loading: boolean;
  readonly nodeReady: boolean;
  readonly selectedPathValid: boolean;
  readonly enterprise: boolean;
  readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null | undefined;
  readonly nodeOwnership:
    | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
    | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number }
    | undefined;
  readonly nodeManageable?: boolean | undefined;
  readonly workspaceCreatable?: boolean | undefined;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{
  register: [ownership?: { ownerType: 'ORGANIZATION'; ownerOrganizationId: number }];
}>();
const organizations = ref<readonly OrganizationSummary[]>([]);
const ownerOrganizationId = ref<number>();
const organizationOptions = computed(() => {
  if (props.nodeOwnership?.ownerType !== 'ORGANIZATION') return [];
  const rootId = props.nodeOwnership.ownerOrganizationId;
  const byParent = new Map<number, number[]>();
  for (const organization of organizations.value) {
    if (organization.parentOrganizationId === null) continue;
    const children = byParent.get(organization.parentOrganizationId) ?? [];
    children.push(organization.id);
    byParent.set(organization.parentOrganizationId, children);
  }
  const allowed = new Set<number>([rootId]);
  const pending = [rootId];
  while (pending.length > 0)
    for (const child of byParent.get(pending.shift()!) ?? [])
      if (!allowed.has(child)) {
        allowed.add(child);
        pending.push(child);
      }
  return organizations.value.filter((organization) => allowed.has(organization.id));
});
const fixedOrganizationOwnership = computed(
  () =>
    props.nodeOwnership?.ownerType === 'ORGANIZATION' &&
    props.workspaceCreatable === true &&
    props.nodeManageable === false
);
const canRegisterOwnership = computed(
  () =>
    fixedOrganizationOwnership.value ||
    props.nodeOwnership?.ownerType !== 'ORGANIZATION' ||
    (props.role !== 'MEMBER' && ownerOrganizationId.value !== undefined)
);
watch(
  () => props.nodeOwnership,
  (ownership) => {
    ownerOrganizationId.value =
      ownership?.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : undefined;
  },
  { immediate: true }
);
watch(
  () => props.enterprise,
  async (enterprise) => {
    if (!enterprise || props.role === 'MEMBER') return;
    try {
      organizations.value = (
        await props.request<{ organizations: readonly OrganizationSummary[] }>('/api/organizations')
      ).organizations;
    } catch {
      organizations.value = [];
    }
  },
  { immediate: true }
);
function submit(): void {
  if (fixedOrganizationOwnership.value) {
    emit('register');
    return;
  }
  if (props.nodeOwnership?.ownerType === 'ORGANIZATION') {
    if (ownerOrganizationId.value === undefined) return;
    emit('register', { ownerType: 'ORGANIZATION', ownerOrganizationId: ownerOrganizationId.value });
    return;
  }
  emit('register');
}
</script>
<template>
  <CorePicker
    v-bind="$attrs"
    :model-value="modelValue"
    :directory="directory"
    :selected-path="selectedPath"
    :pending-directory-name="pendingDirectoryName"
    :loading-directory="loadingDirectory"
    :loading="loading"
    :node-ready="nodeReady"
    :selected-path-valid="selectedPathValid"
    :registration-disabled="!canRegisterOwnership"
    @register="submit"
  >
    <template #ownership>
      <div v-if="enterprise" class="workspace-picker-ownership">
        <span>{{ translate('generated.workspaceRegistrationPicker.resourceOwner') }}</span>
        <strong v-if="nodeOwnership?.ownerType !== 'ORGANIZATION'">{{
          translate('generated.workspaceRegistrationPicker.personal')
        }}</strong>
        <strong v-else-if="fixedOrganizationOwnership">{{
          organizationDisplayLabel(organizations, nodeOwnership.ownerOrganizationId)
        }}</strong>
        <el-select
          v-else
          v-model="ownerOrganizationId"
          :disabled="role === 'MEMBER'"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            v-for="organization in organizationOptions"
            :key="organization.id"
            :value="organization.id"
            :label="organizationDisplayLabel(organizations, organization.id)"
          />
        </el-select>
        <small
          v-if="
            nodeOwnership?.ownerType === 'ORGANIZATION' &&
            role === 'MEMBER' &&
            !fixedOrganizationOwnership
          "
          >{{
            translate(
              'generated.workspaceRegistrationPicker.mEMBERUsersCannotCreateOrganizationWorkspaces'
            )
          }}</small
        >
      </div>
    </template>
  </CorePicker>
</template>
<style scoped>
.workspace-picker-ownership {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
}
.workspace-picker-ownership > span {
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
</style>
