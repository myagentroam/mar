<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '../../util/mar-icons.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessageBox } from '../../service/message-box-service.js';
import { type FormInstance, type FormRules } from 'element-plus';
import {
  formatGitRemoteUrl,
  gitCredentialInputSchema,
  gitCredentialUpdateSchema,
  parseGitRemoteUrl,
  type GitCredentialSummary,
  type PersonalGitSummary
} from '@myagentroam/protocol';
import { PersonalGitService } from '../../service/personal-git-service.js';
import { translate as t } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import LoadingPanel from '../common/LoadingPanel.vue';

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const service = new PersonalGitService(props.request);
const summary = ref<PersonalGitSummary>({ credentials: [] });
const loading = ref(true);
const ready = ref(false);
const failed = ref(false);
const saving = ref(false);
const dialogOpen = ref(false);
const editing = ref<GitCredentialSummary>();
const detailOpen = ref(false);
const detail = ref<GitCredentialSummary>();
const credentialForm = ref<FormInstance>();
const emptyDraft = () => ({
  name: '',
  remoteUrl: '',
  protocol: 'HTTPS' as 'HTTPS' | 'SSH',
  username: '',
  commitName: '',
  commitEmail: '',
  secret: '',
  passphrase: '',
  clearPassphrase: false
});
const draft = ref(emptyDraft());
let alive = true;
const draftProtocol = computed(() => remoteTarget()?.protocol ?? draft.value.protocol);
const credentialRules = computed<FormRules>(() =>
  Object.fromEntries(
    ['name', 'remoteUrl', 'username', 'commitName', 'commitEmail', 'secret', 'passphrase'].map(
      (field) => [
        field,
        [
          {
            validator: (_rule: unknown, _value: unknown, callback: (error?: Error) => void) =>
              callback(credentialFieldError(field))
          }
        ]
      ]
    )
  )
);
onMounted(() => {
  void load();
});
onUnmounted(() => {
  alive = false;
  draft.value = emptyDraft();
});

function apply(value: PersonalGitSummary): void {
  if (!alive) return;
  summary.value = value;
  ready.value = true;
}
async function load(): Promise<void> {
  loading.value = true;
  failed.value = false;
  try {
    apply(await service.read());
  } catch (error) {
    if (alive) {
      failed.value = true;
      showMessage(errorMessage(error), 'error', error);
    }
  } finally {
    if (alive) loading.value = false;
  }
}
function openCredential(value?: GitCredentialSummary): void {
  closeCredentialDetail();
  draft.value =
    value === undefined
      ? emptyDraft()
      : {
          ...emptyDraft(),
          ...value,
          remoteUrl: formatGitRemoteUrl(value),
          secret: '',
          passphrase: ''
        };
  editing.value = value;
  dialogOpen.value = true;
}
function closeCredential(): void {
  dialogOpen.value = false;
  draft.value = emptyDraft();
  editing.value = undefined;
}
function openCredentialDetail(value: GitCredentialSummary): void {
  if (saving.value) return;
  detail.value = value;
  detailOpen.value = true;
}
function closeCredentialDetail(): void {
  detailOpen.value = false;
  detail.value = undefined;
}
function remoteTarget() {
  try {
    return parseGitRemoteUrl(draft.value.remoteUrl);
  } catch {
    return undefined;
  }
}
function changeRemote(): void {
  const remote = remoteTarget();
  if (
    remote === undefined ||
    remote.protocol === draft.value.protocol ||
    editing.value !== undefined
  )
    return;
  draft.value.protocol = remote.protocol;
  draft.value.secret = '';
  draft.value.passphrase = '';
  draft.value.clearPassphrase = false;
}
function credentialInput(): Record<string, unknown> {
  const value = draft.value;
  const remote = remoteTarget();
  return {
    name: value.name,
    protocol: remote?.protocol ?? value.protocol,
    host: remote?.host ?? '',
    port: remote?.port ?? (value.protocol === 'SSH' ? 22 : 443),
    pathPrefix: remote?.pathPrefix ?? '',
    username: remote?.protocol === 'SSH' ? (remote.username ?? '') : value.username,
    commitName: value.commitName,
    commitEmail: value.commitEmail,
    ...(editing.value === undefined || value.secret.length > 0 ? { secret: value.secret } : {}),
    ...((remote?.protocol ?? value.protocol) !== 'SSH'
      ? {}
      : value.clearPassphrase
        ? { passphrase: null }
        : value.passphrase.length > 0
          ? { passphrase: value.passphrase }
          : {})
  };
}
function credentialFieldError(field: string): Error | undefined {
  const remote = remoteTarget();
  if (
    field === 'remoteUrl' &&
    (remote === undefined ||
      (editing.value !== undefined && remote.protocol !== editing.value.protocol))
  )
    return new Error(t('personalGit.remoteInvalid'));
  const parsed = (
    editing.value === undefined ? gitCredentialInputSchema : gitCredentialUpdateSchema
  ).safeParse(credentialInput());
  if (parsed.success) return undefined;
  const issueMatches = parsed.error.issues.some((issue) => {
    const path = String(issue.path[0]);
    return field === 'remoteUrl'
      ? ['protocol', 'host', 'port', 'pathPrefix'].includes(path)
      : path === field;
  });
  if (!issueMatches) return undefined;
  const message = {
    name: 'nameInvalid',
    remoteUrl: 'remoteInvalid',
    username: 'usernameInvalid',
    commitName: 'identityInvalid',
    commitEmail: 'identityInvalid',
    secret: 'secretInvalid',
    passphrase: 'passphraseInvalid'
  }[field];
  return message === undefined ? undefined : new Error(t(`personalGit.${message}`));
}
async function saveCredential(): Promise<void> {
  if (!(await credentialForm.value?.validate().catch(() => false))) return;
  const parsed = (
    editing.value === undefined ? gitCredentialInputSchema : gitCredentialUpdateSchema
  ).safeParse(credentialInput());
  if (!parsed.success) return;
  saving.value = true;
  try {
    const result =
      editing.value === undefined
        ? await service.createCredential(parsed.data)
        : await service.updateCredential(editing.value.id, parsed.data);
    if (!alive) return;
    apply(result);
    closeCredential();
    showMessage(t('personalGit.saved'), 'success');
  } catch (error) {
    if (alive) showMessage(errorMessage(error), 'error', error);
  } finally {
    if (alive) saving.value = false;
  }
}
async function removeCredential(value: GitCredentialSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('personalGit.removeConfirm', { name: value.name }),
      t('personalGit.remove'),
      { closeIcon: marIcon('close'), icon: marIcon('warning'), type: 'warning' }
    );
  } catch {
    return;
  }
  saving.value = true;
  try {
    apply(await service.removeCredential(value.id));
    if (detail.value?.id === value.id) closeCredentialDetail();
  } catch (error) {
    if (alive) showMessage(errorMessage(error), 'error', error);
  } finally {
    if (alive) saving.value = false;
  }
}
</script>

<template>
  <LoadingPanel class="personal-git-settings" :loading="loading && !ready" variant="page">
    <div class="mar-management-page">
      <header>
        <div>
          <h2>{{ t('personalGit.title') }}</h2>
        </div>
      </header>
      <el-button v-if="failed" @click="load">{{ t('personalGit.reload') }}</el-button>
      <template v-else>
        <p class="git-page-hint">{{ t('personalGit.summary') }}</p>
        <div class="mar-table-actions">
          <el-button
            type="primary"
            :icon="marIcon('plus')"
            :disabled="loading || saving"
            @click="openCredential()"
            :loading-icon="marIcon('loading-action')"
            >{{ t('personalGit.add') }}</el-button
          >
        </div>
        <!-- Personal Git identity and redacted credentials are returned as one complete document. -->
        <el-table
          class="clickable-rows"
          :data="summary.credentials"
          :empty-text="t('personalGit.empty')"
          table-layout="auto"
          @row-click="openCredentialDetail"
        >
          <el-table-column prop="name" :label="t('personalGit.name')" min-width="140" />
          <el-table-column :label="t('personalGit.remote')" min-width="260"
            ><template #default="{ row }"
              ><code class="git-scope">{{ formatGitRemoteUrl(row) }}</code></template
            ></el-table-column
          >
          <el-table-column prop="username" :label="t('personalGit.username')" min-width="140" />
          <el-table-column :label="t('personalGit.identity')" min-width="220"
            ><template #default="{ row }"
              ><template v-if="row.commitName"
                >{{ row.commitName }} &lt;{{ row.commitEmail }}&gt;</template
              ><span v-else>{{ t('personalGit.identityEmpty') }}</span></template
            ></el-table-column
          >
          <el-table-column :label="t('personalGit.actions')" width="180"
            ><template #default="{ row }"
              ><div class="mar-row-actions">
                <el-button
                  link
                  :icon="marIcon('edit')"
                  :disabled="saving"
                  @click.stop="openCredential(row)"
                  >{{ t('personalGit.edit') }}</el-button
                >
                <el-button
                  link
                  type="danger"
                  :icon="marIcon('delete')"
                  :disabled="saving"
                  @click.stop="removeCredential(row)"
                  >{{ t('personalGit.remove') }}</el-button
                >
              </div></template
            ></el-table-column
          >
        </el-table>
      </template>
    </div>
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="detailOpen && detail"
      v-model="detailOpen"
      :title="t('personalGit.detail')"
      width="min(720px, calc(100vw - 32px))"
      append-to-body
      @closed="closeCredentialDetail"
      :close-icon="marIcon('close')"
    >
      <el-descriptions :column="1" border>
        <el-descriptions-item :label="t('personalGit.credentialId')">{{
          detail.id
        }}</el-descriptions-item>
        <el-descriptions-item :label="t('personalGit.name')">{{
          detail.name
        }}</el-descriptions-item>
        <el-descriptions-item :label="t('personalGit.remote')"
          ><code class="git-scope">{{ formatGitRemoteUrl(detail) }}</code></el-descriptions-item
        >
        <el-descriptions-item
          v-if="detail.protocol === 'HTTPS'"
          :label="t('personalGit.username')"
          >{{ detail.username }}</el-descriptions-item
        >
        <el-descriptions-item :label="t('personalGit.identity')"
          ><template v-if="detail.commitName"
            >{{ detail.commitName }} &lt;{{ detail.commitEmail }}&gt;</template
          ><span v-else>{{ t('personalGit.identityEmpty') }}</span></el-descriptions-item
        >
        <el-descriptions-item :label="t('personalGit.secretStatus')"
          ><el-tag :type="detail.hasSecret ? 'success' : 'info'">{{
            t(detail.hasSecret ? 'personalGit.configured' : 'personalGit.notConfigured')
          }}</el-tag></el-descriptions-item
        >
        <el-descriptions-item
          v-if="detail.protocol === 'SSH'"
          :label="t('personalGit.passphraseStatus')"
          ><el-tag :type="detail.hasPassphrase ? 'success' : 'info'">{{
            t(detail.hasPassphrase ? 'personalGit.configured' : 'personalGit.notConfigured')
          }}</el-tag></el-descriptions-item
        >
      </el-descriptions>
      <template #footer>
        <div class="detail-close">
          <el-button :disabled="saving" @click="closeCredentialDetail">{{
            t('personalGit.close')
          }}</el-button>
        </div>
      </template>
    </el-dialog>
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="dialogOpen"
      v-model="dialogOpen"
      :title="t(editing ? 'personalGit.editCredential' : 'personalGit.add')"
      width="min(620px, calc(100vw - 32px))"
      append-to-body
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @closed="closeCredential"
      :close-icon="marIcon('close')"
    >
      <el-form
        ref="credentialForm"
        :model="draft"
        :rules="credentialRules"
        label-position="top"
        :disabled="saving"
        @submit.prevent="saveCredential"
      >
        <el-form-item prop="name" :label="t('personalGit.name')"
          ><el-input v-model="draft.name" :placeholder="t('personalGit.nameHint')" :maxlength="320"
        /></el-form-item>
        <el-form-item prop="remoteUrl" :label="t('personalGit.remote')"
          ><el-input
            v-model="draft.remoteUrl"
            :placeholder="t('personalGit.remoteHint')"
            :maxlength="2048"
            @change="changeRemote"
        /></el-form-item>
        <el-form-item
          v-if="draftProtocol === 'HTTPS'"
          prop="username"
          :label="t('personalGit.username')"
          ><el-input
            v-model="draft.username"
            :placeholder="t('personalGit.usernameHint')"
            :maxlength="320"
            autocomplete="off"
        /></el-form-item>
        <section class="git-identity-fields">
          <p class="git-form-group-title">{{ t('personalGit.identity') }}</p>
          <p class="git-hint">{{ t('personalGit.identityHint') }}</p>
          <div class="git-field-pair">
            <el-form-item prop="commitName" :label="t('personalGit.commitName')"
              ><el-input
                v-model="draft.commitName"
                :placeholder="t('personalGit.namePlaceholder')"
                :maxlength="320"
            /></el-form-item>
            <el-form-item prop="commitEmail" :label="t('personalGit.email')"
              ><el-input
                v-model="draft.commitEmail"
                :placeholder="t('personalGit.emailPlaceholder')"
                :maxlength="320"
            /></el-form-item>
          </div>
        </section>
        <el-form-item
          prop="secret"
          :label="t(draftProtocol === 'SSH' ? 'personalGit.privateKey' : 'personalGit.password')"
        >
          <el-input
            v-model="draft.secret"
            :type="draftProtocol === 'SSH' ? 'textarea' : 'password'"
            :rows="5"
            :placeholder="
              t(
                editing
                  ? 'personalGit.keepSecret'
                  : draftProtocol === 'SSH'
                    ? 'personalGit.keyHint'
                    : 'personalGit.secretHint'
              )
            "
            autocomplete="new-password"
            :maxlength="32768"
          />
        </el-form-item>
        <template v-if="draftProtocol === 'SSH'">
          <el-form-item prop="passphrase" :label="t('personalGit.passphrase')"
            ><el-input
              v-model="draft.passphrase"
              type="password"
              :disabled="draft.clearPassphrase"
              :placeholder="
                t(
                  editing?.hasPassphrase
                    ? 'personalGit.keepPassphrase'
                    : 'personalGit.passphraseHint'
                )
              "
              autocomplete="new-password"
              :maxlength="4096"
          /></el-form-item>
          <el-checkbox v-if="editing?.hasPassphrase" v-model="draft.clearPassphrase">{{
            t('personalGit.clearPassphrase')
          }}</el-checkbox>
          <p class="git-hint">{{ t('personalGit.sshNotice') }}</p>
        </template>
        <p class="git-hint">{{ t('personalGit.secretNotice') }}</p>
      </el-form>
      <template #footer
        ><el-button :disabled="saving" @click="closeCredential">{{
          t('personalGit.cancel')
        }}</el-button
        ><el-button
          type="primary"
          :loading="saving"
          @click="saveCredential"
          :loading-icon="marIcon('loading-action')"
          >{{ t('personalGit.save') }}</el-button
        ></template
      >
    </el-dialog>
  </LoadingPanel>
</template>

<style scoped>
.git-hint {
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
.git-page-hint {
  margin: 0;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
.git-form-group-title {
  margin: 0 0 8px;
  color: var(--el-text-color-regular);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
}
.git-identity-fields {
  margin-bottom: 18px;
}
.git-field-pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}
.git-scope {
  display: block;
  overflow-wrap: anywhere;
}
.detail-close {
  display: flex;
  flex-wrap: wrap;
}
.detail-close {
  justify-content: flex-end;
}
small {
  color: var(--el-text-color-secondary);
}
@media (max-width: 600px) {
  .git-field-pair {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
}
</style>
