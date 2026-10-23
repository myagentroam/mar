<script setup lang="ts">
import { showMessage } from '../../service/MessageFeedbackService.js';

import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { translate } from '../../service/LocalePreferenceService';
import {
  createSystemConfigurationService,
  type SystemSettingDefinition
} from '../../service/SystemConfigurationService';
import { errorMessage } from '../../util/workbench-presentation';
import MailTemplateManagement from './MailTemplateManagement.vue';
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly settings?: readonly SystemSettingDefinition[];
}>();
const service = createSystemConfigurationService(props.request, props.settings);
const originForm = ref<FormInstance>();
const smtpForm = ref<FormInstance>();
const smtpValidationError = ref('');
const smtpDialogOpen = ref(false);
const smtpSetting = service.settings.find((setting) => setting.key === 'mail-smtp')!;
const smtpEnabled = ref(false);
const smtpModel = reactive({
  host: '',
  port: 587,
  tls: 'STARTTLS' as 'TLS' | 'STARTTLS',
  from: '',
  fromName: '',
  username: '',
  password: ''
});
let savedSmtpUsername = '';
const smtpRules: FormRules = {
  host: [
    {
      required: true,
      pattern: /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u,
      message: translate('generated.systemConfigurationPage.smtpHostInvalid'),
      trigger: 'blur'
    }
  ],
  port: [
    {
      type: 'integer',
      min: 1,
      max: 65535,
      required: true,
      message: translate('generated.systemConfigurationPage.smtpPortInvalid'),
      trigger: 'change'
    }
  ],
  tls: [{ required: true, trigger: 'change' }],
  from: [
    {
      required: true,
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/u,
      message: translate('generated.systemConfigurationPage.smtpFromInvalid'),
      trigger: 'blur'
    }
  ],
  fromName: [
    {
      max: 128,
      pattern: /^[^\r\n]*$/u,
      message: translate('generated.systemConfigurationPage.smtpFromNameInvalid'),
      trigger: 'blur'
    }
  ],
  username: [
    {
      max: 320,
      pattern: /^[^\r\n]*$/u,
      message: translate('generated.systemConfigurationPage.smtpUsernameInvalid'),
      trigger: 'blur'
    }
  ],
  password: [
    {
      validator: (_rule, value: unknown, callback) =>
        callback(
          typeof value === 'string' &&
            value.length <= 1024 &&
            (smtpModel.username === ''
              ? value === ''
              : value !== '' || smtpModel.username === savedSmtpUsername)
            ? undefined
            : new Error(translate('generated.systemConfigurationPage.smtpPasswordInvalid'))
        ),
      trigger: 'blur'
    }
  ]
};
const originSetting = service.settings.find((setting) => setting.key === 'html-preview-origin')!;
const originRules: FormRules = {
  origin: [
    {
      validator: (_rule, value: unknown, callback) =>
        callback(
          service.validValue(originSetting, value)
            ? undefined
            : new Error(translate('generated.systemConfigurationPage.htmlPreviewOriginInvalid'))
        ),
      trigger: 'change'
    }
  ]
};
const { snapshot, drafts, editingKey, savingKey, loading, beginEdit, cancelEdit } = service;
const initialized = ref(false);
const originModel = computed(() => ({ origin: drafts.value.htmlPreviewOrigin }));
const rows = computed(() =>
  service.settings.map((setting) => ({
    ...setting,
    name: translate(setting.nameKey),
    description: translate(setting.descriptionKey)
  }))
);
watch(smtpDialogOpen, (open) => {
  smtpValidationError.value = '';
  if (!open) {
    smtpModel.password = '';
    savedSmtpUsername = '';
    cancelEdit('mail-smtp');
  }
});
function numberDraft(field: string): number | undefined {
  const value = drafts.value[field];
  return typeof value === 'number' ? value : undefined;
}

function originDraft(field: string): string {
  const value = drafts.value[field];
  return typeof value === 'string' ? value : '';
}

function openSmtpDialog(): void {
  if (!props.writable) return;
  beginEdit('mail-smtp');
  if (editingKey.value !== 'mail-smtp') return;
  const config = JSON.parse(String(snapshot.value.smtpConfiguration)) as Partial<typeof smtpModel>;
  smtpEnabled.value = Object.keys(config).length > 0;
  Object.assign(smtpModel, {
    host: config.host ?? '',
    port: config.port ?? 587,
    tls: config.tls ?? 'STARTTLS',
    from: config.from ?? '',
    fromName: config.fromName ?? '',
    username: config.username ?? '',
    password: ''
  });
  savedSmtpUsername = config.username ?? '';
  smtpDialogOpen.value = editingKey.value === 'mail-smtp';
}

async function load(): Promise<void> {
  try {
    await service.load();
    initialized.value = true;
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.systemConfigurationPage.unableToLoadSystemConfiguration'),
      'error',
      error
    );
  }
}

async function save(key: string): Promise<void> {
  if (!props.writable) return;
  smtpValidationError.value = '';
  if (key === 'html-preview-origin') {
    try {
      await originForm.value?.validate();
    } catch {
      return;
    }
  }
  if (key === 'mail-smtp') {
    if (smtpEnabled.value) {
      try {
        await smtpForm.value?.validate();
      } catch {
        return;
      }
      const config = JSON.stringify({ ...smtpModel });
      if (!service.validValue(smtpSetting, config)) {
        smtpValidationError.value = translate('generated.systemConfigurationPage.smtpInvalid');
        return;
      }
      service.setDraft(key, config);
    } else {
      if (snapshot.value.smtpConfiguration !== '{}') {
        try {
          await ElMessageBox.confirm(
            translate('generated.systemConfigurationPage.smtpDisableConfirmation'),
            translate('generated.systemConfigurationPage.smtpDisableTitle'),
            {
              closeIcon: marIcon('close'),
              icon: marIcon('warning'),
              type: 'warning',
              confirmButtonText: translate('generated.systemConfigurationPage.smtpDisableTitle'),
              cancelButtonText: translate('common.cancel')
            }
          );
        } catch (error) {
          if (error === 'cancel' || error === 'close') return;
          showMessage(
            error instanceof Error
              ? errorMessage(error)
              : translate('generated.systemConfigurationPage.unableToSaveSystemConfiguration'),
            'error',
            error
          );
          return;
        }
      }
      if (!smtpDialogOpen.value || editingKey.value !== key) return;
      service.setDraft(key, '{}');
    }
  }
  try {
    if (await service.save(key)) {
      if (key === 'mail-smtp') smtpDialogOpen.value = false;
      showMessage(
        translate('generated.systemConfigurationPage.systemConfigurationSaved'),
        'success'
      );
    }
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.systemConfigurationPage.unableToSaveSystemConfiguration'),
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
    v-loading="loading && !initialized"
    element-loading-custom-class="mar-page-loading"
    class="management-page"
  >
    <div class="table-actions">
      <el-button
        :icon="marIcon('refresh')"
        :loading="loading && initialized"
        @click="load"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('generated.systemConfigurationPage.refresh') }}</el-button
      >
    </div>
    <el-table :data="rows" row-key="key">
      <el-table-column
        prop="name"
        :label="translate('generated.systemConfigurationPage.setting')"
        min-width="180"
      />
      <el-table-column
        prop="description"
        :label="translate('generated.systemConfigurationPage.description')"
        min-width="320"
      />
      <el-table-column
        :label="translate('generated.systemConfigurationPage.value')"
        min-width="180"
      >
        <template #default="{ row }">
          <el-input-number
            v-if="row.type === 'number' && editingKey === row.key"
            :model-value="numberDraft(row.field)"
            :placeholder="
              row.placeholderKey === undefined ? undefined : translate(row.placeholderKey)
            "
            :min="row.min"
            :max="row.max"
            :disabled="savingKey !== null"
            @update:model-value="service.setDraft(row.key, $event)"
            ><template #decrease-icon><MarIcon name="subtract" /></template
            ><template #increase-icon><MarIcon name="plus" /></template
          ></el-input-number>
          <span v-else-if="row.type === 'number'">{{ snapshot[row.field] }}</span>
          <el-form
            v-else-if="row.type === 'origin' && editingKey === row.key"
            ref="originForm"
            :model="originModel"
            :rules="originRules"
          >
            <el-form-item prop="origin" class="origin-setting-form">
              <el-input
                :model-value="originDraft(row.field)"
                :placeholder="translate(row.placeholderKey)"
                :disabled="savingKey !== null"
                @update:model-value="service.setDraft(row.key, $event)"
              />
            </el-form-item>
          </el-form>
          <span v-else-if="row.type === 'origin'">{{
            snapshot[row.field] ||
            translate('generated.systemConfigurationPage.htmlPreviewCurrentOrigin')
          }}</span>
          <span v-else-if="row.type === 'json'">-</span>
          <el-switch
            v-else
            :model-value="drafts[row.field] === true"
            :disabled="editingKey !== row.key || !writable || savingKey !== null"
            @update:model-value="service.setDraft(row.key, $event)"
          />
        </template>
      </el-table-column>
      <el-table-column
        :label="translate('generated.systemConfigurationPage.actions')"
        min-width="220"
      >
        <template #default="{ row }">
          <el-button
            v-if="editingKey !== row.key || row.type === 'json'"
            link
            type="primary"
            :icon="marIcon('edit')"
            :disabled="!writable || editingKey !== null"
            @click="row.type === 'json' ? openSmtpDialog() : beginEdit(row.key)"
          >
            {{ translate('generated.systemConfigurationPage.edit') }}
          </el-button>
          <template v-else>
            <el-button
              link
              type="primary"
              :icon="marIcon('check')"
              :loading="savingKey === row.key"
              :disabled="!writable || savingKey !== null"
              @click="save(row.key)"
              :loading-icon="marIcon('loading-action')"
            >
              {{ translate('generated.systemConfigurationPage.save') }}
            </el-button>
            <el-button
              link
              :icon="marIcon('close')"
              :disabled="savingKey !== null"
              @click="cancelEdit(row.key)"
            >
              {{ translate('common.cancel') }}
            </el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog
      v-if="smtpDialogOpen"
      v-model="smtpDialogOpen"
      :title="translate('generated.systemConfigurationPage.smtp')"
      width="min(620px, calc(100vw - 32px))"
      :close-on-click-modal="savingKey === null"
      :close-on-press-escape="savingKey === null"
      :show-close="savingKey === null"
      append-to-body
      :close-icon="marIcon('close')"
    >
      <div class="smtp-toggle">
        <span>{{ translate('generated.systemConfigurationPage.smtpEnable') }}</span>
        <el-switch
          v-model="smtpEnabled"
          :disabled="savingKey !== null"
          :aria-label="translate('generated.systemConfigurationPage.smtpEnable')"
        />
      </div>
      <el-form
        v-if="smtpEnabled"
        ref="smtpForm"
        :model="smtpModel"
        :rules="smtpRules"
        label-position="top"
        class="smtp-form"
      >
        <el-alert
          v-if="smtpValidationError"
          :title="smtpValidationError"
          type="error"
          :closable="false"
        />
        <el-form-item :label="translate('generated.systemConfigurationPage.smtpHost')" prop="host">
          <el-input
            v-model="smtpModel.host"
            maxlength="253"
            autocomplete="off"
            :disabled="savingKey !== null"
          />
        </el-form-item>
        <div class="smtp-form__pair">
          <el-form-item
            :label="translate('generated.systemConfigurationPage.smtpPort')"
            prop="port"
          >
            <el-input-number
              v-model="smtpModel.port"
              :min="1"
              :max="65535"
              :controls="false"
              :disabled="savingKey !== null"
            />
          </el-form-item>
          <el-form-item :label="translate('generated.systemConfigurationPage.smtpTls')" prop="tls">
            <el-select
              v-model="smtpModel.tls"
              :disabled="savingKey !== null"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <el-option label="STARTTLS" value="STARTTLS" />
              <el-option label="TLS" value="TLS" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item :label="translate('generated.systemConfigurationPage.smtpFrom')" prop="from">
          <el-input
            v-model="smtpModel.from"
            maxlength="320"
            autocomplete="off"
            :disabled="savingKey !== null"
          />
        </el-form-item>
        <el-form-item
          :label="translate('generated.systemConfigurationPage.smtpFromName')"
          prop="fromName"
        >
          <el-input
            v-model="smtpModel.fromName"
            maxlength="128"
            autocomplete="off"
            :disabled="savingKey !== null"
          />
        </el-form-item>
        <el-form-item
          :label="translate('generated.systemConfigurationPage.smtpUsername')"
          prop="username"
        >
          <el-input
            v-model="smtpModel.username"
            maxlength="320"
            autocomplete="off"
            :disabled="savingKey !== null"
          />
        </el-form-item>
        <el-form-item
          :label="translate('generated.systemConfigurationPage.smtpPassword')"
          prop="password"
        >
          <el-input
            v-model="smtpModel.password"
            type="password"
            maxlength="1024"
            autocomplete="new-password"
            :placeholder="
              savedSmtpUsername === smtpModel.username && savedSmtpUsername
                ? translate('generated.systemConfigurationPage.smtpPasswordKeep')
                : undefined
            "
            :disabled="savingKey !== null"
          />
        </el-form-item>
      </el-form>
      <div class="smtp-template-row">
        <MailTemplateManagement :request="request" :writable="writable" />
      </div>
      <p class="smtp-dialog-hint">
        {{ translate('generated.systemConfigurationPage.smtpDialogHint') }}
      </p>
      <template #footer>
        <div class="smtp-dialog-footer">
          <el-button :disabled="savingKey !== null" @click="smtpDialogOpen = false">
            {{ translate('common.cancel') }}
          </el-button>
          <el-button
            type="primary"
            :loading="savingKey === 'mail-smtp'"
            @click="save('mail-smtp')"
            :loading-icon="marIcon('loading-action')"
          >
            {{ translate('generated.systemConfigurationPage.save') }}
          </el-button>
        </div>
      </template>
    </el-dialog>
    <el-alert
      v-if="snapshot.skillTlsVerificationDisabled"
      class="skill-tls-warning"
      type="error"
      :closable="false"
      :title="
        translate(
          'generated.systemConfigurationPage.skillSourceTLSCertificateVerificationIsDisabled'
        )
      "
    />
  </section>
</template>

<style scoped>
.origin-setting-form {
  margin-bottom: 0;
}
.smtp-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0 16px;
}
.smtp-form__pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.smtp-form__pair :deep(.el-input-number),
.smtp-form__pair :deep(.el-select) {
  width: 100%;
}
.smtp-form__pair :deep(.el-input-number .el-input__inner) {
  text-align: left;
}
.smtp-template-row {
  margin: 4px 0 12px;
}
.smtp-dialog-hint {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}
.smtp-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.skill-tls-warning {
  margin-top: 18px;
}
</style>
