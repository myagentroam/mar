<script setup lang="ts">
import { marIcon } from '../util/mar-icons.js';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElButton, ElInput } from 'element-plus';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/input/style/css';
import AuthEntryPanel from './common/AuthEntryPanel.vue';

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
  <AuthEntryPanel
    title-id="login-title"
    :title="t('auth.title')"
    :summary="t('auth.summary')"
    :logo-url="logoUrl"
  >
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
  </AuthEntryPanel>
</template>
