<script setup lang="ts">
import { showMessage } from '@myagentroam/web-core/message-feedback';

import { proxyRefs, watch } from 'vue';
import EnterpriseLoginExtension from '@/view/auth/EnterpriseLoginExtension.vue';
import { createWorkbenchPageController } from '@/service/WorkbenchPageController';
import { oauthErrorMessage } from '@/util/oauth-callback';
import WorkbenchSurface from '@/view/workbench/WorkbenchSurface.vue';
import { useI18n } from 'vue-i18n';

import CorePage from '@myagentroam/web-core/WorkbenchPage.vue';
const page = proxyRefs(createWorkbenchPageController());
const { t } = useI18n();
const oauthError = new URLSearchParams(window.location.search).get('oauthError');
let oauthErrorHandled = false;
watch(
  () => page.adminLoaded,
  (loaded) => {
    if (!loaded || oauthErrorHandled) return;
    if (oauthError === null) return;
    oauthErrorHandled = true;
    showMessage(oauthErrorMessage(oauthError, t('workbench.oauthFailure')), 'error');
    const url = new URL(window.location.href);
    url.searchParams.delete('oauthError');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  },
  { immediate: true }
);
</script>
<template>
  <CorePage :page="page">
    <template #identity-extension><EnterpriseLoginExtension :request="page.request" /></template>
    <template #surface><WorkbenchSurface :page="page" /></template>
  </CorePage>
</template>
