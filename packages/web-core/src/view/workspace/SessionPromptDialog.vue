<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/MobileDialogReturnService.js';
import { showMessage } from '../../service/MessageFeedbackService.js';

import { marIcon } from '../../util/mar-icons.js';
import { type FormInstance, type FormRules } from 'element-plus';
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { createSessionPromptService } from '../../service/SessionPromptService.js';
import { translate } from '../../service/LocalePreferenceService.js';
import { errorMessage } from '../../util/error-presentation.js';

const props = defineProps<{
  readonly nodeId: string;
  readonly sessionId: string;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{ close: [] }>();
const service = createSessionPromptService(props);
const formRef = ref<FormInstance>();
const form = reactive({ prompt: '' });
const loading = ref(true);
const saving = ref(false);
const ready = ref(false);
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});
const rules: FormRules = {
  prompt: [
    {
      validator: (_rule, value: string, callback) => {
        if (value.trim().length <= 20_000) callback();
        else callback(new Error(translate('generated.sessionPrompt.tooLong')));
      },
      trigger: 'blur'
    }
  ]
};
onMounted(async () => {
  try {
    const value = await service.read();
    if (!disposed) {
      form.prompt = value;
      ready.value = true;
    }
  } catch (error) {
    if (!disposed) showMessage(errorMessage(error), 'error', error);
  } finally {
    if (!disposed) loading.value = false;
  }
});
async function save(): Promise<void> {
  if (!ready.value || saving.value) return;
  saving.value = true;
  try {
    if (!(await formRef.value?.validate().catch(() => false))) return;
    await service.save(form.prompt);
    if (!disposed) emit('close');
  } catch (error) {
    if (!disposed) showMessage(errorMessage(error), 'error', error);
  } finally {
    if (!disposed) saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    :model-value="true"
    :title="translate('generated.sessionPrompt.title')"
    width="min(640px, calc(100vw - 32px))"
    append-to-body
    :close-on-click-modal="false"
    :before-close="
      (done: () => void) => {
        if (!saving) done();
      }
    "
    @closed="emit('close')"
    :close-icon="marIcon('close')"
  >
    <p class="session-prompt-description">{{ translate('generated.sessionPrompt.description') }}</p>
    <el-form
      ref="formRef"
      v-loading="loading"
      :model="form"
      :rules="rules"
      label-position="top"
      @submit.prevent="save"
    >
      <el-form-item prop="prompt" :label="translate('generated.sessionPrompt.title')">
        <el-input
          v-model="form.prompt"
          type="textarea"
          :rows="10"
          :disabled="!ready || saving"
          :placeholder="translate('generated.sessionPrompt.placeholder')"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="emit('close')">{{
        translate('generated.sessionPrompt.cancel')
      }}</el-button>
      <el-button
        type="primary"
        :disabled="!ready"
        :loading="saving"
        @click="save"
        :loading-icon="marIcon('loading-action')"
        >{{ translate('generated.sessionPrompt.save') }}</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.session-prompt-description {
  margin: 0 0 1rem;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
</style>
