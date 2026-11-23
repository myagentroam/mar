<script setup lang="ts">
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarLink } from '@myagentroam/mar-ui/link';
import { MarForm, MarFormItem } from '@myagentroam/mar-ui/form';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';
import { MarButton } from '@myagentroam/mar-ui/button';
import { useMarUiLocale } from '@myagentroam/mar-ui/locale';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarRegionStatus } from '@myagentroam/mar-ui/region-status';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '@myagentroam/mar-ui/icons';
import { MarMessageBox } from '../../service/message-box-service.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDocumentationAvailability } from '../../service/documentation-availability.js';
import {
  activityToggleKeys,
  closeAllTabsKeys,
  closeTabKeys,
  composerModelKeys,
  composerSendKeys,
  composerStopKeys,
  fileKeys,
  findNavigationKeys,
  queueKeys,
  shortcutKeysLabel,
  workspaceKeys
} from '../../service/console-shortcut-keys.js';
import { iconThemes, type IconThemeId } from '../../icon-themes/index.js';
import type { UserSessionSummary } from '../../model/workbench.js';
import type { SettingsSection } from '../../model/settings.js';
import { iconThemePreferenceService } from '../../service/icon-theme-preference-service.js';
import {
  fileEditorPreferenceService,
  type FileEditorDefaultMode
} from '../../service/file-editor-preference-service.js';
import {
  themePreferenceService,
  type ThemePreference
} from '../../service/theme-preference-service.js';
import { analyzeCustomTheme } from '../../util/custom-theme.js';
import ThemeSettings from './ThemeSettings.vue';
import {
  localizedDocsPath,
  localePreferenceService,
  SUPPORTED_LOCALES,
  translate,
  type AppLocale
} from '../../service/locale-preference-service.js';
import { useI18n } from 'vue-i18n';
import logoIcon from '../../assets/logo-icon.png';
import QuickPromptSettings from './QuickPromptSettings.vue';
import PersonalInstructionsSettings from './PersonalInstructionsSettings.vue';
import PromptCompletionPreferences from './PromptCompletionPreferences.vue';
import PersonalGitSettings from './PersonalGitSettings.vue';
import UsageStatisticsSettings from './UsageStatisticsSettings.vue';
import SystemNotificationControl from './SystemNotificationControl.vue';
import type { WorkbenchNotificationService } from '../../service/workbench-notification-service.js';
import type { PwaApplicationState } from '../../service/pwa-application-service.js';
import type { QuickPrompt } from '../../model/workbench.js';

const documentationAvailable = useDocumentationAvailability();
const uiLocale = useMarUiLocale();

const props = defineProps<{
  readonly section: SettingsSection;
  readonly webVersion: string;
  readonly pwaState?: PwaApplicationState;
  readonly checkingForUpdates?: boolean;
  readonly sessions: readonly UserSessionSummary[];
  readonly sessionsRefreshing?: boolean;
  readonly sessionsManualRefresh?: boolean;
  readonly sessionsReadState?: 'idle' | 'loading' | 'ready' | 'failed';
  readonly sessionRevoking?: string | undefined;
  readonly newPassword: string;
  readonly passwordValidationError: string;
  readonly registrationToken: string | undefined;
  readonly registrationLoading: boolean;
  readonly loading: boolean;
  readonly changePassword: (input: {
    readonly currentPassword: string;
    readonly password: string;
    readonly confirmation: string;
  }) => Promise<boolean>;
  readonly formatSessionTime: (value: number) => string;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly quickPrompts: readonly QuickPrompt[];
  readonly quickPromptsLoading: boolean;
  readonly quickPromptsFailed: boolean;
  readonly refreshQuickPrompts: () => Promise<void>;
  readonly systemNotifications?: WorkbenchNotificationService['systemNotifications'];
}>();

const emit = defineEmits<{
  clearPasswordError: [];
  refreshSessions: [];
  logoutSession: [session: UserSessionSummary];
  logout: [];
  createRegistrationToken: [];
  checkForUpdates: [];
  applyWebUpdate: [];
}>();
const passwordDialogOpen = ref(false);
const themeService = themePreferenceService();
const theme = themeService.theme;
const iconThemeService = iconThemePreferenceService();
const iconTheme = iconThemeService.theme;
const fileEditorService = fileEditorPreferenceService();
const fileEditorMode = fileEditorService.mode;
const localeService = localePreferenceService();
const locale = localeService.locale;
const { t } = useI18n();
const standaloneWindow = ref(false);
let removeDisplayModeListener: (() => void) | undefined;
onMounted(() => {
  if (typeof window === 'undefined') return;
  const media = window.matchMedia('(display-mode: standalone)');
  const updateDisplayMode = () => {
    standaloneWindow.value =
      media.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  };
  updateDisplayMode();
  media.addEventListener('change', updateDisplayMode);
  removeDisplayModeListener = () => media.removeEventListener('change', updateDisplayMode);
});
onBeforeUnmount(() => removeDisplayModeListener?.());
const customThemes = computed(() =>
  themeService.customThemes.value.map((item) => ({
    id: item.id,
    name: analyzeCustomTheme(item.source).name ?? t('customThemes.untitled')
  }))
);
function setTheme(value: ThemePreference): void {
  try {
    themeService.setTheme(value);
  } catch {
    showMessage(t('customThemes.storageFailed'), 'error');
  }
}
function setIconTheme(value: IconThemeId): void {
  try {
    iconThemeService.setTheme(value);
  } catch {
    showMessage(t('customThemes.storageFailed'), 'error');
  }
}
const webVersion = props.webVersion;
const thirdPartyGroups = ['web', 'server', 'execution', 'tools', 'icons', 'computerUse'] as const;
const currentPassword = ref('');
const password = ref('');
const confirmation = ref('');
const passwordSubmitting = ref(false);
let passwordDialogGeneration = 0;
watch(
  passwordDialogOpen,
  () => {
    passwordDialogGeneration += 1;
    currentPassword.value = '';
    password.value = '';
    confirmation.value = '';
    passwordSubmitting.value = false;
    emit('clearPasswordError');
  },
  { flush: 'sync' }
);
watch(
  () => props.section,
  (section) => {
    if (section !== 'account') closePasswordDialog();
  }
);

async function updateLocale(value: AppLocale): Promise<void> {
  const previous = locale.value;
  localeService.setLocale(value);
  try {
    await props.request('/api/auth/preferences/locale', {
      method: 'PUT',
      body: JSON.stringify({ locale: value })
    });
  } catch (error) {
    localeService.setLocale(previous);
    showMessage(translate('common.localeUpdateFailed'), 'error', error);
  }
}
async function submitPasswordChange(): Promise<void> {
  if (props.loading || passwordSubmitting.value) return;
  const generation = passwordDialogGeneration;
  passwordSubmitting.value = true;
  try {
    const changed = await props.changePassword({
      currentPassword: currentPassword.value,
      password: password.value,
      confirmation: confirmation.value
    });
    if (changed && generation === passwordDialogGeneration) closePasswordDialog();
  } finally {
    if (generation === passwordDialogGeneration) passwordSubmitting.value = false;
  }
}
function closePasswordDialog(): void {
  passwordDialogOpen.value = false;
}
async function confirmLogoutSession(session: UserSessionSummary): Promise<void> {
  try {
    await MarMessageBox.confirm(
      translate('generated.settingsContent.confirmSignOutSession'),
      translate('generated.settingsContent.signOut'),
      { icon: marIcon('warning'), type: 'warning' }
    );
  } catch {
    return;
  }
  emit('logoutSession', session);
}
async function confirmLogout(): Promise<void> {
  try {
    await MarMessageBox.confirm(
      translate('generated.settingsContent.confirmSignOut'),
      translate('generated.settingsContent.signOut2'),
      { icon: marIcon('warning'), type: 'warning' }
    );
  } catch {
    return;
  }
  emit('logout');
}
</script>

<template>
  <section
    class="settings-content"
    :class="{
      'personal-instructions-content': section === 'personal-instructions',
      'page-settings-content':
        section === 'usage' || section === 'git' || section === 'quick-prompts'
    }"
  >
    <UsageStatisticsSettings v-if="section === 'usage'" :request="request" />
    <PersonalGitSettings v-else-if="section === 'git'" :request="request" />
    <section v-if="section === 'account'" class="full settings-panel">
      <h2>{{ translate('generated.settingsContent.accountSecurity') }}</h2>
      <p class="account-summary">
        {{ translate('generated.settingsContent.currentAccountAdminUpTo5Devices') }}
      </p>
      <section
        class="admin-sessions"
        :aria-label="translate('generated.settingsContent.signInSessions')"
      >
        <div class="admin-sessions-heading">
          <h3>
            {{
              translate('generated.settingsContent.signInSessions5', { value0: sessions.length })
            }}
          </h3>
          <MarButton
            v-tooltip="translate('generated.settingsContent.refreshSignInSessions')"
            class="mar-icon-action"
            :icon="marIcon('refresh')"
            :loading="sessionsManualRefresh"
            :disabled="sessionsRefreshing || sessionRevoking !== undefined"
            :aria-label="translate('generated.settingsContent.refreshSignInSessions')"
            text
            @click="emit('refreshSessions')"
          />
        </div>
        <MarRegionStatus
          v-if="
            !sessionsManualRefresh &&
            (sessionsRefreshing || sessionsReadState === 'idle' || sessionsReadState === 'loading')
          "
        >
          <span role="progressbar" :aria-label="translate('common.loading')">
            <MarBusyIndicator class="mar-read-loading-indicator" />
          </span>
        </MarRegionStatus>
        <MarRegionStatus v-else-if="sessions.length === 0">
          {{
            sessionsReadState === 'failed'
              ? uiLocale.noData
              : translate('generated.settingsContent.noActiveSignInSessions')
          }}
        </MarRegionStatus>
        <ul v-if="sessions.length > 0">
          <li v-for="session in sessions" :key="session.id">
            <strong>{{
              session.current
                ? translate('generated.settingsContent.currentDevice')
                : translate('generated.settingsContent.signedInDevice')
            }}</strong>
            <span v-tooltip="session.userAgent">{{ session.userAgent }}</span>
            <small>
              {{ session.ipAddress }} · {{ translate('generated.settingsContent.signedIn') }}
              {{ formatSessionTime(session.createdAt) }} ·
              {{ translate('generated.settingsContent.expires') }}
              {{ formatSessionTime(session.expiresAt) }}
            </small>
            <MarButton
              link
              type="danger"
              :icon="marIcon('delete')"
              :loading="sessionRevoking === session.id"
              :disabled="sessionRevoking !== undefined || sessionsRefreshing || loading"
              @click="confirmLogoutSession(session)"
            >
              {{ translate('generated.settingsContent.signOut') }}
            </MarButton>
          </li>
        </ul>
      </section>
      <slot name="account-identity" />
      <div class="account-actions">
        <MarButton type="primary" :icon="marIcon('key')" @click="passwordDialogOpen = true">{{
          translate('generated.settingsContent.changePassword')
        }}</MarButton>
        <MarButton
          :loading="loading"
          :disabled="sessionRevoking !== undefined"
          plain
          :icon="marIcon('power')"
          @click="confirmLogout"
          >{{ translate('generated.settingsContent.signOut2') }}</MarButton
        >
      </div>
      <MarDialog
        @vue:mounted="mountMobileDialogReturn"
        @vue:before-unmount="unmountMobileDialogReturn"
        v-if="passwordDialogOpen"
        v-model="passwordDialogOpen"
        :title="translate('generated.settingsContent.changePassword2')"
        width="min(420px, calc(100vw - 32px))"
      >
        <MarForm label-position="top" @submit.prevent="submitPasswordChange">
          <MarFormItem :label="translate('generated.settingsContent.currentPassword')" required
            ><MarInput
              v-model="currentPassword"
              :placeholder="translate('generated.settingsContent.enterCurrentPassword')"
              :aria-label="translate('generated.settingsContent.currentPassword2')"
              type="password"
              autocomplete="current-password"
              @input="emit('clearPasswordError')"
          /></MarFormItem>
          <MarFormItem :label="translate('generated.settingsContent.newPassword')" required
            ><MarInput
              v-model="password"
              :placeholder="translate('generated.settingsContent.enterNewPassword')"
              :aria-label="translate('generated.settingsContent.newPassword2')"
              type="password"
              autocomplete="new-password"
              @input="emit('clearPasswordError')"
          /></MarFormItem>
          <MarFormItem :label="translate('generated.settingsContent.confirmNewPassword')" required
            ><MarInput
              v-model="confirmation"
              :placeholder="translate('generated.settingsContent.enterTheNewPasswordAgain')"
              :aria-label="translate('generated.settingsContent.confirmNewPassword2')"
              type="password"
              autocomplete="new-password"
              @input="emit('clearPasswordError')"
          /></MarFormItem>
          <p v-if="passwordValidationError" class="password-form-error" role="alert">
            {{ passwordValidationError }}
          </p>
        </MarForm>
        <template #footer
          ><MarButton @click="closePasswordDialog">{{
            translate('generated.settingsContent.cancel')
          }}</MarButton
          ><MarButton
            :loading="loading || passwordSubmitting"
            type="primary"
            @click="submitPasswordChange"
            >{{ translate('generated.settingsContent.confirmChange') }}</MarButton
          ></template
        >
      </MarDialog>
    </section>
    <section v-else-if="section === 'registration'" class="full settings-panel">
      <h2>{{ translate('generated.settingsContent.nodeRegistration') }}</h2>
      <p class="registration-summary">
        {{ translate('generated.settingsContent.createAOneTimeTokenThenComplete') }}
      </p>
      <p v-if="documentationAvailable" class="registration-guide">
        <MarLink
          type="primary"
          :icon="marIcon('link')"
          :underline="false"
          :href="localizedDocsPath(locale, 'deployment/node-installation')"
          target="_blank"
          rel="noopener noreferrer"
          >{{ translate('generated.settingsContent.viewNodeDeploymentAndAutoStartGuide') }}</MarLink
        >
      </p>
      <div class="registration-action">
        <slot name="registration-owner" />
        <MarButton
          :loading="registrationLoading"
          type="primary"
          @click="emit('createRegistrationToken')"
        >
          {{ translate('generated.settingsContent.createOneTimeNodeRegistrationToken') }}
        </MarButton>
      </div>
      <p v-if="registrationToken" class="token registration-token">
        <code>{{ registrationToken }}</code>
      </p>
    </section>
    <ThemeSettings v-else-if="section === 'custom-themes'" class="full" />
    <section v-else-if="section === 'appearance'" class="full settings-panel">
      <h2>{{ t('settings.appearance') }}</h2>
      <p class="account-summary">{{ t('settings.appearanceSummary') }}</p>
      <div class="appearance-options">
        <div class="theme-row">
          <label id="appearance-theme-label" class="theme-label" for="appearance-theme">{{
            t('settings.theme')
          }}</label>
          <MarSelect
            id="appearance-theme"
            :model-value="theme"
            class="theme-select"
            aria-labelledby="appearance-theme-label"
            @update:model-value="setTheme($event as ThemePreference)"
          >
            <MarOption :label="t('settings.light')" value="daylight" />
            <MarOption :label="t('settings.dark')" value="vscode-dark-2026" />
            <MarOption
              v-for="item in customThemes"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
          </MarSelect>
        </div>
        <div class="theme-row">
          <label
            id="appearance-file-editor-label"
            class="theme-label"
            for="appearance-file-editor"
            >{{ t('settings.defaultFileMode') }}</label
          >
          <MarSelect
            id="appearance-file-editor"
            :model-value="fileEditorMode"
            class="theme-select"
            aria-labelledby="appearance-file-editor-label"
            @update:model-value="fileEditorService.setMode($event as FileEditorDefaultMode)"
          >
            <MarOption :label="t('settings.fileModeEdit')" value="edit" />
            <MarOption :label="t('settings.fileModeReadOnly')" value="read-only" />
          </MarSelect>
        </div>
        <div class="theme-row">
          <label id="appearance-icon-theme-label" class="theme-label" for="appearance-icon-theme">{{
            t('settings.iconTheme')
          }}</label>
          <MarSelect
            id="appearance-icon-theme"
            :model-value="iconTheme"
            class="theme-select"
            aria-labelledby="appearance-icon-theme-label"
            @update:model-value="setIconTheme($event as IconThemeId)"
          >
            <MarOption
              v-for="option in iconThemes"
              :key="option.id"
              :label="t(option.labelKey)"
              :value="option.id"
            />
          </MarSelect>
        </div>
        <div class="theme-row">
          <label id="appearance-language-label" class="theme-label" for="appearance-language">{{
            t('common.language')
          }}</label>
          <MarSelect
            id="appearance-language"
            :model-value="locale"
            class="theme-select"
            aria-labelledby="appearance-language-label"
            @update:model-value="updateLocale($event as AppLocale)"
          >
            <MarOption
              v-for="option in SUPPORTED_LOCALES"
              :key="option.value"
              :label="option.nativeLabel"
              :value="option.value"
            />
          </MarSelect>
        </div>
        <PromptCompletionPreferences />
      </div>
    </section>
    <section
      v-else-if="section === 'notifications' && systemNotifications"
      class="full settings-panel"
    >
      <h2>{{ t('workbenchNotificationCenter.systemNotifications.title') }}</h2>
      <p class="account-summary">
        {{
          t(
            systemNotifications.mode === 'mobile-push'
              ? 'workbenchNotificationCenter.webPush.summary'
              : 'workbenchNotificationCenter.systemNotifications.summary'
          )
        }}
      </p>
      <SystemNotificationControl :service="systemNotifications" />
    </section>
    <QuickPromptSettings
      v-else-if="section === 'quick-prompts'"
      class="full"
      :prompts="quickPrompts"
      :loading="quickPromptsLoading"
      :failed="quickPromptsFailed"
      :request="request"
      :refresh="refreshQuickPrompts"
    />
    <PersonalInstructionsSettings
      v-else-if="section === 'personal-instructions'"
      class="full"
      :request="request"
    />
    <section v-else-if="section === 'shortcuts'" class="full settings-panel">
      <h2>{{ translate('generated.settingsContent.keyboardShortcuts') }}</h2>
      <p class="account-summary">
        {{ translate('generated.settingsContent.theFollowingShortcutsAreAvailableInThe') }}
      </p>
      <p class="account-summary">{{ translate('keyboardShortcuts.platformHint') }}</p>
      <section class="shortcut-group" aria-labelledby="shortcut-workspace">
        <h3 id="shortcut-workspace">{{ translate('shortcutGroups.workspace') }}</h3>
        <dl class="shortcut-list">
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(activityToggleKeys) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.openRecentSessions') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(workspaceKeys.cycle.slice(0, 2)) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.cycleWorkspaceTabs') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(workspaceKeys.cycle.slice(2)) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.cycleWorkspaceTabsWithCtrlTab') }}</dd>
          </div>
          <div>
            <dt>
              <kbd
                >{{ shortcutKeysLabel([workspaceKeys.numbered[1]!]) }}…{{
                  workspaceKeys.numbered[9]!.key
                }}/{{ workspaceKeys.numbered[0]!.key }}</kbd
              >
            </dt>
            <dd>{{ translate('keyboardShortcuts.selectWorkspaceTab') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(workspaceKeys.newSession) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.openNewSession') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(closeTabKeys) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.closeWorkspaceTab') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(closeAllTabsKeys) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.closeAllWorkspaceTabs') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(workspaceKeys.changes) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.openGitChanges') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(workspaceKeys.terminal) }}</kbd>
            </dt>
            <dd>
              {{ translate('keyboardShortcuts.focusWorkspaceTerminal') }}
            </dd>
          </div>
        </dl>
      </section>
      <section class="shortcut-group" aria-labelledby="shortcut-files">
        <h3 id="shortcut-files">{{ translate('shortcutGroups.files') }}</h3>
        <dl class="shortcut-list">
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(workspaceKeys.quickOpen) }}</kbd>
            </dt>
            <dd>
              {{ translate('keyboardShortcuts.quickOpenWorkspaceFile') }}
            </dd>
          </div>
          <div>
            <dt>
              <kbd>↑</kbd>/<kbd>↓</kbd>, <kbd>{{ shortcutKeysLabel([fileKeys.choose[0]]) }}</kbd
              >/<kbd>{{ shortcutKeysLabel([fileKeys.dismiss[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.quickOpenNavigation') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(fileKeys.choose.slice(1)) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.quickOpenSeparatePreview') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Click</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.openCompanionPreview') }}</dd>
          </div>
          <div>
            <dt><kbd>←</kbd>/<kbd>→</kbd>, <kbd>Home</kbd>/<kbd>End</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.fileTabNavigation') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([fileKeys.dismiss[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.closeFileTab') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([fileKeys.back[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.previousPreviewLocation') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([fileKeys.forward[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.nextPreviewLocation') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(workspaceKeys.preview) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.openMarkdownPreview') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([fileKeys.dismiss[0]]) }}</kbd>
              / <kbd>{{ shortcutKeysLabel(closeAllTabsKeys) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.closeStandalonePreview') }}</dd>
          </div>
        </dl>
      </section>
      <section class="shortcut-group" aria-labelledby="shortcut-editing">
        <h3 id="shortcut-editing">{{ translate('shortcutGroups.editing') }}</h3>
        <dl class="shortcut-list">
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(workspaceKeys.search) }}</kbd>
            </dt>
            <dd>
              {{ translate('keyboardShortcuts.searchWorkspaceContent') }}
            </dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(fileKeys.find) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.findInPreview') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([findNavigationKeys[0]]) }}</kbd
              >/<kbd>{{ shortcutKeysLabel([findNavigationKeys[1]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.findMatchNavigation') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([fileKeys.dismiss[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.closeEmbeddedFind') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([fileKeys.symbols[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.openEditorSymbols') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(fileKeys.toggleEdit) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.toggleFileEditing') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(fileKeys.selectAll) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.selectEditorContent') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(fileKeys.replace) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.replaceInEditor') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel(fileKeys.save) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.saveEditor') }}</dd>
          </div>
        </dl>
      </section>
      <section class="shortcut-group" aria-labelledby="shortcut-composer">
        <h3 id="shortcut-composer">{{ translate('shortcutGroups.composer') }}</h3>
        <dl class="shortcut-list">
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([composerModelKeys[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.openComposerModelMenu') }}</dd>
          </div>
          <div>
            <dt><kbd>Tab</kbd>/<kbd>Shift</kbd><span>+</span><kbd>Tab</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.modelMenuGroup') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([composerSendKeys[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.sendMessage') }}</dd>
          </div>
          <div>
            <dt><kbd>Shift</kbd>/<kbd>Alt</kbd><span>+</span><kbd>Enter</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.composerNewline') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([composerSendKeys[1]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.replaceRunningMessage') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([composerStopKeys[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.stopRun') }}</dd>
          </div>
          <div>
            <dt><kbd>@</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.openFileReferences') }}</dd>
          </div>
          <div>
            <dt><kbd>/</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.openAgentCommands') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([queueKeys.save[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.saveQueuedMessage') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>{{ shortcutKeysLabel([queueKeys.execute[0]]) }}</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.runQueuedMessage') }}</dd>
          </div>
        </dl>
      </section>
    </section>
    <section v-else-if="section === 'about'" class="about-settings full settings-panel">
      <div class="system-brand" :aria-label="t('settings.about')">
        <img :src="logoIcon" alt="" />
        <div>
          <strong>{{ translate('common.productName') }}</strong
          ><code>v{{ webVersion }}</code>
        </div>
      </div>
      <dl class="about-details">
        <div>
          <dt>{{ t('webUpdate.displayModeLabel') }}</dt>
          <dd>{{ t(`webUpdate.displayMode.${standaloneWindow ? 'standalone' : 'browser'}`) }}</dd>
        </div>
        <div v-if="pwaState">
          <dt>{{ t('webUpdate.offlineLabel') }}</dt>
          <dd>
            <span>{{ t(`webUpdate.offline.${pwaState.offline}`) }}</span>
            <div class="pwa-actions">
              <MarButton :loading="checkingForUpdates" @click="emit('checkForUpdates')">{{
                t('webUpdate.check')
              }}</MarButton>
              <MarButton v-if="pwaState.update" type="primary" @click="emit('applyWebUpdate')">{{
                t('webUpdate.apply')
              }}</MarButton>
              <MarButton v-else-if="pwaState.reload" @click="emit('applyWebUpdate')">{{
                t(
                  pwaState.reload.action === 'activate'
                    ? 'webUpdate.usePrepared'
                    : 'webUpdate.reloadPrepared'
                )
              }}</MarButton>
            </div>
          </dd>
        </div>
        <div v-if="documentationAvailable">
          <dt>{{ t('settings.documentation') }}</dt>
          <dd>
            <MarLink
              :href="localizedDocsPath(locale, 'getting-started/overview')"
              target="_blank"
              :underline="false"
              >{{ t('settings.openDocumentation') }}</MarLink
            >
          </dd>
        </div>
        <div>
          <dt>{{ t('settings.thirdPartyOpenSourceSoftware') }}</dt>
          <dd>
            <p class="third-party-scope">{{ t('settings.thirdPartySummary') }}</p>
            <dl class="third-party-groups">
              <div v-for="group in thirdPartyGroups" :key="group">
                <dt>{{ t('settings.thirdPartyGroups.' + group + '.title') }}</dt>
                <dd>{{ t('settings.thirdPartyGroups.' + group + '.components') }}</dd>
              </div>
            </dl>
            <MarLink
              class="third-party-notices-link"
              href="/THIRD_PARTY_NOTICES.txt"
              target="_blank"
              rel="noopener noreferrer"
              :underline="false"
              >{{ t('settings.viewThirdPartyNotices') }}</MarLink
            >
            <p class="third-party-scope">{{ t('settings.thirdPartyDistributionNotices') }}</p>
          </dd>
        </div>
      </dl>
    </section>
  </section>
</template>

<style scoped>
.password-form-error {
  grid-column: 1 / -1;
  grid-row: 2;
  margin: 0;
  color: var(--mar-control-color-danger);
  font-size: var(--mar-font-size-meta);
  line-height: 1.4;
}
.pwa-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
</style>

<style scoped>
.about-settings {
  width: 100%;
  min-height: 100%;
  box-sizing: border-box;
  background: var(--mar-bg-panel);
}
.system-brand {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--mar-border-subtle);
}
.system-brand img {
  width: 64px;
  height: 64px;
}
.system-brand div {
  display: grid;
  gap: 5px;
}
.system-brand strong {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-page-title);
  letter-spacing: -0.02em;
}
.system-brand code {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
}

.about-details {
  margin: 0;
}

.about-details > div {
  display: grid;
  grid-template-columns: 11rem minmax(0, 1fr);
  gap: 0.5rem 1.5rem;
  padding-block: 1rem;
  border-bottom: 1px solid var(--mar-border-subtle);
}

.about-details dt {
  color: var(--mar-text-secondary);
  font-weight: 400;
}

.about-details dd {
  min-width: 0;
  margin: 0;
  color: var(--mar-text-primary);
  overflow-wrap: anywhere;
}

.about-details dd > p:first-child {
  margin-top: 0;
}

.third-party-groups {
  display: grid;
  gap: 0.75rem;
  margin: 0.75rem 0;
}

.third-party-groups dt {
  color: var(--mar-text-secondary);
  font-weight: 600;
}

.third-party-groups dd {
  margin: 0.2rem 0 0;
  color: var(--mar-text-primary);
  overflow-wrap: anywhere;
}

.third-party-scope {
  margin: 0.5rem 0;
  color: var(--mar-text-secondary);
  overflow-wrap: anywhere;
}

.third-party-notices-link {
  margin-top: 10px;
  font-weight: 600;
}

.registration-token {
  width: min(100%, 520px);
  margin: 0.65rem 0 0;
}

.registration-token code {
  display: block;
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
}

.token {
  border: 1px dashed var(--mar-border-strong);
  border-radius: 4px;
  background: var(--mar-fill-subtle);
  padding: 0.55rem;
}
</style>

<style scoped>
.settings-content {
  --mar-settings-page-padding: 0.875rem 1rem;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0;
  background: var(--mar-bg-panel);
}

.settings-content .full {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: var(--mar-settings-page-padding);
}

.settings-content.page-settings-content {
  display: flex;
  flex-direction: column;
  padding: 0;
}

.settings-content .full.page-loading-panel {
  max-width: none;
  padding: 0;
}

.settings-content.personal-instructions-content {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
}

.settings-content.personal-instructions-content .full {
  box-sizing: border-box;
  min-height: 0;
  flex: 1 1 auto;
}

.settings-panel > h2 {
  margin: 0;
  font-size: var(--mar-font-size-title);
  line-height: 1.4;
}

.settings-panel > p {
  margin: 5px 0 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
}

.shortcut-group {
  margin-top: 1.25rem;
}

.shortcut-group h3 {
  margin: 0;
  padding-bottom: 0.45rem;
  border-bottom: 1px solid var(--mar-border-subtle);
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-weight: 600;
}

.shortcut-list {
  display: grid;
  gap: 0.75rem;
  margin: 0.75rem 0 0;
  font-size: var(--mar-font-size-body);
}

.theme-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 18rem);
  align-items: center;
  gap: 1rem;
  padding-block: 0.875rem;
  border-bottom: 1px solid var(--mar-border-subtle);
}

.appearance-options {
  max-width: 34rem;
  margin-top: 0.5rem;
}

.theme-label {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-weight: 400;
}

.theme-select {
  width: min(18rem, 100%);
}

.shortcut-list > div {
  display: grid;
  grid-template-columns: minmax(0, 16rem) minmax(0, 1fr);
  gap: 1rem;
  align-items: center;
}

.shortcut-list dt {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
}

.shortcut-list dd {
  margin: 0;
  color: var(--mar-text-secondary);
}

.shortcut-list kbd {
  border: 1px solid var(--mar-border-strong);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 0.08rem 0.35rem;
  background: var(--mar-fill-subtle);
  font-family: inherit;
  font-size: var(--mar-font-size-body);
}

.account-summary {
  margin-bottom: 0.65rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.55;
}

.registration-summary {
  margin-bottom: 0.65rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.55;
}

.registration-guide {
  margin: -0.2rem 0 0.75rem;
  font-size: var(--mar-font-size-body);
  line-height: 1.55;
}

.registration-guide :deep(.mar-ui-link) {
  font-size: var(--mar-font-size-body);
}

.registration-action {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.admin-sessions {
  margin: 0.8rem 0;
  border-block: 1px solid var(--mar-border-subtle);
  padding: 0.55rem 0;
}

.admin-sessions-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.45rem;
}

.admin-sessions-heading h3 {
  margin: 0;
  font-size: var(--mar-font-size-body);
}

.admin-sessions > p {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
}

.admin-sessions ul {
  display: grid;
  margin: 0.35rem 0 0;
  padding: 0;
  list-style: none;
}

.admin-sessions li {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) auto;
  gap: 0.16rem 0.5rem;
  align-items: baseline;
  border-top: 1px solid var(--mar-border-subtle);
  padding: 0.45rem 0;
}

.admin-sessions li:first-child {
  border-top: 0;
}

.admin-sessions li > strong {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
}

.admin-sessions li > span {
  min-width: 0;
  overflow: hidden;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-sessions li > small {
  grid-column: 2;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
}

.account-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 0.8rem;
  border-top: 1px solid var(--mar-border-subtle);
  padding-top: 0.8rem;
}

@media (max-width: 520px) {
  .theme-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.35rem;
  }

  .theme-select {
    width: 100%;
  }

  .admin-sessions li {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}

@media (max-width: 520px) {
  .shortcut-list > div {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }

  .admin-sessions li > strong,
  .admin-sessions li > span,
  .admin-sessions li > small {
    grid-column: 1;
  }
}

@media (max-width: 767px) {
  .settings-content {
    --mar-settings-page-padding: 0.75rem;
  }
}

@media (max-width: 520px) {
  .about-details > div {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

<style scoped>
:global(.admin-sessions li > .mar-ui-button) {
  grid-column: 3;
  grid-row: 1 / span 2;
  align-self: center;
}

@media (max-width: 520px) {
  :global(.admin-sessions li > .mar-ui-button) {
    grid-column: 2;
    grid-row: 1 / span 3;
  }
}
</style>
