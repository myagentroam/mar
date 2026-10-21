<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { currentLocale } from '@/service/LocalePreferenceService';
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const providers = ref<readonly { providerKey: string; name: string }[]>([]);
const { t } = useI18n();
onMounted(async () => {
  try {
    providers.value = (
      await props.request<{ providers: readonly { providerKey: string; name: string }[] }>(
        '/api/oauth/providers'
      )
    ).providers.filter((provider) =>
      /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(provider.providerKey)
    );
  } catch {
    providers.value = [];
  }
});
</script>
<template>
  <div v-if="providers.length > 0" class="sso-login" :aria-label="t('auth.enterpriseLogin')">
    <div>
      <span>{{ t('auth.orEnterprise') }}</span>
    </div>
    <el-button
      v-for="provider in providers"
      :key="provider.providerKey"
      tag="a"
      :href="`/api/oauth/${encodeURIComponent(provider.providerKey)}/login?locale=${encodeURIComponent(currentLocale())}`"
      >{{ t('auth.loginWith', { provider: provider.name }) }}</el-button
    >
  </div>
</template>
<style scoped>
.sso-login {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.sso-login > div {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 8px;
  align-items: center;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}

.sso-login > div::before,
.sso-login > div::after {
  height: 1px;
  background: var(--mar-border-subtle);
  content: '';
}
</style>
