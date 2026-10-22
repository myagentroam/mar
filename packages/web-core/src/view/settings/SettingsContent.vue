<script setup lang="ts">
import { Delete, Key, Link, Refresh, SwitchButton } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, ref, watch } from 'vue';
import { useDocumentationAvailability } from '../../service/DocumentationAvailability.js';
import { iconThemes } from '../../icon-themes/index.js';
import type { UserSessionSummary } from '../../model/workbench.js';
import type { SettingsSection } from '../../model/settings.js';
import { iconThemePreferenceService } from '../../service/IconThemePreferenceService.js';
import {
  fileEditorPreferenceService,
  type FileEditorDefaultMode
} from '../../service/FileEditorPreferenceService.js';
import {
  themePreferenceService,
  type ThemePreference
} from '../../service/ThemePreferenceService.js';
import { analyzeCustomTheme } from '../../util/custom-theme.js';
import ThemeSettings from './ThemeSettings.vue';
import {
  localizedDocsPath,
  localePreferenceService,
  SUPPORTED_LOCALES,
  translate,
  type AppLocale
} from '../../service/LocalePreferenceService.js';
import { useI18n } from 'vue-i18n';
import logoIcon from '../../assets/logo-icon.png';
import QuickPromptSettings from './QuickPromptSettings.vue';
import PersonalInstructionsSettings from './PersonalInstructionsSettings.vue';
import PromptCompletionPreferences from './PromptCompletionPreferences.vue';
import PersonalGitSettings from './PersonalGitSettings.vue';
import PersonalUsageSettings from './PersonalUsageSettings.vue';
import SystemNotificationControl from './SystemNotificationControl.vue';
import type { WorkbenchNotificationService } from '../../service/WorkbenchNotificationService.js';
import type { QuickPrompt } from '../../model/workbench.js';

const documentationAvailable = useDocumentationAvailability();

const props = defineProps<{
  readonly section: SettingsSection;
  readonly webVersion: string;
  readonly sessions: readonly UserSessionSummary[];
  readonly newPassword: string;
  readonly passwordValidationError: string;
  readonly registrationToken: string | undefined;
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
    ElMessage.error(t('customThemes.storageFailed'));
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
  } catch {
    localeService.setLocale(previous);
    ElMessage.error(translate('common.localeUpdateFailed'));
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
    await ElMessageBox.confirm(
      translate('generated.settingsContent.confirmSignOutSession'),
      translate('generated.settingsContent.signOut'),
      { type: 'warning' }
    );
  } catch {
    return;
  }
  emit('logoutSession', session);
}
async function confirmLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.settingsContent.confirmSignOut'),
      translate('generated.settingsContent.signOut2'),
      { type: 'warning' }
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
    <PersonalUsageSettings v-if="section === 'usage'" :request="request" />
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
          <el-button
            class="utility-control"
            :icon="Refresh"
            :aria-label="translate('generated.settingsContent.refreshSignInSessions')"
            :title="translate('generated.settingsContent.refreshSignInSessions')"
            text
            @click="emit('refreshSessions')"
          />
        </div>
        <p v-if="sessions.length === 0">
          {{ translate('generated.settingsContent.noActiveSignInSessions') }}
        </p>
        <ul v-else>
          <li v-for="session in sessions" :key="session.id">
            <strong>{{
              session.current
                ? translate('generated.settingsContent.currentDevice')
                : translate('generated.settingsContent.signedInDevice')
            }}</strong>
            <span :title="session.userAgent">{{ session.userAgent }}</span>
            <small>
              {{ session.ipAddress }} · {{ translate('generated.settingsContent.signedIn') }}
              {{ formatSessionTime(session.createdAt) }} ·
              {{ translate('generated.settingsContent.expires') }}
              {{ formatSessionTime(session.expiresAt) }}
            </small>
            <el-button link type="danger" :icon="Delete" @click="confirmLogoutSession(session)">
              {{ translate('generated.settingsContent.signOut') }}
            </el-button>
          </li>
        </ul>
      </section>
      <slot name="account-identity" />
      <div class="account-actions">
        <el-button type="primary" :icon="Key" @click="passwordDialogOpen = true">{{
          translate('generated.settingsContent.changePassword')
        }}</el-button>
        <el-button :loading="loading" plain :icon="SwitchButton" @click="confirmLogout">{{
          translate('generated.settingsContent.signOut2')
        }}</el-button>
      </div>
      <el-dialog
        v-if="passwordDialogOpen"
        v-model="passwordDialogOpen"
        :title="translate('generated.settingsContent.changePassword2')"
        width="min(420px, calc(100vw - 32px))"
      >
        <el-form label-position="top" @submit.prevent="submitPasswordChange">
          <el-form-item :label="translate('generated.settingsContent.currentPassword')" required
            ><el-input
              v-model="currentPassword"
              :placeholder="translate('generated.settingsContent.enterCurrentPassword')"
              :aria-label="translate('generated.settingsContent.currentPassword2')"
              type="password"
              autocomplete="current-password"
              @input="emit('clearPasswordError')"
          /></el-form-item>
          <el-form-item :label="translate('generated.settingsContent.newPassword')" required
            ><el-input
              v-model="password"
              :placeholder="translate('generated.settingsContent.enterNewPassword')"
              :aria-label="translate('generated.settingsContent.newPassword2')"
              type="password"
              autocomplete="new-password"
              @input="emit('clearPasswordError')"
          /></el-form-item>
          <el-form-item :label="translate('generated.settingsContent.confirmNewPassword')" required
            ><el-input
              v-model="confirmation"
              :placeholder="translate('generated.settingsContent.enterTheNewPasswordAgain')"
              :aria-label="translate('generated.settingsContent.confirmNewPassword2')"
              type="password"
              autocomplete="new-password"
              @input="emit('clearPasswordError')"
          /></el-form-item>
          <p v-if="passwordValidationError" class="password-form-error" role="alert">
            {{ passwordValidationError }}
          </p>
        </el-form>
        <template #footer
          ><el-button @click="closePasswordDialog">{{
            translate('generated.settingsContent.cancel')
          }}</el-button
          ><el-button
            :loading="loading || passwordSubmitting"
            type="primary"
            @click="submitPasswordChange"
            >{{ translate('generated.settingsContent.confirmChange') }}</el-button
          ></template
        >
      </el-dialog>
    </section>
    <section v-else-if="section === 'registration'" class="full settings-panel">
      <h2>{{ translate('generated.settingsContent.nodeRegistration') }}</h2>
      <p class="registration-summary">
        {{ translate('generated.settingsContent.createAOneTimeTokenThenComplete') }}
      </p>
      <p v-if="documentationAvailable" class="registration-guide">
        <el-link
          type="primary"
          :icon="Link"
          :underline="false"
          :href="localizedDocsPath(locale, 'deployment/node-installation')"
          target="_blank"
          rel="noopener noreferrer"
          >{{ translate('generated.settingsContent.viewNodeDeploymentAndAutoStartGuide') }}</el-link
        >
      </p>
      <div class="registration-action">
        <slot name="registration-owner" />
        <el-button :loading="loading" type="primary" @click="emit('createRegistrationToken')">
          {{ translate('generated.settingsContent.createOneTimeNodeRegistrationToken') }}
        </el-button>
      </div>
      <p v-if="registrationToken" class="token registration-token">
        <code>{{ registrationToken }}</code>
      </p>
    </section>
    <ThemeSettings v-else-if="section === 'custom-themes'" class="full" />
    <section v-else-if="section === 'appearance'" class="full settings-panel">
      <h2>{{ t('settings.appearance') }}</h2>
      <p class="account-summary">{{ t('settings.appearanceSummary') }}</p>
      <div class="theme-row">
        <label class="theme-label" for="appearance-theme">{{ t('settings.theme') }}</label>
        <el-select
          id="appearance-theme"
          :model-value="theme"
          class="theme-select"
          :aria-label="t('settings.theme')"
          @update:model-value="setTheme($event as ThemePreference)"
        >
          <el-option :label="t('settings.light')" value="daylight" />
          <el-option :label="t('settings.dark')" value="vscode-dark-2026" />
          <el-option
            v-for="item in customThemes"
            :key="item.id"
            :label="item.name"
            :value="item.id"
          />
        </el-select>
      </div>
      <div class="theme-row">
        <label class="theme-label" for="appearance-file-editor">{{
          t('settings.defaultFileMode')
        }}</label>
        <el-select
          id="appearance-file-editor"
          :model-value="fileEditorMode"
          class="theme-select"
          :aria-label="t('settings.defaultFileMode')"
          @update:model-value="fileEditorService.setMode($event as FileEditorDefaultMode)"
        >
          <el-option :label="t('settings.fileModeEdit')" value="edit" />
          <el-option :label="t('settings.fileModeReadOnly')" value="read-only" />
        </el-select>
      </div>
      <div class="theme-row">
        <label class="theme-label" for="appearance-icon-theme">{{ t('settings.iconTheme') }}</label>
        <el-select
          id="appearance-icon-theme"
          :model-value="iconTheme"
          class="theme-select"
          :aria-label="t('settings.iconTheme')"
          @update:model-value="iconThemeService.setTheme($event as 'seti' | 'material')"
        >
          <el-option
            v-for="option in iconThemes"
            :key="option.id"
            :label="t(option.labelKey)"
            :value="option.id"
          />
        </el-select>
      </div>
      <div class="theme-row">
        <label class="theme-label" for="appearance-language">{{ t('common.language') }}</label>
        <el-select
          id="appearance-language"
          :model-value="locale"
          class="theme-select"
          :aria-label="t('common.language')"
          @update:model-value="updateLocale($event as AppLocale)"
        >
          <el-option
            v-for="option in SUPPORTED_LOCALES"
            :key="option.value"
            :label="option.nativeLabel"
            :value="option.value"
          />
        </el-select>
      </div>
      <PromptCompletionPreferences />
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
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>E</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.openNotificationCenter') }}</dd>
          </div>
          <div>
            <dt><kbd>Alt</kbd><span>+</span><kbd>←/→</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.cycleWorkspaceTabs') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>Ctrl</kbd><span>+</span><kbd>Tab</kbd><span>/</span><kbd>Ctrl</kbd><span>+</span
              ><kbd>Shift</kbd><span>+</span><kbd>Tab</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.cycleWorkspaceTabsWithCtrlTab') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>1…9/0</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.selectWorkspaceTab') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>/</span><kbd>Alt</kbd><span>+</span><kbd>N</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.openNewSession') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>/</span><kbd>Alt</kbd><span>+</span><kbd>W</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.closeWorkspaceTab') }}</dd>
          </div>
          <div>
            <dt>
              <kbd>Ctrl</kbd><span>/</span><kbd>Alt</kbd><span>+</span><kbd>Shift</kbd><span>+</span
              ><kbd>W</kbd>
            </dt>
            <dd>{{ translate('keyboardShortcuts.closeAllWorkspaceTabs') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>K</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.openGitChanges') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>`</kbd></dt>
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
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>O</kbd></dt>
            <dd>
              {{ translate('keyboardShortcuts.quickOpenWorkspaceFile') }}
            </dd>
          </div>
          <div>
            <dt><kbd>↑</kbd>/<kbd>↓</kbd>, <kbd>Enter</kbd>/<kbd>Esc</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.quickOpenNavigation') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd></dt>
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
            <dt><kbd>Esc</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.closeFileTab') }}</dd>
          </div>
          <div>
            <dt><kbd>Alt</kbd><span>+</span><kbd>←</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.previousPreviewLocation') }}</dd>
          </div>
          <div>
            <dt><kbd>Alt</kbd><span>+</span><kbd>→</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.nextPreviewLocation') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>V</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.openMarkdownPreview') }}</dd>
          </div>
          <div>
            <dt><kbd>Esc</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.closeStandalonePreview') }}</dd>
          </div>
        </dl>
      </section>
      <section class="shortcut-group" aria-labelledby="shortcut-editing">
        <h3 id="shortcut-editing">{{ translate('shortcutGroups.editing') }}</h3>
        <dl class="shortcut-list">
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>F</kbd></dt>
            <dd>
              {{ translate('keyboardShortcuts.searchWorkspaceContent') }}
            </dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>F</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.findInPreview') }}</dd>
          </div>
          <div>
            <dt><kbd>Enter</kbd>/<kbd>Shift</kbd><span>+</span><kbd>Enter</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.findMatchNavigation') }}</dd>
          </div>
          <div>
            <dt><kbd>Esc</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.closeEmbeddedFind') }}</dd>
          </div>
          <div>
            <dt><kbd>Alt</kbd><span>+</span><kbd>M</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.openEditorSymbols') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>E</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.toggleFileEditing') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>A</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.selectEditorContent') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>H</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.replaceInEditor') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>S</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.saveEditor') }}</dd>
          </div>
        </dl>
      </section>
      <section class="shortcut-group" aria-labelledby="shortcut-composer">
        <h3 id="shortcut-composer">{{ translate('shortcutGroups.composer') }}</h3>
        <dl class="shortcut-list">
          <div>
            <dt><kbd>Alt</kbd><span>+</span><kbd>M</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.openComposerModelMenu') }}</dd>
          </div>
          <div>
            <dt><kbd>Tab</kbd>/<kbd>Shift</kbd><span>+</span><kbd>Tab</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.modelMenuGroup') }}</dd>
          </div>
          <div>
            <dt><kbd>Enter</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.sendMessage') }}</dd>
          </div>
          <div>
            <dt><kbd>Shift</kbd>/<kbd>Alt</kbd><span>+</span><kbd>Enter</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.composerNewline') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.replaceRunningMessage') }}</dd>
          </div>
          <div>
            <dt><kbd>Esc</kbd></dt>
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
            <dt><kbd>Enter</kbd></dt>
            <dd>{{ translate('keyboardShortcuts.saveQueuedMessage') }}</dd>
          </div>
          <div>
            <dt><kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd></dt>
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
      <el-descriptions :column="1" border>
        <el-descriptions-item v-if="documentationAvailable" :label="t('settings.documentation')">
          <el-link
            :href="localizedDocsPath(locale, 'getting-started/overview')"
            target="_blank"
            :underline="false"
            >{{ t('settings.openDocumentation') }}</el-link
          >
        </el-descriptions-item>
        <el-descriptions-item :label="t('settings.thirdPartyOpenSourceSoftware')">
          <p class="third-party-scope">{{ t('settings.thirdPartySummary') }}</p>
          <dl class="third-party-groups">
            <div v-for="group in thirdPartyGroups" :key="group">
              <dt>{{ t('settings.thirdPartyGroups.' + group + '.title') }}</dt>
              <dd>{{ t('settings.thirdPartyGroups.' + group + '.components') }}</dd>
            </div>
          </dl>
          <el-link
            class="third-party-notices-link"
            href="/THIRD_PARTY_NOTICES.txt"
            target="_blank"
            rel="noopener noreferrer"
            :underline="false"
            >{{ t('settings.viewThirdPartyNotices') }}</el-link
          >
          <p class="third-party-scope">{{ t('settings.thirdPartyDistributionNotices') }}</p>
        </el-descriptions-item>
      </el-descriptions>
    </section>
  </section>
</template>

<style scoped>
.password-form-error {
  grid-column: 1 / -1;
  grid-row: 2;
  margin: 0;
  color: var(--el-color-danger);
  font-size: var(--mar-font-size-meta);
  line-height: 1.4;
}
</style>

<style scoped>
.full {
  max-width: 960px;
}
.about-settings {
  width: 100%;
  min-height: 100%;
  box-sizing: border-box;
  padding: 28px 32px 36px;
  background: var(--mar-bg-panel);
}
.system-brand {
  display: flex;
  align-items: center;
  gap: 16px;
  width: min(100%, 820px);
  padding-bottom: 22px;
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
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-body);
}

.about-settings :deep(.el-descriptions) {
  width: min(100%, 820px);
  overflow: hidden;
  border: 1px solid var(--mar-border-medium);
  border-radius: 10px;
  background: var(--mar-bg-panel);
}

.about-settings :deep(.el-descriptions__table) {
  table-layout: fixed;
}

.about-settings :deep(.el-descriptions__label) {
  width: 180px;
  background: var(--mar-fill-subtle);
  color: var(--mar-text-secondary);
  font-weight: 600;
}

.about-settings :deep(.el-descriptions__content) {
  background: var(--mar-bg-panel);
  color: var(--mar-text-primary);
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
  border: 1px dashed var(--mar-text-faint);
  border-radius: 4px;
  background: var(--mar-fill-subtle);
  padding: 0.55rem;
}
</style>

<style scoped>
.settings-content {
  width: 100%;
  padding: 0;
  background: var(--mar-bg-panel);
}

.settings-content .full {
  max-width: 960px;
  padding: 14px 16px;
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
  color: var(--mar-text-muted);
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
  grid-template-columns: 9.5rem minmax(0, 18rem);
  align-items: center;
  gap: 1rem;
  margin-top: 0.75rem;
}

.theme-label {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-weight: 600;
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

.registration-guide :deep(.el-link) {
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
  border-block: 1px solid var(--mar-border-medium);
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
  color: var(--mar-text-muted);
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
  border-top: 1px solid var(--mar-fill-hover);
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
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
}

.account-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 0.8rem;
  border-top: 1px solid var(--mar-border-medium);
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
    padding: 0.75rem;
  }

  .about-settings {
    padding: 20px 16px 28px;
  }

  .about-settings :deep(.el-descriptions__label) {
    width: 128px;
  }
}

@media (max-width: 460px) {
  .host-summary,
  .overview-grid,
  .full,
  .settings-content {
    padding: 0.65rem;
  }
}
</style>

<style scoped>
:global(.admin-sessions li > .el-button) {
  grid-column: 3;
  grid-row: 1 / span 2;
  align-self: center;
}

@media (max-width: 520px) {
  :global(.admin-sessions li > .el-button) {
    grid-column: 2;
    grid-row: 1 / span 3;
  }
}
</style>
