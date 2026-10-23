<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { createSessionShareAccessService } from '../../service/SessionShareAccessService.js';
import {
  createStandaloneFileWindowService,
  STANDALONE_FILE_OPEN_EVENT,
  standaloneFileContext
} from '../../service/StandaloneFileWindowService.js';
import { translate } from '../../service/LocalePreferenceService.js';
import { errorMessage } from '../../util/error-presentation.js';
import SessionShareConversation from './SessionShareConversation.vue';
import BusyIndicator from '../common/BusyIndicator.vue';
const StandaloneFilePreviewPage = defineAsyncComponent(
  () => import('../workspace/StandaloneFilePreviewPage.vue')
);

const props = defineProps<{ shareId: string }>();
const access = createSessionShareAccessService(props.shareId);
const { session, invalidCode } = access;
const context = `share:${props.shareId}`;
const windows = createStandaloneFileWindowService(undefined, context);
const initialIntent = new URLSearchParams(location.search);
const standalone = initialIntent.get('standaloneFile') === '1';
const previewIntent = ref<URLSearchParams | undefined>(standalone ? initialIntent : undefined);
const previewVersion = ref(0);
const loading = ref(true);
const restoring = ref(true);
const form = ref<FormInstance>();
const fields = ref({ password: '' });
const rules: FormRules = {
  password: [
    {
      pattern: /^[0-9]{6}$/u,
      required: true,
      message: translate('sessionShare.passwordFormat'),
      trigger: 'blur'
    }
  ]
};
async function login(restore = false): Promise<void> {
  if (!restore && !(await form.value?.validate().catch(() => false))) return;
  loading.value = true;
  try {
    await access.authenticate(restore ? undefined : fields.value.password);
    fields.value.password = '';
  } catch (error) {
    ElMessage.error({ icon: marIcon('error'), message: errorMessage(error) });
  } finally {
    loading.value = false;
  }
}
function openFile(path: string, line?: number, column?: number, external?: boolean): void {
  const intent = new URLSearchParams({ standaloneFile: '1', path, rawContent: '1' });
  if (line !== undefined) intent.set('line', String(line));
  if (column !== undefined) intent.set('column', String(column));
  if (external) {
    if (windows.open(`/share/${encodeURIComponent(props.shareId)}?${intent}`) === undefined)
      ElMessage.error({
        icon: marIcon('error'),
        message: translate('sessionShare.previewWindowBlocked')
      });
  } else {
    previewIntent.value = intent;
    previewVersion.value += 1;
  }
}
function acceptFile(event: Event): void {
  if (!standalone) return;
  const url: unknown = (event as CustomEvent<{ url?: unknown }>).detail?.url;
  if (typeof url !== 'string' || standaloneFileContext(url) !== context) return;
  const parsed = new URL(url, location.origin);
  if (parsed.searchParams.get('standaloneFile') !== '1') return;
  event.preventDefault();
  location.replace(parsed.href);
}
onMounted(() => {
  window.addEventListener(STANDALONE_FILE_OPEN_EVENT, acceptFile);
  void login(true).finally(() => {
    restoring.value = false;
  });
});
onBeforeUnmount(() => {
  window.removeEventListener(STANDALONE_FILE_OPEN_EVENT, acceptFile);
  access.dispose();
});
</script>

<template>
  <template v-if="session">
    <SessionShareConversation
      v-if="!standalone"
      v-show="!previewIntent"
      :access="access"
      @open-file="openFile"
    />
    <section v-if="previewIntent" class="share-preview">
      <StandaloneFilePreviewPage
        :key="previewVersion"
        :share="{ access, intent: previewIntent, embedded: !standalone }"
        @close="previewIntent = undefined"
      />
    </section>
  </template>
  <main v-else class="share-entry">
    <section class="share-entry-panel">
      <span class="share-entry-mark" aria-hidden="true">MAR</span>
      <h1>{{ translate('sessionShare.sharedConversation') }}</h1>
      <p v-if="invalidCode && invalidCode !== 'SESSION_SHARE_CREDENTIAL_INVALID'" role="status">
        {{ translate('sessionShare.invalid') }}
      </p>
      <div
        v-else-if="restoring"
        class="page-loading-state"
        role="status"
        :aria-label="translate('sessionShare.loading')"
      >
        <BusyIndicator />
      </div>
      <el-form
        v-else
        ref="form"
        :model="fields"
        :rules="rules"
        label-position="top"
        @submit.prevent="login()"
      >
        <p>{{ translate('sessionShare.enterPassword') }}</p>
        <el-form-item prop="password" :label="translate('sessionShare.password')">
          <el-input
            v-model="fields.password"
            type="password"
            inputmode="numeric"
            maxlength="6"
            autocomplete="off"
            autofocus
            show-password
          >
            <template #password-icon="{ visible }">
              <MarIcon :name="visible ? 'view' : 'view-off'" />
            </template>
          </el-input>
        </el-form-item>
        <el-button
          type="primary"
          native-type="submit"
          :loading="loading"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('sessionShare.enter') }}</el-button
        >
      </el-form>
    </section>
  </main>
</template>

<style scoped>
.share-entry {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 1.5rem;
  background: var(--el-bg-color-page);
}
.share-entry-panel {
  width: min(24rem, 100%);
  padding: 2rem;
  border: 1px solid var(--el-border-color-lighter);
  border-top: 3px solid var(--el-color-primary);
  border-radius: 8px;
  background: var(--el-bg-color);
}
.share-entry-mark {
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--el-color-primary);
}
h1 {
  font-size: var(--mar-font-size-page-title);
  margin: 1rem 0;
}
p {
  color: var(--el-text-color-secondary);
  line-height: 1.6;
  margin: 0 0 1.25rem;
}
.share-entry-panel :deep(.el-button) {
  width: 100%;
}
.share-entry-panel :deep(:focus-visible) {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.share-preview {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: var(--el-bg-color);
  overflow: auto;
}
@media (max-width: 767px) {
  .share-entry-panel {
    padding: 1.5rem;
  }
}
</style>
