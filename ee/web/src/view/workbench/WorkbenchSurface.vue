<script setup lang="ts">
import MarIcon from '@myagentroam/web-core/MarIcon.vue';
import LoadingPanel from '@myagentroam/web-core/LoadingPanel.vue';

import { defineAsyncComponent, h } from 'vue';
import CoreSurface from '@myagentroam/web-core/WorkbenchSurface.vue';
import type { ManagementSection } from '@/model/workbench';
import type { WorkspaceRegistrationOwnership } from '@/service/workspace-registration-service';
import WorkspaceRegistrationPicker from '@/view/workspace/WorkspaceRegistrationPicker.vue';
import { translate } from '@/service/locale-preference-service';

const loadingComponent = {
  render: () =>
    h(LoadingPanel, { loading: true, variant: 'page', 'aria-label': translate('common.loading') })
};

const SettingsContent = defineAsyncComponent({
  loader: () => import('@/view/settings/SettingsContent.vue'),
  loadingComponent,
  delay: 0
});
type NodeOwnership = Extract<WorkspaceRegistrationOwnership, { ownerType: 'ORGANIZATION' }>;
type CoreSurfaceProps = Parameters<
  typeof CoreSurface<ManagementSection, WorkspaceRegistrationOwnership, NodeOwnership>
>[0];
defineProps<{ page: CoreSurfaceProps['page'] }>();
</script>
<template>
  <CoreSurface :page="page">
    <template #workspace-registration>
      <WorkspaceRegistrationPicker
        v-model="page.registration.openWorkspaceTools"
        v-model:preserve-git-config="page.registration.workspacePreserveGitConfig"
        :git-policy-supported="page.registration.workspaceGitPolicySupported"
        :directory="page.registration.workspaceDirectory"
        :selected-path="page.resources.workspacePath"
        :pending-directory-name="page.registration.pendingWorkspaceDirectoryName"
        :loading-directory="page.registration.loadingWorkspaceDirectory"
        :loading="page.identity.loading"
        :node-ready="page.registration.workspaceRegistrationReady"
        :selected-path-valid="page.registration.selectedWorkspaceDirectorySelectable"
        :enterprise="page.identity.admin.edition === 'ENTERPRISE'"
        :role="page.identity.admin.role"
        :node-ownership="page.registration.workspaceRegistrationNode?.ownership"
        :node-manageable="page.registration.workspaceRegistrationNode?.manageable"
        :workspace-creatable="page.registration.workspaceRegistrationNode?.workspaceCreatable"
        :request="page.identity.request"
        @navigate="page.registration.loadWorkspaceDirectories"
        @select="page.registration.selectWorkspaceDirectory"
        @select-pending="page.registration.selectPendingWorkspaceDirectory"
        @discard-pending="page.registration.discardPendingWorkspaceDirectory"
        @register="page.registration.registerWorkspace"
      />
    </template>
    <template #settings>
      <SettingsContent
        v-model:new-password="page.identity.newPassword"
        :section="page.application.settingsSection"
        :sessions="page.identity.adminSessions"
        :password-validation-error="page.identity.passwordValidationError"
        :registration-token="page.settings.registrationToken"
        :registration-loading="page.settings.registrationLoading"
        :loading="page.identity.loading"
        :format-session-time="page.identity.formatSessionTime"
        :request="page.identity.request"
        :edition="page.identity.admin.edition ?? 'COMMUNITY'"
        :role="page.identity.admin.role ?? null"
        :management-writable="page.identity.admin.managementWritable ?? true"
        :quick-prompts="page.settings.quickPrompts"
        :quick-prompts-loading="page.settings.quickPromptsLoading"
        :quick-prompts-failed="page.settings.quickPromptsFailed"
        :refresh-quick-prompts="page.settings.refreshQuickPrompts"
        :system-notifications="page.notifications.systemNotifications"
        @clear-password-error="page.identity.passwordValidationError = ''"
        @refresh-sessions="page.identity.refreshAdminSessions"
        @logout-session="page.identity.logoutAdminSession"
        :change-password="page.identity.changePassword"
        @logout="page.identity.logout"
        @create-registration-token="page.settings.createRegistrationToken"
      />
    </template>
    <template #management-notice>
      <el-alert
        v-if="page.identity.admin.licenseState === 'ENTERPRISE_FROZEN'"
        class="enterprise-frozen-banner"
        type="warning"
        :closable="false"
        show-icon
        :title="
          page.identity.admin.role === 'ADMIN'
            ? translate(
                'generated.workbenchSurface.theEnterpriseLicenseIsFrozenConfiguredResources'
              )
            : translate(
                'generated.workbenchSurface.theEnterpriseLicenseIsFrozenConfiguredResources2'
              )
        "
        ><template #icon><MarIcon name="warning" /></template
      ></el-alert>
    </template>
  </CoreSurface>
</template>

<style scoped>
.enterprise-frozen-banner {
  margin: 8px 16px 0;
}

@media (max-width: 767px) {
  .enterprise-frozen-banner {
    margin: 8px 12px 0;
  }
}
</style>
