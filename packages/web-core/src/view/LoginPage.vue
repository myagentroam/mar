<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AuthEntryPanel from './auth/AuthEntryPanel.vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarInput } from '@myagentroam/mar-ui/input';

const props = defineProps<{
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
  if (props.loading) return;
  emit('login', { username: username.value, password: password.value });
  password.value = '';
}
</script>

<template>
  <AuthEntryPanel
    title-id="login-title"
    :title="t('auth.title')"
    :summary="t('auth.summary')"
    :logo-url="logoUrl"
  >
    <form class="auth-form" @submit.prevent="submit">
      <label>{{ t('auth.username') }}<MarInput v-model="username" autocomplete="username" /></label>
      <label
        >{{ t('auth.password')
        }}<MarInput v-model="password" type="password" autocomplete="current-password"
      /></label>
      <MarButton type="primary" native-type="submit" :loading="loading">
        {{ t('auth.login') }}
      </MarButton>
    </form>
    <slot name="identity-extension" />
  </AuthEntryPanel>
</template>
