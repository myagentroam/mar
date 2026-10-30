import { sessionShareEnUS } from './session-share.en-US.js';
import { sessionShareZhCN } from './session-share.zh-CN.js';
import { promptCompletionEnUS } from './prompt-completion.en-US.js';
import { promptCompletionZhCN } from './prompt-completion.zh-CN.js';
import { hostingManagementEnUS, hostingManagementZhCN } from './hosting-management.js';
import { templateManagementEnUS, templateManagementZhCN } from './template-management.js';
import { resourceDetailsEnUS, resourceDetailsZhCN } from './resource-details.js';
import { modelManagementEnUS, modelManagementZhCN } from './model-management.js';
import { catalogSourcesEnUS, catalogSourcesZhCN } from './catalog-sources.js';
import { systemConfigurationEnUS, systemConfigurationZhCN } from './system-configuration.js';
import { environmentSecretsEnUS, environmentSecretsZhCN } from './environment-secrets.js';
import { skillConfigurationEnUS, skillConfigurationZhCN } from './skill-configuration.js';
import { workbenchPageEnUS, workbenchPageZhCN } from './workbench-page.js';
import { workbenchShellEnUS, workbenchShellZhCN } from './workbench-shell.js';
import { workbenchCompositionEnUS, workbenchCompositionZhCN } from './workbench-composition.js';
import { notificationsEnUS, notificationsZhCN } from './notifications.js';
import { personalSettingsEnUS, personalSettingsZhCN } from './personal-settings.js';
import { hostedConversationsEnUS, hostedConversationsZhCN } from './hosted-conversations.js';
import { conversationUiEnUS, conversationUiZhCN } from './conversation-ui.js';
import { workspaceInspectorEnUS, workspaceInspectorZhCN } from './workspace-inspector.js';
import { filePreviewEnUS, filePreviewZhCN } from './file-preview.js';
import { fileNavigationEnUS, fileNavigationZhCN } from './file-navigation.js';
import { workspaceEnUS, workspaceZhCN } from './workspace.js';
import { errorPresentationEnUS, errorPresentationZhCN } from './error-presentation.js';
import { composerEnUS, composerZhCN } from './composer.js';
import { terminalEnUS, terminalZhCN } from './terminal.js';
import { conversationHistoryEnUS, conversationHistoryZhCN } from './conversation-history.js';
import { sessionPresentationEnUS, sessionPresentationZhCN } from './session-presentation.js';
import { authenticationEnUS, authenticationZhCN } from './authentication.js';
import { systemInformationEnUS, systemInformationZhCN } from './system-information.js';
import { personalGitEnUS } from './personal-git.en-US.js';
import { personalGitZhCN } from './personal-git.zh-CN.js';

export const commonMessages = {
  'en-US': {
    sessionGroups: workspaceEnUS.sessionGroups,
    sessionShare: sessionShareEnUS,
    personalGit: personalGitEnUS,
    promptCompletion: promptCompletionEnUS,
    usageStatistics: personalSettingsEnUS.usageStatistics,
    customThemes: personalSettingsEnUS.customThemes,
    ...hostingManagementEnUS,
    ...authenticationEnUS,
    navigation: {
      ...workbenchShellEnUS.navigation,
      ...workbenchPageEnUS.navigation,
      conversationTemplates: templateManagementEnUS.title
    },
    webUpdate: workbenchPageEnUS.webUpdate,
    conversationTemplates: {
      ...skillConfigurationEnUS.conversationTemplates,
      ...templateManagementEnUS
    },
    marAgentModels: modelManagementEnUS.marAgentModels,
    workspaceSessions: workbenchShellEnUS.workspaceSessions,
    performanceDiagnostics: workbenchShellEnUS.performanceDiagnostics,
    workspace: workbenchCompositionEnUS.workspace,
    activityCenter: notificationsEnUS.activityCenter,
    workbenchNotificationCenter: notificationsEnUS.workbenchNotificationCenter,
    gitWorktrees: workspaceInspectorEnUS.gitWorktrees,
    gitSync: workspaceInspectorEnUS.gitSync,
    workspaceWatch: workspaceInspectorEnUS.workspaceWatch,
    fileEditor: filePreviewEnUS.fileEditor,
    filePreviewContext: filePreviewEnUS.filePreviewContext,
    markdownPreview: filePreviewEnUS.markdownPreview,
    htmlPreview: filePreviewEnUS.htmlPreview,
    inlineFind: filePreviewEnUS.inlineFind,
    gitDiffViewer: filePreviewEnUS.gitDiffViewer,
    filePreviewDialog: filePreviewEnUS.filePreviewDialog,
    errors: { ...errorPresentationEnUS.errors, ...hostedConversationsEnUS.errors },
    hostedConversations: hostedConversationsEnUS.hostedConversations,
    workbench: { ...hostedConversationsEnUS.workbench, ...workbenchPageEnUS.workbench },
    goal: composerEnUS.goal,
    quickPrompts: { ...composerEnUS.quickPrompts, ...personalSettingsEnUS.quickPrompts },
    personalInstructions: personalSettingsEnUS.personalInstructions,
    shortcutGroups: personalSettingsEnUS.shortcutGroups,
    keyboardShortcuts: personalSettingsEnUS.keyboardShortcuts,
    composer: composerEnUS.composer,
    composerReference: composerEnUS.composerReference,
    composerSend: composerEnUS.composerSend,
    workspaceTabs: workbenchShellEnUS.workspaceTabs,
    settings: { ...fileNavigationEnUS.settings, ...personalSettingsEnUS.settings },
    workspaceDisplayFilter: {
      ...fileNavigationEnUS.workspaceDisplayFilter,
      ...workspaceInspectorEnUS.workspaceDisplayFilter
    },
    runnerProfiles: composerEnUS.runnerProfiles,
    nodeMessages: {
      ...workbenchCompositionEnUS.nodeMessages,
      ...composerEnUS.nodeMessages,
      ...conversationUiEnUS.nodeMessages
    },
    permissionStop: conversationUiEnUS.permissionStop,
    toolPresentation: conversationUiEnUS.toolPresentation,
    conversationProcess: conversationUiEnUS.conversationProcess,
    conversationActivity: conversationUiEnUS.conversationActivity,
    conversationEmpty: conversationUiEnUS.conversationEmpty,
    presentation: {
      ...conversationUiEnUS.presentation,
      ...hostedConversationsEnUS.presentation
    },
    common: {
      ...skillConfigurationEnUS.common,
      ...catalogSourcesEnUS.common,
      ...resourceDetailsEnUS.common,
      ...workbenchPageEnUS.common,
      ...workbenchCompositionEnUS.common,
      ...authenticationEnUS.common,
      ...workbenchShellEnUS.common,
      ...personalSettingsEnUS.common,
      ...hostedConversationsEnUS.common,
      ...systemInformationEnUS.common,
      ...errorPresentationEnUS.common,
      ...composerEnUS.common,
      ...filePreviewEnUS.common
    },
    generated: {
      ...resourceDetailsEnUS.generated,
      ...catalogSourcesEnUS.generated,
      ...systemConfigurationEnUS.generated,
      ...environmentSecretsEnUS.generated,
      ...skillConfigurationEnUS.generated,
      skillSourceManagementPage: {
        ...skillConfigurationEnUS.generated.skillSourceManagementPage,
        ...catalogSourcesEnUS.generated.skillSourceManagementPage
      },
      mcpSourceManagementPage: {
        ...skillConfigurationEnUS.generated.mcpSourceManagementPage,
        ...catalogSourcesEnUS.generated.mcpSourceManagementPage
      },
      ...workbenchPageEnUS.generated,
      ...workbenchCompositionEnUS.generated,
      ...authenticationEnUS.generated,
      ...workbenchShellEnUS.generated,
      ...notificationsEnUS.generated,
      ...composerEnUS.generated,
      ...workspaceEnUS.generated,
      ...fileNavigationEnUS.generated,
      ...filePreviewEnUS.generated,
      ...workspaceInspectorEnUS.generated,
      ...systemInformationEnUS.generated,
      ...sessionPresentationEnUS.generated,
      ...terminalEnUS.generated,
      ...conversationHistoryEnUS.generated,
      ...conversationUiEnUS.generated,
      workspaceTree: {
        ...workspaceEnUS.generated.workspaceTree,
        ...workbenchShellEnUS.generated.workspaceTree
      },
      settingsContent: {
        ...systemInformationEnUS.generated.settingsContent,
        ...personalSettingsEnUS.generated.settingsContent
      },
      conversationDomain: {
        ...composerEnUS.generated.conversationDomain,
        ...conversationUiEnUS.generated.conversationDomain
      }
    }
  },
  'zh-CN': {
    sessionGroups: workspaceZhCN.sessionGroups,
    sessionShare: sessionShareZhCN,
    personalGit: personalGitZhCN,
    promptCompletion: promptCompletionZhCN,
    usageStatistics: personalSettingsZhCN.usageStatistics,
    customThemes: personalSettingsZhCN.customThemes,
    ...hostingManagementZhCN,
    ...authenticationZhCN,
    navigation: {
      ...workbenchShellZhCN.navigation,
      ...workbenchPageZhCN.navigation,
      conversationTemplates: templateManagementZhCN.title
    },
    webUpdate: workbenchPageZhCN.webUpdate,
    conversationTemplates: {
      ...skillConfigurationZhCN.conversationTemplates,
      ...templateManagementZhCN
    },
    marAgentModels: modelManagementZhCN.marAgentModels,
    workspaceSessions: workbenchShellZhCN.workspaceSessions,
    performanceDiagnostics: workbenchShellZhCN.performanceDiagnostics,
    workspace: workbenchCompositionZhCN.workspace,
    activityCenter: notificationsZhCN.activityCenter,
    workbenchNotificationCenter: notificationsZhCN.workbenchNotificationCenter,
    gitWorktrees: workspaceInspectorZhCN.gitWorktrees,
    gitSync: workspaceInspectorZhCN.gitSync,
    workspaceWatch: workspaceInspectorZhCN.workspaceWatch,
    fileEditor: filePreviewZhCN.fileEditor,
    filePreviewContext: filePreviewZhCN.filePreviewContext,
    markdownPreview: filePreviewZhCN.markdownPreview,
    htmlPreview: filePreviewZhCN.htmlPreview,
    inlineFind: filePreviewZhCN.inlineFind,
    gitDiffViewer: filePreviewZhCN.gitDiffViewer,
    filePreviewDialog: filePreviewZhCN.filePreviewDialog,
    errors: { ...errorPresentationZhCN.errors, ...hostedConversationsZhCN.errors },
    hostedConversations: hostedConversationsZhCN.hostedConversations,
    workbench: { ...hostedConversationsZhCN.workbench, ...workbenchPageZhCN.workbench },
    goal: composerZhCN.goal,
    quickPrompts: { ...composerZhCN.quickPrompts, ...personalSettingsZhCN.quickPrompts },
    personalInstructions: personalSettingsZhCN.personalInstructions,
    shortcutGroups: personalSettingsZhCN.shortcutGroups,
    keyboardShortcuts: personalSettingsZhCN.keyboardShortcuts,
    composer: composerZhCN.composer,
    composerReference: composerZhCN.composerReference,
    composerSend: composerZhCN.composerSend,
    workspaceTabs: workbenchShellZhCN.workspaceTabs,
    settings: { ...fileNavigationZhCN.settings, ...personalSettingsZhCN.settings },
    workspaceDisplayFilter: {
      ...fileNavigationZhCN.workspaceDisplayFilter,
      ...workspaceInspectorZhCN.workspaceDisplayFilter
    },
    runnerProfiles: composerZhCN.runnerProfiles,
    nodeMessages: {
      ...workbenchCompositionZhCN.nodeMessages,
      ...composerZhCN.nodeMessages,
      ...conversationUiZhCN.nodeMessages
    },
    permissionStop: conversationUiZhCN.permissionStop,
    toolPresentation: conversationUiZhCN.toolPresentation,
    conversationProcess: conversationUiZhCN.conversationProcess,
    conversationActivity: conversationUiZhCN.conversationActivity,
    conversationEmpty: conversationUiZhCN.conversationEmpty,
    presentation: {
      ...conversationUiZhCN.presentation,
      ...hostedConversationsZhCN.presentation
    },
    common: {
      ...skillConfigurationZhCN.common,
      ...catalogSourcesZhCN.common,
      ...resourceDetailsZhCN.common,
      ...workbenchPageZhCN.common,
      ...workbenchCompositionZhCN.common,
      ...authenticationZhCN.common,
      ...workbenchShellZhCN.common,
      ...personalSettingsZhCN.common,
      ...hostedConversationsZhCN.common,
      ...systemInformationZhCN.common,
      ...errorPresentationZhCN.common,
      ...composerZhCN.common,
      ...filePreviewZhCN.common
    },
    generated: {
      ...resourceDetailsZhCN.generated,
      ...catalogSourcesZhCN.generated,
      ...systemConfigurationZhCN.generated,
      ...environmentSecretsZhCN.generated,
      ...skillConfigurationZhCN.generated,
      skillSourceManagementPage: {
        ...skillConfigurationZhCN.generated.skillSourceManagementPage,
        ...catalogSourcesZhCN.generated.skillSourceManagementPage
      },
      mcpSourceManagementPage: {
        ...skillConfigurationZhCN.generated.mcpSourceManagementPage,
        ...catalogSourcesZhCN.generated.mcpSourceManagementPage
      },
      ...workbenchPageZhCN.generated,
      ...workbenchCompositionZhCN.generated,
      ...authenticationZhCN.generated,
      ...workbenchShellZhCN.generated,
      ...notificationsZhCN.generated,
      ...composerZhCN.generated,
      ...workspaceZhCN.generated,
      ...fileNavigationZhCN.generated,
      ...filePreviewZhCN.generated,
      ...workspaceInspectorZhCN.generated,
      ...systemInformationZhCN.generated,
      ...sessionPresentationZhCN.generated,
      ...terminalZhCN.generated,
      ...conversationHistoryZhCN.generated,
      ...conversationUiZhCN.generated,
      workspaceTree: {
        ...workspaceZhCN.generated.workspaceTree,
        ...workbenchShellZhCN.generated.workspaceTree
      },
      settingsContent: {
        ...systemInformationZhCN.generated.settingsContent,
        ...personalSettingsZhCN.generated.settingsContent
      },
      conversationDomain: {
        ...composerZhCN.generated.conversationDomain,
        ...conversationUiZhCN.generated.conversationDomain
      }
    }
  }
} as const;
