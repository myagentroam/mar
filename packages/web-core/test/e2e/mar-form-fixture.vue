<script setup lang="ts">
import { computed, ref } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarForm, MarFormItem, type FormInstance, type FormRules } from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';
import { MarSwitch } from '@myagentroam/mar-ui/switch';
import { useI18n } from 'vue-i18n';

const disabled = ref(false);
const form = ref<FormInstance>();
const draft = ref({ name: '', mode: '' as '' | number, visible: true, confirmed: false });
const saved = ref(0);
const { t } = useI18n();
const rules = computed<FormRules>(() => ({
  name: [{ required: true, message: t('nameError'), trigger: 'blur' }],
  mode: [{ required: true, message: t('modeError'), trigger: 'change' }]
}));

async function submit() {
  if (await form.value?.validate().catch(() => false)) saved.value++;
}
</script>

<template>
  <main class="form-panel">
    <h1>{{ t('heading') }}</h1>
    <MarForm
      ref="form"
      :model="draft"
      :rules="rules"
      :disabled="disabled"
      label-position="top"
      @submit.prevent="submit"
    >
      <MarFormItem prop="name" :label="t('name')">
        <MarInput v-model="draft.name" prefix-icon="search" aria-describedby="name-hint" />
        <span id="name-hint">{{ t('nameHint') }}</span>
      </MarFormItem>
      <MarFormItem prop="mode" :label="t('mode')">
        <MarSelect v-model="draft.mode" filterable clearable>
          <MarOption :value="0" :label="t('local')" />
        </MarSelect>
      </MarFormItem>
      <MarFormItem :label="t('visible')">
        <MarSwitch v-model="draft.visible" name="visible" />
      </MarFormItem>
      <MarFormItem :label="t('confirmed')">
        <MarSwitch v-model="draft.confirmed" :disabled="false" />
      </MarFormItem>
      <MarButton native-type="submit" type="primary" icon="check">{{ t('save') }}</MarButton>
    </MarForm>
    <MarButton @click="disabled = !disabled">{{ t('disabled') }}</MarButton>
    <MarButton @click="form?.clearValidate('name')">{{ t('clear') }}</MarButton>
    <output>{{ saved }}</output>
  </main>
</template>

<style scoped>
.form-panel {
  box-sizing: border-box;
  inline-size: min(100%, 30rem);
  margin: 0 auto;
  padding: 16px;
  color: var(--mar-text-primary);
  background: var(--mar-surface-panel);
}

#name-hint {
  flex-basis: 100%;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
</style>
