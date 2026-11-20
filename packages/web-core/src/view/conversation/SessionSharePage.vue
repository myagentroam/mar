<script setup lang="ts">
import {
  MarForm,
  MarFormItem,
  type FormInstance,
  type FormItemProp,
  type FormRules
} from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarButton } from '@myagentroam/mar-ui/button';
import { showMessage } from '../../service/message-feedback-service.js';

import logoIcon from '../../assets/logo-icon.png';
import { errorCode } from '../../util/api-error.js';
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { createSessionShareAccessService } from '../../service/session-share-access-service.js';
import {
  createStandaloneFileWindowService,
  STANDALONE_FILE_OPEN_EVENT,
  standaloneFileContext
} from '../../service/standalone-file-window-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import SessionShareConversation from './SessionShareConversation.vue';
import AuthEntryPanel from '../common/AuthEntryPanel.vue';
import BusyIndicator from '../common/BusyIndicator.vue';
import MarIcon from '../common/MarIcon.vue';
const StandaloneFilePreviewPage = defineAsyncComponent(
  () => import('../workspace/StandaloneFilePreviewPage.vue')
);

const props = defineProps<{ shareId: string }>();
const conversation = ref<InstanceType<typeof SessionShareConversation>>();
const access = createSessionShareAccessService(props.shareId);
const { session, invalidCode } = access;
const shareUnavailable = computed(
  () => !!invalidCode.value && invalidCode.value !== 'SESSION_SHARE_CREDENTIAL_INVALID'
);
const context = `share:${props.shareId}`;
const windows = createStandaloneFileWindowService(undefined, context);
const initialIntent = new URLSearchParams(location.search);
const standalone = initialIntent.get('standaloneFile') === '1';
const previewIntent = ref<URLSearchParams | undefined>(standalone ? initialIntent : undefined);
const previewVersion = ref(0);
const loading = ref(false);
const restoring = ref(true);
const form = ref<FormInstance>();
const passwordInput = ref<InstanceType<typeof MarInput>>();
const unavailableStatus = ref<HTMLElement>();
const fields = ref({ password: '' });
const passwordVisible = ref(false);
const passwordError = ref('');
const requestError = ref('');
const rules: FormRules = {
  password: [
    {
      pattern: /^[0-9]{6}$/u,
      required: true,
      message: () => translate('sessionShare.passwordFormat')
    }
  ]
};

function onPasswordInput(): void {
  if (!fields.value.password) passwordVisible.value = false;
  passwordError.value = '';
  form.value?.clearValidate('password');
}

function presentValidation(_field: FormItemProp, valid: boolean, message: string): void {
  passwordError.value = valid ? '' : message;
}

function presentRequestError(error: unknown): void {
  requestError.value = errorMessage(
    error,
    shareUnavailable.value ? translate('sessionShare.invalid') : undefined
  );
}

async function login(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  requestError.value = '';
  try {
    if (!(await form.value?.validate().catch(() => false))) return;
    passwordVisible.value = false;
    await access.authenticate(fields.value.password);
    fields.value.password = '';
  } catch (error) {
    if (errorCode(error) === 'SESSION_SHARE_CREDENTIAL_INVALID') {
      passwordError.value = errorMessage(error);
    } else {
      presentRequestError(error);
    }
  } finally {
    loading.value = false;
    if (shareUnavailable.value || passwordError.value) {
      await nextTick();
      if (shareUnavailable.value) unavailableStatus.value?.focus();
      else passwordInput.value?.focus();
    }
  }
}

async function restoreAccess(): Promise<void> {
  try {
    await access.authenticate();
  } catch (error) {
    presentRequestError(error);
  } finally {
    restoring.value = false;
  }
}

function openFile(path: string, line?: number, column?: number, external?: boolean): void {
  const intent = new URLSearchParams({ standaloneFile: '1', path, rawContent: '1' });
  if (line !== undefined) intent.set('line', String(line));
  if (column !== undefined) intent.set('column', String(column));
  if (external) {
    if (windows.open(`/share/${encodeURIComponent(props.shareId)}?${intent}`) === undefined)
      showMessage(translate('sessionShare.previewWindowBlocked'), 'error');
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
  void restoreAccess();
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
      ref="conversation"
      :access="access"
      @open-file="openFile"
    />
    <section v-if="previewIntent" class="share-preview" :class="{ 'is-embedded': !standalone }">
      <StandaloneFilePreviewPage
        :quote-target="standalone ? undefined : conversation?.quoteTarget"
        :key="previewVersion"
        :share="{ access, intent: previewIntent, embedded: !standalone }"
        @close="previewIntent = undefined"
      />
    </section>
  </template>
  <main v-else class="share-entry">
    <div
      v-if="restoring"
      class="mar-page-loading-state"
      role="status"
      aria-busy="true"
      :aria-label="translate('sessionShare.loading')"
    >
      <BusyIndicator />
    </div>
    <AuthEntryPanel
      v-else
      title-id="share-entry-title"
      :title="translate('sessionShare.sharedConversation')"
      :summary="shareUnavailable ? undefined : translate('sessionShare.enterPassword')"
      :logo-url="logoIcon"
    >
      <p
        v-if="shareUnavailable"
        ref="unavailableStatus"
        class="share-entry-status"
        role="status"
        tabindex="-1"
      >
        {{ requestError || translate('sessionShare.invalid') }}
      </p>
      <MarForm
        v-else
        ref="form"
        class="auth-form"
        method="post"
        :model="fields"
        :rules="rules"
        label-position="top"
        hide-required-asterisk
        novalidate
        @validate="presentValidation"
        @submit.prevent="login"
      >
        <MarFormItem
          class="share-password-field"
          prop="password"
          for="share-password"
          :show-message="false"
          :label="translate('sessionShare.password')"
        >
          <MarInput
            id="share-password"
            ref="passwordInput"
            v-model="fields.password"
            name="share-password"
            :type="passwordVisible ? 'text' : 'password'"
            inputmode="numeric"
            enterkeyhint="go"
            maxlength="6"
            autocomplete="current-password"
            required
            :readonly="loading"
            :validate-event="false"
            :aria-invalid="Boolean(passwordError)"
            :aria-describedby="passwordError ? 'share-password-error' : undefined"
            @input="onPasswordInput"
          >
            <template #suffix>
              <button
                v-if="fields.password"
                class="mar-icon-button mar-icon-action mar-icon-action--inline"
                type="button"
                :aria-label="translate('sessionShare.showPassword')"
                :aria-pressed="passwordVisible"
                :disabled="loading"
                @click="passwordVisible = !passwordVisible"
              >
                <MarIcon :name="passwordVisible ? 'view-off' : 'view'" />
              </button>
            </template>
          </MarInput>
          <div id="share-password-error" role="alert">
            <p v-if="passwordError" class="share-entry-error">{{ passwordError }}</p>
          </div>
        </MarFormItem>
        <div>
          <MarButton type="primary" native-type="submit" :loading="loading">{{
            translate('sessionShare.enter')
          }}</MarButton>
          <div role="alert">
            <p v-if="requestError" class="share-entry-error">{{ requestError }}</p>
          </div>
        </div>
      </MarForm>
    </AuthEntryPanel>
  </main>
</template>

<style scoped>
.share-entry {
  display: grid;
  height: 100vh;
  height: 100dvh;
  place-items: safe center;
  overflow: auto;
  padding: 1rem;
  background: var(--mar-bg-page);
}
.share-password-field {
  margin: 0;
}
.share-password-field :deep(.mar-ui-form-item__label) {
  margin-bottom: 0.35rem;
  line-height: 1.4;
}
.share-password-field :deep(.mar-ui-form-item__content) {
  display: block;
}
.share-entry-status {
  margin: 0;
  color: var(--mar-text-secondary);
  line-height: 1.6;
}
.share-entry-status,
.share-entry-error {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.share-entry-error {
  margin: 0.35rem 0 0;
  color: var(--mar-color-danger-text);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
}
.share-preview {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: var(--mar-bg-panel);
  overflow: auto;
}
.share-preview.is-embedded {
  position: static;
  background: transparent;
  overflow: visible;
}
</style>
