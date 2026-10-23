<script setup lang="ts">
import { marIcon } from '../util/mar-icons.js';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElButton, ElInput } from 'element-plus';

defineProps<{
  readonly loading: boolean;
  readonly logoUrl: string;
}>();

const emit = defineEmits<{
  login: [credentials: { readonly username: string; readonly password: string }];
}>();

const username = ref('');
const password = ref('');
const { t } = useI18n();

function submit(): void {
  emit('login', { username: username.value, password: password.value });
  password.value = '';
}
</script>

<template>
  <section class="gate-panel" aria-labelledby="login-title">
    <div class="login-brand" :aria-label="t('common.productName')">
      <img :src="logoUrl" alt="" />
      <strong>{{ t('common.productName') }}</strong>
    </div>
    <h1 id="login-title">{{ t('auth.title') }}</h1>
    <p class="lede">{{ t('auth.summary') }}</p>
    <form class="auth-form" @submit.prevent="submit">
      <label>{{ t('auth.username') }}<el-input v-model="username" autocomplete="username" /></label>
      <label
        >{{ t('auth.password')
        }}<el-input v-model="password" type="password" autocomplete="current-password"
      /></label>
      <el-button
        :loading="loading"
        native-type="submit"
        type="primary"
        :loading-icon="marIcon('loading-action')"
        >{{ t('auth.login') }}</el-button
      >
    </form>
    <slot name="identity-extension" />
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

.lede {
  margin: 0;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-body);
  line-height: 1.6;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.login-brand img {
  display: block;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  object-fit: contain;
}

.login-brand strong {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-title);
  letter-spacing: -0.01em;
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
</style>
