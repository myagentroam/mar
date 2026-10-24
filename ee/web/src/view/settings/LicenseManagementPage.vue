<script setup lang="ts">
import { showMessage } from '@myagentroam/web-core/message-feedback';

import { managementDateTime } from '@myagentroam/web-core/time-presentation';
import { computed, ref } from 'vue';

import { translate } from '@/service/locale-preference-service';
import { errorMessage } from '@/util/workbench-presentation';

const PERMANENT_LICENSE_EXPIRES_AT = 253_402_300_799_000;

interface LicenseStatus {
  edition: 'COMMUNITY' | 'ENTERPRISE';
  state: 'COMMUNITY' | 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN';
  reason: string | null;
  licenseId: string | null;
  enterpriseName: string | null;
  expiresAt: number | null;
  managementWritable: boolean;
}
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly embedded?: boolean;
}>();
const emit = defineEmits<{ imported: [] }>();
const status = ref<LicenseStatus>();
const requestCode = ref('');
const document = ref('');
const loading = ref(false);
const ready = ref(false);
const requestCodeLoading = ref(true);
const editionLabel = computed(() =>
  status.value?.edition === 'ENTERPRISE'
    ? translate('generated.licenseManagementPage.enterprise')
    : translate('generated.licenseManagementPage.personal')
);
const expired = computed(() => status.value?.reason === 'LICENSE_EXPIRED');
function expiresAtLabel(expiresAt: number): string {
  return expiresAt === PERMANENT_LICENSE_EXPIRES_AT
    ? translate('generated.licenseManagementPage.permanent')
    : managementDateTime(expiresAt);
}
async function load(): Promise<void> {
  loading.value = true;
  requestCodeLoading.value = true;
  try {
    const [licenseStatus, generatedRequest] = await Promise.allSettled([
      props.request<LicenseStatus>('/api/license'),
      props.request<{ requestCode: string }>('/api/license/request-code')
    ]);
    if (licenseStatus.status === 'rejected') throw licenseStatus.reason;
    status.value = licenseStatus.value;
    ready.value = true;
    if (generatedRequest.status === 'fulfilled') {
      requestCode.value = generatedRequest.value.requestCode;
    } else {
      requestCode.value = '';
      showMessage(
        translate('generated.licenseManagementPage.unableToGenerateLicenseRequestCode'),
        'error'
      );
    }
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.licenseManagementPage.unableToLoadLicense'),
      'error',
      error
    );
  } finally {
    requestCodeLoading.value = false;
    loading.value = false;
  }
}
async function copyRequestCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(requestCode.value);
    showMessage(translate('generated.licenseManagementPage.licenseRequestCodeCopied'), 'info');
  } catch {
    showMessage(
      translate('generated.licenseManagementPage.unableToCopyCheckBrowserClipboardPermissions'),
      'error'
    );
  }
}
async function importLicense(): Promise<void> {
  if (document.value.trim().length === 0) return;
  loading.value = true;
  try {
    status.value = await props.request<LicenseStatus>('/api/license/import', {
      method: 'POST',
      body: JSON.stringify({ document: document.value.trim() })
    });
    document.value = '';
    showMessage(translate('generated.licenseManagementPage.licenseImported'), 'success');
    emit('imported');
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.licenseManagementPage.unableToImportLicense'),
      'error',
      error
    );
  } finally {
    loading.value = false;
  }
}
void load();
</script>

<template>
  <section
    class="management-page license-management"
    v-loading="loading && !ready"
    element-loading-custom-class="mar-page-loading"
  >
    <h3 v-if="embedded">{{ translate('generated.licenseManagementPage.license') }}</h3>
    <div
      v-if="status"
      class="license-ledger"
      :aria-label="translate('generated.licenseManagementPage.licenseStatus')"
    >
      <div>
        <span>{{ translate('generated.licenseManagementPage.edition') }}</span>
        <div class="license-version">
          <strong>{{ editionLabel }}</strong>
          <el-tag v-if="expired" type="danger" effect="plain">{{
            translate('generated.licenseManagementPage.expired')
          }}</el-tag>
        </div>
      </div>
      <div>
        <span>{{ translate('generated.licenseManagementPage.organization') }}</span>
        <strong v-if="status.enterpriseName !== null">{{ status.enterpriseName }}</strong>
        <span v-else class="empty-value">-</span>
      </div>
      <div>
        <span>{{ translate('common.licenseId') }}</span>
        <code v-if="status.licenseId !== null">{{ status.licenseId }}</code>
        <span v-else class="empty-value">-</span>
      </div>
      <div>
        <span>{{ translate('generated.licenseManagementPage.expires') }}</span>
        <strong v-if="status.expiresAt !== null">{{ expiresAtLabel(status.expiresAt) }}</strong>
        <span v-else class="empty-value">-</span>
      </div>
      <div>
        <span>{{ translate('generated.licenseManagementPage.statusReason') }}</span>
        <code v-if="status.reason !== null">{{ status.reason }}</code>
        <span v-else class="empty-value">-</span>
      </div>
    </div>
    <div class="license-request">
      <div class="section-label">
        {{ translate('generated.licenseManagementPage.licenseRequestCode') }}
      </div>
      <el-input
        class="license-code-input"
        :model-value="requestCode"
        :placeholder="
          requestCodeLoading
            ? translate('generated.licenseManagementPage.generating')
            : translate('generated.licenseManagementPage.generationFailed')
        "
        :title="requestCode"
        readonly
      >
        <template #append>
          <el-button
            :disabled="requestCode.length === 0"
            :aria-label="translate('generated.licenseManagementPage.copyLicenseRequestCode')"
            @click="copyRequestCode"
            >{{ translate('generated.licenseManagementPage.copy') }}</el-button
          >
        </template>
      </el-input>
      <p>
        {{ translate('generated.licenseManagementPage.sendThisCodeToTheLicenseIssuer') }}
      </p>
    </div>
    <div class="license-import">
      <label class="section-label" for="license-document">{{
        translate('generated.licenseManagementPage.licenseDocument')
      }}</label>
      <el-input
        id="license-document"
        v-model="document"
        type="textarea"
        :rows="4"
        resize="vertical"
        autocomplete="off"
        :placeholder="translate('generated.licenseManagementPage.pasteTheCompleteLicenseDocument')"
      />
      <el-button type="primary" :disabled="document.trim().length === 0" @click="importLicense">{{
        translate('generated.licenseManagementPage.importLicense')
      }}</el-button>
    </div>
  </section>
</template>

<style scoped>
.license-management > h3 {
  margin: 16px 0 6px;
  font-size: var(--mar-font-size-body);
}
.license-ledger {
  border-top: 1px solid var(--mar-border-default);
}
.license-ledger > div {
  min-height: 34px;
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr);
  align-items: center;
  border-bottom: 1px solid var(--mar-border-default);
  font-size: var(--mar-font-size-body);
}
.license-ledger > div > span {
  color: var(--mar-text-muted);
}
.license-version {
  display: flex;
  align-items: center;
  gap: 6px;
}
.license-version :deep(.el-tag) {
  height: 20px;
  padding-inline: 6px;
  font-size: var(--mar-font-size-meta);
}
.license-ledger code {
  color: var(--el-text-color-regular);
  font-size: var(--mar-font-size-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.license-ledger .empty-value {
  color: var(--el-text-color-regular);
  font-family: var(--el-font-family);
  font-size: var(--mar-font-size-body);
  font-weight: 400;
}
.license-request,
.license-import {
  display: grid;
  gap: 6px;
}
.section-label {
  color: var(--el-text-color-regular);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  line-height: 20px;
}
.license-code-input :deep(.el-input__inner) {
  color: var(--el-text-color-regular);
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-input);
  text-overflow: ellipsis;
}
.license-code-input :deep(.el-input-group__append .el-button) {
  min-width: 64px;
}
.license-request p {
  margin: 0;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  line-height: 18px;
}
.license-import .el-button {
  justify-self: start;
}
.license-import :deep(.el-textarea__inner) {
  min-height: 92px !important;
  font-family: var(--el-font-family);
  font-size: var(--mar-font-size-input);
  line-height: 18px;
}
@media (max-width: 767px) {
  .license-ledger > div {
    grid-template-columns: 88px minmax(0, 1fr);
  }
}
</style>
