<script setup lang="ts">
import '../../styles/region-retry-action.css';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarRegionStatus } from '@myagentroam/mar-ui/region-status';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarDatePicker } from '@myagentroam/mar-ui/date-picker';
import { MarLink } from '@myagentroam/mar-ui/link';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarButton } from '@myagentroam/mar-ui/button';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { MarIcon, marIcon } from '@myagentroam/mar-ui/icons';
import { computed, onMounted, ref } from 'vue';
import { MarMessageBox } from '../../service/message-box-service.js';
import type { SessionShareTarget } from '@myagentroam/protocol';
import { createSessionShareManagementService } from '../../service/session-share-management-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import { managementDateTime } from '../../util/time-presentation.js';
const props = defineProps<{
  target: SessionShareTarget;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{ close: [] }>();
const service = createSessionShareManagementService(props.target, props.request);
const { shares, created, busy } = service;
const readState = ref<'loading' | 'ready' | 'failed'>('loading');
const retrying = ref(false);
const creating = ref(false);
const removingId = ref<string>();
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
  if (busy.value || readState.value === 'loading') return;
  creating.value = true;
  try {
    await service.create(values.value.expiresAt?.toISOString() ?? null);
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
  } finally {
    creating.value = false;
  }
}
async function remove(id: string): Promise<void> {
  try {
    await MarMessageBox.confirm(
      translate('sessionShare.deleteWarning'),
      translate('sessionShare.delete'),
      { icon: marIcon('warning'), type: 'warning' }
    );
  } catch {
    return;
  }
  if (busy.value || readState.value === 'loading') return;
  removingId.value = id;
  try {
    await service.remove(id);
    showMessage(translate('sessionShare.deleted'), 'success');
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
  } finally {
    removingId.value = undefined;
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
async function load(): Promise<void> {
  readState.value = 'loading';
  try {
    await service.load();
    readState.value = 'ready';
  } catch {
    readState.value = 'failed';
  }
}
async function retry(): Promise<void> {
  if (busy.value || retrying.value || readState.value !== 'failed') return;
  retrying.value = true;
  try {
    await load();
  } finally {
    retrying.value = false;
  }
}
onMounted(() => void load());
async function copyRecord(id: string): Promise<void> {
  try {
    let password = await service.copyPassword(id);
    if (password === null) {
      const result = await MarMessageBox.prompt(
        translate('sessionShare.restorePassword'),
        translate('sessionShare.password'),
        {
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
  <MarDialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    :model-value="true"
    :title="translate('sessionShare.title')"
    width="min(1000px, calc(100vw - 32px))"
    append-to-body
    @close="emit('close')"
  >
    <MarForm
      ref="form"
      :model="values"
      :rules="rules"
      label-position="top"
      @submit.prevent="create"
    >
      <MarFormItem prop="expiresAt" :label="translate('sessionShare.expiresAt')">
        <MarDatePicker
          v-model="values.expiresAt"
          :aria-label="translate('sessionShare.expiresAt')"
          type="datetime"
          :placeholder="translate('sessionShare.permanent')"
          clearable
          :prefix-icon="marIcon('calendar')"
          :clear-icon="marIcon('clear-input')"
          ><template #prev-month><MarIcon name="chevron-left" /></template
          ><template #next-month><MarIcon name="chevron-right" /></template
          ><template #prev-year><MarIcon name="chevrons-left" /></template
          ><template #next-year><MarIcon name="chevrons-right" /></template
        ></MarDatePicker>
      </MarFormItem>
      <MarButton
        type="primary"
        native-type="submit"
        :disabled="busy || readState === 'loading'"
        :loading="creating"
        >{{ translate('sessionShare.create') }}</MarButton
      >
    </MarForm>
    <section v-if="created" class="created-share" aria-live="polite">
      <p class="share-text">{{ shareText }}</p>
      <MarButton :icon="marIcon('copy')" @click="copy(shareText)">{{
        translate('sessionShare.copy')
      }}</MarButton>
    </section>
    <h3>{{ translate('sessionShare.records') }}</h3>
    <MarRegionStatus v-if="shares.length > 0 && readState !== 'ready'">
      <MarButton
        v-if="retrying || readState === 'failed'"
        class="mar-region-retry-action"
        link
        :disabled="busy"
        :aria-disabled="retrying || undefined"
        :aria-busy="retrying || undefined"
        :aria-label="retrying ? translate('common.loading') : undefined"
        @click="retry"
      >
        <MarBusyIndicator v-if="retrying" class="mar-read-loading-indicator" />
        <template v-else>{{ translate('common.loadFailedRetry') }}</template>
      </MarButton>
      <span v-else role="progressbar" :aria-label="translate('common.loading')">
        <MarBusyIndicator class="mar-read-loading-indicator" />
      </span>
    </MarRegionStatus>
    <MarTable
      :data="shares"
      :empty-text="translate('sessionShare.noRecords')"
      :aria-busy="readState === 'loading'"
    >
      <template v-if="readState !== 'ready'" #empty>
        <MarButton
          v-if="retrying || readState === 'failed'"
          link
          :disabled="busy"
          :aria-disabled="retrying || undefined"
          :aria-busy="retrying || undefined"
          :aria-label="retrying ? translate('common.loading') : undefined"
          @click="retry"
        >
          <MarBusyIndicator v-if="retrying" class="mar-read-loading-indicator" />
          <template v-else>{{ translate('common.loadFailedRetry') }}</template>
        </MarButton>
        <span v-else role="progressbar" :aria-label="translate('common.loading')">
          <MarBusyIndicator class="mar-read-loading-indicator" />
        </span>
      </template>
      <MarTableColumn :label="translate('sessionShare.link')" min-width="230" show-overflow-tooltip>
        <template #default="{ row }">
          <MarLink class="share-record-link" :href="link(row.id)" target="_blank" rel="noopener">
            {{ link(row.id) }}
          </MarLink>
        </template>
      </MarTableColumn>
      <MarTableColumn
        :label="translate('sessionShare.createdAt')"
        prop="createdAt"
        sortable
        min-width="215"
        ><template #default="{ row }">{{
          managementDateTime(row.createdAt)
        }}</template></MarTableColumn
      >
      <MarTableColumn
        :label="translate('sessionShare.expiresAt')"
        prop="expiresAt"
        sortable
        min-width="215"
        ><template #default="{ row }">{{
          row.expiresAt === null
            ? translate('sessionShare.permanent')
            : managementDateTime(row.expiresAt)
        }}</template></MarTableColumn
      >
      <MarTableColumn :label="translate('sessionShare.status')" min-width="100"
        ><template #default="{ row }"
          ><MarTag
            :type="row.expiresAt !== null && row.expiresAt <= Date.now() ? 'info' : 'success'"
            >{{
              translate(
                row.expiresAt !== null && row.expiresAt <= Date.now()
                  ? 'sessionShare.expired'
                  : 'sessionShare.active'
              )
            }}</MarTag
          ></template
        ></MarTableColumn
      >
      <MarTableColumn :label="translate('sessionShare.actions')" min-width="180"
        ><template #default="{ row }">
          <MarButton link :icon="marIcon('copy')" :disabled="busy" @click="copyRecord(row.id)">{{
            translate('sessionShare.copy')
          }}</MarButton>
          <MarButton
            link
            type="danger"
            :icon="marIcon('delete')"
            :disabled="busy || readState === 'loading'"
            :loading="removingId === row.id"
            @click="remove(row.id)"
            >{{ translate('sessionShare.delete') }}</MarButton
          >
        </template></MarTableColumn
      >
    </MarTable>
  </MarDialog>
</template>

<style scoped>
.created-share {
  margin-top: 1rem;
  padding: 1rem;
  background: var(--mar-fill-muted);
  border: 1px solid var(--mar-border-subtle);
  border-radius: 6px;
  overflow-wrap: anywhere;
}
.share-text {
  margin: 0 0 0.75rem;
  white-space: pre-wrap;
}
.share-record-link,
.share-record-link :deep(.mar-ui-link__inner) {
  display: inline;
}
h3 {
  font-size: var(--mar-font-size-title);
  margin: 1.5rem 0 0.5rem;
}
</style>
