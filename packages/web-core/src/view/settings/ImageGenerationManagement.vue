<script setup lang="ts">
import { vMarLoading } from '@myagentroam/mar-ui/loading';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarDescriptions, MarDescriptionsItem } from '@myagentroam/mar-ui/descriptions';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarSwitch } from '@myagentroam/mar-ui/switch';
import { createUuid } from '../../util/uuid.js';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { onMounted, reactive, ref, computed } from 'vue';
import { MarMessageBox } from '../../service/message-box-service.js';
import { imageGenerationUrlSchema } from '@myagentroam/protocol';
import type { CodexCredentialSummary, ImageGenerationModel } from '@myagentroam/protocol';
import { createCodexCredentialManagementService } from '../../service/codex-credential-management-service';
import { translate } from '../../service/locale-preference-service';
import { createManagementOrderState } from '../../service/management-order-state';
import { errorMessage } from '../../util/workbench-presentation';

const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  writable: boolean;
}>();
const service = createCodexCredentialManagementService(props.request);
const models = ref<ImageGenerationModel[]>([]);
const credentials = ref<readonly CodexCredentialSummary[]>([]);
const codexCredentials = computed(() =>
  credentials.value.filter((credential) => credential.type === 'CODEX_OAUTH')
);
const busy = ref(false);
const ready = ref(false);
const refreshing = ref(false);
const dialog = ref(false);
const detailOpen = ref(false);
const selectedDetail = ref<ImageGenerationModel>();
const providerLabelKeys = {
  CODEX: 'marAgentModels.imageGenerationProviderCodex',
  BYTED_ARK: 'marAgentModels.imageGenerationProviderArk'
} as const;
function providerLabel(provider: ImageGenerationModel['provider']) {
  return translate(providerLabelKeys[provider]);
}
function credentialName(credentialId: string) {
  return (
    credentials.value.find((credential) => credential.id === credentialId)?.name ?? credentialId
  );
}
function openDetails(model: ImageGenerationModel): void {
  if (sorting.value) return;
  selectedDetail.value = model;
  detailOpen.value = true;
}
const {
  sorting,
  draggedId,
  startSorting,
  cancelSorting,
  finishSorting,
  dragStart,
  dragOver,
  moveBy
} = createManagementOrderState(models, () => props.writable && !busy.value && ready.value);
const form = ref<FormInstance>();
const draft = reactive({
  id: '',
  name: '',
  enabled: true,
  provider: 'CODEX' as 'CODEX' | 'BYTED_ARK',
  credentialId: '',
  modelId: '',
  url: '',
  apiKey: '',
  hasApiKey: false
});
const rules = computed<FormRules>(() => ({
  name: [
    {
      required: true,
      whitespace: true,
      max: 128,
      message: translate('marAgentModels.nameRequired')
    }
  ],
  url: [
    {
      validator: (_rule, value, callback) =>
        draft.provider !== 'BYTED_ARK' || imageGenerationUrlSchema.safeParse(value).success
          ? callback()
          : callback(new Error(translate('marAgentModels.imageGenerationUrlInvalid')))
    }
  ],
  modelId: [
    {
      required: true,
      whitespace: true,
      max: 256,
      message: translate('marAgentModels.imageGenerationModelRequired')
    }
  ],
  credentialId: [
    {
      validator: (_rule, value, callback) =>
        draft.provider !== 'CODEX' || value
          ? callback()
          : callback(new Error(translate('marAgentModels.credentialRequired')))
    }
  ],
  apiKey: [
    {
      validator: (_rule, value, callback) =>
        draft.provider !== 'BYTED_ARK' ||
        ((String(value).trim() || draft.hasApiKey) && String(value).length <= 16384)
          ? callback()
          : callback(new Error(translate('marAgentModels.keyRequired')))
    }
  ]
}));
async function load(showRefresh = false) {
  if (sorting.value) return;
  if (showRefresh) refreshing.value = true;
  busy.value = true;
  try {
    models.value = await service.imageGenerationConfiguration();
    ready.value = true;
    credentials.value = await service.listCredentials();
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
  } finally {
    busy.value = false;
    if (showRefresh) refreshing.value = false;
  }
}
function edit(model?: ImageGenerationModel) {
  if (sorting.value || !props.writable || busy.value) return;
  Object.assign(draft, {
    id: model?.id ?? createUuid(),
    name: model?.name ?? '',
    enabled: model?.enabled ?? true,
    provider: model?.provider ?? 'CODEX',
    credentialId: model?.provider === 'CODEX' ? model.config.credentialId : '',
    modelId: model?.config.modelId ?? '',
    url: model?.provider === 'BYTED_ARK' ? (model.config.url ?? '') : '',
    apiKey: '',
    hasApiKey: model?.provider === 'BYTED_ARK' && Boolean(model.config.hasApiKey)
  });
  dialog.value = true;
}
function providerChanged() {
  draft.modelId = '';
  draft.url = '';
  draft.apiKey = '';
  draft.hasApiKey = models.value.some(
    (model) => model.id === draft.id && model.provider === 'BYTED_ARK' && model.config.hasApiKey
  );
  form.value?.clearValidate();
}
async function persist(next: ImageGenerationModel[]) {
  if (!props.writable || busy.value || !ready.value) return false;
  busy.value = true;
  try {
    models.value = await service.updateImageGenerationConfiguration(next);
    showMessage(translate('marAgentModels.imageGenerationSaved'), 'success');
    return true;
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
    return false;
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (!(await form.value?.validate().catch(() => false))) return;
  const common = { id: draft.id, name: draft.name.trim(), enabled: draft.enabled };
  const model: ImageGenerationModel =
    draft.provider === 'CODEX'
      ? {
          ...common,
          provider: 'CODEX',
          config: { credentialId: draft.credentialId, modelId: draft.modelId.trim() }
        }
      : {
          ...common,
          provider: 'BYTED_ARK',
          config: {
            modelId: draft.modelId.trim(),
            url: draft.url.trim(),
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
          }
        };
  const next = models.value.some((item) => item.id === model.id)
    ? models.value.map((item) => (item.id === model.id ? model : item))
    : [...models.value, model];
  if (await persist(next)) {
    dialog.value = false;
    draft.apiKey = '';
  }
}
async function remove(model: ImageGenerationModel) {
  try {
    await MarMessageBox.confirm(
      translate('marAgentModels.imageGenerationRemoveConfirm', { name: model.name }),
      translate('marAgentModels.remove'),
      {}
    );
  } catch {
    return;
  }
  await persist(models.value.filter((item) => item.id !== model.id));
}
async function saveOrder() {
  if (sorting.value && (await persist(models.value))) finishSorting();
}
onMounted(load);
</script>

<template>
  <section v-mar-loading:page="busy && !ready" class="image-generation-management">
    <p class="selection-rule">{{ translate('marAgentModels.imageGenerationPriorityHint') }}</p>
    <div class="mar-table-actions">
      <MarButton
        :icon="marIcon('refresh')"
        :loading="refreshing && ready"
        :disabled="busy || sorting"
        @click="load(true)"
        >{{ translate('marAgentModels.refresh') }}</MarButton
      >
      <MarButton
        v-if="writable && !sorting"
        :icon="marIcon('queue')"
        :disabled="busy || !ready"
        @click="startSorting"
        >{{ translate('marAgentModels.adjustOrder') }}</MarButton
      >
      <MarButton
        v-if="writable && sorting"
        type="primary"
        :icon="marIcon('check')"
        :loading="busy"
        @click="saveOrder"
        >{{ translate('marAgentModels.saveOrder') }}</MarButton
      >
      <MarButton
        v-if="writable && sorting"
        :icon="marIcon('close')"
        :disabled="busy"
        @click="cancelSorting"
        >{{ translate('marAgentModels.cancel') }}</MarButton
      >
      <MarButton
        v-if="writable && !sorting"
        type="primary"
        :icon="marIcon('plus')"
        :disabled="busy || !ready"
        @click="edit()"
        >{{ translate('marAgentModels.imageGenerationAdd') }}</MarButton
      >
    </div>
    <MarTable
      :class="{ 'clickable-rows': !sorting }"
      :data="models"
      row-key="id"
      @row-click="openDetails"
    >
      <MarTableColumn width="92" :label="translate('marAgentModels.imageGenerationPriority')">
        <template #default="{ row, $index }">
          <div
            v-if="sorting"
            class="order-handle"
            :class="{ 'is-dragging': draggedId === row.id }"
            :draggable="!busy"
            :tabindex="busy ? -1 : 0"
            role="button"
            :aria-label="translate('marAgentModels.adjustOrder')"
            :aria-disabled="busy"
            @dragstart="dragStart(row.id, $event)"
            @dragenter.prevent="dragOver(row.id)"
            @dragover.prevent
            @dragend="draggedId = undefined"
            @keydown.up.prevent="moveBy(row.id, -1)"
            @keydown.down.prevent="moveBy(row.id, 1)"
          >
            <MarIcon name="queue" /><span>{{ $index + 1 }}</span>
          </div>
          <span v-else>{{ $index + 1 }}</span>
        </template>
      </MarTableColumn>
      <MarTableColumn prop="name" :label="translate('marAgentModels.name')" min-width="160" />
      <MarTableColumn
        prop="provider"
        :label="translate('marAgentModels.imageGenerationProvider')"
        min-width="130"
      >
        <template #default="{ row }">{{ providerLabel(row.provider) }}</template>
      </MarTableColumn>
      <MarTableColumn
        prop="config.modelId"
        :label="translate('marAgentModels.imageGenerationModel')"
        min-width="230"
      />
      <MarTableColumn :label="translate('marAgentModels.enabled')" width="100">
        <template #default="{ row }"
          ><MarSwitch
            :model-value="row.enabled"
            :disabled="!writable || busy || sorting"
            :aria-label="translate('marAgentModels.enabled')"
            @click.stop
            @change="
              persist(
                models.map((item) =>
                  item.id === row.id ? { ...item, enabled: !item.enabled } : item
                )
              )
            "
        /></template>
      </MarTableColumn>
      <MarTableColumn
        v-if="writable && !sorting"
        :label="translate('marAgentModels.actions')"
        width="200"
      >
        <template #default="{ row }">
          <div class="mar-row-actions" @click.stop>
            <MarButton link :icon="marIcon('edit')" :disabled="busy" @click="edit(row)">{{
              translate('marAgentModels.edit')
            }}</MarButton>
            <MarButton
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="busy"
              @click="remove(row)"
              >{{ translate('marAgentModels.remove') }}</MarButton
            >
          </div>
        </template>
      </MarTableColumn>
    </MarTable>
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="dialog"
      v-model="dialog"
      :title="translate('marAgentModels.imageGenerationEdit')"
      width="min(720px, calc(100vw - 32px))"
      @closed="draft.apiKey = ''"
    >
      <MarForm
        ref="form"
        :model="draft"
        :rules="rules"
        label-position="top"
        :disabled="busy || !writable"
      >
        <MarFormItem prop="name" :label="translate('marAgentModels.name')"
          ><MarInput v-model="draft.name" maxlength="128"
        /></MarFormItem>
        <MarFormItem :label="translate('marAgentModels.imageGenerationProvider')">
          <MarSelect
            v-model="draft.provider"
            @change="providerChanged"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <MarOption value="CODEX" :label="providerLabel('CODEX')" />
            <MarOption value="BYTED_ARK" :label="providerLabel('BYTED_ARK')" />
          </MarSelect>
        </MarFormItem>
        <MarFormItem
          v-if="draft.provider === 'CODEX'"
          prop="credentialId"
          :label="translate('marAgentModels.imageGenerationCredential')"
        >
          <MarSelect
            v-model="draft.credentialId"
            filterable
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
            ><MarOption
              v-for="credential in codexCredentials"
              :key="credential.id"
              :label="credential.name"
              :value="credential.id"
          /></MarSelect>
        </MarFormItem>
        <MarFormItem
          v-else
          prop="apiKey"
          :label="translate('marAgentModels.imageGenerationApiKey')"
        >
          <MarInput
            v-model="draft.apiKey"
            type="password"
            autocomplete="new-password"
            maxlength="16384"
            :placeholder="draft.hasApiKey ? translate('marAgentModels.imageGenerationKeepKey') : ''"
          />
        </MarFormItem>
        <MarFormItem
          v-if="draft.provider === 'BYTED_ARK'"
          prop="url"
          :label="translate('marAgentModels.imageGenerationUrl')"
          required
        >
          <MarInput v-model="draft.url" maxlength="2048" />
        </MarFormItem>
        <MarFormItem prop="modelId" :label="translate('marAgentModels.imageGenerationModel')"
          ><MarInput v-model="draft.modelId" maxlength="256"
        /></MarFormItem>
      </MarForm>
      <template #footer
        ><MarButton
          :disabled="busy"
          @click="
            dialog = false;
            draft.apiKey = '';
          "
          >{{ translate('marAgentModels.cancel') }}</MarButton
        ><MarButton type="primary" :loading="busy" @click="save">{{
          translate('marAgentModels.save')
        }}</MarButton></template
      >
    </MarDialog>
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="detailOpen && selectedDetail"
      v-model="detailOpen"
      :title="translate('marAgentModels.details')"
      width="min(720px, calc(100vw - 32px))"
    >
      <MarDescriptions class="mar-detail-descriptions" :column="1" border>
        <MarDescriptionsItem :label="translate('marAgentModels.imageGenerationConfigurationId')">
          <code>{{ selectedDetail.id }}</code>
        </MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('marAgentModels.name')">{{
          selectedDetail.name
        }}</MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('marAgentModels.imageGenerationProvider')">{{
          providerLabel(selectedDetail.provider)
        }}</MarDescriptionsItem>
        <MarDescriptionsItem
          v-if="selectedDetail.provider === 'CODEX'"
          :label="translate('marAgentModels.imageGenerationCredential')"
          >{{ credentialName(selectedDetail.config.credentialId) }}</MarDescriptionsItem
        >
        <MarDescriptionsItem v-else :label="translate('marAgentModels.imageGenerationApiKey')">{{
          selectedDetail.config.hasApiKey
            ? translate('marAgentModels.imageGenerationApiKeyConfigured')
            : '—'
        }}</MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('marAgentModels.imageGenerationModel')">
          <code>{{ selectedDetail.config.modelId }}</code>
        </MarDescriptionsItem>
        <MarDescriptionsItem
          v-if="selectedDetail.provider === 'BYTED_ARK'"
          :label="translate('marAgentModels.imageGenerationUrl')"
        >
          <code class="image-generation-detail-url">{{ selectedDetail.config.url ?? '—' }}</code>
        </MarDescriptionsItem>
        <MarDescriptionsItem :label="translate('marAgentModels.enabled')">
          <MarTag :type="selectedDetail.enabled ? 'success' : 'info'" effect="plain">{{
            translate(selectedDetail.enabled ? 'marAgentModels.enabled' : 'marAgentModels.disabled')
          }}</MarTag>
        </MarDescriptionsItem>
      </MarDescriptions>
      <template #footer>
        <MarButton @click="detailOpen = false">{{ translate('common.close') }}</MarButton>
      </template>
    </MarDialog>
  </section>
</template>
<style scoped>
.mar-table-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.mar-table-actions .mar-ui-button + .mar-ui-button {
  margin-left: 0;
}
.mar-row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
.order-handle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding-inline: 6px;
  border-radius: 4px;
  color: var(--mar-text-secondary);
  cursor: grab;
  user-select: none;
}
.order-handle:hover {
  background: var(--mar-fill-hover);
  color: var(--mar-text-primary);
}
.order-handle.is-dragging {
  opacity: 0.45;
  cursor: grabbing;
}
.selection-rule {
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-body);
  margin: 0 0 12px;
}
.image-generation-management {
  min-width: 0;
}
.clickable-rows :deep(.mar-ui-table__row) {
  cursor: pointer;
}
.image-generation-detail-url {
  overflow-wrap: anywhere;
}
</style>
