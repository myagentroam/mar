import { resourceDetailsEnUS } from '@myagentroam/web-core/resource-details-messages';
import { catalogSourcesEnUS } from '@myagentroam/web-core/catalog-sources-messages';
import { systemConfigurationEnUS } from '@myagentroam/web-core/system-configuration-messages';
import { environmentSecretsEnUS } from '@myagentroam/web-core/environment-secrets-messages';
import { skillConfigurationEnUS } from '@myagentroam/web-core/skill-configuration-messages';
import { workbenchPageEnUS } from '@myagentroam/web-core/workbench-page-messages';
import { workbenchShellEnUS } from '@myagentroam/web-core/workbench-shell-messages';
import { workbenchCompositionEnUS } from '@myagentroam/web-core/workbench-composition-messages';
import { notificationsEnUS } from '@myagentroam/web-core/notification-messages';
import { personalSettingsEnUS } from '@myagentroam/web-core/settings-messages';
import { conversationUiEnUS } from '@myagentroam/web-core/conversation-ui-messages';
import { workspaceInspectorEnUS } from '@myagentroam/web-core/workspace-inspector-messages';
import { filePreviewEnUS } from '@myagentroam/web-core/file-preview-messages';
import { fileNavigationEnUS } from '@myagentroam/web-core/file-navigation-messages';
import { workspaceEnUS } from '@myagentroam/web-core/workspace-messages';
import { composerEnUS } from '@myagentroam/web-core/composer-messages';
import { terminalEnUS } from '@myagentroam/web-core/terminal-messages';
import { conversationHistoryEnUS } from '@myagentroam/web-core/conversation-messages';
import { sessionPresentationEnUS } from '@myagentroam/web-core/session-messages';
import { systemInformationEnUS } from '@myagentroam/web-core/system-messages';
import { authenticationEnUS } from '@myagentroam/web-core/auth-messages';
import { expandGeneratedMessages } from './messages.generated.js';

const generatedEnUSFlat: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(systemConfigurationEnUS.generated.systemConfigurationPage).map(
      ([key, value]) => [`systemConfigurationPage.${key}`, value]
    )
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiEnUS.generated.conversationHeader).map(([key, value]) => [
      `conversationHeader.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiEnUS.generated.conversationScroll).map(([key, value]) => [
      `conversationScroll.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiEnUS.generated.conversationTimeline).map(([key, value]) => [
      `conversationTimeline.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiEnUS.generated.conversationApprovals).map(([key, value]) => [
      `conversationApprovals.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiEnUS.generated.conversationPresentation).map(([key, value]) => [
      `conversationPresentation.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiEnUS.generated.imagePreviewDialogs).map(([key, value]) => [
      `imagePreviewDialogs.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiEnUS.generated.conversationImageService).map(([key, value]) => [
      `conversationImageService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiEnUS.generated.conversationDomain).map(([key, value]) => [
      `conversationDomain.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(workspaceInspectorEnUS.generated.workspaceInspector).map(([key, value]) => [
      `workspaceInspector.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(filePreviewEnUS.generated.gitDiffViewer).map(([key, value]) => [
      `gitDiffViewer.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(filePreviewEnUS.generated.standaloneFilePreviewPage).map(([key, value]) => [
      `standaloneFilePreviewPage.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(filePreviewEnUS.generated.filePreviewDialog).map(([key, value]) => [
      `filePreviewDialog.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(fileNavigationEnUS.generated.workspaceFileTree).map(([key, value]) => [
      `workspaceFileTree.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(fileNavigationEnUS.generated.quickOpenDialog).map(([key, value]) => [
      `quickOpenDialog.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(fileNavigationEnUS.generated.composerFileReferencePicker).map(([key, value]) => [
      `composerFileReferencePicker.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(composerEnUS.generated.composerAttachments).map(([key, value]) => [
      `composerAttachments.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerEnUS.generated.composerCommandPicker).map(([key, value]) => [
      `composerCommandPicker.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerEnUS.generated.composerQueue).map(([key, value]) => [
      `composerQueue.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerEnUS.generated.composerToolbar).map(([key, value]) => [
      `composerToolbar.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerEnUS.generated.conversationComposer).map(([key, value]) => [
      `conversationComposer.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(composerEnUS.generated.workbenchRunControlService).map(([key, value]) => [
      `workbenchRunControlService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerEnUS.generated.composerAttachmentService).map(([key, value]) => [
      `composerAttachmentService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerEnUS.generated.workbenchComposerController).map(([key, value]) => [
      `workbenchComposerController.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerEnUS.generated.runnerProfileService).map(([key, value]) => [
      `runnerProfileService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(terminalEnUS.generated.terminalTabView).map(([key, value]) => [
      `terminalTabView.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(terminalEnUS.generated.terminalDock).map(([key, value]) => [
      `terminalDock.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(terminalEnUS.generated.terminalRelayService).map(([key, value]) => [
      `terminalRelayService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationHistoryEnUS.generated.workbenchConversationPagingService).map(
      ([key, value]) => [`workbenchConversationPagingService.${key}`, value]
    )
  ),
  ...Object.fromEntries(
    Object.entries(conversationHistoryEnUS.generated.conversationHistory).map(([key, value]) => [
      `conversationHistory.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(sessionPresentationEnUS.generated.sessionPresentation).map(([key, value]) => [
      `sessionPresentation.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(systemInformationEnUS.generated.settingsContent).map(([key, value]) => [
      `settingsContent.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(authenticationEnUS.generated.adminAuthService).map(([key, value]) => [
      `adminAuthService.${key}`,
      value
    ])
  ),

  'workspaceUploadService.uploading': notificationsEnUS.generated.workspaceUploadService.uploading,
  'workspaceUploadService.queued': notificationsEnUS.generated.workspaceUploadService.queued,
  'workspaceUploadService.completed': notificationsEnUS.generated.workspaceUploadService.completed,
  'workspaceUploadService.canceled': notificationsEnUS.generated.workspaceUploadService.canceled,
  'workspaceUploadService.interrupted':
    notificationsEnUS.generated.workspaceUploadService.interrupted,
  'workspaceUploadService.failed': notificationsEnUS.generated.workspaceUploadService.failed,
  'workspaceUploadService.selectTheOriginalFileWithTheSame':
    notificationsEnUS.generated.workspaceUploadService.selectTheOriginalFileWithTheSame,
  'workspaceSessionService.unableToLoadMoreSessions':
    workspaceEnUS.generated.workspaceSessionService.unableToLoadMoreSessions,
  'workspaceSessionService.unableToSynchronizeSessions':
    workspaceEnUS.generated.workspaceSessionService.unableToSynchronizeSessions,

  'workbenchEntityService.leaveBlankToDisplayTheRegisteredAddress':
    workbenchCompositionEnUS.generated.workbenchEntityService
      .leaveBlankToDisplayTheRegisteredAddress,
  'workbenchEntityService.renameNode':
    workbenchCompositionEnUS.generated.workbenchEntityService.renameNode,
  'workbenchEntityService.nodeName':
    workbenchCompositionEnUS.generated.workbenchEntityService.nodeName,
  'workbenchEntityService.nodeNameCannotExceed80Characters':
    workbenchCompositionEnUS.generated.workbenchEntityService.nodeNameCannotExceed80Characters,
  'workbenchEntityService.save': workbenchCompositionEnUS.generated.workbenchEntityService.save,
  'workbenchEntityService.cancel': workbenchCompositionEnUS.generated.workbenchEntityService.cancel,
  'workbenchEntityService.unableToUpdateTheNodeName':
    workbenchCompositionEnUS.generated.workbenchEntityService.unableToUpdateTheNodeName,
  'workbenchEntityService.enterANonEmptySessionName':
    workbenchCompositionEnUS.generated.workbenchEntityService.enterANonEmptySessionName,
  'workbenchEntityService.renameSession':
    workbenchCompositionEnUS.generated.workbenchEntityService.renameSession,
  'workbenchEntityService.sessionName':
    workbenchCompositionEnUS.generated.workbenchEntityService.sessionName,
  'workbenchEntityService.sessionNameCannotBeEmpty':
    workbenchCompositionEnUS.generated.workbenchEntityService.sessionNameCannotBeEmpty,
  'workbenchEntityService.sessionNameCannotExceed160Characters':
    workbenchCompositionEnUS.generated.workbenchEntityService.sessionNameCannotExceed160Characters,
  'workbenchEntityService.save2': workbenchCompositionEnUS.generated.workbenchEntityService.save2,
  'workbenchEntityService.cancel2':
    workbenchCompositionEnUS.generated.workbenchEntityService.cancel2,
  'workbenchEntityService.unableToUpdateTheSessionName':
    workbenchCompositionEnUS.generated.workbenchEntityService.unableToUpdateTheSessionName,
  'workbenchEntityService.unableToTheSession':
    workbenchCompositionEnUS.generated.workbenchEntityService.unableToTheSession,
  'workbenchEntityService.unableToMoveThePinnedSession':
    workbenchCompositionEnUS.generated.workbenchEntityService.unableToMoveThePinnedSession,
  'workbenchEntityService.thisPermanentlyDeletesTheNativeSessionAnd':
    workbenchCompositionEnUS.generated.workbenchEntityService
      .thisPermanentlyDeletesTheNativeSessionAnd,
  'workbenchEntityService.deleteSession':
    workbenchCompositionEnUS.generated.workbenchEntityService.deleteSession,
  'workbenchEntityService.deleteSession2':
    workbenchCompositionEnUS.generated.workbenchEntityService.deleteSession2,
  'workbenchEntityService.cancel3':
    workbenchCompositionEnUS.generated.workbenchEntityService.cancel3,
  'workbenchEntityService.theNativeSessionWasDeleted':
    workbenchCompositionEnUS.generated.workbenchEntityService.theNativeSessionWasDeleted,
  'workbenchEntityService.unableToDeleteTheSession':
    workbenchCompositionEnUS.generated.workbenchEntityService.unableToDeleteTheSession,
  'workbenchEntityService.deletingDisconnectsItAndRemovesItsServer':
    workbenchCompositionEnUS.generated.workbenchEntityService
      .deletingDisconnectsItAndRemovesItsServer,
  'workbenchEntityService.deleteNode':
    workbenchCompositionEnUS.generated.workbenchEntityService.deleteNode,
  'workbenchEntityService.deleteNode2':
    workbenchCompositionEnUS.generated.workbenchEntityService.deleteNode2,
  'workbenchEntityService.cancel4':
    workbenchCompositionEnUS.generated.workbenchEntityService.cancel4,
  'workbenchEntityService.nodeDeletedCreateANewRegistrationToken':
    workbenchCompositionEnUS.generated.workbenchEntityService
      .nodeDeletedCreateANewRegistrationToken,
  'workbenchEntityService.unableToDeleteTheNode':
    workbenchCompositionEnUS.generated.workbenchEntityService.unableToDeleteTheNode,
  'workbenchPresentationStateService.contextWindow':
    workbenchCompositionEnUS.generated.workbenchPresentationStateService.contextWindow,
  'workbenchPresentationStateService.stopping':
    workbenchCompositionEnUS.generated.workbenchPresentationStateService.stopping,

  'workbenchSessionMessageService.enterAMessageWhenAttachingFiles':
    composerEnUS.generated.workbenchSessionMessageService.enterAMessageWhenAttachingFiles,
  'workbenchSessionMessageService.attachmentsAreStillUploadingOrFailedWait':
    composerEnUS.generated.workbenchSessionMessageService.attachmentsAreStillUploadingOrFailedWait,
  'workbenchSessionMessageService.sendARegularMessageToCreateThe':
    composerEnUS.generated.workbenchSessionMessageService.sendARegularMessageToCreateThe,
  'workbenchSessionMessageService.selectAWorkspaceBeforeSendingAMessage':
    composerEnUS.generated.workbenchSessionMessageService.selectAWorkspaceBeforeSendingAMessage,
  'workbenchSessionMessageService.unableToSendTheMessage':
    composerEnUS.generated.workbenchSessionMessageService.unableToSendTheMessage,

  'workbenchPageInteractionService.filePreviewIsCurrentlyUnavailable':
    workbenchCompositionEnUS.generated.workbenchPageInteractionService
      .filePreviewIsCurrentlyUnavailable,
  'workbenchPageInteractionService.copyFailedCheckTheBrowserClipboardPermission':
    workbenchCompositionEnUS.generated.workbenchPageInteractionService
      .copyFailedCheckTheBrowserClipboardPermission,
  'workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe':
    workspaceEnUS.generated.workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe,
  'workbenchWorkspaceSelectionService.unableToLoadNodeWorkspaces':
    workspaceEnUS.generated.workbenchWorkspaceSelectionService.unableToLoadNodeWorkspaces,
  'workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe2':
    workspaceEnUS.generated.workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe2,
  'workbenchWorkspaceSelectionService.unableToRefreshNodeWorkspaces':
    workspaceEnUS.generated.workbenchWorkspaceSelectionService.unableToRefreshNodeWorkspaces,
  'workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe3':
    workspaceEnUS.generated.workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe3,
  'workbenchWorkspaceSelectionService.unableToLoadTheNodeState':
    workspaceEnUS.generated.workbenchWorkspaceSelectionService.unableToLoadTheNodeState,
  'workbenchNewSessionController.foldersCannotBeAttachedCompressTheFolder':
    workbenchCompositionEnUS.generated.workbenchNewSessionController
      .foldersCannotBeAttachedCompressTheFolder,
  'workbenchPageController.noNodeSelected':
    workbenchPageEnUS.generated.workbenchPageController.noNodeSelected,
  'workbenchPageController.theNodeIsDisabledOnlyTheCurrent':
    workbenchPageEnUS.generated.workbenchPageController.theNodeIsDisabledOnlyTheCurrent,
  'workbenchPageController.theNodeIsOfflineLoadedContentIs':
    workbenchPageEnUS.generated.workbenchPageController.theNodeIsOfflineLoadedContentIs,
  'workbenchPageController.nodeWorkbenchCapabilitiesAreUnknownTheWorkspace':
    workbenchPageEnUS.generated.workbenchPageController
      .nodeWorkbenchCapabilitiesAreUnknownTheWorkspace,
  'workbenchPageController.nodeWorkbenchCapabilitiesAreUnavailable':
    workbenchPageEnUS.generated.workbenchPageController.nodeWorkbenchCapabilitiesAreUnavailable,
  'workbenchPageController.unableToOpenTheSessionLinkedTo':
    workbenchPageEnUS.generated.workbenchPageController.unableToOpenTheSessionLinkedTo,
  'workbenchPageController.aNewerInstanceWithTheSameIdentity':
    workbenchPageEnUS.generated.workbenchPageController.aNewerInstanceWithTheSameIdentity,
  'workbenchPageController.receivedAnUnreadableLiveUpdate':
    workbenchPageEnUS.generated.workbenchPageController.receivedAnUnreadableLiveUpdate,
  'workbenchPageController.unknown': workbenchPageEnUS.generated.workbenchPageController.unknown,
  'workbenchPageController.unableToCreateARegistrationToken':
    workbenchPageEnUS.generated.workbenchPageController.unableToCreateARegistrationToken,
  'workbenchPageController.createANewSessionBranchBeforeThis':
    workbenchPageEnUS.generated.workbenchPageController.createANewSessionBranchBeforeThis,
  'workbenchPageController.createANewSessionBranchThatRetains':
    workbenchPageEnUS.generated.workbenchPageController.createANewSessionBranchThatRetains,
  'workbenchPageController.createFallbackBranch':
    workbenchPageEnUS.generated.workbenchPageController.createFallbackBranch,
  'workbenchPageController.createBranch':
    workbenchPageEnUS.generated.workbenchPageController.createBranch,
  'workbenchPageController.cancel': workbenchPageEnUS.generated.workbenchPageController.cancel,
  'workbenchPageController.fallbackBranchCreated':
    workbenchPageEnUS.generated.workbenchPageController.fallbackBranchCreated,
  'workbenchPageController.unableToCreateAFallbackBranch':
    workbenchPageEnUS.generated.workbenchPageController.unableToCreateAFallbackBranch,
  'workbenchPageController.rollbackConversationWarning':
    workbenchPageEnUS.generated.workbenchPageController.rollbackConversationWarning,
  'workbenchPageController.rollbackConversation':
    workbenchPageEnUS.generated.workbenchPageController.rollbackConversation,
  'workbenchPageController.confirmRollbackConversation':
    workbenchPageEnUS.generated.workbenchPageController.confirmRollbackConversation,
  'workbenchPageController.unableToRollbackConversation':
    workbenchPageEnUS.generated.workbenchPageController.unableToRollbackConversation,
  'workspaceQueueService.theQueueOrderChangedTryAgain':
    composerEnUS.generated.workspaceQueueService.theQueueOrderChangedTryAgain,
  'workspaceQueueService.unableToEditTheQueuedMessage':
    composerEnUS.generated.workspaceQueueService.unableToEditTheQueuedMessage,
  'workspaceQueueService.unableToDeleteTheQueuedMessage':
    composerEnUS.generated.workspaceQueueService.unableToDeleteTheQueuedMessage,
  'workspaceQueueService.unableToRunTheQueuedMessageNow':
    composerEnUS.generated.workspaceQueueService.unableToRunTheQueuedMessageNow,
  'conversationUserInputService.answerEveryQuestionBeforeSubmitting':
    composerEnUS.generated.conversationUserInputService.answerEveryQuestionBeforeSubmitting,
  'conversationUserInputService.answersWereNotSubmitted':
    composerEnUS.generated.conversationUserInputService.answersWereNotSubmitted,
  'workbenchSessionSelectionService.unableToLoadConversationHistory':
    workspaceEnUS.generated.workbenchSessionSelectionService.unableToLoadConversationHistory,
  'runnerUsageService.usageCapabilityDetectionFailedCloseAndReopen':
    workbenchCompositionEnUS.generated.runnerUsageService
      .usageCapabilityDetectionFailedCloseAndReopen,
  'runnerUsageService.detectingUsageCapability':
    workbenchCompositionEnUS.generated.runnerUsageService.detectingUsageCapability,
  'runnerUsageService.usageQueriesRequireAnOfficialOAuthAccount':
    workbenchCompositionEnUS.generated.runnerUsageService.usageQueriesRequireAnOfficialOAuthAccount,
  'runnerUsageService.thisRunnerIsUnavailableSoUsageCannot':
    workbenchCompositionEnUS.generated.runnerUsageService.thisRunnerIsUnavailableSoUsageCannot,
  'runnerUsageService.thisRunnerDoesNotCurrentlySupportUsage':
    workbenchCompositionEnUS.generated.runnerUsageService.thisRunnerDoesNotCurrentlySupportUsage,
  'runnerUsageService.unableToQueryUsage':
    workbenchCompositionEnUS.generated.runnerUsageService.unableToQueryUsage,
  'runnerUsageService.notProvided':
    workbenchCompositionEnUS.generated.runnerUsageService.notProvided,
  'workbenchCapabilityService.unableToLoadNodes':
    workbenchCompositionEnUS.generated.workbenchCapabilityService.unableToLoadNodes,
  'workbenchCapabilityService.unknown':
    workbenchCompositionEnUS.generated.workbenchCapabilityService.unknown,
  'workbenchCapabilityService.unknown2':
    workbenchCompositionEnUS.generated.workbenchCapabilityService.unknown2,
  'environmentSecretService.enterAnEnvironmentVariableName':
    environmentSecretsEnUS.generated.environmentSecretService.enterAnEnvironmentVariableName,
  'environmentSecretService.theEnvironmentVariableNameCannotExceed128':
    environmentSecretsEnUS.generated.environmentSecretService
      .theEnvironmentVariableNameCannotExceed128,
  'environmentSecretService.theEnvironmentVariableNameMustStartWith':
    environmentSecretsEnUS.generated.environmentSecretService
      .theEnvironmentVariableNameMustStartWith,
  'environmentSecretService.theEnvironmentVariableNameCanContainOnly':
    environmentSecretsEnUS.generated.environmentSecretService
      .theEnvironmentVariableNameCanContainOnly,
  'environmentSecretService.enterASecretValue':
    environmentSecretsEnUS.generated.environmentSecretService.enterASecretValue,
  'environmentSecretService.theSecretValueCannotContainNullCharacters':
    environmentSecretsEnUS.generated.environmentSecretService
      .theSecretValueCannotContainNullCharacters,
  'environmentSecretService.theSecretValueCannotExceed16KiB':
    environmentSecretsEnUS.generated.environmentSecretService.theSecretValueCannotExceed16KiB,
  'enterpriseManagementService.systemAdministrator': 'System Administrator',
  'enterpriseManagementService.organizationAdministrator': 'Organization Administrator',
  'enterpriseManagementService.member': 'Member',
  'workbenchPlanService.unableToImplementThePlan':
    composerEnUS.generated.workbenchPlanService.unableToImplementThePlan,
  'workbenchContextCommandService.compactOlderContextToFreeWindowSpace':
    composerEnUS.generated.workbenchContextCommandService.compactOlderContextToFreeWindowSpace,
  'workbenchContextCommandService.compactContext':
    composerEnUS.generated.workbenchContextCommandService.compactContext,
  'workbenchContextCommandService.compact':
    composerEnUS.generated.workbenchContextCommandService.compact,
  'workbenchContextCommandService.cancel':
    composerEnUS.generated.workbenchContextCommandService.cancel,
  'workbenchContextCommandService.unableToCompactContext':
    composerEnUS.generated.workbenchContextCommandService.unableToCompactContext,
  'mcpCenterPanel.thisAccountHasNoManageableNodes':
    skillConfigurationEnUS.generated.mcpCenterPanel.thisAccountHasNoManageableNodes,
  'mcpCenterPanel.selectANode': skillConfigurationEnUS.generated.mcpCenterPanel.selectANode,
  'mcpCenterPanel.theSelectedNodeIsUnavailableSelectAnother':
    skillConfigurationEnUS.generated.mcpCenterPanel.theSelectedNodeIsUnavailableSelectAnother,
  'mcpCenterPanel.theSelectedNodeIsDisabledAndCannot':
    skillConfigurationEnUS.generated.mcpCenterPanel.theSelectedNodeIsDisabledAndCannot,
  'mcpCenterPanel.theSelectedNodeIsOfflineMCPCan':
    skillConfigurationEnUS.generated.mcpCenterPanel.theSelectedNodeIsOfflineMCPCan,
  'mcpCenterPanel.nodeVersionDoesNotSupportMCPUpgrade':
    'Node version {value0} does not support MCP. Upgrade the node first.',
  'mcpCenterPanel.theSelectedNodeHasNoManageableWorkspaces':
    skillConfigurationEnUS.generated.mcpCenterPanel.theSelectedNodeHasNoManageableWorkspaces,
  'mcpCenterPanel.selectAWorkspace':
    skillConfigurationEnUS.generated.mcpCenterPanel.selectAWorkspace,
  'mcpCenterPanel.thisMCPServerWasRemovedFromThe':
    skillConfigurationEnUS.generated.mcpCenterPanel.thisMCPServerWasRemovedFromThe,
  'mcpCenterPanel.enterprise': 'Enterprise',
  'mcpCenterPanel.organization': 'Organization',
  'mcpCenterPanel.personal': skillConfigurationEnUS.generated.mcpCenterPanel.personal,
  'mcpCenterPanel.upToDate': skillConfigurationEnUS.generated.mcpCenterPanel.upToDate,
  'mcpCenterPanel.updateAvailable': skillConfigurationEnUS.generated.mcpCenterPanel.updateAvailable,
  'mcpCenterPanel.invalidConfiguration':
    skillConfigurationEnUS.generated.mcpCenterPanel.invalidConfiguration,
  'mcpCenterPanel.catalogEntryUnavailable':
    skillConfigurationEnUS.generated.mcpCenterPanel.catalogEntryUnavailable,
  'mcpCenterPanel.updateAvailable2':
    skillConfigurationEnUS.generated.mcpCenterPanel.updateAvailable2,
  'mcpCenterPanel.mCPInstallationWasValidatedOnTheNode':
    skillConfigurationEnUS.generated.mcpCenterPanel.mCPInstallationWasValidatedOnTheNode,
  'mcpCenterPanel.mCPServerDisabled':
    skillConfigurationEnUS.generated.mcpCenterPanel.mCPServerDisabled,
  'mcpCenterPanel.removeFromTheCurrentTarget':
    skillConfigurationEnUS.generated.mcpCenterPanel.removeFromTheCurrentTarget,
  'mcpCenterPanel.removeMCPServer': skillConfigurationEnUS.generated.mcpCenterPanel.removeMCPServer,
  'mcpCenterPanel.remove': skillConfigurationEnUS.generated.mcpCenterPanel.remove,
  'mcpCenterPanel.cancel': skillConfigurationEnUS.generated.mcpCenterPanel.cancel,
  'mcpCenterPanel.mCPServerRemoved':
    skillConfigurationEnUS.generated.mcpCenterPanel.mCPServerRemoved,
  'mcpCenterPanel.theNodeIsOfflineTryAgainAfter':
    skillConfigurationEnUS.generated.mcpCenterPanel.theNodeIsOfflineTryAgainAfter,
  'mcpCenterPanel.thisNodeVersionDoesNotSupportMCP':
    skillConfigurationEnUS.generated.mcpCenterPanel.thisNodeVersionDoesNotSupportMCP,
  'mcpCenterPanel.mCPManagementIsNotEnabledOnThis':
    skillConfigurationEnUS.generated.mcpCenterPanel.mCPManagementIsNotEnabledOnThis,
  'mcpCenterPanel.theWorkspaceNoLongerExistsSelectAnother':
    skillConfigurationEnUS.generated.mcpCenterPanel.theWorkspaceNoLongerExistsSelectAnother,
  'mcpCenterPanel.mCPInstallationValidationTimedOutCheckNode':
    skillConfigurationEnUS.generated.mcpCenterPanel.mCPInstallationValidationTimedOutCheckNode,
  'mcpCenterPanel.aSecretReferencedByMCPIsMissing':
    skillConfigurationEnUS.generated.mcpCenterPanel.aSecretReferencedByMCPIsMissing,
  'mcpCenterPanel.mCPAuthenticationFailedCheckTheReferencedSecrets':
    skillConfigurationEnUS.generated.mcpCenterPanel
      .mCPAuthenticationFailedCheckTheReferencedSecrets,
  'mcpCenterPanel.theNodeCouldNotStartTheMCP':
    skillConfigurationEnUS.generated.mcpCenterPanel.theNodeCouldNotStartTheMCP,
  'mcpCenterPanel.theNodeCouldNotConnectToThe':
    skillConfigurationEnUS.generated.mcpCenterPanel.theNodeCouldNotConnectToThe,
  'mcpCenterPanel.mCPProtocolValidationFailedAfterStartupCheck':
    skillConfigurationEnUS.generated.mcpCenterPanel.mCPProtocolValidationFailedAfterStartupCheck,
  'mcpCenterPanel.mCPConnectedButExposedNoToolsCheck':
    skillConfigurationEnUS.generated.mcpCenterPanel.mCPConnectedButExposedNoToolsCheck,
  'mcpCenterPanel.youDoNotHavePermissionToManage':
    skillConfigurationEnUS.generated.mcpCenterPanel.youDoNotHavePermissionToManage,
  'mcpCenterPanel.theMCPOperationDidNotCompleteTry':
    'The MCP operation did not complete. Try again later.',
  'mcpCenterPanel.mCPConfigurationTarget':
    skillConfigurationEnUS.generated.mcpCenterPanel.mCPConfigurationTarget,
  'mcpCenterPanel.configurationTarget':
    skillConfigurationEnUS.generated.mcpCenterPanel.configurationTarget,
  'mcpCenterPanel.selectWhereTheMCPServerWillBe':
    skillConfigurationEnUS.generated.mcpCenterPanel.selectWhereTheMCPServerWillBe,
  'mcpCenterPanel.node': skillConfigurationEnUS.generated.mcpCenterPanel.node,
  'mcpCenterPanel.workspace': skillConfigurationEnUS.generated.mcpCenterPanel.workspace,
  'mcpCenterPanel.selectANode2': skillConfigurationEnUS.generated.mcpCenterPanel.selectANode2,
  'mcpCenterPanel.disabled': skillConfigurationEnUS.generated.mcpCenterPanel.disabled,
  'mcpCenterPanel.online': skillConfigurationEnUS.generated.mcpCenterPanel.online,
  'mcpCenterPanel.offline': skillConfigurationEnUS.generated.mcpCenterPanel.offline,
  'mcpCenterPanel.selectAWorkspace2':
    skillConfigurationEnUS.generated.mcpCenterPanel.selectAWorkspace2,
  'mcpCenterPanel.availableMCPServers':
    skillConfigurationEnUS.generated.mcpCenterPanel.availableMCPServers,
  'mcpCenterPanel.installedMCPServers':
    skillConfigurationEnUS.generated.mcpCenterPanel.installedMCPServers,
  'mcpCenterPanel.searchMCPServers':
    skillConfigurationEnUS.generated.mcpCenterPanel.searchMCPServers,
  'mcpCenterPanel.mCPCategories': skillConfigurationEnUS.generated.mcpCenterPanel.mCPCategories,
  'mcpCenterPanel.all': skillConfigurationEnUS.generated.mcpCenterPanel.all,
  'mcpCenterPanel.updateAvailable3':
    skillConfigurationEnUS.generated.mcpCenterPanel.updateAvailable3,
  'mcpCenterPanel.noDescriptionIsAvailableForThisMCP':
    skillConfigurationEnUS.generated.mcpCenterPanel.noDescriptionIsAvailableForThisMCP,
  'mcpCenterPanel.featured': skillConfigurationEnUS.generated.mcpCenterPanel.featured,
  'mcpCenterPanel.inheritedFromNode':
    skillConfigurationEnUS.generated.mcpCenterPanel.inheritedFromNode,
  'mcpCenterPanel.downloadingAndValidatingMCPOnTheNode':
    skillConfigurationEnUS.generated.mcpCenterPanel.downloadingAndValidatingMCPOnTheNode,
  'mcpCenterPanel.details2': 'Details',
  'mcpCenterPanel.disable': skillConfigurationEnUS.generated.mcpCenterPanel.disable,
  'mcpCenterPanel.enable': skillConfigurationEnUS.generated.mcpCenterPanel.enable,
  'mcpCenterPanel.update': skillConfigurationEnUS.generated.mcpCenterPanel.update,
  'mcpCenterPanel.reinstall': skillConfigurationEnUS.generated.mcpCenterPanel.reinstall,
  'mcpCenterPanel.delete': skillConfigurationEnUS.generated.mcpCenterPanel.delete,
  'mcpCenterPanel.details3': 'Details',
  'mcpCenterPanel.update2': skillConfigurationEnUS.generated.mcpCenterPanel.update2,
  'mcpCenterPanel.reinstall2': skillConfigurationEnUS.generated.mcpCenterPanel.reinstall2,
  'mcpCenterPanel.install': skillConfigurationEnUS.generated.mcpCenterPanel.install,
  'mcpCenterPanel.thisTargetHasNoInstalledMCPServers':
    skillConfigurationEnUS.generated.mcpCenterPanel.thisTargetHasNoInstalledMCPServers,
  'mcpCenterPanel.noMCPServersAreAvailableAddOne':
    skillConfigurationEnUS.generated.mcpCenterPanel.noMCPServersAreAvailableAddOne,
  'workbenchNotificationService.fileUploadFailed':
    notificationsEnUS.generated.workbenchNotificationService.fileUploadFailed,
  'workbenchNotificationService.fileUploadCompleted':
    notificationsEnUS.generated.workbenchNotificationService.fileUploadCompleted,
  'workbenchNotificationService.uploadingFile':
    notificationsEnUS.generated.workbenchNotificationService.uploadingFile,
  'workbenchNotificationService.runCompleted':
    notificationsEnUS.generated.workbenchNotificationService.runCompleted,
  'workbenchNotificationService.runFailed':
    notificationsEnUS.generated.workbenchNotificationService.runFailed,
  'workbenchNotificationService.runCancelled':
    notificationsEnUS.generated.workbenchNotificationService.runCancelled,
  'workbenchNotificationService.runInterrupted':
    notificationsEnUS.generated.workbenchNotificationService.runInterrupted,
  'workbenchNotificationService.clickToOpenTheRelatedSession':
    notificationsEnUS.generated.workbenchNotificationService.clickToOpenTheRelatedSession,
  'workbenchNotificationService.approvalRequired':
    notificationsEnUS.generated.workbenchNotificationService.approvalRequired,
  'workbenchNotificationService.theAgentIsWaitingForYourConfirmation':
    notificationsEnUS.generated.workbenchNotificationService.theAgentIsWaitingForYourConfirmation,
  'workbenchNotificationService.planReadyToImplement':
    notificationsEnUS.generated.workbenchNotificationService.planReadyToImplement,
  'workbenchNotificationService.openTheSessionToViewTheImplementation':
    notificationsEnUS.generated.workbenchNotificationService.openTheSessionToViewTheImplementation,
  'workbenchNotificationService.yourAnswerIsRequired':
    notificationsEnUS.generated.workbenchNotificationService.yourAnswerIsRequired,
  'workbenchNotificationService.theAgentIsWaitingForYourAnswer':
    notificationsEnUS.generated.workbenchNotificationService.theAgentIsWaitingForYourAnswer,
  'workbenchNotificationService.session':
    notificationsEnUS.generated.workbenchNotificationService.session,
  'workbenchSelectionStateService.unknown':
    workbenchPageEnUS.generated.workbenchSelectionStateService.unknown,

  'workbenchWorkspaceTreeController.thisWorkspaceIsNoLongerInThe':
    workspaceEnUS.generated.workbenchWorkspaceTreeController.thisWorkspaceIsNoLongerInThe,
  'workbenchWorkspaceTreeController.unableToLoadNodeWorkspaces':
    workspaceEnUS.generated.workbenchWorkspaceTreeController.unableToLoadNodeWorkspaces,
  'workbenchWorkspaceTreeController.unregisterThisDoesNotDeleteTheLocal':
    workspaceEnUS.generated.workbenchWorkspaceTreeController.unregisterThisDoesNotDeleteTheLocal,
  'workbenchWorkspaceTreeController.unregisterWorkspace':
    workspaceEnUS.generated.workbenchWorkspaceTreeController.unregisterWorkspace,
  'workbenchWorkspaceTreeController.unregister':
    workspaceEnUS.generated.workbenchWorkspaceTreeController.unregister,
  'workbenchWorkspaceTreeController.cancel':
    workspaceEnUS.generated.workbenchWorkspaceTreeController.cancel,
  'workbenchWorkspaceTreeController.cleanupOldSessions': 'Clean up sessions',
  'workbenchWorkspaceTreeController.cleanupOldSessionsDescription':
    'Enter how many days of inactive sessions to clean up. Matching native sessions are permanently deleted; pinned, active, queued, or viewed sessions are kept.',
  'workbenchWorkspaceTreeController.inactiveDaysMustBeBetween':
    'Enter a whole number of days from 1 to 365.',
  'workbenchWorkspaceTreeController.cleanup': 'Clean up sessions',
  'workbenchWorkspaceTreeController.oldSessionsCleanupCompleted':
    'Old session cleanup completed: {value0} deleted ({value3}), {value1} skipped, {value2} failed.',
  'workbenchWorkspaceTreeController.cleanupByRunner': 'by Agent: {value0}',
  'workbenchWorkspaceTreeController.noSessionsDeleted': 'no Agent sessions deleted',
  'workbenchWorkspaceTreeController.unableToCleanUpOldSessions':
    'Unable to clean up sessions: {value0}',
  'workbenchWorkspaceTreeController.theWorkspaceWasUnregisteredItsLocalDirectory':
    workspaceEnUS.generated.workbenchWorkspaceTreeController
      .theWorkspaceWasUnregisteredItsLocalDirectory,
  'workbenchWorkspaceTreeController.unableToUnregisterTheWorkspace':
    workspaceEnUS.generated.workbenchWorkspaceTreeController.unableToUnregisterTheWorkspace,

  'workbenchApprovalService.approvalWasNotSubmitted':
    composerEnUS.generated.workbenchApprovalService.approvalWasNotSubmitted,

  'workspaceRegistrationService.unableToLoadAvailableDirectories':
    workspaceEnUS.generated.workspaceRegistrationService.unableToLoadAvailableDirectories,
  'workspaceRegistrationService.aDirectoryWithThisNameAlreadyExists':
    workspaceEnUS.generated.workspaceRegistrationService.aDirectoryWithThisNameAlreadyExists,
  'workspaceRegistrationService.theDirectoryNameIsInvalidEnterA':
    workspaceEnUS.generated.workspaceRegistrationService.theDirectoryNameIsInvalidEnterA,
  'workspaceRegistrationService.theSelectedDirectoryIsOutsideTheWorkspace':
    workspaceEnUS.generated.workspaceRegistrationService.theSelectedDirectoryIsOutsideTheWorkspace,
  'workspaceRegistrationService.unableToRegisterTheWorkspace':
    workspaceEnUS.generated.workspaceRegistrationService.unableToRegisterTheWorkspace,
  'skillDetailsDialog.skillDetails':
    skillConfigurationEnUS.generated.skillDetailsDialog.skillDetails,
  'skillDetailsDialog.noDescriptionIsAvailableForThisSkill':
    skillConfigurationEnUS.generated.skillDetailsDialog.noDescriptionIsAvailableForThisSkill,
  'skillDetailsDialog.source': skillConfigurationEnUS.generated.skillDetailsDialog.source,
  'skillDetailsDialog.availability':
    skillConfigurationEnUS.generated.skillDetailsDialog.availability,
  'skillDetailsDialog.skillPath': skillConfigurationEnUS.generated.skillDetailsDialog.skillPath,
  'skillDetailsDialog.version': skillConfigurationEnUS.generated.skillDetailsDialog.version,
  'skillDetailsDialog.updated': skillConfigurationEnUS.generated.skillDetailsDialog.updated,
  'skillDetailsDialog.status': skillConfigurationEnUS.generated.skillDetailsDialog.status,
  'skillDetailsDialog.installs': skillConfigurationEnUS.generated.skillDetailsDialog.installs,
  'skillDetailsDialog.tags': skillConfigurationEnUS.generated.skillDetailsDialog.tags,
  'skillDetailsDialog.featured': skillConfigurationEnUS.generated.skillDetailsDialog.featured,
  'skillDetailsDialog.close': skillConfigurationEnUS.generated.skillDetailsDialog.close,
  'workbenchRunnerChannelService.theMessageWasAddedToTheCurrent':
    composerEnUS.generated.workbenchRunnerChannelService.theMessageWasAddedToTheCurrent,
  'workbenchRunnerChannelService.theMessageWasNotDeliveredToThe':
    composerEnUS.generated.workbenchRunnerChannelService.theMessageWasNotDeliveredToThe,
  'workbenchRunnerChannelService.unableToSendThroughTheClaudeChannel':
    composerEnUS.generated.workbenchRunnerChannelService.unableToSendThroughTheClaudeChannel,

  'skillCenterPage.theSkillOperationDidNotCompleteTry':
    skillConfigurationEnUS.generated.skillCenterPage.theSkillOperationDidNotCompleteTry,
  'skillCenterPage.compatibleLink': skillConfigurationEnUS.generated.skillCenterPage.compatibleLink,
  'skillCenterPage.directoryJunction':
    skillConfigurationEnUS.generated.skillCenterPage.directoryJunction,
  'skillCenterPage.managedCopy': skillConfigurationEnUS.generated.skillCenterPage.managedCopy,
  'skillCenterPage.unavailable': skillConfigurationEnUS.generated.skillCenterPage.unavailable,
  'skillCenterPage.environmentModeSkillsFoundRequireAttention':
    skillConfigurationEnUS.generated.skillCenterPage.environmentModeSkillsFoundRequireAttention,
  'skillCenterPage.environmentCheckFoundIssues':
    skillConfigurationEnUS.generated.skillCenterPage.environmentCheckFoundIssues,
  'skillCenterPage.environmentCheckPassed':
    skillConfigurationEnUS.generated.skillCenterPage.environmentCheckPassed,
  'skillCenterPage.oK': skillConfigurationEnUS.generated.skillCenterPage.oK,
  'skillCenterPage.theEnvironmentCheckDidNotCompleteTry':
    skillConfigurationEnUS.generated.skillCenterPage.theEnvironmentCheckDidNotCompleteTry,
  'skillCenterPage.installing': skillConfigurationEnUS.generated.skillCenterPage.installing,
  'skillCenterPage.install': skillConfigurationEnUS.generated.skillCenterPage.install,
  'skillCenterPage.reinstall': skillConfigurationEnUS.generated.skillCenterPage.reinstall,
  'skillCenterPage.update': skillConfigurationEnUS.generated.skillCenterPage.update,
  'skillCenterPage.reinstallingWillOverwriteExistingFilesForManual':
    skillConfigurationEnUS.generated.skillCenterPage
      .reinstallingWillOverwriteExistingFilesForManual,
  'skillCenterPage.overwriteSkill': skillConfigurationEnUS.generated.skillCenterPage.overwriteSkill,
  'skillCenterPage.continue': skillConfigurationEnUS.generated.skillCenterPage.continue,
  'skillCenterPage.cancel': skillConfigurationEnUS.generated.skillCenterPage.cancel,
  'skillCenterPage.skillUpdated': skillConfigurationEnUS.generated.skillCenterPage.skillUpdated,
  'skillCenterPage.skillInstalled': skillConfigurationEnUS.generated.skillCenterPage.skillInstalled,
  'skillCenterPage.theTargetContainsGitTrackedFilesOverwritten':
    skillConfigurationEnUS.generated.skillCenterPage.theTargetContainsGitTrackedFilesOverwritten,
  'skillCenterPage.overwriteTrackedFiles':
    skillConfigurationEnUS.generated.skillCenterPage.overwriteTrackedFiles,
  'skillCenterPage.overwriteFiles': skillConfigurationEnUS.generated.skillCenterPage.overwriteFiles,
  'skillCenterPage.cancel2': skillConfigurationEnUS.generated.skillCenterPage.cancel2,
  'skillCenterPage.skillInstalled2':
    skillConfigurationEnUS.generated.skillCenterPage.skillInstalled2,
  'skillCenterPage.skillInstallationDidNotCompleteTryAgain':
    skillConfigurationEnUS.generated.skillCenterPage.skillInstallationDidNotCompleteTryAgain,
  'skillCenterPage.skillInstallationDidNotCompleteTryAgain2':
    skillConfigurationEnUS.generated.skillCenterPage.skillInstallationDidNotCompleteTryAgain2,
  'skillCenterPage.unknownVersion': skillConfigurationEnUS.generated.skillCenterPage.unknownVersion,
  'skillCenterPage.incompleteInstallation':
    skillConfigurationEnUS.generated.skillCenterPage.incompleteInstallation,
  'skillCenterPage.gitRulesNeedRepair':
    skillConfigurationEnUS.generated.skillCenterPage.gitRulesNeedRepair,
  'skillCenterPage.directoryError': skillConfigurationEnUS.generated.skillCenterPage.directoryError,
  'skillCenterPage.unknownVersion2':
    skillConfigurationEnUS.generated.skillCenterPage.unknownVersion2,
  'skillCenterPage.upToDate': skillConfigurationEnUS.generated.skillCenterPage.upToDate,
  'skillCenterPage.updateAvailable':
    skillConfigurationEnUS.generated.skillCenterPage.updateAvailable,
  'skillCenterPage.deleteFromTheCurrentTargetTheSystem':
    skillConfigurationEnUS.generated.skillCenterPage.deleteFromTheCurrentTargetTheSystem,
  'skillCenterPage.deleteSkill': skillConfigurationEnUS.generated.skillCenterPage.deleteSkill,
  'skillCenterPage.deleteDirectory':
    skillConfigurationEnUS.generated.skillCenterPage.deleteDirectory,
  'skillCenterPage.cancel3': skillConfigurationEnUS.generated.skillCenterPage.cancel3,
  'skillCenterPage.unableToConfirmDeletionTryAgainLater':
    skillConfigurationEnUS.generated.skillCenterPage.unableToConfirmDeletionTryAgainLater,
  'skillCenterPage.skillDeleted': skillConfigurationEnUS.generated.skillCenterPage.skillDeleted,
  'skillCenterPage.repairingTheEnvironmentUpdatesTheWorkspaceS':
    skillConfigurationEnUS.generated.skillCenterPage.repairingTheEnvironmentUpdatesTheWorkspaceS,
  'skillCenterPage.repairSkillEnvironment':
    skillConfigurationEnUS.generated.skillCenterPage.repairSkillEnvironment,
  'skillCenterPage.repair': skillConfigurationEnUS.generated.skillCenterPage.repair,
  'skillCenterPage.cancel4': skillConfigurationEnUS.generated.skillCenterPage.cancel4,
  'skillCenterPage.unableToConfirmRepairTryAgainLater':
    skillConfigurationEnUS.generated.skillCenterPage.unableToConfirmRepairTryAgainLater,
  'skillCenterPage.localGitExcludeRulesRepaired':
    skillConfigurationEnUS.generated.skillCenterPage.localGitExcludeRulesRepaired,
  'skillCenterPage.theSkillOperationDidNotCompleteTry2':
    skillConfigurationEnUS.generated.skillCenterPage.theSkillOperationDidNotCompleteTry2,
  'skillCenterPage.enterprise': 'Enterprise',
  'skillCenterPage.organization': 'Organization',
  'skillCenterPage.personal': skillConfigurationEnUS.generated.skillCenterPage.personal,
  'skillCenterPage.skillConfiguration':
    skillConfigurationEnUS.generated.skillCenterPage.skillConfiguration,
  'skillCenterPage.skillConfiguration2':
    skillConfigurationEnUS.generated.skillCenterPage.skillConfiguration2,
  'skillCenterPage.installAndMaintainSkillsForNodesOr':
    skillConfigurationEnUS.generated.skillCenterPage.installAndMaintainSkillsForNodesOr,
  'skillCenterPage.skillConfigurationTarget':
    skillConfigurationEnUS.generated.skillCenterPage.skillConfigurationTarget,
  'skillCenterPage.configurationTarget':
    skillConfigurationEnUS.generated.skillCenterPage.configurationTarget,
  'skillCenterPage.selectWhereTheSkillWillBeUsed':
    skillConfigurationEnUS.generated.skillCenterPage.selectWhereTheSkillWillBeUsed,
  'skillCenterPage.node': skillConfigurationEnUS.generated.skillCenterPage.node,
  'skillCenterPage.workspace': skillConfigurationEnUS.generated.skillCenterPage.workspace,
  'skillCenterPage.selectANode': skillConfigurationEnUS.generated.skillCenterPage.selectANode,
  'skillCenterPage.skillNode': skillConfigurationEnUS.generated.skillCenterPage.skillNode,
  'skillCenterPage.disabled': skillConfigurationEnUS.generated.skillCenterPage.disabled,
  'skillCenterPage.online': skillConfigurationEnUS.generated.skillCenterPage.online,
  'skillCenterPage.offline': skillConfigurationEnUS.generated.skillCenterPage.offline,
  'skillCenterPage.selectAWorkspace':
    skillConfigurationEnUS.generated.skillCenterPage.selectAWorkspace,
  'skillCenterPage.skillWorkspace': skillConfigurationEnUS.generated.skillCenterPage.skillWorkspace,
  'skillCenterPage.checkEnvironment':
    skillConfigurationEnUS.generated.skillCenterPage.checkEnvironment,
  'skillCenterPage.repairEnvironment':
    skillConfigurationEnUS.generated.skillCenterPage.repairEnvironment,
  'skillCenterPage.noManageableNodesAreAvailableForSkill':
    skillConfigurationEnUS.generated.skillCenterPage.noManageableNodesAreAvailableForSkill,
  'skillCenterPage.theCurrentNodeDoesNotSupportThis':
    skillConfigurationEnUS.generated.skillCenterPage.theCurrentNodeDoesNotSupportThis,
  'skillCenterPage.availableSkills':
    skillConfigurationEnUS.generated.skillCenterPage.availableSkills,
  'skillCenterPage.searchSkillNamesOrDescriptions2':
    skillConfigurationEnUS.generated.skillCenterPage.searchSkillNamesOrDescriptions2,
  'skillCenterPage.showAll': 'Show all',
  'skillCenterPage.skillCategories2':
    skillConfigurationEnUS.generated.skillCenterPage.skillCategories2,
  'skillCenterPage.all2': skillConfigurationEnUS.generated.skillCenterPage.all2,
  'skillCenterPage.noDescriptionIsAvailableForThisSkill2':
    skillConfigurationEnUS.generated.skillCenterPage.noDescriptionIsAvailableForThisSkill2,
  'skillCenterPage.featured2': skillConfigurationEnUS.generated.skillCenterPage.featured2,
  'skillCenterPage.installingAndValidatingTheSkillOnThe':
    skillConfigurationEnUS.generated.skillCenterPage.installingAndValidatingTheSkillOnThe,
  'skillCenterPage.details2': 'Details',
  'skillCenterPage.noSkillsAreAvailableAddSkillsFrom2':
    skillConfigurationEnUS.generated.skillCenterPage.noSkillsAreAvailableAddSkillsFrom2,
  'skillCenterPage.noMatchingSkills2':
    skillConfigurationEnUS.generated.skillCenterPage.noMatchingSkills2,
  'skillCenterPage.installedSkills':
    skillConfigurationEnUS.generated.skillCenterPage.installedSkills,
  'skillCenterPage.noValidSkillDescriptionWasFound':
    skillConfigurationEnUS.generated.skillCenterPage.noValidSkillDescriptionWasFound,
  'skillCenterPage.installingAndValidatingTheSkillOnThe2':
    skillConfigurationEnUS.generated.skillCenterPage.installingAndValidatingTheSkillOnThe2,
  'skillCenterPage.details3': 'Details',
  'skillCenterPage.update2': skillConfigurationEnUS.generated.skillCenterPage.update2,
  'skillCenterPage.reinstall2': skillConfigurationEnUS.generated.skillCenterPage.reinstall2,
  'skillCenterPage.delete': skillConfigurationEnUS.generated.skillCenterPage.delete,
  'skillCenterPage.thisTargetHasNoInstalledSkills':
    skillConfigurationEnUS.generated.skillCenterPage.thisTargetHasNoInstalledSkills,
  'skillSourceManagementPage.enterASourceName':
    catalogSourcesEnUS.generated.skillSourceManagementPage.enterASourceName,
  'skillSourceManagementPage.enterARepositoryURL':
    catalogSourcesEnUS.generated.skillSourceManagementPage.enterARepositoryURL,
  'skillSourceManagementPage.enterAnHTTPSOrGitSSHRepository':
    catalogSourcesEnUS.generated.skillSourceManagementPage.enterAnHTTPSOrGitSSHRepository,
  'skillSourceManagementPage.selectAnOrganization': 'Select an organization',
  'skillSourceManagementPage.eachTagMustContain132Characters':
    catalogSourcesEnUS.generated.skillSourceManagementPage.eachTagMustContain132Characters,
  'skillSourceManagementPage.duplicateTagsAreNotAllowed':
    catalogSourcesEnUS.generated.skillSourceManagementPage.duplicateTagsAreNotAllowed,
  'skillSourceManagementPage.theSkillSourceOperationDidNotComplete':
    catalogSourcesEnUS.generated.skillSourceManagementPage.theSkillSourceOperationDidNotComplete,
  'skillSourceManagementPage.skillSourceAdded':
    catalogSourcesEnUS.generated.skillSourceManagementPage.skillSourceAdded,
  'skillSourceManagementPage.skillInformationUpdated':
    catalogSourcesEnUS.generated.skillSourceManagementPage.skillInformationUpdated,
  'skillSourceManagementPage.skillAddedToTheCatalog':
    catalogSourcesEnUS.generated.skillSourceManagementPage.skillAddedToTheCatalog,
  'skillSourceManagementPage.updateAvailable':
    catalogSourcesEnUS.generated.skillSourceManagementPage.updateAvailable,
  'skillSourceManagementPage.alreadyUpToDate':
    catalogSourcesEnUS.generated.skillSourceManagementPage.alreadyUpToDate,
  'skillSourceManagementPage.catalogSkillUpdated':
    catalogSourcesEnUS.generated.skillSourceManagementPage.catalogSkillUpdated,
  'skillSourceManagementPage.deleteSkillSource':
    catalogSourcesEnUS.generated.skillSourceManagementPage.deleteSkillSource,
  'skillSourceManagementPage.deleteSkillSource2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.deleteSkillSource2,
  'skillSourceManagementPage.delete': catalogSourcesEnUS.generated.skillSourceManagementPage.delete,
  'skillSourceManagementPage.cancel': catalogSourcesEnUS.generated.skillSourceManagementPage.cancel,
  'skillSourceManagementPage.unableToConfirmDeletionTryAgainLater':
    catalogSourcesEnUS.generated.skillSourceManagementPage.unableToConfirmDeletionTryAgainLater,
  'skillSourceManagementPage.skillSourceDeleted':
    catalogSourcesEnUS.generated.skillSourceManagementPage.skillSourceDeleted,
  'skillSourceManagementPage.removeFromTheSkillCatalogInstalledCopies':
    catalogSourcesEnUS.generated.skillSourceManagementPage.removeFromTheSkillCatalogInstalledCopies,
  'skillSourceManagementPage.removeSkill':
    catalogSourcesEnUS.generated.skillSourceManagementPage.removeSkill,
  'skillSourceManagementPage.remove': catalogSourcesEnUS.generated.skillSourceManagementPage.remove,
  'skillSourceManagementPage.cancel2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.cancel2,
  'skillSourceManagementPage.unableToConfirmRemovalTryAgainLater':
    catalogSourcesEnUS.generated.skillSourceManagementPage.unableToConfirmRemovalTryAgainLater,
  'skillSourceManagementPage.skillRemoved':
    catalogSourcesEnUS.generated.skillSourceManagementPage.skillRemoved,
  'skillSourceManagementPage.enterprise': 'Enterprise',
  'skillSourceManagementPage.organization': 'Organization',
  'skillSourceManagementPage.personal':
    catalogSourcesEnUS.generated.skillSourceManagementPage.personal,
  'skillSourceManagementPage.skillSources':
    catalogSourcesEnUS.generated.skillSourceManagementPage.skillSources,
  'skillSourceManagementPage.manageExternalSourcesAndAddSkillsTo':
    'Manage external sources and add skills to personal, organization, or enterprise catalogs.',
  'skillSourceManagementPage.addSkillSource':
    catalogSourcesEnUS.generated.skillSourceManagementPage.addSkillSource,
  'skillSourceManagementPage.name': skillConfigurationEnUS.generated.skillSourceManagementPage.name,
  'skillSourceManagementPage.scope': catalogSourcesEnUS.generated.skillSourceManagementPage.scope,
  'skillSourceManagementPage.uRL': catalogSourcesEnUS.generated.skillSourceManagementPage.uRL,
  'skillSourceManagementPage.status': catalogSourcesEnUS.generated.skillSourceManagementPage.status,
  'skillSourceManagementPage.enabled':
    catalogSourcesEnUS.generated.skillSourceManagementPage.enabled,
  'skillSourceManagementPage.disabled':
    catalogSourcesEnUS.generated.skillSourceManagementPage.disabled,
  'skillSourceManagementPage.actions':
    skillConfigurationEnUS.generated.skillSourceManagementPage.actions,
  'skillSourceManagementPage.skillSourceStatusUpdated':
    catalogSourcesEnUS.generated.skillSourceManagementPage.skillSourceStatusUpdated,
  'skillSourceManagementPage.updateSkillSourceStatus':
    catalogSourcesEnUS.generated.skillSourceManagementPage.updateSkillSourceStatus,
  'skillSourceManagementPage.confirmDisableSkillSource':
    catalogSourcesEnUS.generated.skillSourceManagementPage.confirmDisableSkillSource,
  'skillSourceManagementPage.confirmEnableSkillSource':
    catalogSourcesEnUS.generated.skillSourceManagementPage.confirmEnableSkillSource,
  'skillSourceManagementPage.unableToConfirmSourceStatusChange':
    catalogSourcesEnUS.generated.skillSourceManagementPage.unableToConfirmSourceStatusChange,
  'skillSourceManagementPage.disable':
    catalogSourcesEnUS.generated.skillSourceManagementPage.disable,
  'skillSourceManagementPage.enable': catalogSourcesEnUS.generated.skillSourceManagementPage.enable,
  'skillSourceManagementPage.delete2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.delete2,
  'skillSourceManagementPage.sourceSkills':
    catalogSourcesEnUS.generated.skillSourceManagementPage.sourceSkills,
  'skillSourceManagementPage.selectASkillSource':
    catalogSourcesEnUS.generated.skillSourceManagementPage.selectASkillSource,
  'skillSourceManagementPage.selectAnEnabledSkillSource':
    catalogSourcesEnUS.generated.skillSourceManagementPage.selectAnEnabledSkillSource,
  'skillSourceManagementPage.enterASkillNameOrDescription':
    catalogSourcesEnUS.generated.skillSourceManagementPage.enterASkillNameOrDescription,
  'skillSourceManagementPage.search': catalogSourcesEnUS.generated.skillSourceManagementPage.search,
  'skillSourceManagementPage.noDescriptionWasProvidedByThisSource':
    catalogSourcesEnUS.generated.skillSourceManagementPage.noDescriptionWasProvidedByThisSource,
  'skillSourceManagementPage.details': 'Details',
  'skillSourceManagementPage.addToCatalog':
    catalogSourcesEnUS.generated.skillSourceManagementPage.addToCatalog,
  'skillSourceManagementPage.noPopularSkillsAreAvailableEnterA':
    catalogSourcesEnUS.generated.skillSourceManagementPage.noPopularSkillsAreAvailableEnterA,
  'skillSourceManagementPage.thisSourceHasNoAvailableSkills':
    catalogSourcesEnUS.generated.skillSourceManagementPage.thisSourceHasNoAvailableSkills,
  'skillSourceManagementPage.selectAnEnabledSkillSource2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.selectAnEnabledSkillSource2,
  'skillSourceManagementPage.catalogSkills':
    catalogSourcesEnUS.generated.skillSourceManagementPage.catalogSkills,
  'skillSourceManagementPage.searchSkillNamesOrDescriptions':
    catalogSourcesEnUS.generated.skillSourceManagementPage.searchSkillNamesOrDescriptions,
  'skillSourceManagementPage.catalogSkillCategories':
    catalogSourcesEnUS.generated.skillSourceManagementPage.catalogSkillCategories,
  'skillSourceManagementPage.all': catalogSourcesEnUS.generated.skillSourceManagementPage.all,
  'skillSourceManagementPage.noDescriptionIsAvailableForThisSkill':
    catalogSourcesEnUS.generated.skillSourceManagementPage.noDescriptionIsAvailableForThisSkill,
  'skillSourceManagementPage.version': 'Version',
  'skillSourceManagementPage.updated':
    catalogSourcesEnUS.generated.skillSourceManagementPage.updated,
  'skillSourceManagementPage.featured':
    catalogSourcesEnUS.generated.skillSourceManagementPage.featured,
  'skillSourceManagementPage.details2': 'Details',
  'skillSourceManagementPage.edit': catalogSourcesEnUS.generated.skillSourceManagementPage.edit,
  'skillSourceManagementPage.checkForUpdates':
    catalogSourcesEnUS.generated.skillSourceManagementPage.checkForUpdates,
  'skillSourceManagementPage.updateTo':
    catalogSourcesEnUS.generated.skillSourceManagementPage.updateTo,
  'skillSourceManagementPage.remove2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.remove2,
  'skillSourceManagementPage.noCatalogSkills':
    catalogSourcesEnUS.generated.skillSourceManagementPage.noCatalogSkills,
  'skillSourceManagementPage.noMatchingSkills':
    catalogSourcesEnUS.generated.skillSourceManagementPage.noMatchingSkills,
  'skillSourceManagementPage.addSkillSource2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.addSkillSource2,
  'skillSourceManagementPage.name2': catalogSourcesEnUS.generated.skillSourceManagementPage.name2,
  'skillSourceManagementPage.repositoryURL':
    catalogSourcesEnUS.generated.skillSourceManagementPage.repositoryURL,
  'skillSourceManagementPage.httpsGithubComOrgRepoOrGit':
    catalogSourcesEnUS.generated.skillSourceManagementPage.httpsGithubComOrgRepoOrGit,
  'skillSourceManagementPage.gitRepositoriesUseTheServerProcessUser':
    catalogSourcesEnUS.generated.skillSourceManagementPage.gitRepositoriesUseTheServerProcessUser,
  'skillSourceManagementPage.scope2': catalogSourcesEnUS.generated.skillSourceManagementPage.scope2,
  'skillSourceManagementPage.personal2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.personal2,
  'skillSourceManagementPage.organization2': 'Organization',
  'skillSourceManagementPage.enterprise2': 'Enterprise',
  'skillSourceManagementPage.organization3': 'Organization',
  'skillSourceManagementPage.selectAManageableOrganization': 'Select organization',
  'skillSourceManagementPage.cancel3':
    catalogSourcesEnUS.generated.skillSourceManagementPage.cancel3,
  'skillSourceManagementPage.add': catalogSourcesEnUS.generated.skillSourceManagementPage.add,
  'skillSourceManagementPage.addToCatalog2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.addToCatalog2,
  'skillSourceManagementPage.availability':
    catalogSourcesEnUS.generated.skillSourceManagementPage.availability,
  'skillSourceManagementPage.personal3':
    catalogSourcesEnUS.generated.skillSourceManagementPage.personal3,
  'skillSourceManagementPage.organizationMembers': 'Organization Members',
  'skillSourceManagementPage.enterpriseMembers': 'Enterprise Members',
  'skillSourceManagementPage.organization4': 'Organization',
  'skillSourceManagementPage.selectAManageableOrganization2': 'Select organization',
  'skillSourceManagementPage.featured2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.featured2,
  'skillSourceManagementPage.tags': catalogSourcesEnUS.generated.skillSourceManagementPage.tags,
  'skillSourceManagementPage.enterATagAndPressEnterUp':
    catalogSourcesEnUS.generated.skillSourceManagementPage.enterATagAndPressEnterUp,
  'skillSourceManagementPage.cancel4':
    catalogSourcesEnUS.generated.skillSourceManagementPage.cancel4,
  'skillSourceManagementPage.add2': catalogSourcesEnUS.generated.skillSourceManagementPage.add2,
  'skillSourceManagementPage.editSkillInformation':
    catalogSourcesEnUS.generated.skillSourceManagementPage.editSkillInformation,
  'skillSourceManagementPage.featured3':
    catalogSourcesEnUS.generated.skillSourceManagementPage.featured3,
  'skillSourceManagementPage.tags2': catalogSourcesEnUS.generated.skillSourceManagementPage.tags2,
  'skillSourceManagementPage.enterATagAndPressEnterUp2':
    catalogSourcesEnUS.generated.skillSourceManagementPage.enterATagAndPressEnterUp2,
  'skillSourceManagementPage.cancel5':
    catalogSourcesEnUS.generated.skillSourceManagementPage.cancel5,
  'skillSourceManagementPage.save': catalogSourcesEnUS.generated.skillSourceManagementPage.save,

  'mcpSourceManagementPage.enterASourceName':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.enterASourceName,
  'mcpSourceManagementPage.enterARegistryURL':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.enterARegistryURL,
  'mcpSourceManagementPage.enterAnHTTPSURL':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.enterAnHTTPSURL,
  'mcpSourceManagementPage.selectAnOrganization': 'Select an organization',
  'mcpSourceManagementPage.selectAnOrganization2': 'Select an organization',
  'mcpSourceManagementPage.addNoMoreThan10Tags':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.addNoMoreThan10Tags,
  'mcpSourceManagementPage.eachTagMustContain132Characters':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.eachTagMustContain132Characters,
  'mcpSourceManagementPage.duplicateTagsAreNotAllowed':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.duplicateTagsAreNotAllowed,
  'mcpSourceManagementPage.mCPSourceAdded':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.mCPSourceAdded,
  'mcpSourceManagementPage.deleteMCPSource':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.deleteMCPSource,
  'mcpSourceManagementPage.deleteMCPSource2':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.deleteMCPSource2,
  'mcpSourceManagementPage.delete': catalogSourcesEnUS.generated.mcpSourceManagementPage.delete,
  'mcpSourceManagementPage.cancel': catalogSourcesEnUS.generated.mcpSourceManagementPage.cancel,
  'mcpSourceManagementPage.mCPSourceDeleted':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.mCPSourceDeleted,
  'mcpSourceManagementPage.addedToMCPCenter':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.addedToMCPCenter,
  'mcpSourceManagementPage.mCPInformationUpdated':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.mCPInformationUpdated,
  'mcpSourceManagementPage.updateAvailable':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.updateAvailable,
  'mcpSourceManagementPage.alreadyUpToDate':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.alreadyUpToDate,
  'mcpSourceManagementPage.mCPCatalogVersionUpdated':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.mCPCatalogVersionUpdated,
  'mcpSourceManagementPage.removeFromMCPCenter':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.removeFromMCPCenter,
  'mcpSourceManagementPage.removeCatalogEntry':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.removeCatalogEntry,
  'mcpSourceManagementPage.remove': catalogSourcesEnUS.generated.mcpSourceManagementPage.remove,
  'mcpSourceManagementPage.cancel2': catalogSourcesEnUS.generated.mcpSourceManagementPage.cancel2,
  'mcpSourceManagementPage.removedFromMCPCenter':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.removedFromMCPCenter,
  'mcpSourceManagementPage.thisMCPServerIsAlreadyInThe':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.thisMCPServerIsAlreadyInThe,
  'mcpSourceManagementPage.theMCPSourceOperationDidNotComplete':
    'The MCP source operation did not complete.',
  'mcpSourceManagementPage.enterprise': 'Enterprise',
  'mcpSourceManagementPage.organization': 'Organization',
  'mcpSourceManagementPage.personal': catalogSourcesEnUS.generated.mcpSourceManagementPage.personal,
  'mcpSourceManagementPage.mCPSources':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.mCPSources,
  'mcpSourceManagementPage.manageRegistrySourcesAndAddMCPServers':
    'Manage registry sources and add MCP servers to personal, organization, or enterprise catalogs.',
  'mcpSourceManagementPage.addMCPSource':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.addMCPSource,
  'mcpSourceManagementPage.name': skillConfigurationEnUS.generated.mcpSourceManagementPage.name,
  'mcpSourceManagementPage.scope': skillConfigurationEnUS.generated.mcpSourceManagementPage.scope,
  'mcpSourceManagementPage.uRL': catalogSourcesEnUS.generated.mcpSourceManagementPage.uRL,
  'mcpSourceManagementPage.status': catalogSourcesEnUS.generated.mcpSourceManagementPage.status,
  'mcpSourceManagementPage.enabled': catalogSourcesEnUS.generated.mcpSourceManagementPage.enabled,
  'mcpSourceManagementPage.disabled': catalogSourcesEnUS.generated.mcpSourceManagementPage.disabled,
  'mcpSourceManagementPage.actions':
    skillConfigurationEnUS.generated.mcpSourceManagementPage.actions,
  'mcpSourceManagementPage.updateMCPSourceStatus':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.updateMCPSourceStatus,
  'mcpSourceManagementPage.confirmDisableMCPSource':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.confirmDisableMCPSource,
  'mcpSourceManagementPage.confirmEnableMCPSource':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.confirmEnableMCPSource,
  'mcpSourceManagementPage.disable': catalogSourcesEnUS.generated.mcpSourceManagementPage.disable,
  'mcpSourceManagementPage.enable': catalogSourcesEnUS.generated.mcpSourceManagementPage.enable,
  'mcpSourceManagementPage.delete2': catalogSourcesEnUS.generated.mcpSourceManagementPage.delete2,
  'mcpSourceManagementPage.sourceMCPServers':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.sourceMCPServers,
  'mcpSourceManagementPage.selectAnEnabledMCPSource':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.selectAnEnabledMCPSource,
  'mcpSourceManagementPage.enterAnMCPServerNameOrDescription':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.enterAnMCPServerNameOrDescription,
  'mcpSourceManagementPage.search': catalogSourcesEnUS.generated.mcpSourceManagementPage.search,
  'mcpSourceManagementPage.noDescriptionWasProvidedByThisSource':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.noDescriptionWasProvidedByThisSource,
  'mcpSourceManagementPage.version': 'Version',
  'mcpSourceManagementPage.details': 'Details',
  'mcpSourceManagementPage.added': catalogSourcesEnUS.generated.mcpSourceManagementPage.added,
  'mcpSourceManagementPage.addToCatalog':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.addToCatalog,
  'mcpSourceManagementPage.enterAKeywordToSearchThisSource':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.enterAKeywordToSearchThisSource,
  'mcpSourceManagementPage.selectAnEnabledMCPSource2':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.selectAnEnabledMCPSource2,
  'mcpSourceManagementPage.catalogMCPServers':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.catalogMCPServers,
  'mcpSourceManagementPage.noDescriptionIsAvailableForThisMCP':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.noDescriptionIsAvailableForThisMCP,
  'mcpSourceManagementPage.featured': catalogSourcesEnUS.generated.mcpSourceManagementPage.featured,
  'mcpSourceManagementPage.version2': 'Version',
  'mcpSourceManagementPage.details2': 'Details',
  'mcpSourceManagementPage.edit': catalogSourcesEnUS.generated.mcpSourceManagementPage.edit,
  'mcpSourceManagementPage.checkForUpdates':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.checkForUpdates,
  'mcpSourceManagementPage.updateTo': catalogSourcesEnUS.generated.mcpSourceManagementPage.updateTo,
  'mcpSourceManagementPage.remove2': catalogSourcesEnUS.generated.mcpSourceManagementPage.remove2,
  'mcpSourceManagementPage.noCatalogMCPServers':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.noCatalogMCPServers,
  'mcpSourceManagementPage.addMCPSource2':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.addMCPSource2,
  'mcpSourceManagementPage.name2': catalogSourcesEnUS.generated.mcpSourceManagementPage.name2,
  'mcpSourceManagementPage.scope2': catalogSourcesEnUS.generated.mcpSourceManagementPage.scope2,
  'mcpSourceManagementPage.personal2':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.personal2,
  'mcpSourceManagementPage.organization2': 'Organization',
  'mcpSourceManagementPage.enterprise2': 'Enterprise',
  'mcpSourceManagementPage.organization3': 'Organization',
  'mcpSourceManagementPage.cancel3': catalogSourcesEnUS.generated.mcpSourceManagementPage.cancel3,
  'mcpSourceManagementPage.confirm': catalogSourcesEnUS.generated.mcpSourceManagementPage.confirm,
  'mcpSourceManagementPage.addToMCPCenter':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.addToMCPCenter,
  'mcpSourceManagementPage.scope3': catalogSourcesEnUS.generated.mcpSourceManagementPage.scope3,
  'mcpSourceManagementPage.personal3':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.personal3,
  'mcpSourceManagementPage.organization4': 'Organization',
  'mcpSourceManagementPage.enterprise3': 'Enterprise',
  'mcpSourceManagementPage.organization5': 'Organization',
  'mcpSourceManagementPage.tags': catalogSourcesEnUS.generated.mcpSourceManagementPage.tags,
  'mcpSourceManagementPage.selectAnExistingTagOrEnterA':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.selectAnExistingTagOrEnterA,
  'mcpSourceManagementPage.featured2':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.featured2,
  'mcpSourceManagementPage.cancel4': catalogSourcesEnUS.generated.mcpSourceManagementPage.cancel4,
  'mcpSourceManagementPage.confirm2': catalogSourcesEnUS.generated.mcpSourceManagementPage.confirm2,
  'mcpSourceManagementPage.editMCPInformation':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.editMCPInformation,
  'mcpSourceManagementPage.featured3':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.featured3,
  'mcpSourceManagementPage.tags2': catalogSourcesEnUS.generated.mcpSourceManagementPage.tags2,
  'mcpSourceManagementPage.selectAnExistingTagOrEnterA2':
    catalogSourcesEnUS.generated.mcpSourceManagementPage.selectAnExistingTagOrEnterA2,
  'mcpSourceManagementPage.cancel5': catalogSourcesEnUS.generated.mcpSourceManagementPage.cancel5,
  'mcpSourceManagementPage.save': catalogSourcesEnUS.generated.mcpSourceManagementPage.save,

  'mcpDetailsDialog.mCPDetails': skillConfigurationEnUS.generated.mcpDetailsDialog.mCPDetails,
  'mcpDetailsDialog.noDescriptionIsAvailableForThisMCP':
    skillConfigurationEnUS.generated.mcpDetailsDialog.noDescriptionIsAvailableForThisMCP,
  'mcpDetailsDialog.serverName': skillConfigurationEnUS.generated.mcpDetailsDialog.serverName,
  'mcpDetailsDialog.source': skillConfigurationEnUS.generated.mcpDetailsDialog.source,
  'mcpDetailsDialog.availability': skillConfigurationEnUS.generated.mcpDetailsDialog.availability,
  'mcpDetailsDialog.version': skillConfigurationEnUS.generated.mcpDetailsDialog.version,
  'mcpDetailsDialog.transport': skillConfigurationEnUS.generated.mcpDetailsDialog.transport,
  'mcpDetailsDialog.updated': skillConfigurationEnUS.generated.mcpDetailsDialog.updated,
  'mcpDetailsDialog.status': skillConfigurationEnUS.generated.mcpDetailsDialog.status,
  'mcpDetailsDialog.tags': skillConfigurationEnUS.generated.mcpDetailsDialog.tags,
  'mcpDetailsDialog.featured': skillConfigurationEnUS.generated.mcpDetailsDialog.featured,
  'mcpDetailsDialog.close': skillConfigurationEnUS.generated.mcpDetailsDialog.close,

  'auditManagementPage.managementOperation': 'Management Operation',
  'auditManagementPage.conversationInput': 'Conversation Input',
  'auditManagementPage.administratorInitialized': 'Administrator Initialized',
  'auditManagementPage.signInSucceeded': 'Sign-in Succeeded',
  'auditManagementPage.signInFailed': 'Sign-in Failed',
  'auditManagementPage.signInRateLimited': 'Sign-in Rate Limited',
  'auditManagementPage.signInSessionEvicted': 'Sign-in Session Evicted',
  'auditManagementPage.signedOut': 'Signed Out',
  'auditManagementPage.userSessionRevoked': 'User Session Revoked',
  'auditManagementPage.passwordChanged': 'Password Changed',
  'auditManagementPage.passwordReset': 'Password Reset',
  'auditManagementPage.userPasswordResetByAdministrator': 'User Password Reset by Administrator',
  'auditManagementPage.userCreated': 'User Created',
  'auditManagementPage.userCreatedByAdministrator': 'User Created by Administrator',
  'auditManagementPage.userDeleted': 'User Deleted',
  'auditManagementPage.userDeletedByAdministrator': 'User Deleted by Administrator',
  'auditManagementPage.nodeRegistered': 'Node Registered',
  'auditManagementPage.nodeRegistrationTokenCreated': 'Node Registration Key Created',
  'auditManagementPage.nodeRevoked': 'Node Revoked',
  'auditManagementPage.nodeDeleted': 'Node Deleted',
  'auditManagementPage.environmentSecretCreated': 'Environment Secret Created',
  'auditManagementPage.environmentSecretReplaced': 'Environment Secret Replaced',
  'auditManagementPage.environmentSecretDeleted': 'Environment Secret Deleted',
  'auditManagementPage.approvalDecided': 'Approval Decided',
  'auditManagementPage.agentInputRequestAnswered': 'Agent Input Request Answered',
  'auditManagementPage.sessionInterruptRequested': 'Session Interrupt Requested',
  'auditManagementPage.licenseImported': 'License Imported',
  'auditManagementPage.resourceGrant': 'Resource Grant',
  'auditManagementPage.resourceOwnershipChanged': 'Resource Ownership Changed',
  'auditManagementPage.oAuthIdentityBound': 'OAuth Identity Bound',
  'auditManagementPage.oAuthIdentityUnbound': 'OAuth Identity Unbound',
  'auditManagementPage.create': 'Create',
  'auditManagementPage.update': 'Update',
  'auditManagementPage.delete': 'Delete',
  'auditManagementPage.view': 'View',
  'auditManagementPage.sendMessage': 'Send Message',
  'auditManagementPage.import': 'Import',
  'auditManagementPage.export': 'Export',
  'auditManagementPage.grant': 'Grant',
  'auditManagementPage.revokeGrant': 'Revoke Grant',
  'auditManagementPage.workspace': 'Workspace',
  'auditManagementPage.session': 'Session',
  'auditManagementPage.conversation': 'Conversation',
  'auditManagementPage.terminal': 'Terminal',
  'auditManagementPage.file': 'File',
  'auditManagementPage.node': 'Node',
  'auditManagementPage.organization': 'Organization',
  'auditManagementPage.user': 'User',
  'auditManagementPage.oAuthProvider': 'OAuth Provider',
  'auditManagementPage.resource': 'Resource',
  'auditManagementPage.create2': 'Create',
  'auditManagementPage.start': 'Start',
  'auditManagementPage.open': 'Open',
  'auditManagementPage.update2': 'Update',
  'auditManagementPage.save': 'Save',
  'auditManagementPage.delete2': 'Delete',
  'auditManagementPage.remove': 'Remove',
  'auditManagementPage.close': 'Close',
  'auditManagementPage.cancel': 'Cancel',
  'auditManagementPage.interrupt': 'Interrupt',
  'auditManagementPage.respond': 'Respond',
  'auditManagementPage.decide': 'Decide',
  'auditManagementPage.restore': 'Restore',
  'auditManagementPage.execute': 'Execute',
  'auditManagementPage.reorder': 'Reorder',
  'auditManagementPage.pause': 'Pause',
  'auditManagementPage.resume': 'Resume',
  'auditManagementPage.sendMessage2': 'Send Message',
  'auditManagementPage.success': 'Success',
  'auditManagementPage.denied': 'Denied',
  'auditManagementPage.failed': 'Failed',
  'auditManagementPage.user2': 'User',
  'auditManagementPage.organization2': 'Organization',
  'auditManagementPage.enterprise': 'Enterprise',
  'auditManagementPage.node2': 'Node',
  'auditManagementPage.workspace2': 'Workspace',
  'auditManagementPage.session2': 'Session',
  'auditManagementPage.run': 'Run',
  'auditManagementPage.password': 'Password',
  'auditManagementPage.system': 'System',
  'auditManagementPage.requestID': 'Request ID',
  'auditManagementPage.operationID': 'Operation ID',
  'auditManagementPage.targetType': 'Target Type',
  'auditManagementPage.targetID': 'Target ID',
  'auditManagementPage.organizationID': 'Organization ID',
  'auditManagementPage.nodeID': 'Node ID',
  'auditManagementPage.workspaceID': 'Workspace ID',
  'auditManagementPage.sessionID': 'Session ID',
  'auditManagementPage.runID': 'Run ID',
  'auditManagementPage.clientMessageID': 'Client Message ID',
  'auditManagementPage.queueItemID': 'Queue Item ID',
  'auditManagementPage.inputMode': 'Input Mode',
  'auditManagementPage.insufficientPermissions': 'Insufficient Permissions',
  'auditManagementPage.licenseManagementFrozen': 'License Management Frozen',
  'auditManagementPage.requestValidationFailed': 'Request Validation Failed',
  'auditManagementPage.requestOriginNotAllowed': 'Request Origin Not Allowed',
  'auditManagementPage.executeRunnerCommand': 'Execute Agent Command',
  'auditManagementPage.createNodeRegistrationToken': 'Create Node Registration Key',
  'auditManagementPage.pushNodeUpgrade': 'Push Node Upgrade',
  'auditManagementPage.cancelNodeUpgrade': 'Cancel Node Upgrade',
  'auditManagementPage.createResourceGrant': 'Create Resource Grant',
  'auditManagementPage.createOAuthProvider': 'Create OAuth Provider',
  'auditManagementPage.importLicense': 'Import License',
  'auditManagementPage.createExecute': 'Create/Execute',
  'auditManagementPage.replace': 'Replace',
  'auditManagementPage.update3': 'Update',
  'auditManagementPage.delete3': 'Delete',
  'auditManagementPage.organization3': 'Organization',
  'auditManagementPage.managedObject': 'Managed Object',
  'auditManagementPage.enterpriseUser': 'Enterprise User',
  'auditManagementPage.node3': 'Node',
  'auditManagementPage.workspace3': 'Workspace',
  'auditManagementPage.resourceGrant2': 'Resource Grant',
  'auditManagementPage.oAuthProvider2': 'OAuth Provider',
  'auditManagementPage.systemConfiguration': 'System Configuration',
  'auditManagementPage.secret': 'Secret',
  'auditManagementPage.nodeRegistrationToken': 'Node Registration Key',
  'auditManagementPage.runnerProfile': 'Agent Profile',
  'auditManagementPage.runnerCommand': 'Agent Command',
  'auditManagementPage.auditEvent': 'Audit Event',
  'auditManagementPage.authentication': 'Authentication',
  'auditManagementPage.systemOperation': 'System Operation',
  'auditManagementPage.systemOperation2': 'System Operation',
  'auditManagementPage.unableToLoadAuditEvents': 'Unable to load audit events',
  'auditManagementPage.auditLog': 'Audit Log',
  'auditManagementPage.recordsOperationsAndRelatedIDsWithoutStoring':
    'Records operations and related IDs without storing conversation or terminal content.',
  'auditManagementPage.timeRange': 'Time Range:',
  'auditManagementPage.to': 'to',
  'auditManagementPage.startTime': 'Start Time',
  'auditManagementPage.endTime': 'End Time',
  'auditManagementPage.refresh': 'Refresh',
  'auditManagementPage.exportCSV': 'Export CSV',
  'auditManagementPage.time': 'Time',
  'auditManagementPage.event': 'Event',
  'auditManagementPage.actor': 'Actor',
  'auditManagementPage.result': 'Result',
  'auditManagementPage.actions': 'Actions',
  'auditManagementPage.view2': 'View',
  'auditManagementPage.loadMore': 'Load More',
  'auditManagementPage.auditDetails': 'Audit Details',
  'auditManagementPage.auditEventId': 'Audit event ID',
  'auditManagementPage.event2': 'Event',
  'auditManagementPage.time2': 'Time',
  'auditManagementPage.actor2': 'Actor',
  'auditManagementPage.authentication2': 'Authentication',
  'auditManagementPage.result2': 'Result',
  'auditManagementPage.sharedConversationInputAccepted': 'Shared conversation input accepted',
  'auditManagementPage.sharedConversationInputRejected': 'Shared conversation input rejected',
  'auditManagementPage.sharedConversationQueueUpdated': 'Shared conversation queue updated',
  'auditManagementPage.sharedConversationQueueDeleted': 'Shared conversation queue deleted',
  'auditManagementPage.sharedConversationQueueReordered': 'Shared conversation queue reordered',
  'auditManagementPage.sharedConversationQueueExecuteRequested':
    'Shared conversation queue execute requested',
  'auditManagementPage.conversationHostingDisabled': 'Conversation hosting disabled',
  'auditManagementPage.conversationHostingStorageInspected':
    'Conversation hosting storage inspected',
  'auditManagementPage.sessionPublicID': 'Public session ID',
  'auditManagementPage.conversationTitle': 'Conversation title',
  'auditManagementPage.userMessage': 'User message',
  'auditManagementPage.errorCode': 'Error code',
  'auditManagementPage.inputModeNewSession': 'New session',
  'auditManagementPage.inputModeSend': 'Send message',
  'auditManagementPage.inputModeContinue': 'Continue run',
  'auditManagementPage.inputModeSteer': 'Steer run',
  'auditManagementPage.inputModeQueue': 'Queue message',
  'auditManagementPage.inputModeReplaceCurrent': 'Replace current run',
  'auditManagementPage.inputModeRunNow': 'Run now',
  'auditManagementPage.inputModeUserInputResponse': 'Respond to run input',
  'auditManagementPage.inputModeEditQueue': 'Edit queued message',
  'auditManagementPage.inputModeDeleteQueue': 'Delete queued message',
  'auditManagementPage.inputModeReorderQueue': 'Reorder queue',
  'auditManagementPage.inputModeExecuteQueue': 'Execute queued message',
  'auditManagementPage.inputModePauseQueue': 'Pause queue',
  'auditManagementPage.inputModeResumeQueue': 'Resume queue',

  'workspaceTree.collapseWorkspaces': workbenchShellEnUS.generated.workspaceTree.collapseWorkspaces,
  'workspaceTree.expandWorkspaces': workbenchShellEnUS.generated.workspaceTree.expandWorkspaces,
  'workspaceTree.addWorkspace': workbenchShellEnUS.generated.workspaceTree.addWorkspace,
  'workspaceTree.refreshWorkspaces': workbenchShellEnUS.generated.workspaceTree.refreshWorkspaces,
  'workspaceTree.nodeActions': workbenchShellEnUS.generated.workspaceTree.nodeActions,
  'workspaceTree.nodeDetails': workbenchShellEnUS.generated.workspaceTree.nodeDetails,
  'workspaceTree.workspaceActions': workbenchShellEnUS.generated.workspaceTree.workspaceActions,
  'workspaceTree.workspaceDetails': workbenchShellEnUS.generated.workspaceTree.workspaceDetails,
  'workspaceTree.rename': workbenchShellEnUS.generated.workspaceTree.rename,
  'workspaceTree.cleanupSessions': 'Clean up sessions',
  'workspaceTree.delete': workbenchShellEnUS.generated.workspaceTree.delete,
  'workspaceTree.enterWorkspaceName': workspaceEnUS.generated.workspaceTree.enterWorkspaceName,
  'workspaceTree.renameWorkspace': workspaceEnUS.generated.workspaceTree.renameWorkspace,
  'workspaceTree.workspaceNameRequired':
    workspaceEnUS.generated.workspaceTree.workspaceNameRequired,
  'workspaceTree.workspaceNameTooLong': workspaceEnUS.generated.workspaceTree.workspaceNameTooLong,
  'workspaceTree.save': workspaceEnUS.generated.workspaceTree.save,
  'workspaceTree.cancel': workspaceEnUS.generated.workspaceTree.cancel,
  'workspaceTree.unregister': 'Remove {value0}',
  'workspaceTree.unregisterWorkspace': 'Remove workspace',
  'workspaceTree.selectAWorkspaceToContinueInThe':
    workbenchShellEnUS.generated.workspaceTree.selectAWorkspaceToContinueInThe,
  'workspaceTree.noNodes': workbenchShellEnUS.generated.workspaceTree.noNodes,
  'nodeManagementPage.unableToDeleteNode': 'Unable to delete node',
  'nodeManagementPage.deleteNodeItMustBeRegisteredAgain':
    'Delete node “{value0}”? It must be registered again before it can be used.',
  'nodeManagementPage.deleteNode': 'Delete Node',
  'nodeManagementPage.deleteNode2': 'Delete Node',
  'nodeManagementPage.cancel': 'Cancel',
  'nodeManagementPage.disabled': 'Disabled',
  'nodeManagementPage.online': 'Online',
  'nodeManagementPage.offline': 'Offline',
  'nodeManagementPage.noHeartbeat': 'No heartbeat',
  'nodeManagementPage.available': 'Available',
  'nodeManagementPage.nodeManagement': 'Node Management',
  'nodeManagementPage.viewNodeRegistrationStatusAndRemoveNodes':
    'View node registration status and remove nodes.',
  'nodeManagementPage.selectOwner': 'Select owner',
  'nodeManagementPage.selectStatus': 'Select status',
  'nodeManagementPage.online2': 'Online',
  'nodeManagementPage.offline2': 'Offline',
  'nodeManagementPage.disabled2': 'Disabled',
  'nodeManagementPage.node': 'Node',
  'nodeManagementPage.owner': 'Owner',
  'nodeManagementPage.platform': 'Platform',
  'nodeManagementPage.nodeVersion': 'Node Version',
  'nodeManagementPage.status': 'Status',
  'nodeManagementPage.actions': 'Actions',
  'nodeManagementPage.details': 'Details',
  'nodeManagementPage.delete': 'Delete',
  'nodeManagementPage.nodeDetails': 'Node Details',
  'nodeManagementPage.name': 'Name',
  'nodeManagementPage.owner2': 'Owner',
  'nodeManagementPage.registeredAddress': 'Registered Address',
  'nodeManagementPage.status2': 'Status',
  'nodeManagementPage.system': 'System',
  'nodeManagementPage.nodeVersion2': 'Node Version',
  'nodeManagementPage.toolEnvironment': 'Tool Environment',
  'nodeManagementPage.supportedAgents': 'Supported Agents',
  'nodeManagementPage.none': 'None',
  'nodeManagementPage.lastHeartbeat': 'Last Heartbeat',
  'workspaceTransferDock.fileTransfers': 'File transfers',
  'workspaceTransferDock.fileTransfers2': 'File transfers',
  'workspaceTransferDock.closeFileTransfers': 'Close file transfers',
  'workspaceTransferDock.bytes': 'bytes',
  'workspaceTransferDock.resume': 'Resume',
  'workspaceTransferDock.retry': 'Retry',
  'workspaceTransferDock.cancel': 'Cancel',
  'workspaceTransferDock.delete': 'Delete',

  'oAuthManagementPage.oAuthURLsMustUseHTTPS': 'OAuth URLs must use HTTPS',
  'oAuthManagementPage.enterAValidOAuthURL': 'Enter a valid OAuth URL',
  'oAuthManagementPage.enterAProviderKey': 'Enter a provider key',
  'oAuthManagementPage.theProviderKeyCanContainOnlyLowercase':
    'The provider key can contain only lowercase letters, numbers, and hyphens',
  'oAuthManagementPage.enterADisplayName': 'Enter a display name',
  'oAuthManagementPage.theDisplayNameCannotExceed128Characters':
    'The display name cannot exceed 128 characters',
  'oAuthManagementPage.enterTheClientID': 'Enter the Client ID',
  'oAuthManagementPage.theClientIDCannotExceed512Characters':
    'The Client ID cannot exceed 512 characters',
  'oAuthManagementPage.enterTheClientSecret': 'Enter the Client Secret',
  'oAuthManagementPage.enterTheAuthorizationURL': 'Enter the authorization URL',
  'oAuthManagementPage.enterTheTokenURL': 'Enter the token URL',
  'oAuthManagementPage.enterTheUserInfoURL': 'Enter the UserInfo URL',
  'oAuthManagementPage.scopesCanContainUpTo32Entries':
    'Scopes can contain up to 32 entries of 128 characters each',
  'oAuthManagementPage.selectAPKCEMode': 'Select a PKCE mode',
  'oAuthManagementPage.selectHowToSendTheClientSecret': 'Select how to send the Client Secret',
  'oAuthManagementPage.enterTheExternalUserIDJSONPointer':
    'Enter the external user ID JSON Pointer',
  'oAuthManagementPage.enterAValidJSONPointerSuchAs':
    'Enter a valid JSON Pointer, such as /data/open_id',
  'oAuthManagementPage.enterAValidJSONPointer': 'Enter a valid JSON Pointer',
  'oAuthManagementPage.enterAValidJSONPointer2': 'Enter a valid JSON Pointer',
  'oAuthManagementPage.unableToLoadOAuthProviders': 'Unable to load OAuth providers',
  'oAuthManagementPage.enterTheClientSecret2': 'Enter the Client Secret',
  'oAuthManagementPage.oAuthProviderSavedTestItBeforeEnabling':
    'OAuth provider saved. Test it before enabling it.',
  'oAuthManagementPage.unableToSaveOAuthProvider': 'Unable to save OAuth provider',
  'oAuthManagementPage.configurationTestPassed': 'Configuration test passed',
  'oAuthManagementPage.oAuthConfigurationTestFailed': 'OAuth configuration test failed',
  'oAuthManagementPage.unableToUpdateProviderStatus': 'Unable to update provider status',
  'oAuthManagementPage.deleteOAuthProvider': 'Delete OAuth provider “{value0}”?',
  'oAuthManagementPage.deleteOAuthProvider2': 'Delete OAuth Provider',
  'oAuthManagementPage.delete': 'Delete',
  'oAuthManagementPage.cancel': 'Cancel',
  'oAuthManagementPage.unableToDeleteOAuthProvider': 'Unable to delete OAuth provider',
  'oAuthManagementPage.oAuthConfiguration': 'OAuth Configuration',
  'oAuthManagementPage.mapExternalIdentitiesOnlyFromTheToken':
    'Map external identities only from the token response. Each provider uses a unique key and callback.',
  'oAuthManagementPage.provider': 'Provider:',
  'oAuthManagementPage.enterAProviderNameOrKey': 'Name or key',
  'oAuthManagementPage.refresh': 'Refresh',
  'oAuthManagementPage.addProvider': 'Add provider',
  'oAuthManagementPage.provider2': 'Provider',
  'oAuthManagementPage.providerKey': 'Provider Key',
  'oAuthManagementPage.autoProvisioning': 'Auto Provisioning',
  'oAuthManagementPage.rootOrganizationMEMBER': 'New users join the root organization as members',
  'oAuthManagementPage.updateOAuthProviderStatus': 'Update OAuth Provider Status',
  'oAuthManagementPage.confirmDisableOAuthProvider':
    'Disable OAuth provider “{value0}”? Users can no longer sign in through it.',
  'oAuthManagementPage.confirmEnableOAuthProvider':
    'Enable OAuth provider “{value0}”? Users can sign in through it.',
  'oAuthManagementPage.off': 'Off',
  'oAuthManagementPage.status': 'Status',
  'oAuthManagementPage.enabled': 'Enabled',
  'oAuthManagementPage.untested': 'Untested',
  'oAuthManagementPage.disabled': 'Disabled',
  'oAuthManagementPage.actions': 'Actions',
  'oAuthManagementPage.edit': 'Edit',
  'oAuthManagementPage.test': 'Test',
  'oAuthManagementPage.disable': 'Disable',
  'oAuthManagementPage.enable': 'Enable',
  'oAuthManagementPage.delete2': 'Delete',
  'oAuthManagementPage.editOAuthProvider': 'Edit OAuth Provider',
  'oAuthManagementPage.addOAuthProvider': 'Add OAuth Provider',
  'oAuthManagementPage.providerKey2': 'Provider Key',
  'oAuthManagementPage.forExampleFeishu': 'For example, feishu',
  'oAuthManagementPage.displayName': 'Display Name',
  'oAuthManagementPage.enterADisplayName2': 'Enter a display name',
  'oAuthManagementPage.callbackURL': 'Callback URL',
  'oAuthManagementPage.enterTheClientID2': 'Enter the Client ID',
  'oAuthManagementPage.leaveBlankToKeepTheCurrentValue': 'Leave blank to keep the current value',
  'oAuthManagementPage.required': 'Required',
  'oAuthManagementPage.authorizationURL': 'Authorization URL',
  'oAuthManagementPage.enterTheOAuthAuthorizationURL': 'Enter the OAuth authorization URL',
  'oAuthManagementPage.tokenURL': 'Token URL',
  'oAuthManagementPage.enterTheOAuthTokenURL': 'Enter the OAuth token URL',
  'oAuthManagementPage.userInfoURL': 'UserInfo URL',
  'oAuthManagementPage.enterTheOAuthUserInfoURL': 'Enter the OAuth UserInfo URL',
  'oAuthManagementPage.scopesOnePerLine': 'Scopes (one per line)',
  'oAuthManagementPage.enterOneScopePerLine': 'Enter one scope per line',
  'oAuthManagementPage.externalUserIDJSONPointer': 'External User ID JSON Pointer',
  'oAuthManagementPage.emailJSONPointerOptional': 'Email JSON Pointer (Optional)',
  'oAuthManagementPage.leaveBlankToSkipExistingAccountMatching':
    'Leave blank to skip existing-account matching',
  'oAuthManagementPage.nameJSONPointerOptional': 'Name JSON Pointer (Optional)',
  'oAuthManagementPage.forExampleDataName': 'For example, /data/name',
  'oAuthManagementPage.selectAPKCEMode2': 'Select a PKCE mode',
  'oAuthManagementPage.required2': 'Required',
  'oAuthManagementPage.supported': 'Supported',
  'oAuthManagementPage.disabled2': 'Disabled',
  'oAuthManagementPage.clientSecretMethod': 'Client Secret Method',
  'oAuthManagementPage.selectAMethod': 'Select a method',
  'oAuthManagementPage.allowAutoProvisioningNewUsersAreCreated':
    'Allow auto provisioning (new users join the root organization as members)',
  'oAuthManagementPage.cancel2': 'Cancel',
  'oAuthManagementPage.saveAndDisable': 'Save and disable',

  'workbenchSurface.selectAWorkspace':
    workbenchPageEnUS.generated.workbenchSurface.selectAWorkspace,
  'workbenchSurface.selectANodeInTheResourceExplorer':
    workbenchPageEnUS.generated.workbenchSurface.selectANodeInTheResourceExplorer,
  'workbenchSurface.noNodeConnectedYetCreateARegistration':
    workbenchPageEnUS.generated.workbenchSurface.noNodeConnectedYetCreateARegistration,
  'workbenchSurface.openNodeManagement':
    workbenchPageEnUS.generated.workbenchSurface.openNodeManagement,
  'workbenchSurface.nodeWorkbenchCapabilitiesAreUnavailable':
    workbenchPageEnUS.generated.workbenchSurface.nodeWorkbenchCapabilitiesAreUnavailable,
  'workbenchSurface.openAWorkspace': workbenchPageEnUS.generated.workbenchSurface.openAWorkspace,
  'workbenchSurface.selectAWorkspaceOnTheCurrentNode':
    workbenchPageEnUS.generated.workbenchSurface.selectAWorkspaceOnTheCurrentNode,
  'workbenchSurface.agentConversation':
    workbenchPageEnUS.generated.workbenchSurface.agentConversation,
  'workbenchSurface.run': workbenchPageEnUS.generated.workbenchSurface.run,
  'workbenchSurface.typeForCommandsToReferenceWorkspaceFiles':
    workbenchPageEnUS.generated.workbenchSurface.typeForCommandsToReferenceWorkspaceFiles,
  'workbenchSurface.readOnlyInspector':
    workbenchPageEnUS.generated.workbenchSurface.readOnlyInspector,
  'workbenchSurface.workspace': workbenchPageEnUS.generated.workbenchSurface.workspace,
  'workbenchSurface.theEnterpriseLicenseIsFrozenConfiguredResources':
    'The enterprise license is frozen. Configured resources continue running, but management writes are disabled. Import a new license in System Information.',
  'workbenchSurface.theEnterpriseLicenseIsFrozenConfiguredResources2':
    'The enterprise license is frozen. Configured resources continue running, but management writes are disabled. Contact your enterprise administrator to update the license.',
  'workspaceTabs.openWorkspaces': workbenchShellEnUS.generated.workspaceTabs.openWorkspaces,
  'workspaceTabs.close': workbenchShellEnUS.generated.workspaceTabs.close,
  'resourceSharingPage.enterAResourceName':
    resourceDetailsEnUS.generated.resourceSharingPage.enterAResourceName,
  'resourceSharingPage.theNodeNameCannotExceed128Characters':
    resourceDetailsEnUS.generated.resourceSharingPage.theNodeNameCannotExceed128Characters,
  'resourceSharingPage.theWorkspaceNameCannotExceed255Characters':
    resourceDetailsEnUS.generated.resourceSharingPage.theWorkspaceNameCannotExceed255Characters,
  'resourceSharingPage.enterANodeName':
    resourceDetailsEnUS.generated.resourceSharingPage.enterANodeName,
  'resourceSharingPage.theNodeNameCannotExceed128Characters2':
    resourceDetailsEnUS.generated.resourceSharingPage.theNodeNameCannotExceed128Characters2,
  'resourceSharingPage.selectATargetOrganization': 'Select a target organization',
  'resourceSharingPage.selectATargetUser': 'Select a target user',
  'resourceSharingPage.personal': resourceDetailsEnUS.generated.resourceSharingPage.personal,
  'resourceSharingPage.unableToLoadResources':
    resourceDetailsEnUS.generated.resourceSharingPage.unableToLoadResources,
  'resourceSharingPage.disabled': resourceDetailsEnUS.generated.resourceSharingPage.disabled,
  'resourceSharingPage.online': resourceDetailsEnUS.generated.resourceSharingPage.online,
  'resourceSharingPage.offline': resourceDetailsEnUS.generated.resourceSharingPage.offline,
  'resourceSharingPage.waitingForRuns':
    resourceDetailsEnUS.generated.resourceSharingPage.waitingForRuns,
  'resourceSharingPage.readyToRestart':
    resourceDetailsEnUS.generated.resourceSharingPage.readyToRestart,
  'resourceSharingPage.upgradeFailed':
    resourceDetailsEnUS.generated.resourceSharingPage.upgradeFailed,
  'resourceSharingPage.unavailable': resourceDetailsEnUS.generated.resourceSharingPage.unavailable,
  'resourceSharingPage.upgradeTo': resourceDetailsEnUS.generated.resourceSharingPage.upgradeTo,
  'resourceSharingPage.upToDate': resourceDetailsEnUS.generated.resourceSharingPage.upToDate,
  'resourceSharingPage.nodeIsNewerThanServer':
    resourceDetailsEnUS.generated.resourceSharingPage.nodeIsNewerThanServer,
  'resourceSharingPage.unknownOrUnsupportedVersion':
    resourceDetailsEnUS.generated.resourceSharingPage.unknownOrUnsupportedVersion,
  'resourceSharingPage.enableSupervisorManually':
    resourceDetailsEnUS.generated.resourceSharingPage.enableSupervisorManually,
  'resourceSharingPage.targetNpmPackageUnavailable':
    resourceDetailsEnUS.generated.resourceSharingPage.targetNpmPackageUnavailable,
  'resourceSharingPage.upgradeToLimitedByTheLatestStable':
    resourceDetailsEnUS.generated.resourceSharingPage.upgradeToLimitedByTheLatestStable,
  'resourceSharingPage.pushNodeUpgrade':
    resourceDetailsEnUS.generated.resourceSharingPage.pushNodeUpgrade,
  'resourceSharingPage.pushUpgrade': resourceDetailsEnUS.generated.resourceSharingPage.pushUpgrade,
  'resourceSharingPage.pushAllUpgrades':
    resourceDetailsEnUS.generated.resourceSharingPage.pushAllUpgrades,
  'resourceSharingPage.confirmPushAllUpgrades':
    resourceDetailsEnUS.generated.resourceSharingPage.confirmPushAllUpgrades,
  'resourceSharingPage.pushAllUpgradesImpact':
    resourceDetailsEnUS.generated.resourceSharingPage.pushAllUpgradesImpact,
  'resourceSharingPage.pushAllUpgradesSucceeded':
    resourceDetailsEnUS.generated.resourceSharingPage.pushAllUpgradesSucceeded,
  'resourceSharingPage.pushAllUpgradesPartial':
    resourceDetailsEnUS.generated.resourceSharingPage.pushAllUpgradesPartial,
  'resourceSharingPage.cancel': resourceDetailsEnUS.generated.resourceSharingPage.cancel,
  'resourceSharingPage.upgradeRequestedTheNodeWillUpgradeWhen':
    resourceDetailsEnUS.generated.resourceSharingPage.upgradeRequestedTheNodeWillUpgradeWhen,
  'resourceSharingPage.pendingUpgradeCanceled':
    resourceDetailsEnUS.generated.resourceSharingPage.pendingUpgradeCanceled,
  'resourceSharingPage.unableToCancelUpgrade':
    resourceDetailsEnUS.generated.resourceSharingPage.unableToCancelUpgrade,
  'resourceSharingPage.resourceUpdated':
    resourceDetailsEnUS.generated.resourceSharingPage.resourceUpdated,
  'resourceSharingPage.unableToUpdateResource':
    resourceDetailsEnUS.generated.resourceSharingPage.unableToUpdateResource,
  'resourceSharingPage.unableToCreateRegistrationToken':
    resourceDetailsEnUS.generated.resourceSharingPage.unableToCreateRegistrationToken,
  'resourceSharingPage.deletingTheNodeRegistrationRequiresANew':
    resourceDetailsEnUS.generated.resourceSharingPage.deletingTheNodeRegistrationRequiresANew,
  'resourceSharingPage.unregisteringTheWorkspaceRemovesOnlyItsRegistration':
    resourceDetailsEnUS.generated.resourceSharingPage
      .unregisteringTheWorkspaceRemovesOnlyItsRegistration,
  'resourceSharingPage.deleteNode': resourceDetailsEnUS.generated.resourceSharingPage.deleteNode,
  'resourceSharingPage.unregisterWorkspace':
    resourceDetailsEnUS.generated.resourceSharingPage.unregisterWorkspace,
  'resourceSharingPage.deleteNode2': resourceDetailsEnUS.generated.resourceSharingPage.deleteNode2,
  'resourceSharingPage.unregisterWorkspace2':
    resourceDetailsEnUS.generated.resourceSharingPage.unregisterWorkspace2,
  'resourceSharingPage.cancel2': resourceDetailsEnUS.generated.resourceSharingPage.cancel2,
  'resourceSharingPage.unableToLoadUsage':
    resourceDetailsEnUS.generated.resourceSharingPage.unableToLoadUsage,
  'resourceSharingPage.usageUnavailable':
    resourceDetailsEnUS.generated.resourceSharingPage.usageUnavailable,
  'resourceSharingPage.type': resourceDetailsEnUS.generated.resourceSharingPage.type,
  'resourceSharingPage.branch': resourceDetailsEnUS.generated.resourceSharingPage.branch,
  'resourceSharingPage.unableToLoadGrants': 'Unable to load grants',
  'resourceSharingPage.unableToCreateGrant': 'Unable to create grant',
  'resourceSharingPage.afterRevocationTheTargetImmediatelyLosesDirect':
    'After revocation, the target immediately loses direct access to this resource.',
  'resourceSharingPage.revokeGrant': 'Revoke Grant',
  'resourceSharingPage.revoke': 'Revoke',
  'resourceSharingPage.cancel3': 'Cancel',
  'resourceSharingPage.nodeManagement':
    resourceDetailsEnUS.generated.resourceSharingPage.nodeManagement,
  'resourceSharingPage.workspaceManagement':
    resourceDetailsEnUS.generated.resourceSharingPage.workspaceManagement,
  'resourceSharingPage.ownershipDeterminesManagementScopeGrantsProvideFull':
    'Ownership determines management scope. Grants provide full access, and node grants automatically cover its workspaces.',
  'resourceSharingPage.keyword': resourceDetailsEnUS.generated.resourceSharingPage.keyword,
  'resourceSharingPage.enterANameOrID':
    resourceDetailsEnUS.generated.resourceSharingPage.enterANameOrID,
  'resourceSharingPage.ownerType': 'Owner Type:',
  'resourceSharingPage.ownershipType':
    resourceDetailsEnUS.generated.resourceSharingPage.ownershipType,
  'resourceSharingPage.selectAnOwnerType': 'Owner type',
  'resourceSharingPage.personal2': resourceDetailsEnUS.generated.resourceSharingPage.personal2,
  'resourceSharingPage.organization': 'Organization',
  'resourceSharingPage.organization2': 'Organization:',
  'resourceSharingPage.selectAnOwnerOrganization': 'Select',
  'resourceSharingPage.status': resourceDetailsEnUS.generated.resourceSharingPage.status,
  'resourceSharingPage.selectAStatus':
    resourceDetailsEnUS.generated.resourceSharingPage.selectAStatus,
  'resourceSharingPage.online2': resourceDetailsEnUS.generated.resourceSharingPage.online2,
  'resourceSharingPage.offline2': resourceDetailsEnUS.generated.resourceSharingPage.offline2,
  'resourceSharingPage.disabled2': resourceDetailsEnUS.generated.resourceSharingPage.disabled2,
  'resourceSharingPage.refresh': resourceDetailsEnUS.generated.resourceSharingPage.refresh,
  'resourceSharingPage.registerNode':
    resourceDetailsEnUS.generated.resourceSharingPage.registerNode,
  'resourceSharingPage.nodeName': resourceDetailsEnUS.generated.resourceSharingPage.nodeName,
  'resourceSharingPage.workspaceName':
    resourceDetailsEnUS.generated.resourceSharingPage.workspaceName,
  'resourceSharingPage.node': resourceDetailsEnUS.generated.resourceSharingPage.node,
  'resourceSharingPage.node5': resourceDetailsEnUS.generated.resourceSharingPage.node5,
  'resourceSharingPage.workspace4': resourceDetailsEnUS.generated.resourceSharingPage.workspace4,
  'resourceSharingPage.status2': resourceDetailsEnUS.generated.resourceSharingPage.status2,
  'resourceSharingPage.owner': resourceDetailsEnUS.generated.resourceSharingPage.owner,
  'resourceSharingPage.lastHeartbeat':
    resourceDetailsEnUS.generated.resourceSharingPage.lastHeartbeat,
  'resourceSharingPage.upgradeStatus':
    resourceDetailsEnUS.generated.resourceSharingPage.upgradeStatus,
  'resourceSharingPage.actions': resourceDetailsEnUS.generated.resourceSharingPage.actions,
  'resourceSharingPage.details': 'Details',
  'resourceSharingPage.edit': resourceDetailsEnUS.generated.resourceSharingPage.edit,
  'resourceSharingPage.manageGrants': 'Manage grants',
  'resourceSharingPage.editNode': resourceDetailsEnUS.generated.resourceSharingPage.editNode,
  'resourceSharingPage.editWorkspace':
    resourceDetailsEnUS.generated.resourceSharingPage.editWorkspace,
  'resourceSharingPage.nodeName2': resourceDetailsEnUS.generated.resourceSharingPage.nodeName2,
  'resourceSharingPage.workspaceName2':
    resourceDetailsEnUS.generated.resourceSharingPage.workspaceName2,
  'resourceSharingPage.enterANodeName2':
    resourceDetailsEnUS.generated.resourceSharingPage.enterANodeName2,
  'resourceSharingPage.enterAWorkspaceName':
    resourceDetailsEnUS.generated.resourceSharingPage.enterAWorkspaceName,
  'resourceSharingPage.owner2': resourceDetailsEnUS.generated.resourceSharingPage.owner2,
  'resourceSharingPage.personal3': resourceDetailsEnUS.generated.resourceSharingPage.personal3,
  'resourceSharingPage.selectAnOrganization': 'Select an organization',
  'resourceSharingPage.cancel4': resourceDetailsEnUS.generated.resourceSharingPage.cancel4,
  'resourceSharingPage.save': resourceDetailsEnUS.generated.resourceSharingPage.save,
  'resourceSharingPage.workspaceDetails':
    resourceDetailsEnUS.generated.resourceSharingPage.workspaceDetails,
  'resourceSharingPage.workspaceName3':
    resourceDetailsEnUS.generated.resourceSharingPage.workspaceName3,
  'resourceSharingPage.owner3': resourceDetailsEnUS.generated.resourceSharingPage.owner3,
  'resourceSharingPage.fullPath': resourceDetailsEnUS.generated.resourceSharingPage.fullPath,
  'resourceSharingPage.theNodeIsOfflineThePathIs':
    resourceDetailsEnUS.generated.resourceSharingPage.theNodeIsOfflineThePathIs,
  'resourceSharingPage.upgradeStatus2':
    resourceDetailsEnUS.generated.resourceSharingPage.upgradeStatus2,
  'resourceSharingPage.close': 'Close',
  'resourceSharingPage.pushUpgrade2':
    resourceDetailsEnUS.generated.resourceSharingPage.pushUpgrade2,
  'resourceSharingPage.cancelUpgrade':
    resourceDetailsEnUS.generated.resourceSharingPage.cancelUpgrade,
  'resourceSharingPage.deleteNode3': 'Delete Node',
  'resourceSharingPage.unregisterWorkspace3': 'Remove Workspace',
  'resourceSharingPage.registerNode2':
    resourceDetailsEnUS.generated.resourceSharingPage.registerNode2,
  'resourceSharingPage.nodeName4': resourceDetailsEnUS.generated.resourceSharingPage.nodeName4,
  'resourceSharingPage.enterANodeName3':
    resourceDetailsEnUS.generated.resourceSharingPage.enterANodeName3,
  'resourceSharingPage.owner4': resourceDetailsEnUS.generated.resourceSharingPage.owner4,
  'resourceSharingPage.personal4': resourceDetailsEnUS.generated.resourceSharingPage.personal4,
  'resourceSharingPage.selectAnOwner': 'Select an owner',
  'resourceSharingPage.personal5': 'Personal',
  'resourceSharingPage.docsEnUSDeploymentNodeInstallation':
    resourceDetailsEnUS.generated.resourceSharingPage.docsEnUSDeploymentNodeInstallation,
  'resourceSharingPage.viewNodeDeploymentAndAutostartGuide':
    resourceDetailsEnUS.generated.resourceSharingPage.viewNodeDeploymentAndAutostartGuide,
  'resourceSharingPage.close2': resourceDetailsEnUS.generated.resourceSharingPage.close2,
  'resourceSharingPage.createOneTimeRegistrationToken':
    resourceDetailsEnUS.generated.resourceSharingPage.createOneTimeRegistrationToken,
  'resourceSharingPage.resets': 'Resets: ',
  'resourceSharingPage.updated': 'Updated',
  'resourceSharingPage.close3': 'Close',
  'resourceSharingPage.resourceGrants': 'Resource Grants',
  'resourceSharingPage.targetType': 'Target Type',
  'resourceSharingPage.selectATargetType': 'Select a target type',
  'resourceSharingPage.organization3': 'Organization',
  'resourceSharingPage.user': 'User',
  'resourceSharingPage.entireEnterprise': 'Entire Enterprise',
  'resourceSharingPage.targetOrganization': 'Target Organization',
  'resourceSharingPage.selectATargetOrganization2': 'Select a target organization',
  'resourceSharingPage.targetUser': 'Target User',
  'resourceSharingPage.selectATargetUser2': 'Select a target user',
  'resourceSharingPage.targetType2': 'Target Type',
  'resourceSharingPage.entireEnterprise2': 'Entire Enterprise',
  'resourceSharingPage.user2': 'User',
  'resourceSharingPage.organization4': 'Organization',
  'resourceSharingPage.target': 'Target',
  'resourceSharingPage.entireEnterprise3': 'Entire Enterprise',
  'resourceSharingPage.actions2': 'Actions',
  'resourceSharingPage.revoke2': 'Revoke',
  'resourceSharingPage.close4': 'Close',
  'resourceSharingPage.grantAccess': 'Grant Access',
  'workspaceSessionList.unableToLoadCurrentSkillsTryAgain':
    workbenchShellEnUS.generated.workspaceSessionList.unableToLoadCurrentSkillsTryAgain,
  'workspaceSessionList.unableToLoadCurrentMCPServersTry':
    workbenchShellEnUS.generated.workspaceSessionList.unableToLoadCurrentMCPServersTry,
  'workspaceSessionList.available': workbenchShellEnUS.generated.workspaceSessionList.available,
  'workspaceSessionList.incompleteInstallation':
    workbenchShellEnUS.generated.workspaceSessionList.incompleteInstallation,
  'workspaceSessionList.unknownVersion':
    workbenchShellEnUS.generated.workspaceSessionList.unknownVersion,
  'workspaceSessionList.invalidGitRules':
    workbenchShellEnUS.generated.workspaceSessionList.invalidGitRules,
  'workspaceSessionList.invalidDirectory':
    workbenchShellEnUS.generated.workspaceSessionList.invalidDirectory,
  'workspaceSessionList.workspaceSessions':
    workbenchShellEnUS.generated.workspaceSessionList.workspaceSessions,
  'workspaceSessionList.sessions': workbenchShellEnUS.generated.workspaceSessionList.sessions,
  'workspaceSessionList.newSession': workbenchShellEnUS.generated.workspaceSessionList.newSession,
  'workspaceSessionList.refreshWorkspaceSessions':
    workbenchShellEnUS.generated.workspaceSessionList.refreshWorkspaceSessions,
  'workspaceSessionList.resyncWorkspaceSessions':
    workbenchShellEnUS.generated.workspaceSessionList.resyncWorkspaceSessions,
  'workspaceSessionList.moreWorkspaceActions':
    workbenchShellEnUS.generated.workspaceSessionList.moreWorkspaceActions,
  'workspaceSessionList.loadedSkills':
    workbenchShellEnUS.generated.workspaceSessionList.loadedSkills,
  'workspaceSessionList.loadedMCP': workbenchShellEnUS.generated.workspaceSessionList.loadedMCP,
  'workspaceSessionList.cleanupSessions':
    workbenchShellEnUS.generated.workspaceSessionList.cleanupSessions,
  'workspaceSessionList.pinned': workbenchShellEnUS.generated.workspaceSessionList.pinned,
  'workspaceSessionList.pinned2': workbenchShellEnUS.generated.workspaceSessionList.pinned2,
  'workspaceSessionList.hasUnreadNotifications':
    workbenchShellEnUS.generated.workspaceSessionList.hasUnreadNotifications,
  'workspaceSessionList.hasUnreadNotifications2':
    workbenchShellEnUS.generated.workspaceSessionList.hasUnreadNotifications2,
  'workspaceSessionList.unread': workbenchShellEnUS.generated.workspaceSessionList.unread,
  'workspaceSessionList.moreSessionActions':
    workbenchShellEnUS.generated.workspaceSessionList.moreSessionActions,
  'workspaceSessionList.moreSessionActions2':
    workbenchShellEnUS.generated.workspaceSessionList.moreSessionActions2,
  'workspaceSessionList.pin': workbenchShellEnUS.generated.workspaceSessionList.pin,
  'workspaceSessionList.unpin': workbenchShellEnUS.generated.workspaceSessionList.unpin,
  'workspaceSessionList.moveUp': workbenchShellEnUS.generated.workspaceSessionList.moveUp,
  'workspaceSessionList.moveDown': workbenchShellEnUS.generated.workspaceSessionList.moveDown,
  'workspaceSessionList.rename': workbenchShellEnUS.generated.workspaceSessionList.rename,
  'workspaceSessionList.delete': workbenchShellEnUS.generated.workspaceSessionList.delete,
  'workspaceSessionList.loadMoreSessions':
    workbenchShellEnUS.generated.workspaceSessionList.loadMoreSessions,
  'workspaceSessionList.loading': workbenchShellEnUS.generated.workspaceSessionList.loading,
  'workspaceSessionList.loadMore': workbenchShellEnUS.generated.workspaceSessionList.loadMore,
  'workspaceSessionList.syncingOpenCodeCodexAndClaudeCodeSessions':
    workbenchShellEnUS.generated.workspaceSessionList.syncingOpenCodeCodexAndClaudeCodeSessions,
  'workspaceSessionList.currentSkills':
    workbenchShellEnUS.generated.workspaceSessionList.currentSkills,
  'workspaceSessionList.thisWorkspaceHasNoAvailableSkills':
    workbenchShellEnUS.generated.workspaceSessionList.thisWorkspaceHasNoAvailableSkills,
  'workspaceSessionList.noDescription':
    workbenchShellEnUS.generated.workspaceSessionList.noDescription,
  'workspaceSessionList.loadedMCP2': workbenchShellEnUS.generated.workspaceSessionList.loadedMCP2,
  'workspaceSessionList.thisWorkspaceHasNoLoadedMCPServers':
    workbenchShellEnUS.generated.workspaceSessionList.thisWorkspaceHasNoLoadedMCPServers,
  'workspaceSessionList.loaded': workbenchShellEnUS.generated.workspaceSessionList.loaded,
  'workspaceSessionList.marScheduleMcp':
    workbenchShellEnUS.generated.workspaceSessionList.marScheduleMcp,
  'workspaceSessionList.marNotificationMcp':
    workbenchShellEnUS.generated.workspaceSessionList.marNotificationMcp,
  'workspaceSessionList.executionInjected':
    workbenchShellEnUS.generated.workspaceSessionList.executionInjected,
  'workspaceSessionList.builtInMcp': workbenchShellEnUS.generated.workspaceSessionList.builtInMcp,
  'workspaceSessionCleanupDialog.title':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.title,
  'workspaceSessionCleanupDialog.description':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.description,
  'workspaceSessionCleanupDialog.inactiveDays':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.inactiveDays,
  'workspaceSessionCleanupDialog.inactiveDaysInvalid':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.inactiveDaysInvalid,
  'workspaceSessionCleanupDialog.cancel':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.cancel,
  'workspaceSessionCleanupDialog.cleanup':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.cleanup,
  'workspaceSessionCleanupDialog.cleaning':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.cleaning,
  'workspaceSessionCleanupDialog.cleanupFailed':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.cleanupFailed,
  'workspaceSessionCleanupDialog.completed':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.completed,
  'workspaceSessionCleanupDialog.deleted':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.deleted,
  'workspaceSessionCleanupDialog.skipped':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.skipped,
  'workspaceSessionCleanupDialog.failed':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.failed,
  'workspaceSessionCleanupDialog.byRunner':
    workbenchShellEnUS.generated.workspaceSessionCleanupDialog.byRunner,
  'environmentSecretManager.selectAnOrganization': 'Select an organization',
  'environmentSecretManager.deleteEnvironmentSecretNewConversationRunsAnd':
    environmentSecretsEnUS.generated.environmentSecretManager
      .deleteEnvironmentSecretNewConversationRunsAnd,
  'environmentSecretManager.deleteSecret':
    environmentSecretsEnUS.generated.environmentSecretManager.deleteSecret,
  'environmentSecretManager.deleteSecret2':
    environmentSecretsEnUS.generated.environmentSecretManager.deleteSecret2,
  'environmentSecretManager.cancel':
    environmentSecretsEnUS.generated.environmentSecretManager.cancel,
  'environmentSecretManager.environmentSecrets':
    environmentSecretsEnUS.generated.environmentSecretManager.environmentSecrets,
  'environmentSecretManager.secretName':
    environmentSecretsEnUS.generated.environmentSecretManager.secretName,
  'environmentSecretManager.enterASecretName':
    environmentSecretsEnUS.generated.environmentSecretManager.enterASecretName,
  'environmentSecretManager.refresh':
    environmentSecretsEnUS.generated.environmentSecretManager.refresh,
  'environmentSecretManager.addSecret':
    environmentSecretsEnUS.generated.environmentSecretManager.addSecret,
  'environmentSecretManager.environmentSecretList':
    environmentSecretsEnUS.generated.environmentSecretManager.environmentSecretList,
  'environmentSecretManager.name': environmentSecretsEnUS.generated.environmentSecretManager.name,
  'environmentSecretManager.value': environmentSecretsEnUS.generated.environmentSecretManager.value,
  'environmentSecretManager.scope': environmentSecretsEnUS.generated.environmentSecretManager.scope,
  'environmentSecretManager.personal':
    environmentSecretsEnUS.generated.environmentSecretManager.personal,
  'environmentSecretManager.node': environmentSecretsEnUS.generated.environmentSecretManager.node,
  'environmentSecretManager.organization': 'Organization',
  'environmentSecretManager.owner': environmentSecretsEnUS.generated.environmentSecretManager.owner,
  'environmentSecretManager.personal2':
    environmentSecretsEnUS.generated.environmentSecretManager.personal2,
  'environmentSecretManager.visibility':
    environmentSecretsEnUS.generated.environmentSecretManager.visibility,
  'environmentSecretManager.public': 'Public',
  'environmentSecretManager.private': 'Private',
  'environmentSecretManager.actions':
    environmentSecretsEnUS.generated.environmentSecretManager.actions,
  'environmentSecretManager.updateValue':
    environmentSecretsEnUS.generated.environmentSecretManager.updateValue,
  'environmentSecretManager.delete':
    environmentSecretsEnUS.generated.environmentSecretManager.delete,
  'environmentSecretManager.addSecret2':
    environmentSecretsEnUS.generated.environmentSecretManager.addSecret2,
  'environmentSecretManager.updateSecretValue':
    environmentSecretsEnUS.generated.environmentSecretManager.updateSecretValue,
  'environmentSecretManager.scope2':
    environmentSecretsEnUS.generated.environmentSecretManager.scope2,
  'environmentSecretManager.selectAScope':
    environmentSecretsEnUS.generated.environmentSecretManager.selectAScope,
  'environmentSecretManager.personal3': 'Personal',
  'environmentSecretManager.node2': 'Node',
  'environmentSecretManager.organization2': 'Organization',
  'environmentSecretManager.visibility2': 'Visibility',
  'environmentSecretManager.selectVisibility': 'Select visibility',
  'environmentSecretManager.privateThisOrganizationOnly': 'Private (this organization only)',
  'environmentSecretManager.publicInheritedByChildOrganizations':
    'Public (inherited by child organizations)',
  'environmentSecretManager.organization3': 'Organization',
  'environmentSecretManager.selectAnOrganization2': 'Select an organization',
  'environmentSecretManager.environmentVariableName':
    environmentSecretsEnUS.generated.environmentSecretManager.environmentVariableName,
  'environmentSecretManager.enterAnEnvironmentVariableName':
    environmentSecretsEnUS.generated.environmentSecretManager.enterAnEnvironmentVariableName,
  'environmentSecretManager.secretValue':
    environmentSecretsEnUS.generated.environmentSecretManager.secretValue,
  'environmentSecretManager.enterASecretValue':
    environmentSecretsEnUS.generated.environmentSecretManager.enterASecretValue,
  'environmentSecretManager.cancel2':
    environmentSecretsEnUS.generated.environmentSecretManager.cancel2,
  'environmentSecretManager.save': environmentSecretsEnUS.generated.environmentSecretManager.save,

  'systemConfigurationPage.unableToLoadSystemConfiguration':
    systemConfigurationEnUS.generated.systemConfigurationPage.unableToLoadSystemConfiguration,
  'systemConfigurationPage.skillTLSConfigurationSaved': 'Skill TLS configuration saved',
  'systemConfigurationPage.unableToSaveSkillTLSConfiguration':
    'Unable to save Skill TLS configuration',
  'systemConfigurationPage.systemConfigurationSaved':
    systemConfigurationEnUS.generated.systemConfigurationPage.systemConfigurationSaved,
  'systemConfigurationPage.unableToSaveSystemConfiguration':
    systemConfigurationEnUS.generated.systemConfigurationPage.unableToSaveSystemConfiguration,
  'systemConfigurationPage.systemConfiguration':
    systemConfigurationEnUS.generated.systemConfigurationPage.systemConfiguration,
  'systemConfigurationPage.manageEnterpriseRuntimeSettings': 'Manage enterprise runtime settings.',
  'systemConfigurationPage.refresh':
    systemConfigurationEnUS.generated.systemConfigurationPage.refresh,
  'systemConfigurationPage.auditRetentionDays': 'Audit Retention Days',
  'systemConfigurationPage.theServerRemovesExpiredEventsInBatches':
    'The server removes expired events in batches. Valid range: 1–3650 days.',
  'systemConfigurationPage.setting':
    systemConfigurationEnUS.generated.systemConfigurationPage.setting,
  'systemConfigurationPage.description':
    systemConfigurationEnUS.generated.systemConfigurationPage.description,
  'systemConfigurationPage.value': systemConfigurationEnUS.generated.systemConfigurationPage.value,
  'systemConfigurationPage.enterRetentionDays': 'Enter retention days',
  'systemConfigurationPage.actions':
    systemConfigurationEnUS.generated.systemConfigurationPage.actions,
  'systemConfigurationPage.edit': systemConfigurationEnUS.generated.systemConfigurationPage.edit,
  'systemConfigurationPage.save': systemConfigurationEnUS.generated.systemConfigurationPage.save,
  'systemConfigurationPage.skillSourceTLSCertificateVerificationIsDisabled':
    systemConfigurationEnUS.generated.systemConfigurationPage
      .skillSourceTLSCertificateVerificationIsDisabled,
  'systemConfigurationPage.disableSkillSourceTLSVerification':
    systemConfigurationEnUS.generated.systemConfigurationPage.disableSkillSourceTLSVerification,
  'systemConfigurationPage.keepThisOffByDefaultUseIt':
    systemConfigurationEnUS.generated.systemConfigurationPage.keepThisOffByDefaultUseIt,
  'nodeDetailsDialogs.nodeDetails': resourceDetailsEnUS.generated.nodeDetailsDialogs.nodeDetails,
  'nodeDetailsDialogs.name': resourceDetailsEnUS.generated.nodeDetailsDialogs.name,
  'nodeDetailsDialogs.registeredAddress':
    resourceDetailsEnUS.generated.nodeDetailsDialogs.registeredAddress,
  'nodeDetailsDialogs.system': resourceDetailsEnUS.generated.nodeDetailsDialogs.system,
  'nodeDetailsDialogs.unknown': resourceDetailsEnUS.generated.nodeDetailsDialogs.unknown,
  'nodeDetailsDialogs.nodeVersion': resourceDetailsEnUS.generated.nodeDetailsDialogs.nodeVersion,
  'nodeDetailsDialogs.toolEnvironment':
    resourceDetailsEnUS.generated.nodeDetailsDialogs.toolEnvironment,
  'nodeDetailsDialogs.computerUse': resourceDetailsEnUS.generated.nodeDetailsDialogs.computerUse,
  'nodeDetailsDialogs.computerUseEnabled':
    resourceDetailsEnUS.generated.nodeDetailsDialogs.computerUseEnabled,
  'nodeDetailsDialogs.computerUseDisabled':
    resourceDetailsEnUS.generated.nodeDetailsDialogs.computerUseDisabled,
  'nodeDetailsDialogs.status': resourceDetailsEnUS.generated.nodeDetailsDialogs.status,
  'nodeDetailsDialogs.disabled': resourceDetailsEnUS.generated.nodeDetailsDialogs.disabled,
  'nodeDetailsDialogs.online': resourceDetailsEnUS.generated.nodeDetailsDialogs.online,
  'nodeDetailsDialogs.offline': resourceDetailsEnUS.generated.nodeDetailsDialogs.offline,
  'nodeDetailsDialogs.supportedAgents':
    resourceDetailsEnUS.generated.nodeDetailsDialogs.supportedAgents,
  'nodeDetailsDialogs.available': resourceDetailsEnUS.generated.nodeDetailsDialogs.available,
  'nodeDetailsDialogs.none': resourceDetailsEnUS.generated.nodeDetailsDialogs.none,
  'nodeDetailsDialogs.close': resourceDetailsEnUS.generated.nodeDetailsDialogs.close,
  'nodeDetailsDialogs.deleteNode': 'Delete Node',
  'nodeDetailsDialogs.resets': resourceDetailsEnUS.generated.nodeDetailsDialogs.resets,
  'nodeDetailsDialogs.updated': resourceDetailsEnUS.generated.nodeDetailsDialogs.updated,
  'nodeDetailsDialogs.close2': resourceDetailsEnUS.generated.nodeDetailsDialogs.close2,
  'settingsContent.unableToLoadOAuthBindings': 'Unable to load OAuth bindings',
  'settingsContent.unableToStartOAuthBinding': 'Unable to start OAuth binding',
  'settingsContent.unbindFromTheCurrentAccount': 'Unbind “{value0}” from the current account?',
  'settingsContent.unbindOAuth': 'Unbind OAuth',
  'settingsContent.oAuthBindingRemoved': 'OAuth binding removed',
  'settingsContent.unableToRemoveOAuthBinding': 'Unable to remove OAuth binding',
  'settingsContent.accountSecurity': personalSettingsEnUS.generated.settingsContent.accountSecurity,
  'settingsContent.currentAccountAdminUpTo5Devices':
    personalSettingsEnUS.generated.settingsContent.currentAccountAdminUpTo5Devices,
  'settingsContent.signInSessions': personalSettingsEnUS.generated.settingsContent.signInSessions,
  'settingsContent.signInSessions5': personalSettingsEnUS.generated.settingsContent.signInSessions5,
  'settingsContent.refreshSignInSessions':
    personalSettingsEnUS.generated.settingsContent.refreshSignInSessions,
  'settingsContent.noActiveSignInSessions':
    personalSettingsEnUS.generated.settingsContent.noActiveSignInSessions,
  'settingsContent.currentDevice': personalSettingsEnUS.generated.settingsContent.currentDevice,
  'settingsContent.signedInDevice': personalSettingsEnUS.generated.settingsContent.signedInDevice,
  'settingsContent.signedIn': personalSettingsEnUS.generated.settingsContent.signedIn,
  'settingsContent.expires': personalSettingsEnUS.generated.settingsContent.expires,
  'settingsContent.signOut': personalSettingsEnUS.generated.settingsContent.signOut,
  'settingsContent.confirmSignOutSession':
    personalSettingsEnUS.generated.settingsContent.confirmSignOutSession,
  'settingsContent.oAuthAccountBindings': 'OAuth Account Bindings',
  'settingsContent.oAuthAccountBindings2': 'OAuth Account Bindings',
  'settingsContent.refresh': 'Refresh',
  'settingsContent.identityProvider': 'Identity Provider',
  'settingsContent.status': 'Status',
  'settingsContent.bound': 'Bound',
  'settingsContent.notBound': 'Not Bound',
  'settingsContent.actions': 'Actions',
  'settingsContent.bind': 'Bind',
  'settingsContent.unbind': 'Unbind',
  'settingsContent.changePassword': personalSettingsEnUS.generated.settingsContent.changePassword,
  'settingsContent.signOut2': personalSettingsEnUS.generated.settingsContent.signOut2,
  'settingsContent.confirmSignOut': personalSettingsEnUS.generated.settingsContent.confirmSignOut,
  'settingsContent.changePassword2': personalSettingsEnUS.generated.settingsContent.changePassword2,
  'settingsContent.currentPassword': personalSettingsEnUS.generated.settingsContent.currentPassword,
  'settingsContent.enterCurrentPassword':
    personalSettingsEnUS.generated.settingsContent.enterCurrentPassword,
  'settingsContent.currentPassword2':
    personalSettingsEnUS.generated.settingsContent.currentPassword2,
  'settingsContent.newPassword': personalSettingsEnUS.generated.settingsContent.newPassword,
  'settingsContent.enterNewPassword':
    personalSettingsEnUS.generated.settingsContent.enterNewPassword,
  'settingsContent.newPassword2': personalSettingsEnUS.generated.settingsContent.newPassword2,
  'settingsContent.confirmNewPassword':
    personalSettingsEnUS.generated.settingsContent.confirmNewPassword,
  'settingsContent.enterTheNewPasswordAgain':
    personalSettingsEnUS.generated.settingsContent.enterTheNewPasswordAgain,
  'settingsContent.confirmNewPassword2':
    personalSettingsEnUS.generated.settingsContent.confirmNewPassword2,
  'settingsContent.cancel': personalSettingsEnUS.generated.settingsContent.cancel,
  'settingsContent.confirmChange': personalSettingsEnUS.generated.settingsContent.confirmChange,
  'settingsContent.nodeRegistration':
    personalSettingsEnUS.generated.settingsContent.nodeRegistration,
  'settingsContent.createAOneTimeTokenThenComplete':
    personalSettingsEnUS.generated.settingsContent.createAOneTimeTokenThenComplete,
  'settingsContent.viewNodeDeploymentAndAutoStartGuide':
    personalSettingsEnUS.generated.settingsContent.viewNodeDeploymentAndAutoStartGuide,
  'settingsContent.nodeOwnership': 'Node Ownership',
  'settingsContent.selectOwnership': 'Select ownership',
  'settingsContent.personal': 'Personal',
  'settingsContent.createOneTimeNodeRegistrationToken':
    personalSettingsEnUS.generated.settingsContent.createOneTimeNodeRegistrationToken,
  'settingsContent.keyboardShortcuts':
    personalSettingsEnUS.generated.settingsContent.keyboardShortcuts,
  'settingsContent.theFollowingShortcutsAreAvailableInThe':
    personalSettingsEnUS.generated.settingsContent.theFollowingShortcutsAreAvailableInThe,
  'settingsContent.quickOpenFilesInTheCurrentWorkspace':
    'Quick Open Workspaces, Sessions, Symbols, or Files',
  'settingsContent.switchTheInspectorToGitChanges': 'Switch the Inspector to Git Changes',
  'settingsContent.searchFileContentsInTheCurrentWorkspace':
    'Search File Contents in the Current Workspace',
  'settingsContent.expandAndFocusTheSelectedWorkspaceTerminal':
    'Expand and Focus the Selected Workspace Terminal',
  'workbenchNotificationCenter.openNotificationCenter':
    notificationsEnUS.generated.workbenchNotificationCenter.openNotificationCenter,
  'workbenchNotificationCenter.notificationCenter':
    notificationsEnUS.generated.workbenchNotificationCenter.notificationCenter,
  'workbenchNotificationCenter.notifications':
    notificationsEnUS.generated.workbenchNotificationCenter.notifications,
  'workbenchNotificationCenter.markAllRead':
    notificationsEnUS.generated.workbenchNotificationCenter.markAllRead,
  'workbenchNotificationCenter.clearAll':
    notificationsEnUS.generated.workbenchNotificationCenter.clearAll,
  'workbenchNotificationCenter.fileTransfers':
    notificationsEnUS.generated.workbenchNotificationCenter.fileTransfers,
  'workbenchNotificationCenter.resume':
    notificationsEnUS.generated.workbenchNotificationCenter.resume,
  'workbenchNotificationCenter.retry':
    notificationsEnUS.generated.workbenchNotificationCenter.retry,
  'workbenchNotificationCenter.delete':
    notificationsEnUS.generated.workbenchNotificationCenter.delete,
  'workbenchNotificationCenter.cancel':
    notificationsEnUS.generated.workbenchNotificationCenter.cancel,
  'workbenchNotificationCenter.noNotifications':
    notificationsEnUS.generated.workbenchNotificationCenter.noNotifications,
  'workbenchNotificationCenter.unread':
    notificationsEnUS.generated.workbenchNotificationCenter.unread,
  'workbenchNotificationCenter.deleteNotification':
    notificationsEnUS.generated.workbenchNotificationCenter.deleteNotification,
  'workspaceRegistrationPicker.enterADirectoryName':
    workspaceEnUS.generated.workspaceRegistrationPicker.enterADirectoryName,
  'workspaceRegistrationPicker.enterASingleDirectoryNameWithoutPath':
    workspaceEnUS.generated.workspaceRegistrationPicker.enterASingleDirectoryNameWithoutPath,
  'workspaceRegistrationPicker.registerANewWorkspace':
    workspaceEnUS.generated.workspaceRegistrationPicker.registerANewWorkspace,
  'workspaceRegistrationPicker.resourceOwner': 'Resource Owner',
  'workspaceRegistrationPicker.personal': 'Personal',
  'workspaceRegistrationPicker.mEMBERUsersCannotCreateOrganizationWorkspaces':
    'MEMBER users cannot create organization workspaces',
  'workspaceRegistrationPicker.goToParentDirectory':
    workspaceEnUS.generated.workspaceRegistrationPicker.goToParentDirectory,
  'workspaceRegistrationPicker.goToParentDirectory2':
    workspaceEnUS.generated.workspaceRegistrationPicker.goToParentDirectory2,
  'workspaceRegistrationPicker.up': workspaceEnUS.generated.workspaceRegistrationPicker.up,
  'workspaceRegistrationPicker.roots': workspaceEnUS.generated.workspaceRegistrationPicker.roots,
  'workspaceRegistrationPicker.currentDirectory':
    workspaceEnUS.generated.workspaceRegistrationPicker.currentDirectory,
  'workspaceRegistrationPicker.refreshDirectory':
    workspaceEnUS.generated.workspaceRegistrationPicker.refreshDirectory,
  'workspaceRegistrationPicker.refreshDirectory2':
    workspaceEnUS.generated.workspaceRegistrationPicker.refreshDirectory2,
  'workspaceRegistrationPicker.newDirectory':
    workspaceEnUS.generated.workspaceRegistrationPicker.newDirectory,
  'workspaceRegistrationPicker.selectCurrentDirectory':
    workspaceEnUS.generated.workspaceRegistrationPicker.selectCurrentDirectory,
  'workspaceRegistrationPicker.pending':
    workspaceEnUS.generated.workspaceRegistrationPicker.pending,
  'workspaceRegistrationPicker.cancelNewDirectory':
    workspaceEnUS.generated.workspaceRegistrationPicker.cancelNewDirectory,
  'workspaceRegistrationPicker.cancelNewDirectory2':
    workspaceEnUS.generated.workspaceRegistrationPicker.cancelNewDirectory2,
  'workspaceRegistrationPicker.outsideAllowedRoots':
    workspaceEnUS.generated.workspaceRegistrationPicker.outsideAllowedRoots,
  'workspaceRegistrationPicker.open': workspaceEnUS.generated.workspaceRegistrationPicker.open,
  'workspaceRegistrationPicker.open2': workspaceEnUS.generated.workspaceRegistrationPicker.open2,
  'workspaceRegistrationPicker.loadingAllowedRoots':
    workspaceEnUS.generated.workspaceRegistrationPicker.loadingAllowedRoots,
  'workspaceRegistrationPicker.expandAndSelectADirectoryToRegister':
    workspaceEnUS.generated.workspaceRegistrationPicker.expandAndSelectADirectoryToRegister,
  'workspaceRegistrationPicker.onlyTheFirst200ChildDirectoriesAre':
    workspaceEnUS.generated.workspaceRegistrationPicker.onlyTheFirst200ChildDirectoriesAre,
  'workspaceRegistrationPicker.selected':
    workspaceEnUS.generated.workspaceRegistrationPicker.selected,
  'workspaceRegistrationPicker.createAndRegister':
    workspaceEnUS.generated.workspaceRegistrationPicker.createAndRegister,
  'workspaceRegistrationPicker.registerWorkspace':
    workspaceEnUS.generated.workspaceRegistrationPicker.registerWorkspace,
  'workspaceRegistrationPicker.newDirectory2':
    workspaceEnUS.generated.workspaceRegistrationPicker.newDirectory2,
  'workspaceRegistrationPicker.directoryName':
    workspaceEnUS.generated.workspaceRegistrationPicker.directoryName,
  'workspaceRegistrationPicker.enterADirectoryName2':
    workspaceEnUS.generated.workspaceRegistrationPicker.enterADirectoryName2,
  'workspaceRegistrationPicker.cancel': workspaceEnUS.generated.workspaceRegistrationPicker.cancel,
  'workspaceRegistrationPicker.confirm':
    workspaceEnUS.generated.workspaceRegistrationPicker.confirm,
  'secretManagementPage.unableToLoadOrganizations': 'Unable to load organizations',
  'secretManagementPage.secretManagement':
    environmentSecretsEnUS.generated.secretManagementPage.secretManagement,
  'secretManagementPage.managePersonalAndOrganizationEnvironmentSecretsManage':
    'Manage sensitive information required by Agents and terminals at personal and organization scopes. It is injected through environment variables when new Agent runs and terminals start. Manage Node environment secrets in Node details.',
  'userManagementPage.userCreated': 'User Created',
  'userManagementPage.userDetails': 'User details',
  'userManagementPage.unableToCreateUser': 'Unable to create user',
  'userManagementPage.passwordReset': 'Password Reset',
  'userManagementPage.unableToResetPassword': 'Unable to reset password',
  'userManagementPage.resetThePasswordForTheUserMust':
    'Reset the password for “{value0}”? The user must sign in with the new temporary password and change it.',
  'userManagementPage.resetPassword': 'Reset Password',
  'userManagementPage.resetPassword2': 'Reset password',
  'userManagementPage.cancel': 'Cancel',
  'userManagementPage.unableToDeleteUser': 'Unable to delete user',
  'userManagementPage.deleteUserNodesRegisteredByThisUser':
    'Delete user “{value0}”? Nodes registered by this user will also be deleted.',
  'userManagementPage.deleteUser': 'Delete User',
  'userManagementPage.deleteUser2': 'Delete user',
  'userManagementPage.cancel2': 'Cancel',
  'userManagementPage.usernamePassword': 'Username: {value0}\nPassword: {value1}',
  'userManagementPage.userManagement': 'User Management',
  'userManagementPage.createUsersResetPasswordsOrDeleteUsers':
    'Create users, reset passwords, or delete users.',
  'userManagementPage.createUser': 'Create user',
  'userManagementPage.username': 'Username',
  'userManagementPage.email': 'Email',
  'userManagementPage.nickname': 'Nickname',
  'userManagementPage.role': 'Role',
  'userManagementPage.administrator': 'Administrator',
  'userManagementPage.user': 'User',
  'userManagementPage.actions': 'Actions',
  'userManagementPage.resetPassword3': 'Reset password',
  'userManagementPage.delete': 'Delete',
  'userManagementPage.createUser2': 'Create User',
  'userManagementPage.username2': 'Username',
  'userManagementPage.email2': 'Email',
  'userManagementPage.nickname2': 'Nickname',
  'userManagementPage.cancel3': 'Cancel',
  'userManagementPage.createUser3': 'Create user',
  'userManagementPage.copyAndSecurelyDeliverTheseCredentials':
    '{value0}. Copy and securely deliver these credentials.',
  'userManagementPage.username3': 'Username',
  'userManagementPage.temporaryPassword': 'Temporary Password',
  'userManagementPage.copyUsernameAndPassword': 'Copy username and password',
  'userManagementPage.theUserMustChangeThePasswordAfter':
    'The user must change the password after signing in for the first time.',
  'organizationUserManagementPage.enterAnOrganizationName': 'Enter an organization name',
  'organizationUserManagementPage.theOrganizationNameCannotExceed128Characters':
    'The organization name cannot exceed 128 characters',
  'organizationUserManagementPage.enterAUsername': 'Enter a username',
  'organizationUserManagementPage.theUsernameCannotExceed80Characters':
    'The username cannot exceed 80 characters',
  'organizationUserManagementPage.enterAValidEmailAddress': 'Enter a valid email address',
  'organizationUserManagementPage.theEmailAddressCannotExceed254Characters':
    'The email address cannot exceed 254 characters',
  'organizationUserManagementPage.theDisplayNameCannotExceed80Characters':
    'The display name cannot exceed 80 characters',
  'organizationUserManagementPage.selectARole': 'Select a role',
  'organizationUserManagementPage.selectAnOrganization': 'Select an organization',
  'organizationUserManagementPage.unableToLoadOrganizationsAndUsers':
    'Unable to load organizations and users',
  'organizationUserManagementPage.unableToSaveOrganization': 'Unable to save organization',
  'organizationUserManagementPage.userCreated': 'User Created',
  'organizationUserManagementPage.unableToCreateUser': 'Unable to create user',
  'organizationUserManagementPage.userUpdated': 'User updated',
  'organizationUserManagementPage.unableToUpdateUser': 'Unable to update user',
  'organizationUserManagementPage.resetThePasswordForExistingSessionsWill':
    'Reset the password for “{value0}”? Existing sessions will be revoked immediately.',
  'organizationUserManagementPage.resetPassword': 'Reset Password',
  'organizationUserManagementPage.resetPassword2': 'Reset password',
  'organizationUserManagementPage.cancel': 'Cancel',
  'organizationUserManagementPage.passwordReset': 'Password Reset',
  'organizationUserManagementPage.usernamePassword': 'Username: {value0}\nPassword: {value1}',
  'organizationUserManagementPage.usernameAndPasswordCopied': 'Username and password copied.',
  'organizationUserManagementPage.unableToAccessTheClipboardCopyThe':
    'Unable to access the clipboard. Copy the username and password manually.',
  'organizationUserManagementPage.deletingRemovesPersonalNodesPersonalWorkspacesSessions':
    'Deleting “{value0}” removes {value1} personal nodes, {value2} personal workspaces, {value3} sessions, {value4} external identities, and {value5} direct grants from the server. Directories and files on node hosts are not deleted.',
  'organizationUserManagementPage.deleteUser': 'Delete User',
  'organizationUserManagementPage.deleteUser2': 'Delete user',
  'organizationUserManagementPage.cancel2': 'Cancel',
  'organizationUserManagementPage.deleteItsOrganizationResourcesWillBeTransferred':
    'Delete “{value0}”? Its organization resources will be transferred to the parent organization.',
  'organizationUserManagementPage.deleteOrganization': 'Delete Organization',
  'organizationUserManagementPage.deleteOrganization2': 'Delete organization',
  'organizationUserManagementPage.cancel3': 'Cancel',
  'organizationUserManagementPage.organizationManagement': 'Organization Management',
  'organizationUserManagementPage.userManagement': 'User Management',
  'organizationUserManagementPage.theOrganizationTreeDefinesPermissionInheritanceChild':
    'The organization tree defines permission inheritance. Child organizations can be created under any manageable level.',
  'organizationUserManagementPage.eachUserBelongsToOneOrganizationAnd':
    'Each user belongs to one organization and must have a role.',
  'organizationUserManagementPage.organization': 'Organization:',
  'organizationUserManagementPage.user': 'User:',
  'organizationUserManagementPage.enterAnOrganizationNameOrID': 'Name or ID',
  'organizationUserManagementPage.enterAUsernameEmailOrDisplayName': 'Name or email',
  'organizationUserManagementPage.role': 'Role:',
  'organizationUserManagementPage.selectARole2': 'Select a role',
  'organizationUserManagementPage.allRoles': 'All Roles',
  'organizationUserManagementPage.organization2': 'Organization:',
  'organizationUserManagementPage.selectAnOrganization2': 'Select organization',
  'organizationUserManagementPage.status': 'Status:',
  'organizationUserManagementPage.selectAStatus': 'Select a status',
  'organizationUserManagementPage.allStatuses': 'All Statuses',
  'organizationUserManagementPage.enabled': 'Enabled',
  'organizationUserManagementPage.disabled': 'Disabled',
  'organizationUserManagementPage.refresh': 'Refresh',
  'organizationUserManagementPage.createUser': 'Create user',
  'organizationUserManagementPage.organizationName': 'Organization Name',
  'organizationUserManagementPage.organizationID': 'Organization ID',
  'organizationUserManagementPage.organizationDetails': 'Organization details',
  'organizationUserManagementPage.userDetails': 'User details',
  'organizationUserManagementPage.rootOrganization': 'Root organization',
  'organizationUserManagementPage.actions': 'Actions',
  'organizationUserManagementPage.edit': 'Edit',
  'organizationUserManagementPage.addChild': 'Add child',
  'organizationUserManagementPage.delete': 'Delete',
  'organizationUserManagementPage.user2': 'User',
  'organizationUserManagementPage.email': 'Email',
  'organizationUserManagementPage.displayName': 'Display Name',
  'organizationUserManagementPage.role2': 'Role',
  'organizationUserManagementPage.organization3': 'Organization',
  'organizationUserManagementPage.status2': 'Status',
  'organizationUserManagementPage.enabled2': 'Enabled',
  'organizationUserManagementPage.disabled2': 'Disabled',
  'organizationUserManagementPage.actions2': 'Actions',
  'organizationUserManagementPage.edit2': 'Edit',
  'organizationUserManagementPage.resetPassword3': 'Reset password',
  'organizationUserManagementPage.delete2': 'Delete',
  'organizationUserManagementPage.createOrganization': 'Create Organization',
  'organizationUserManagementPage.editOrganization': 'Edit Organization',
  'organizationUserManagementPage.name': 'Name',
  'organizationUserManagementPage.enterAnOrganizationName2': 'Enter an organization name',
  'organizationUserManagementPage.parentOrganization': 'Parent Organization',
  'organizationUserManagementPage.parentOrganization2': 'Parent Organization',
  'organizationUserManagementPage.cancel4': 'Cancel',
  'organizationUserManagementPage.createOrganization2': 'Create organization',
  'organizationUserManagementPage.save': 'Save',
  'organizationUserManagementPage.createUser2': 'Create User',
  'organizationUserManagementPage.editUser': 'Edit User',
  'organizationUserManagementPage.username': 'Username',
  'organizationUserManagementPage.enterAUsername2': 'Enter a username',
  'organizationUserManagementPage.email2': 'Email',
  'organizationUserManagementPage.enterAnEmailAddressOptional': 'Enter an email address (optional)',
  'organizationUserManagementPage.displayName2': 'Display Name',
  'organizationUserManagementPage.enterADisplayNameOptional': 'Enter a display name (optional)',
  'organizationUserManagementPage.role3': 'Role',
  'organizationUserManagementPage.selectARole3': 'Select a role',
  'organizationUserManagementPage.organization4': 'Organization',
  'organizationUserManagementPage.selectAnOrganization3': 'Select an organization',
  'organizationUserManagementPage.cancel5': 'Cancel',
  'organizationUserManagementPage.createUser3': 'Create user',
  'organizationUserManagementPage.save2': 'Save',
  'organizationUserManagementPage.temporaryCredentialsAreShownOnlyOnceThe':
    'Temporary credentials are shown only once. The user must change the password after the first sign-in.',
  'organizationUserManagementPage.username2': 'Username',
  'organizationUserManagementPage.temporaryPassword': 'Temporary Password',
  'organizationUserManagementPage.copyUsernameAndPassword': 'Copy username and password',
  'organizationUserManagementPage.done': 'Done',
  'licenseManagementPage.enterprise': 'Enterprise',
  'licenseManagementPage.personal': 'Community',
  'licenseManagementPage.permanent': 'Permanent',
  'licenseManagementPage.unableToGenerateLicenseRequestCode':
    'Unable to generate license request code',
  'licenseManagementPage.unableToLoadLicense': 'Unable to load license',
  'licenseManagementPage.licenseRequestCodeCopied': 'License request code copied.',
  'licenseManagementPage.unableToCopyCheckBrowserClipboardPermissions':
    'Unable to copy. Check browser clipboard permissions.',
  'licenseManagementPage.licenseImported': 'License imported',
  'licenseManagementPage.unableToImportLicense': 'Unable to import license',
  'licenseManagementPage.viewTheCurrentLicenseStatusAndImport':
    'View the current license status and import a license bound to this deployment.',
  'licenseManagementPage.license': 'License',
  'licenseManagementPage.licenseStatus': 'License Status',
  'licenseManagementPage.edition': 'Edition',
  'licenseManagementPage.expired': 'Expired',
  'licenseManagementPage.organization': 'Organization',
  'licenseManagementPage.expires': 'Expires',
  'licenseManagementPage.statusReason': 'Status Reason',
  'licenseManagementPage.licenseRequestCode': 'License Request Code',
  'licenseManagementPage.generating': 'Generating…',
  'licenseManagementPage.generationFailed': 'Generation failed',
  'licenseManagementPage.copyLicenseRequestCode': 'Copy license request code',
  'licenseManagementPage.copy': 'Copy',
  'licenseManagementPage.sendThisCodeToTheLicenseIssuer':
    'Send this code to the license issuer to generate a license for this deployment. Reopening this page generates a new code.',
  'licenseManagementPage.licenseDocument': 'License Document',
  'licenseManagementPage.pasteTheCompleteLicenseDocument': 'Paste the complete license document',
  'licenseManagementPage.importLicense': 'Import license',
  'nodeRuntimeEnvironment.available':
    resourceDetailsEnUS.generated.nodeRuntimeEnvironment.available,
  'nodeRuntimeEnvironment.computerUseDisabled':
    resourceDetailsEnUS.generated.nodeRuntimeEnvironment.computerUseDisabled,
  'nodeRuntimeEnvironment.computerUseInitializing':
    resourceDetailsEnUS.generated.nodeRuntimeEnvironment.computerUseInitializing,
  'nodeRuntimeEnvironment.computerUseAvailable':
    resourceDetailsEnUS.generated.nodeRuntimeEnvironment.computerUseAvailable,
  'nodeRuntimeEnvironment.computerUseUnavailable':
    resourceDetailsEnUS.generated.nodeRuntimeEnvironment.computerUseUnavailable,
  'nodeRuntimeEnvironment.gui': resourceDetailsEnUS.generated.nodeRuntimeEnvironment.gui,
  'nodeRuntimeEnvironment.pyAutoGui':
    resourceDetailsEnUS.generated.nodeRuntimeEnvironment.pyAutoGui,
  'nodeRuntimeEnvironment.notFound': resourceDetailsEnUS.generated.nodeRuntimeEnvironment.notFound,
  'nodeRuntimeEnvironment.theNodeHasNotReportedItsEnvironment':
    resourceDetailsEnUS.generated.nodeRuntimeEnvironment.theNodeHasNotReportedItsEnvironment,
  'skillErrors.SKILL_SOURCE_IN_USE':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_IN_USE,
  'skillErrors.SKILL_SOURCE_LIMIT_EXCEEDED':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_LIMIT_EXCEEDED,
  'skillErrors.SKILL_SOURCE_QUERY_INVALID':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_QUERY_INVALID,
  'skillErrors.SKILL_SOURCE_PROVIDER_UNSUPPORTED':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_PROVIDER_UNSUPPORTED,
  'skillErrors.SKILL_SOURCE_UNAVAILABLE':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_UNAVAILABLE,
  'skillErrors.SKILL_SOURCE_ADDRESS_FORBIDDEN':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_ADDRESS_FORBIDDEN,
  'skillErrors.SKILL_SOURCE_RATE_LIMITED':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_RATE_LIMITED,
  'skillErrors.SKILL_SOURCE_RESPONSE_INVALID':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_RESPONSE_INVALID,
  'skillErrors.SKILL_SOURCE_DISABLED':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_DISABLED,
  'skillErrors.SKILL_SOURCE_NOT_FOUND':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_NOT_FOUND,
  'skillErrors.SKILL_SOURCE_FORBIDDEN':
    skillConfigurationEnUS.generated.skillErrors.SKILL_SOURCE_FORBIDDEN,
  'skillErrors.SKILL_FAVORITE_NOT_FOUND':
    skillConfigurationEnUS.generated.skillErrors.SKILL_FAVORITE_NOT_FOUND,
  'skillErrors.SKILL_FAVORITE_FORBIDDEN':
    skillConfigurationEnUS.generated.skillErrors.SKILL_FAVORITE_FORBIDDEN,
  'skillErrors.SKILL_INSTALL_FAILED':
    skillConfigurationEnUS.generated.skillErrors.SKILL_INSTALL_FAILED,
  'skillErrors.SKILL_INSTALL_STATUS_TIMEOUT':
    skillConfigurationEnUS.generated.skillErrors.SKILL_INSTALL_STATUS_TIMEOUT,
  'skillErrors.SKILL_CONTENT_INVALID':
    skillConfigurationEnUS.generated.skillErrors.SKILL_CONTENT_INVALID,
  'skillErrors.SKILL_INSTALL_INVALID_LINK':
    skillConfigurationEnUS.generated.skillErrors.SKILL_INSTALL_INVALID_LINK,
  'skillErrors.SKILL_INSTALL_RECOVERY_REQUIRED':
    skillConfigurationEnUS.generated.skillErrors.SKILL_INSTALL_RECOVERY_REQUIRED,
  'skillErrors.SKILL_NAME_CONFLICT':
    skillConfigurationEnUS.generated.skillErrors.SKILL_NAME_CONFLICT,
  'skillErrors.SKILL_TARGET_LIMIT_EXCEEDED':
    skillConfigurationEnUS.generated.skillErrors.SKILL_TARGET_LIMIT_EXCEEDED,
  'skillErrors.WORKSPACE_BUSY': skillConfigurationEnUS.generated.skillErrors.WORKSPACE_BUSY,
  'skillErrors.WORKSPACE_SKILL_GIT_EXCLUDE_FAILED':
    skillConfigurationEnUS.generated.skillErrors.WORKSPACE_SKILL_GIT_EXCLUDE_FAILED,
  'skillErrors.NODE_REQUEST_TIMEOUT':
    skillConfigurationEnUS.generated.skillErrors.NODE_REQUEST_TIMEOUT,
  'skillErrors.NODE_OFFLINE': skillConfigurationEnUS.generated.skillErrors.NODE_OFFLINE
};

export const generatedEnUS = expandGeneratedMessages(generatedEnUSFlat);
