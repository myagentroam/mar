<script setup lang="ts">
import { showMessage } from '@myagentroam/web-core/message-feedback';

import { marIcon } from '@myagentroam/web-core/icons';
import { ElMessageBox } from '@myagentroam/web-core/MessageBoxService';
import { computed, ref, watch } from 'vue';
import type { SettingsSection, UserSessionSummary, QuickPrompt } from '@/model/workbench';
import {
  organizationPath,
  type OrganizationSummary
} from '@/service/enterprise-management-service';
import { oauthErrorMessage } from '@/util/oauth-callback';
import { translate } from '@/service/locale-preference-service';
import SharedSettingsContent from '@myagentroam/web-core/SettingsContent.vue';
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  readonly section: SettingsSection;
  readonly sessions: readonly UserSessionSummary[];
  readonly newPassword: string;
  readonly passwordValidationError: string;
  readonly registrationToken: string | undefined;
  readonly registrationLoading: boolean;
  readonly loading: boolean;
  readonly changePassword: (input: {
    readonly currentPassword: string;
    readonly password: string;
    readonly confirmation: string;
  }) => Promise<boolean>;
  readonly formatSessionTime: (value: number) => string;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly edition?: 'COMMUNITY' | 'ENTERPRISE';
  readonly role?: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
  readonly managementWritable?: boolean;
  readonly quickPrompts: readonly QuickPrompt[];
  readonly quickPromptsLoading: boolean;
  readonly quickPromptsFailed: boolean;
  readonly refreshQuickPrompts: () => Promise<void>;
}>();

const emit = defineEmits<{
  createRegistrationToken: [ownership?: { ownerType: 'ORGANIZATION'; ownerOrganizationId: number }];
}>();
const webVersion = __MAR_WEB_VERSION__;
const sharedProps = computed(() => ({
  section: props.section,
  sessions: props.sessions,
  newPassword: props.newPassword,
  passwordValidationError: props.passwordValidationError,
  registrationToken: props.registrationToken,
  registrationLoading: props.registrationLoading,
  loading: props.loading,
  changePassword: props.changePassword,
  formatSessionTime: props.formatSessionTime,
  request: props.request,
  quickPrompts: props.quickPrompts,
  quickPromptsLoading: props.quickPromptsLoading,
  quickPromptsFailed: props.quickPromptsFailed,
  refreshQuickPrompts: props.refreshQuickPrompts
}));
const organizations = ref<readonly OrganizationSummary[]>([]);
const registrationOwner = ref<'PERSONAL' | number>('PERSONAL');
interface OAuthBinding {
  readonly providerKey: string;
  readonly name: string;
  readonly bound: boolean;
  readonly externalUserId: string | null;
}
const oauthBindings = ref<readonly OAuthBinding[]>([]);
const oauthLoading = ref(false);
const oauthRefreshing = ref(false);
let oauthLoadSequence = 0;
watch(
  () => [props.section, props.edition] as const,
  async ([section, edition]) => {
    if (section !== 'registration' || edition !== 'ENTERPRISE' || props.role === 'MEMBER') return;
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
watch(
  () => [props.section, props.edition] as const,
  async ([section, edition]) => {
    if (section !== 'account' || edition !== 'ENTERPRISE') return;
    await loadOAuthBindings();
  },
  { immediate: true }
);
async function loadOAuthBindings(refresh = false): Promise<void> {
  const sequence = ++oauthLoadSequence;
  oauthLoading.value = true;
  oauthRefreshing.value = refresh;
  try {
    const bindings = (
      await props.request<{ bindings: readonly OAuthBinding[] }>('/api/oauth-bindings')
    ).bindings;
    if (sequence === oauthLoadSequence) oauthBindings.value = bindings;
  } catch (error) {
    if (sequence === oauthLoadSequence)
      showMessage(
        oauthErrorMessage(error, translate('generated.settingsContent.unableToLoadOAuthBindings')),
        'error',
        error
      );
  } finally {
    if (sequence === oauthLoadSequence) {
      oauthLoading.value = false;
      oauthRefreshing.value = false;
    }
  }
}
async function refreshOAuthBindings(): Promise<void> {
  if (oauthLoading.value) return;
  await loadOAuthBindings(true);
}
async function bindOAuth(provider: OAuthBinding): Promise<void> {
  try {
    const result = await props.request<{ authorizationUrl: string }>(
      `/api/oauth-bindings/${encodeURIComponent(provider.providerKey)}/begin`,
      { method: 'POST' }
    );
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    showMessage(
      oauthErrorMessage(error, translate('generated.settingsContent.unableToStartOAuthBinding')),
      'error',
      error
    );
  }
}
async function unbindOAuth(provider: OAuthBinding): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.settingsContent.unbindFromTheCurrentAccount', { value0: provider.name }),
      translate('generated.settingsContent.unbindOAuth'),
      { closeIcon: marIcon('close'), icon: marIcon('warning'), type: 'warning' }
    );
    await props.request(`/api/oauth-bindings/${encodeURIComponent(provider.providerKey)}`, {
      method: 'DELETE'
    });
    await loadOAuthBindings();
    showMessage(translate('generated.settingsContent.oAuthBindingRemoved'), 'success');
  } catch (error) {
    if (error !== 'cancel')
      showMessage(
        oauthErrorMessage(error, translate('generated.settingsContent.unableToRemoveOAuthBinding')),
        'error',
        error
      );
  }
}
function createNodeToken(): void {
  emit(
    'createRegistrationToken',
    typeof registrationOwner.value === 'number'
      ? { ownerType: 'ORGANIZATION', ownerOrganizationId: registrationOwner.value }
      : undefined
  );
}
</script>
<template>
  <SharedSettingsContent
    v-bind="{ ...sharedProps, ...$attrs }"
    :web-version="webVersion"
    @create-registration-token="createNodeToken"
  >
    <template #account-identity>
      <section
        v-if="edition === 'ENTERPRISE'"
        class="oauth-bindings"
        :aria-label="translate('generated.settingsContent.oAuthAccountBindings')"
      >
        <div class="admin-sessions-heading">
          <h3>{{ translate('generated.settingsContent.oAuthAccountBindings2') }}</h3>
          <el-button
            v-tooltip="translate('generated.settingsContent.refresh')"
            class="mar-icon-action"
            :icon="marIcon('refresh')"
            :loading="oauthRefreshing"
            :loading-icon="marIcon('loading-action')"
            :disabled="oauthLoading"
            :aria-label="translate('generated.settingsContent.refresh')"
            text
            @click="refreshOAuthBindings"
          />
        </div>
        <el-table
          v-loading="oauthLoading && !oauthRefreshing"
          :aria-busy="oauthLoading"
          :data="oauthBindings"
          row-key="providerKey"
        >
          <el-table-column
            prop="name"
            :label="translate('generated.settingsContent.identityProvider')"
          />
          <el-table-column :label="translate('generated.settingsContent.status')" width="110">
            <template #default="{ row }">
              <el-tag :type="row.bound ? 'success' : 'info'" effect="light">
                {{
                  row.bound
                    ? translate('generated.settingsContent.bound')
                    : translate('generated.settingsContent.notBound')
                }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="translate('generated.settingsContent.actions')" width="120">
            <template #default="{ row }">
              <el-button
                v-if="!row.bound"
                link
                :icon="marIcon('link')"
                :disabled="managementWritable !== true || oauthLoading"
                @click="bindOAuth(row)"
                >{{ translate('generated.settingsContent.bind') }}</el-button
              >
              <el-button
                v-else
                link
                type="danger"
                :icon="marIcon('unlock')"
                :disabled="managementWritable !== true || oauthLoading"
                @click="unbindOAuth(row)"
                >{{ translate('generated.settingsContent.unbind') }}</el-button
              >
            </template>
          </el-table-column>
        </el-table>
      </section>
    </template>
    <template #registration-owner>
      <label v-if="edition === 'ENTERPRISE'" class="registration-owner">
        <span>{{ translate('generated.settingsContent.nodeOwnership') }}</span>
        <el-select
          v-model="registrationOwner"
          :placeholder="translate('generated.settingsContent.selectOwnership')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option :label="translate('generated.settingsContent.personal')" value="PERSONAL" />
          <el-option
            v-for="organization in organizations"
            :key="organization.id"
            :label="organizationPath(organizations, organization.id)"
            :value="organization.id"
            :disabled="role === 'MEMBER' || managementWritable !== true"
          />
        </el-select>
      </label>
    </template>
  </SharedSettingsContent>
</template>
<style scoped>
.registration-owner {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--mar-font-size-meta);
}

.registration-owner .el-select {
  width: min(280px, 70vw);
}

.admin-sessions-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.45rem;
}

.admin-sessions-heading h3 {
  margin: 0;
  font-size: var(--mar-font-size-body);
}
</style>
