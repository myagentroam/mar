<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { marIcon } from '../../util/mar-icons.js';
import { ref } from 'vue';
import { channelDisplayNameSchema } from '@myagentroam/protocol';
import { type FormInstance, type FormRules } from 'element-plus';
import { translate } from '../../service/locale-preference-service.js';
const props = defineProps<{ initialName?: string; editing?: boolean }>();
const emit = defineEmits<{ confirm: [name: string]; cancel: [] }>();
const form = ref<FormInstance>();
const values = ref({ name: props.initialName ?? '' });
const rules: FormRules = {
  name: [
    {
      validator: (_rule, value, done) =>
        done(
          channelDisplayNameSchema.safeParse(value).success
            ? undefined
            : new Error(translate('sessionShare.nameRequired'))
        ),
      trigger: 'blur'
    }
  ]
};
async function submit(): Promise<void> {
  if (await form.value?.validate().catch(() => false)) emit('confirm', values.value.name);
}
</script>
<template>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    :model-value="true"
    :title="translate(editing ? 'sessionShare.editName' : 'sessionShare.setName')"
    width="min(420px, calc(100vw - 32px))"
    @close="emit('cancel')"
    :close-icon="marIcon('close')"
  >
    <el-form
      ref="form"
      :model="values"
      :rules="rules"
      label-position="top"
      @submit.prevent="submit"
    >
      <el-form-item prop="name" :label="translate('sessionShare.name')"
        ><el-input v-model="values.name" autofocus :maxlength="80"
      /></el-form-item>
    </el-form>
    <template #footer
      ><el-button @click="emit('cancel')">{{ translate('sessionShare.cancel') }}</el-button
      ><el-button type="primary" @click="submit">{{
        translate(editing ? 'sessionShare.saveName' : 'sessionShare.confirmName')
      }}</el-button></template
    >
  </el-dialog>
</template>
