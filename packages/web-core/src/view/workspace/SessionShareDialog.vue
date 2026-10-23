<script setup lang="ts">
import { showMessage } from '../../service/MessageFeedbackService.js';

import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { computed, onMounted, ref } from 'vue';
import { ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import type { SessionShareTarget } from '@myagentroam/protocol';
import { createSessionShareManagementService } from '../../service/SessionShareManagementService.js';
import { translate } from '../../service/LocalePreferenceService.js';
import { errorMessage } from '../../util/error-presentation.js';
import { managementDateTime } from '../../util/time-presentation.js';
const props = defineProps<{
  target: SessionShareTarget;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{ close: [] }>();
const service = createSessionShareManagementService(props.target, props.request);
const { shares, created, busy } = service;
const form = ref<FormInstance>();
const values = ref({ expiresAt: null as Date | null });
const rules: FormRules = {
  expiresAt: [
    {
      validator: (_rule, value, done) =>
        done(
          value !== null && (!Number.isFinite(+value) || +value <= Date.now())
            ? new Error(translate('sessionShare.futureTime'))
            : undefined
        ),
      trigger: 'change'
    }
  ]
};
const link = (id: string) =>
  new URL(`/share/${encodeURIComponent(id)}`, location.origin).toString();
const shareText = computed(() =>
  created.value
    ? translate('sessionShare.shareText', {
        link: link(created.value.share.id),
        password: created.value.password
      })
    : ''
);
async function create(): Promise<void> {
  if (!(await form.value?.validate().catch(() => false))) return;
  try {
    await service.create(values.value.expiresAt?.toISOString() ?? null);
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
  }
}
async function remove(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('sessionShare.deleteWarning'),
      translate('sessionShare.delete'),
      { closeIcon: marIcon('close'), icon: marIcon('warning'), type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    await service.remove(id);
    showMessage(translate('sessionShare.deleted'), 'success');
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
  }
}
async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    showMessage(translate('sessionShare.copied'), 'info');
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
  }
}
onMounted(
  () => void service.load().catch((error) => showMessage(errorMessage(error), 'error', error))
);
async function copyRecord(id: string): Promise<void> {
  try {
    let password = await service.copyPassword(id);
    if (password === null) {
      const result = await ElMessageBox.prompt(
        translate('sessionShare.restorePassword'),
        translate('sessionShare.password'),
        {
          closeIcon: marIcon('close'),
          inputType: 'password',
          inputPattern: /^[0-9]{6}$/u,
          inputErrorMessage: translate('sessionShare.passwordFormat')
        }
      );
      password = await service.copyPassword(id, result.value);
    }
    if (password !== null)
      await copy(translate('sessionShare.shareText', { link: link(id), password }));
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') showMessage(errorMessage(error), 'error', error);
  }
}
</script>

<template>
  <el-dialog
    :model-value="true"
    :title="translate('sessionShare.title')"
    width="min(1000px, calc(100vw - 32px))"
    append-to-body
    @close="emit('close')"
    :close-icon="marIcon('close')"
  >
    <el-form
      ref="form"
      :model="values"
      :rules="rules"
      label-position="top"
      @submit.prevent="create"
    >
      <el-form-item prop="expiresAt" :label="translate('sessionShare.expiresAt')">
        <el-date-picker
          v-model="values.expiresAt"
          type="datetime"
          :placeholder="translate('sessionShare.permanent')"
          clearable
          :prefix-icon="marIcon('calendar')"
          :clear-icon="marIcon('clear-input')"
          ><template #prev-month><MarIcon name="chevron-left" /></template
          ><template #next-month><MarIcon name="chevron-right" /></template
          ><template #prev-year><MarIcon name="chevrons-left" /></template
          ><template #next-year><MarIcon name="chevrons-right" /></template
        ></el-date-picker>
      </el-form-item>
      <el-button
        type="primary"
        native-type="submit"
        :loading="busy"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('sessionShare.create') }}</el-button
      >
    </el-form>
    <section v-if="created" class="created-share" aria-live="polite">
      <p class="share-text">{{ shareText }}</p>
      <el-button :icon="marIcon('copy')" @click="copy(shareText)">{{
        translate('sessionShare.copy')
      }}</el-button>
    </section>
    <h3>{{ translate('sessionShare.records') }}</h3>
    <el-table :data="shares" :empty-text="translate('sessionShare.noRecords')">
      <el-table-column :label="translate('sessionShare.link')" min-width="230"
        ><template #default="{ row }"
          ><el-link :href="link(row.id)" target="_blank" rel="noopener">{{
            link(row.id)
          }}</el-link></template
        ></el-table-column
      >
      <el-table-column
        :label="translate('sessionShare.createdAt')"
        prop="createdAt"
        sortable
        min-width="215"
        ><template #default="{ row }">{{
          managementDateTime(row.createdAt)
        }}</template></el-table-column
      >
      <el-table-column
        :label="translate('sessionShare.expiresAt')"
        prop="expiresAt"
        sortable
        min-width="215"
        ><template #default="{ row }">{{
          row.expiresAt === null
            ? translate('sessionShare.permanent')
            : managementDateTime(row.expiresAt)
        }}</template></el-table-column
      >
      <el-table-column :label="translate('sessionShare.status')" min-width="100"
        ><template #default="{ row }"
          ><el-tag
            :type="row.expiresAt !== null && row.expiresAt <= Date.now() ? 'info' : 'success'"
            >{{
              translate(
                row.expiresAt !== null && row.expiresAt <= Date.now()
                  ? 'sessionShare.expired'
                  : 'sessionShare.active'
              )
            }}</el-tag
          ></template
        ></el-table-column
      >
      <el-table-column :label="translate('sessionShare.actions')" min-width="180"
        ><template #default="{ row }">
          <el-button link :icon="marIcon('copy')" :disabled="busy" @click="copyRecord(row.id)">{{
            translate('sessionShare.copy')
          }}</el-button>
          <el-button
            link
            type="danger"
            :icon="marIcon('delete')"
            :disabled="busy"
            @click="remove(row.id)"
            >{{ translate('sessionShare.delete') }}</el-button
          >
        </template></el-table-column
      >
    </el-table>
  </el-dialog>
</template>

<style scoped>
.created-share {
  margin-top: 1rem;
  padding: 1rem;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  overflow-wrap: anywhere;
}
.share-text {
  margin: 0 0 0.75rem;
  white-space: pre-wrap;
}
h3 {
  font-size: var(--mar-font-size-title);
  margin: 1.5rem 0 0.5rem;
}
</style>
