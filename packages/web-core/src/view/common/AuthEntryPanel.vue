<script setup lang="ts">
import { useI18n } from 'vue-i18n';

// Shared presentation for password entry pages; callers own validation and authentication.
defineProps<{
  readonly title: string;
  readonly titleId: string;
  readonly logoUrl: string;
  readonly summary?: string | undefined;
}>();
const { t } = useI18n();
</script>

<template>
  <section class="gate-panel" :aria-labelledby="titleId">
    <div class="login-brand">
      <img :src="logoUrl" alt="" />
      <strong>{{ t('common.productName') }}</strong>
    </div>
    <h1 :id="titleId">{{ title }}</h1>
    <p v-if="summary" class="lede">{{ summary }}</p>
    <slot />
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

h1 {
  margin: 0 0 0.4rem;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-page-title);
  line-height: 1.35;
  letter-spacing: -0.015em;
}

.lede {
  margin: 0;
  color: var(--mar-text-secondary);
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

.gate-panel :deep(.auth-form) {
  display: grid;
  gap: 0.75rem;
  margin: 1.25rem 0 0;
}

.gate-panel :deep(.auth-form label) {
  display: grid;
  gap: 0.35rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
}

.gate-panel :deep(.auth-form .mar-ui-input) {
  min-height: 34px;
  border: 1px solid var(--mar-border-default);
  border-radius: 6px;
  background: var(--mar-bg-subtle);
  box-shadow: none;
}

.gate-panel :deep(.auth-form .mar-ui-input:focus-within) {
  background: var(--mar-bg-panel);
  border-color: var(--mar-color-brand-border);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mar-color-brand) 14%, transparent);
}

.gate-panel :deep(.auth-form > button[type='submit']) {
  width: 100%;
  min-height: 34px;
  margin-top: 0.1rem;
  border-radius: 6px;
}
</style>
