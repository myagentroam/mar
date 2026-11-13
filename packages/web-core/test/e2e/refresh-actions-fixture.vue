<script setup lang="ts">
import { ref } from 'vue';
import { createAdminAuthService } from '../../src/service/admin-auth-service.js';
import { createAdminSessionStateService } from '../../src/service/admin-session-state-service.js';
import { createScopedHttpService } from '../../src/service/scoped-http-service.js';
import { createWorkspaceRegistrationService } from '../../src/service/workspace-registration-service.js';
import { localePreferenceService, translate } from '../../src/service/locale-preference-service.js';
import SettingsContent from '../../src/view/settings/SettingsContent.vue';
import WorkspaceRegistrationPicker from '../../src/view/workspace/WorkspaceRegistrationPicker.vue';
import WorkspaceHtmlBrowser from '../../src/view/workspace/WorkspaceHtmlBrowser.vue';

const http = createScopedHttpService({
  csrfToken: () => 'fixture',
  renewCsrfToken: async () => 'fixture'
});
const state = createAdminSessionStateService();
state.admin.value = { authenticated: true, mustChangePassword: false };
const auth = createAdminAuthService({
  presentation: {
    translate,
    currentLocale: () => localePreferenceService().locale.value,
    setLocale: (locale) => localePreferenceService().setLocale(locale)
  },
  admin: state.admin,
  loaded: state.loaded,
  sessions: state.sessions,
  password: state.newPassword,
  passwordError: state.passwordValidationError,
  csrfToken: state.csrfToken,
  loading: state.loading,
  request: http.request,
  renewCsrfToken: async () => 'fixture',
  invalidateRequests: () => {},
  onAuthenticated: async () => {},
  onSignedOut: () => {},
  notice: () => {},
  errorMessage: String
});
const registration = createWorkspaceRegistrationService({
  targetNodeId: ref('node'),
  request: http.request,
  onRegistered: async () => {},
  notice: () => {},
  error: () => {},
  errorMessage: String
});
registration.directory.value = {
  currentPath: '/workspace',
  homePath: '/workspace',
  parentPath: null,
  browseRoots: ['/workspace'],
  selectable: true,
  entries: [],
  truncated: false
};
</script>

<template>
  <main class="refresh-actions-fixture">
    <section data-testid="sign-in-refresh">
      <SettingsContent
        section="account"
        web-version="fixture"
        :sessions="auth.view.adminSessions"
        :sessions-refreshing="auth.view.adminSessionsRefreshing"
        new-password=""
        password-validation-error=""
        :registration-token="undefined"
        :registration-loading="false"
        :loading="false"
        :change-password="auth.changePassword"
        :format-session-time="String"
        :request="http.request"
        :quick-prompts="[]"
        :quick-prompts-loading="false"
        :quick-prompts-failed="false"
        :refresh-quick-prompts="async () => {}"
        @refresh-sessions="auth.refreshSessions"
      />
    </section>
    <section data-testid="directory-refresh">
      <WorkspaceRegistrationPicker
        :model-value="['register']"
        :directory="registration.directory.value"
        :loading-directory="registration.loadingDirectory.value"
        :loading="false"
        selected-path=""
        pending-directory-name=""
        :node-ready="true"
        :selected-path-valid="false"
        @navigate="registration.load"
      />
    </section>
    <section data-testid="html-refresh">
      <WorkspaceHtmlBrowser
        node-id="node"
        workspace-id="workspace"
        path="index.html"
        csrf-token="fixture"
        :renew-csrf-token="async () => 'fixture'"
      />
    </section>
  </main>
</template>

<style scoped>
.refresh-actions-fixture {
  display: grid;
  gap: 16px;
  padding: 12px;
}
</style>
