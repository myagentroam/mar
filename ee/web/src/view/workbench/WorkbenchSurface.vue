<script setup lang="ts">
import LoadingPanel from '@myagentroam/web-core/LoadingPanel.vue';

import { defineAsyncComponent, h, type ShallowUnwrapRef } from 'vue';
import type { createWorkbenchPageController } from '@/service/WorkbenchPageController';
import CoreSurface from '@myagentroam/web-core/WorkbenchSurface.vue';
import WorkspaceRegistrationPicker from '@/view/workspace/WorkspaceRegistrationPicker.vue';
import { translate } from '@/service/LocalePreferenceService';

const loadingComponent = {
  render: () =>
    h(LoadingPanel, { loading: true, variant: 'page', 'aria-label': translate('common.loading') })
};

const SettingsContent = defineAsyncComponent({
  loader: () => import('@/view/settings/SettingsContent.vue'),
  loadingComponent,
  delay: 0
});
defineProps<{ page: ShallowUnwrapRef<ReturnType<typeof createWorkbenchPageController>> }>();
</script>
<template>
  <CoreSurface :page="page">
    <template #workspace-registration>
      <WorkspaceRegistrationPicker
        v-model="page.openWorkspaceTools"
        v-model:preserve-git-config="page.workspacePreserveGitConfig"
        :git-policy-supported="page.workspaceGitPolicySupported"
        :directory="page.workspaceDirectory"
        :selected-path="page.workspacePath"
        :pending-directory-name="page.pendingWorkspaceDirectoryName"
        :loading-directory="page.loadingWorkspaceDirectory"
        :loading="page.loading"
        :node-ready="page.workspaceRegistrationReady"
        :selected-path-valid="page.selectedWorkspaceDirectorySelectable"
        :enterprise="page.admin.edition === 'ENTERPRISE'"
        :role="page.admin.role"
        :node-ownership="page.workspaceRegistrationNode?.ownership"
        :node-manageable="page.workspaceRegistrationNode?.manageable"
        :workspace-creatable="page.workspaceRegistrationNode?.workspaceCreatable"
        :request="page.request"
        @navigate="page.loadWorkspaceDirectories"
        @select="page.selectWorkspaceDirectory"
        @select-pending="page.selectPendingWorkspaceDirectory"
        @discard-pending="page.discardPendingWorkspaceDirectory"
        @register="page.registerWorkspace"
      />
    </template>
    <template #settings>
      <SettingsContent
        v-model:new-password="page.newPassword"
        :section="page.settingsSection"
        :sessions="page.adminSessions"
        :password-validation-error="page.passwordValidationError"
        :registration-token="page.registrationToken"
        :loading="page.loading"
        :format-session-time="page.formatSessionTime"
        :request="page.request"
        :edition="page.admin.edition ?? 'COMMUNITY'"
        :role="page.admin.role ?? null"
        :management-writable="page.admin.managementWritable ?? true"
        :quick-prompts="page.quickPrompts"
        :quick-prompts-loading="page.quickPromptsLoading"
        :quick-prompts-failed="page.quickPromptsFailed"
        :refresh-quick-prompts="page.refreshQuickPrompts"
        :system-notifications="page.workbenchNotificationService.systemNotifications"
        @clear-password-error="page.passwordValidationError = ''"
        @refresh-sessions="page.refreshAdminSessions"
        @logout-session="page.logoutAdminSession"
        :change-password="page.changePassword"
        @logout="page.logout"
        @create-registration-token="page.createRegistrationToken"
      />
    </template>
    <template #management-notice>
      <el-alert
        v-if="page.admin.licenseState === 'ENTERPRISE_FROZEN'"
        class="enterprise-frozen-banner"
        type="warning"
        :closable="false"
        show-icon
        :title="
          page.admin.role === 'ADMIN'
            ? translate(
                'generated.workbenchSurface.theEnterpriseLicenseIsFrozenConfiguredResources'
              )
            : translate(
                'generated.workbenchSurface.theEnterpriseLicenseIsFrozenConfiguredResources2'
              )
        "
      />
    </template>
  </CoreSurface>
</template>
