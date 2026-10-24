<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '@myagentroam/web-core/MobileDialogReturnService';
import { showMessage } from '@myagentroam/web-core/message-feedback';

import { marIcon } from '@myagentroam/web-core/icons';
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from '@myagentroam/web-core/MessageBoxService';
import type { FormInstance, FormRules } from 'element-plus';
import {
  newOAuthProviderDraft,
  oauthProviderInput,
  type OAuthProviderDraft
} from '@/service/EnterpriseManagementService';
import { managementUrlValues, replaceManagementUrlValues } from '@/service/ManagementUrlService';
import { oauthErrorMessage } from '@/util/oauth-callback';
import { translate } from '@/service/LocalePreferenceService';
interface OAuthProvider extends Omit<OAuthProviderDraft, 'clientSecret' | 'callbackUri'> {
  enabled: boolean;
  testedAt: number | null;
}
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
}>();
const providers = ref<readonly OAuthProvider[]>([]);
const loading = ref(false);
const ready = ref(false);
const refreshLoading = ref(false);
const saving = ref(false);
const open = ref(false);
const editing = ref(false);
const providerDetailsOpen = ref(false);
const providerDetails = ref<OAuthProvider>();
const form = ref(newOAuthProviderDraft('', window.location.origin));
const callbackUri = computed(
  () => `${window.location.origin}/api/oauth/${encodeURIComponent(form.value.providerKey)}/callback`
);
const keyword = ref('');
const formRef = ref<FormInstance>();
const httpsEndpointValidator = (
  _rule: unknown,
  input: unknown,
  callback: (error?: Error) => void
) => {
  try {
    const url = new URL(String(input ?? ''));
    url.protocol === 'https:'
      ? callback()
      : callback(new Error(translate('generated.oAuthManagementPage.oAuthURLsMustUseHTTPS')));
  } catch {
    callback(new Error(translate('generated.oAuthManagementPage.enterAValidOAuthURL')));
  }
};
keyword.value = managementUrlValues('oauth', ['keyword']).keyword ?? '';
watch(keyword, () => replaceManagementUrlValues('oauth', { keyword: keyword.value }));
const rules = computed<FormRules>(() => ({
  providerKey: [
    {
      required: true,
      whitespace: true,
      message: translate('generated.oAuthManagementPage.enterAProviderKey'),
      trigger: 'blur'
    },
    {
      pattern: /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
      message: translate('generated.oAuthManagementPage.theProviderKeyCanContainOnlyLowercase'),
      trigger: 'blur'
    }
  ],
  name: [
    {
      required: true,
      whitespace: true,
      message: translate('generated.oAuthManagementPage.enterADisplayName'),
      trigger: 'blur'
    },
    {
      max: 128,
      message: translate('generated.oAuthManagementPage.theDisplayNameCannotExceed128Characters'),
      trigger: 'blur'
    }
  ],
  clientId: [
    {
      required: true,
      whitespace: true,
      message: translate('generated.oAuthManagementPage.enterTheClientID'),
      trigger: 'blur'
    },
    {
      max: 512,
      message: translate('generated.oAuthManagementPage.theClientIDCannotExceed512Characters'),
      trigger: 'blur'
    }
  ],
  clientSecret: [
    {
      validator: (_rule, value, callback) => {
        if (!editing.value && String(value ?? '').trim() === '')
          callback(new Error(translate('generated.oAuthManagementPage.enterTheClientSecret')));
        else callback();
      },
      trigger: 'blur'
    }
  ],
  authorizationEndpoint: [
    {
      required: true,
      message: translate('generated.oAuthManagementPage.enterTheAuthorizationURL'),
      trigger: 'blur'
    },
    { validator: httpsEndpointValidator, trigger: 'blur' }
  ],
  tokenEndpoint: [
    {
      required: true,
      message: translate('generated.oAuthManagementPage.enterTheTokenURL'),
      trigger: 'blur'
    },
    { validator: httpsEndpointValidator, trigger: 'blur' }
  ],
  userinfoEndpoint: [
    {
      required: true,
      message: translate('generated.oAuthManagementPage.enterTheUserInfoURL'),
      trigger: 'blur'
    },
    { validator: httpsEndpointValidator, trigger: 'blur' }
  ],
  scopes: [
    {
      validator: (_rule, input, callback) =>
        Array.isArray(input) && input.length <= 32 && input.every((item) => item.length <= 128)
          ? callback()
          : callback(
              new Error(translate('generated.oAuthManagementPage.scopesCanContainUpTo32Entries'))
            ),
      trigger: 'blur'
    }
  ],
  pkceMode: [
    {
      required: true,
      message: translate('generated.oAuthManagementPage.selectAPKCEMode'),
      trigger: 'change'
    }
  ],
  tokenAuthMethod: [
    {
      required: true,
      message: translate('generated.oAuthManagementPage.selectHowToSendTheClientSecret'),
      trigger: 'change'
    }
  ],
  'mappings.externalUserId': [
    {
      required: true,
      message: translate('generated.oAuthManagementPage.enterTheExternalUserIDJSONPointer'),
      trigger: 'blur'
    },
    {
      pattern: /^(?:\/(?:[^~/]|~[01])*)+$/,
      message: translate('generated.oAuthManagementPage.enterAValidJSONPointerSuchAs'),
      trigger: 'blur'
    }
  ],
  'mappings.email': [
    {
      pattern: /^(?:|(?:\/(?:[^~/]|~[01])*)+)$/,
      message: translate('generated.oAuthManagementPage.enterAValidJSONPointer'),
      trigger: 'blur'
    }
  ],
  'mappings.displayName': [
    {
      pattern: /^(?:|(?:\/(?:[^~/]|~[01])*)+)$/,
      message: translate('generated.oAuthManagementPage.enterAValidJSONPointer2'),
      trigger: 'blur'
    }
  ]
}));
const filteredProviders = computed(() => {
  const value = keyword.value.trim().toLowerCase();
  return value === ''
    ? providers.value
    : providers.value.filter((provider) =>
        `${provider.name} ${provider.providerKey}`.toLowerCase().includes(value)
      );
});
// OAuth providers are a complete configuration snapshot; local search never slices the collection.
async function load(): Promise<void> {
  loading.value = true;
  try {
    providers.value = (
      await props.request<{ providers: readonly OAuthProvider[] }>('/api/oauth-providers')
    ).providers;
    ready.value = true;
  } catch (error) {
    showMessage(
      oauthErrorMessage(
        error,
        translate('generated.oAuthManagementPage.unableToLoadOAuthProviders')
      ),
      'error',
      error
    );
  } finally {
    loading.value = false;
  }
}
async function refresh(): Promise<void> {
  refreshLoading.value = true;
  try {
    await load();
  } finally {
    refreshLoading.value = false;
  }
}
function create(): void {
  editing.value = false;
  form.value = newOAuthProviderDraft('', window.location.origin);
  open.value = true;
}
function edit(provider: OAuthProvider): void {
  editing.value = true;
  form.value = {
    ...newOAuthProviderDraft(provider.providerKey, window.location.origin),
    ...provider,
    clientSecret: '',
    scopes: [...provider.scopes],
    mappings: { ...provider.mappings }
  };
  open.value = true;
}
function openProviderDetails(provider: OAuthProvider): void {
  providerDetails.value = provider;
  providerDetailsOpen.value = true;
}
function providerStatusLabel(provider: OAuthProvider): string {
  return provider.enabled
    ? translate('generated.oAuthManagementPage.enabled')
    : provider.testedAt === null
      ? translate('generated.oAuthManagementPage.untested')
      : translate('generated.oAuthManagementPage.disabled');
}
function providerCallbackUri(provider: OAuthProvider): string {
  return `${window.location.origin}/api/oauth/${encodeURIComponent(provider.providerKey)}/callback`;
}
async function save(): Promise<void> {
  if (saving.value) return;
  if (!(await formRef.value?.validate().catch(() => false))) return;
  saving.value = true;
  try {
    const payload = oauthProviderInput(form.value);
    await props.request(
      editing.value
        ? `/api/oauth-providers/${encodeURIComponent(form.value.providerKey)}`
        : '/api/oauth-providers',
      { method: editing.value ? 'PUT' : 'POST', body: JSON.stringify(payload) }
    );
    open.value = false;
    await load();
    showMessage(
      translate('generated.oAuthManagementPage.oAuthProviderSavedTestItBeforeEnabling'),
      'success'
    );
  } catch (error) {
    showMessage(
      oauthErrorMessage(
        error,
        translate('generated.oAuthManagementPage.unableToSaveOAuthProvider')
      ),
      'error',
      error
    );
  } finally {
    saving.value = false;
  }
}
async function test(provider: OAuthProvider): Promise<void> {
  try {
    await props.request(`/api/oauth-providers/${encodeURIComponent(provider.providerKey)}/test`, {
      method: 'POST'
    });
    await load();
    showMessage(translate('generated.oAuthManagementPage.configurationTestPassed'), 'success');
  } catch (error) {
    showMessage(
      oauthErrorMessage(
        error,
        translate('generated.oAuthManagementPage.oAuthConfigurationTestFailed')
      ),
      'error',
      error
    );
  }
}
async function confirmProviderStatusChange(provider: OAuthProvider): Promise<void> {
  try {
    await ElMessageBox.confirm(
      provider.enabled
        ? translate('generated.oAuthManagementPage.confirmDisableOAuthProvider', {
            value0: provider.name
          })
        : translate('generated.oAuthManagementPage.confirmEnableOAuthProvider', {
            value0: provider.name
          }),
      translate('generated.oAuthManagementPage.updateOAuthProviderStatus'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: provider.enabled
          ? translate('generated.oAuthManagementPage.disable')
          : translate('generated.oAuthManagementPage.enable'),
        cancelButtonText: translate('generated.oAuthManagementPage.cancel')
      }
    );
  } catch {
    return;
  }
  await toggle(provider);
}
async function toggle(provider: OAuthProvider): Promise<void> {
  try {
    await props.request(
      `/api/oauth-providers/${encodeURIComponent(provider.providerKey)}/enabled`,
      { method: 'POST', body: JSON.stringify({ enabled: !provider.enabled }) }
    );
    await load();
  } catch (error) {
    showMessage(
      oauthErrorMessage(
        error,
        translate('generated.oAuthManagementPage.unableToUpdateProviderStatus')
      ),
      'error',
      error
    );
  }
}
async function remove(provider: OAuthProvider): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.oAuthManagementPage.deleteOAuthProvider', { value0: provider.name }),
      translate('generated.oAuthManagementPage.deleteOAuthProvider2'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.oAuthManagementPage.delete'),
        cancelButtonText: translate('generated.oAuthManagementPage.cancel')
      }
    );
    await props.request(`/api/oauth-providers/${encodeURIComponent(provider.providerKey)}`, {
      method: 'DELETE'
    });
    await load();
  } catch (error) {
    if (error !== 'cancel')
      showMessage(
        oauthErrorMessage(
          error,
          translate('generated.oAuthManagementPage.unableToDeleteOAuthProvider')
        ),
        'error',
        error
      );
  }
}
onMounted(() => {
  void load();
});
</script>
<template>
  <section
    v-loading="loading && !ready"
    element-loading-custom-class="mar-page-loading"
    class="management-page oauth-management"
  >
    <div class="filter-row">
      <label class="filter-field"
        ><span>{{ translate('generated.oAuthManagementPage.provider') }}</span
        ><el-input
          v-model="keyword"
          clearable
          :placeholder="translate('generated.oAuthManagementPage.enterAProviderNameOrKey')"
          :clear-icon="marIcon('clear-input')"
      /></label>
    </div>
    <div class="table-actions">
      <el-button
        :icon="marIcon('refresh')"
        :loading="refreshLoading && ready"
        @click="refresh"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('generated.oAuthManagementPage.refresh') }}</el-button
      >
      <el-button type="primary" :icon="marIcon('plus')" :disabled="!writable" @click="create">{{
        translate('generated.oAuthManagementPage.addProvider')
      }}</el-button>
    </div>
    <el-table
      v-loading="loading && ready && !refreshLoading"
      :data="filteredProviders"
      class="clickable-rows oauth-provider-table"
      row-key="providerKey"
      @row-click="openProviderDetails"
      ><el-table-column
        prop="name"
        :label="translate('generated.oAuthManagementPage.provider2')"
      /><el-table-column
        prop="providerKey"
        :label="translate('generated.oAuthManagementPage.providerKey')"
        ><template #default="{ row }"
          ><code>{{ row.providerKey }}</code></template
        ></el-table-column
      ><el-table-column
        :label="translate('generated.oAuthManagementPage.autoProvisioning')"
        width="160"
        ><template #default="{ row }">{{
          row.autoProvisioningEnabled
            ? translate('generated.oAuthManagementPage.rootOrganizationMEMBER')
            : translate('generated.oAuthManagementPage.off')
        }}</template></el-table-column
      ><el-table-column :label="translate('generated.oAuthManagementPage.status')" width="110"
        ><template #default="{ row }"
          ><el-tag
            :type="row.enabled ? 'success' : row.testedAt === null ? 'warning' : 'info'"
            effect="plain"
            >{{ providerStatusLabel(row) }}</el-tag
          ></template
        ></el-table-column
      ><el-table-column :label="translate('generated.oAuthManagementPage.actions')" :width="320"
        ><template #default="{ row }"
          ><div class="row-actions" @click.stop>
            <el-button link :icon="marIcon('edit')" :disabled="!writable" @click="edit(row)">{{
              translate('generated.oAuthManagementPage.edit')
            }}</el-button
            ><el-button
              link
              :icon="marIcon('connection')"
              :disabled="!writable"
              @click="test(row)"
              >{{ translate('generated.oAuthManagementPage.test') }}</el-button
            ><el-button
              link
              :icon="marIcon('power')"
              :disabled="!writable || (!row.enabled && row.testedAt === null)"
              @click="confirmProviderStatusChange(row)"
              >{{
                row.enabled
                  ? translate('generated.oAuthManagementPage.disable')
                  : translate('generated.oAuthManagementPage.enable')
              }}</el-button
            ><el-button
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="!writable"
              @click="remove(row)"
              >{{ translate('generated.oAuthManagementPage.delete2') }}</el-button
            >
          </div></template
        ></el-table-column
      ></el-table
    >
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="providerDetailsOpen && providerDetails"
      v-model="providerDetailsOpen"
      :title="providerDetails.name"
      width="min(720px, calc(100vw - 32px))"
      @closed="providerDetails = undefined"
      :close-icon="marIcon('close')"
    >
      <el-descriptions :column="1" border>
        <el-descriptions-item :label="translate('generated.oAuthManagementPage.providerKey')">
          <code>{{ providerDetails.providerKey }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.oAuthManagementPage.callbackURL')">
          <code>{{ providerCallbackUri(providerDetails) }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('common.clientId')">
          <code>{{ providerDetails.clientId }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.oAuthManagementPage.authorizationURL')">
          <code>{{ providerDetails.authorizationEndpoint }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.oAuthManagementPage.tokenURL')">
          <code>{{ providerDetails.tokenEndpoint }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.oAuthManagementPage.userInfoURL')">
          <code>{{ providerDetails.userinfoEndpoint }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.oAuthManagementPage.scopesOnePerLine')">
          {{ providerDetails.scopes.join(', ') }}
        </el-descriptions-item>
        <el-descriptions-item
          :label="translate('generated.oAuthManagementPage.externalUserIDJSONPointer')"
        >
          <code>{{ providerDetails.mappings.externalUserId }}</code>
        </el-descriptions-item>
        <el-descriptions-item
          :label="translate('generated.oAuthManagementPage.emailJSONPointerOptional')"
        >
          <code>{{ providerDetails.mappings.email || '-' }}</code>
        </el-descriptions-item>
        <el-descriptions-item
          :label="translate('generated.oAuthManagementPage.nameJSONPointerOptional')"
        >
          <code>{{ providerDetails.mappings.displayName || '-' }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('common.pkce')">
          {{ providerDetails.pkceMode }}
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.oAuthManagementPage.autoProvisioning')">
          {{
            providerDetails.autoProvisioningEnabled
              ? translate('generated.oAuthManagementPage.rootOrganizationMEMBER')
              : translate('generated.oAuthManagementPage.off')
          }}
        </el-descriptions-item>
        <el-descriptions-item :label="translate('generated.oAuthManagementPage.status')">
          {{ providerStatusLabel(providerDetails) }}
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="providerDetailsOpen = false">{{ translate('common.close') }}</el-button>
      </template>
    </el-dialog>
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="open"
      v-model="open"
      :title="
        editing
          ? translate('generated.oAuthManagementPage.editOAuthProvider')
          : translate('generated.oAuthManagementPage.addOAuthProvider')
      "
      width="min(680px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
      ><el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="oauth-form"
        ><el-form-item
          :label="translate('generated.oAuthManagementPage.providerKey2')"
          prop="providerKey"
          ><el-input
            v-model="form.providerKey"
            :disabled="editing"
            :placeholder="
              translate('generated.oAuthManagementPage.forExampleFeishu')
            " /></el-form-item
        ><el-form-item :label="translate('generated.oAuthManagementPage.displayName')" prop="name"
          ><el-input
            v-model="form.name"
            :placeholder="
              translate('generated.oAuthManagementPage.enterADisplayName2')
            " /></el-form-item
        ><el-form-item class="wide" :label="translate('generated.oAuthManagementPage.callbackURL')"
          ><el-input :model-value="callbackUri" readonly /></el-form-item
        ><el-form-item :label="translate('common.clientId')" prop="clientId"
          ><el-input
            v-model="form.clientId"
            :placeholder="
              translate('generated.oAuthManagementPage.enterTheClientID2')
            " /></el-form-item
        ><el-form-item :label="translate('common.clientSecret')" prop="clientSecret"
          ><el-input
            v-model="form.clientSecret"
            autocomplete="off"
            :placeholder="
              editing
                ? translate('generated.oAuthManagementPage.leaveBlankToKeepTheCurrentValue')
                : translate('generated.oAuthManagementPage.required')
            " /></el-form-item
        ><el-form-item
          class="wide"
          :label="translate('generated.oAuthManagementPage.authorizationURL')"
          prop="authorizationEndpoint"
          ><el-input
            v-model="form.authorizationEndpoint"
            :placeholder="
              translate('generated.oAuthManagementPage.enterTheOAuthAuthorizationURL')
            " /></el-form-item
        ><el-form-item
          class="wide"
          :label="translate('generated.oAuthManagementPage.tokenURL')"
          prop="tokenEndpoint"
          ><el-input
            v-model="form.tokenEndpoint"
            :placeholder="
              translate('generated.oAuthManagementPage.enterTheOAuthTokenURL')
            " /></el-form-item
        ><el-form-item
          class="wide"
          :label="translate('generated.oAuthManagementPage.userInfoURL')"
          prop="userinfoEndpoint"
          ><el-input
            v-model="form.userinfoEndpoint"
            :placeholder="
              translate('generated.oAuthManagementPage.enterTheOAuthUserInfoURL')
            " /></el-form-item
        ><el-form-item
          :label="translate('generated.oAuthManagementPage.scopesOnePerLine')"
          prop="scopes"
          ><el-input
            :model-value="form.scopes.join('\n')"
            :placeholder="translate('generated.oAuthManagementPage.enterOneScopePerLine')"
            type="textarea"
            :rows="2"
            @update:model-value="form.scopes = $event.split(/\s+/)" /></el-form-item
        ><el-form-item
          :label="translate('generated.oAuthManagementPage.externalUserIDJSONPointer')"
          prop="mappings.externalUserId"
          ><el-input
            v-model="form.mappings.externalUserId"
            :placeholder="translate('common.jsonPointerExample')" /></el-form-item
        ><el-form-item
          :label="translate('generated.oAuthManagementPage.emailJSONPointerOptional')"
          prop="mappings.email"
          ><el-input
            v-model="form.mappings.email"
            :placeholder="
              translate('generated.oAuthManagementPage.leaveBlankToSkipExistingAccountMatching')
            " /></el-form-item
        ><el-form-item
          :label="translate('generated.oAuthManagementPage.nameJSONPointerOptional')"
          prop="mappings.displayName"
          ><el-input
            v-model="form.mappings.displayName"
            :placeholder="
              translate('generated.oAuthManagementPage.forExampleDataName')
            " /></el-form-item
        ><el-form-item :label="translate('common.pkce')" prop="pkceMode"
          ><el-select
            v-model="form.pkceMode"
            :placeholder="translate('generated.oAuthManagementPage.selectAPKCEMode2')"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><el-option
              :label="translate('generated.oAuthManagementPage.required2')"
              value="REQUIRED" /><el-option
              :label="translate('generated.oAuthManagementPage.supported')"
              value="SUPPORTED" /><el-option
              :label="translate('generated.oAuthManagementPage.disabled2')"
              value="DISABLED" /></el-select></el-form-item
        ><el-form-item
          :label="translate('generated.oAuthManagementPage.clientSecretMethod')"
          prop="tokenAuthMethod"
          ><el-select
            v-model="form.tokenAuthMethod"
            :placeholder="translate('generated.oAuthManagementPage.selectAMethod')"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><el-option
              :label="translate('common.httpBasic')"
              value="client_secret_basic" /><el-option
              :label="translate('common.postBody')"
              value="client_secret_post" /><el-option
              :label="translate('common.jsonBody')"
              value="client_secret_json" /></el-select></el-form-item
        ><el-form-item class="wide"
          ><el-checkbox v-model="form.autoProvisioningEnabled">{{
            translate('generated.oAuthManagementPage.allowAutoProvisioningNewUsersAreCreated')
          }}</el-checkbox></el-form-item
        ></el-form
      ><template #footer
        ><el-button @click="open = false">{{
          translate('generated.oAuthManagementPage.cancel2')
        }}</el-button
        ><el-button
          type="primary"
          :loading="saving"
          @click="save"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('generated.oAuthManagementPage.saveAndDisable') }}</el-button
        ></template
      ></el-dialog
    >
  </section>
</template>
<style scoped>
code {
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-muted);
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.oauth-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
.oauth-form .wide {
  grid-column: 1/-1;
}
@media (max-width: 767px) {
  .oauth-form {
    grid-template-columns: 1fr;
  }
  .oauth-form .wide {
    grid-column: auto;
  }
}
</style>
