<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElButton, ElInput } from 'element-plus';
const props = defineProps<{
  readonly password: string;
  readonly validationError: string;
  readonly loading: boolean;
}>();

const emit = defineEmits<{
  'update:password': [value: string];
  clearError: [];
  submit: [
    input: {
      readonly currentPassword: string;
      readonly password: string;
      readonly confirmation: string;
    }
  ];
}>();
const currentPassword = ref('');
const confirmation = ref('');
const { t } = useI18n();
function submit(): void {
  emit('submit', {
    currentPassword: currentPassword.value,
    password: props.password,
    confirmation: confirmation.value
  });
}
</script>

<template>
  <section class="gate-panel" aria-labelledby="password-title">
    <p class="eyebrow">{{ t('passwordGate.firstUse') }}</p>
    <h1 id="password-title">{{ t('passwordGate.title') }}</h1>
    <p class="lede">{{ t('passwordGate.summary') }}</p>
    <p class="lede">{{ t('passwordGate.requirement') }}</p>
    <form class="auth-form" novalidate @submit.prevent="submit">
      <label
        >{{ t('passwordGate.current')
        }}<el-input
          v-model="currentPassword"
          type="password"
          autocomplete="current-password"
          @input="emit('clearError')"
      /></label>
      <label
        >{{ t('passwordGate.next')
        }}<el-input
          :model-value="password"
          type="password"
          autocomplete="new-password"
          @update:model-value="emit('update:password', String($event))"
          @input="emit('clearError')"
      /></label>
      <label
        >{{ t('passwordGate.confirmation')
        }}<el-input
          v-model="confirmation"
          type="password"
          autocomplete="new-password"
          @input="emit('clearError')"
      /></label>
      <p v-if="validationError" class="password-form-error" role="alert">
        {{ validationError }}
      </p>
      <el-button
        :disabled="password.length < 8 || currentPassword.length === 0 || confirmation.length === 0"
        :loading="loading"
        native-type="submit"
        type="primary"
        >{{ t('passwordGate.submit') }}</el-button
      >
    </form>
  </section>
</template>
<style scoped>
.gate-panel {
  width: min(380px, 100%);
  margin: 0;
  border: 1px solid var(--mar-border-default);
  border-radius: 8px;
  background: var(--mar-bg-panel);
  padding: 1.75rem;
  box-shadow: none;
}

.gate-panel h1 {
  margin: 0 0 0.4rem;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-page-title);
  line-height: 1.35;
  letter-spacing: -0.015em;
}

.eyebrow {
  margin: 0 0 0.55rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  letter-spacing: 0.06em;
}

.lede {
  margin: 0;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-body);
  line-height: 1.6;
}

.auth-form {
  display: grid;
  gap: 0.75rem;
  margin: 1.25rem 0 0;
}

.auth-form label {
  display: grid;
  gap: 0.35rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
}

.auth-form :deep(.el-input) {
  width: 100%;
}

.auth-form :deep(.el-input__wrapper) {
  min-height: 34px;
  border: 1px solid var(--mar-border-default);
  border-radius: 6px;
  background: var(--mar-bg-subtle);
  box-shadow: none;
}

.auth-form :deep(.el-input__wrapper.is-focus),
.auth-form :deep(.el-input__wrapper:focus-within) {
  background: var(--mar-bg-panel);
  border-color: var(--mar-color-brand-border);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mar-color-brand) 14%, transparent);
}

.auth-form :deep(.el-button) {
  width: 100%;
  min-height: 34px;
  margin-top: 0.1rem;
  border-radius: 6px;
}

.password-form-error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--el-color-danger);
  font-size: var(--mar-font-size-meta);
  line-height: 1.4;
}
</style>
