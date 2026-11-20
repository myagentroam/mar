<script setup lang="ts">
import { MarLink } from '@myagentroam/mar-ui/link';
import { MarButton } from '@myagentroam/mar-ui/button';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDocumentationAvailability } from '../service/documentation-availability.js';
import {
  DEFAULT_LOCALE,
  localizedDocsPath,
  parseLocale
} from '../service/locale-preference-service.js';

defineProps<{ readonly loading: boolean; readonly logoUrl: string }>();
defineEmits<{ retry: [] }>();
const { t, locale } = useI18n();
const documentationAvailable = useDocumentationAvailability();
const helpPath = computed(() =>
  localizedDocsPath(parseLocale(locale.value) ?? DEFAULT_LOCALE, 'getting-started/overview')
);
</script>

<template>
  <section class="auth-unavailable" aria-labelledby="auth-unavailable-title">
    <div class="brand">
      <img :src="logoUrl" alt="" /><strong>{{ t('common.productName') }}</strong>
    </div>
    <h1 id="auth-unavailable-title">{{ t('auth.unavailableTitle') }}</h1>
    <p>{{ t('auth.unavailableSummary') }}</p>
    <div class="actions">
      <MarButton type="primary" :loading="loading" @click="$emit('retry')">{{
        t('auth.retry')
      }}</MarButton>
      <MarLink v-if="documentationAvailable" :href="helpPath">{{ t('auth.help') }}</MarLink>
    </div>
  </section>
</template>

<style scoped>
.auth-unavailable {
  width: min(380px, 100%);
  border: 1px solid var(--mar-border-default);
  border-radius: 8px;
  background: var(--mar-bg-panel);
  padding: 1.75rem;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-title);
}
.brand img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}
h1 {
  margin: 0 0 0.4rem;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-page-title);
}
p {
  color: var(--mar-text-secondary);
  line-height: 1.6;
}
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
  margin-top: 1rem;
}
</style>
