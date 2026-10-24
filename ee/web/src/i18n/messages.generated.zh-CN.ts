import { resourceDetailsZhCN } from '@myagentroam/web-core/resource-details-messages';
import { catalogSourcesZhCN } from '@myagentroam/web-core/catalog-sources-messages';
import { systemConfigurationZhCN } from '@myagentroam/web-core/system-configuration-messages';
import { environmentSecretsZhCN } from '@myagentroam/web-core/environment-secrets-messages';
import { skillConfigurationZhCN } from '@myagentroam/web-core/skill-configuration-messages';
import { workbenchPageZhCN } from '@myagentroam/web-core/workbench-page-messages';
import { workbenchShellZhCN } from '@myagentroam/web-core/workbench-shell-messages';
import { workbenchCompositionZhCN } from '@myagentroam/web-core/workbench-composition-messages';
import { notificationsZhCN } from '@myagentroam/web-core/notification-messages';
import { personalSettingsZhCN } from '@myagentroam/web-core/settings-messages';
import { conversationUiZhCN } from '@myagentroam/web-core/conversation-ui-messages';
import { workspaceInspectorZhCN } from '@myagentroam/web-core/workspace-inspector-messages';
import { filePreviewZhCN } from '@myagentroam/web-core/file-preview-messages';
import { fileNavigationZhCN } from '@myagentroam/web-core/file-navigation-messages';
import { workspaceZhCN } from '@myagentroam/web-core/workspace-messages';
import { composerZhCN } from '@myagentroam/web-core/composer-messages';
import { terminalZhCN } from '@myagentroam/web-core/terminal-messages';
import { conversationHistoryZhCN } from '@myagentroam/web-core/conversation-messages';
import { sessionPresentationZhCN } from '@myagentroam/web-core/session-messages';
import { systemInformationZhCN } from '@myagentroam/web-core/system-messages';
import { authenticationZhCN } from '@myagentroam/web-core/auth-messages';
import { expandGeneratedMessages } from './messages.generated.js';

const generatedZhCNFlat: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(systemConfigurationZhCN.generated.systemConfigurationPage).map(
      ([key, value]) => [`systemConfigurationPage.${key}`, value]
    )
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiZhCN.generated.conversationHeader).map(([key, value]) => [
      `conversationHeader.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiZhCN.generated.conversationScroll).map(([key, value]) => [
      `conversationScroll.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiZhCN.generated.conversationTimeline).map(([key, value]) => [
      `conversationTimeline.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiZhCN.generated.conversationApprovals).map(([key, value]) => [
      `conversationApprovals.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiZhCN.generated.conversationPresentation).map(([key, value]) => [
      `conversationPresentation.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiZhCN.generated.imagePreviewDialogs).map(([key, value]) => [
      `imagePreviewDialogs.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiZhCN.generated.conversationImageService).map(([key, value]) => [
      `conversationImageService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationUiZhCN.generated.conversationDomain).map(([key, value]) => [
      `conversationDomain.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(workspaceInspectorZhCN.generated.workspaceInspector).map(([key, value]) => [
      `workspaceInspector.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(filePreviewZhCN.generated.gitDiffViewer).map(([key, value]) => [
      `gitDiffViewer.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(filePreviewZhCN.generated.standaloneFilePreviewPage).map(([key, value]) => [
      `standaloneFilePreviewPage.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(filePreviewZhCN.generated.filePreviewDialog).map(([key, value]) => [
      `filePreviewDialog.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(fileNavigationZhCN.generated.workspaceFileTree).map(([key, value]) => [
      `workspaceFileTree.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(fileNavigationZhCN.generated.quickOpenDialog).map(([key, value]) => [
      `quickOpenDialog.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(fileNavigationZhCN.generated.composerFileReferencePicker).map(([key, value]) => [
      `composerFileReferencePicker.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(composerZhCN.generated.composerAttachments).map(([key, value]) => [
      `composerAttachments.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerZhCN.generated.composerCommandPicker).map(([key, value]) => [
      `composerCommandPicker.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerZhCN.generated.composerQueue).map(([key, value]) => [
      `composerQueue.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerZhCN.generated.composerToolbar).map(([key, value]) => [
      `composerToolbar.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerZhCN.generated.conversationComposer).map(([key, value]) => [
      `conversationComposer.${key}`,
      value
    ])
  ),

  ...Object.fromEntries(
    Object.entries(composerZhCN.generated.workbenchRunControlService).map(([key, value]) => [
      `workbenchRunControlService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerZhCN.generated.composerAttachmentService).map(([key, value]) => [
      `composerAttachmentService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerZhCN.generated.workbenchComposerController).map(([key, value]) => [
      `workbenchComposerController.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(composerZhCN.generated.runnerProfileService).map(([key, value]) => [
      `runnerProfileService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(terminalZhCN.generated.terminalTabView).map(([key, value]) => [
      `terminalTabView.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(terminalZhCN.generated.terminalDock).map(([key, value]) => [
      `terminalDock.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(terminalZhCN.generated.terminalRelayService).map(([key, value]) => [
      `terminalRelayService.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(conversationHistoryZhCN.generated.workbenchConversationPagingService).map(
      ([key, value]) => [`workbenchConversationPagingService.${key}`, value]
    )
  ),
  ...Object.fromEntries(
    Object.entries(conversationHistoryZhCN.generated.conversationHistory).map(([key, value]) => [
      `conversationHistory.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(sessionPresentationZhCN.generated.sessionPresentation).map(([key, value]) => [
      `sessionPresentation.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(systemInformationZhCN.generated.settingsContent).map(([key, value]) => [
      `settingsContent.${key}`,
      value
    ])
  ),
  ...Object.fromEntries(
    Object.entries(authenticationZhCN.generated.adminAuthService).map(([key, value]) => [
      `adminAuthService.${key}`,
      value
    ])
  ),

  'workspaceUploadService.uploading': notificationsZhCN.generated.workspaceUploadService.uploading,
  'workspaceUploadService.queued': notificationsZhCN.generated.workspaceUploadService.queued,
  'workspaceUploadService.completed': notificationsZhCN.generated.workspaceUploadService.completed,
  'workspaceUploadService.canceled': notificationsZhCN.generated.workspaceUploadService.canceled,
  'workspaceUploadService.interrupted':
    notificationsZhCN.generated.workspaceUploadService.interrupted,
  'workspaceUploadService.failed': notificationsZhCN.generated.workspaceUploadService.failed,
  'workspaceUploadService.selectTheOriginalFileWithTheSame':
    notificationsZhCN.generated.workspaceUploadService.selectTheOriginalFileWithTheSame,
  'workspaceSessionService.unableToLoadMoreSessions':
    workspaceZhCN.generated.workspaceSessionService.unableToLoadMoreSessions,
  'workspaceSessionService.unableToSynchronizeSessions':
    workspaceZhCN.generated.workspaceSessionService.unableToSynchronizeSessions,

  'workbenchEntityService.leaveBlankToDisplayTheRegisteredAddress':
    workbenchCompositionZhCN.generated.workbenchEntityService
      .leaveBlankToDisplayTheRegisteredAddress,
  'workbenchEntityService.renameNode':
    workbenchCompositionZhCN.generated.workbenchEntityService.renameNode,
  'workbenchEntityService.nodeName':
    workbenchCompositionZhCN.generated.workbenchEntityService.nodeName,
  'workbenchEntityService.nodeNameCannotExceed80Characters':
    workbenchCompositionZhCN.generated.workbenchEntityService.nodeNameCannotExceed80Characters,
  'workbenchEntityService.save': workbenchCompositionZhCN.generated.workbenchEntityService.save,
  'workbenchEntityService.cancel': workbenchCompositionZhCN.generated.workbenchEntityService.cancel,
  'workbenchEntityService.unableToUpdateTheNodeName':
    workbenchCompositionZhCN.generated.workbenchEntityService.unableToUpdateTheNodeName,
  'workbenchEntityService.enterANonEmptySessionName':
    workbenchCompositionZhCN.generated.workbenchEntityService.enterANonEmptySessionName,
  'workbenchEntityService.renameSession':
    workbenchCompositionZhCN.generated.workbenchEntityService.renameSession,
  'workbenchEntityService.sessionName':
    workbenchCompositionZhCN.generated.workbenchEntityService.sessionName,
  'workbenchEntityService.sessionNameCannotBeEmpty':
    workbenchCompositionZhCN.generated.workbenchEntityService.sessionNameCannotBeEmpty,
  'workbenchEntityService.sessionNameCannotExceed160Characters':
    workbenchCompositionZhCN.generated.workbenchEntityService.sessionNameCannotExceed160Characters,
  'workbenchEntityService.save2': workbenchCompositionZhCN.generated.workbenchEntityService.save2,
  'workbenchEntityService.cancel2':
    workbenchCompositionZhCN.generated.workbenchEntityService.cancel2,
  'workbenchEntityService.unableToUpdateTheSessionName':
    workbenchCompositionZhCN.generated.workbenchEntityService.unableToUpdateTheSessionName,
  'workbenchEntityService.unableToTheSession':
    workbenchCompositionZhCN.generated.workbenchEntityService.unableToTheSession,
  'workbenchEntityService.unableToMoveThePinnedSession':
    workbenchCompositionZhCN.generated.workbenchEntityService.unableToMoveThePinnedSession,
  'workbenchEntityService.thisPermanentlyDeletesTheNativeSessionAnd':
    workbenchCompositionZhCN.generated.workbenchEntityService
      .thisPermanentlyDeletesTheNativeSessionAnd,
  'workbenchEntityService.deleteSession':
    workbenchCompositionZhCN.generated.workbenchEntityService.deleteSession,
  'workbenchEntityService.deleteSession2':
    workbenchCompositionZhCN.generated.workbenchEntityService.deleteSession2,
  'workbenchEntityService.cancel3':
    workbenchCompositionZhCN.generated.workbenchEntityService.cancel3,
  'workbenchEntityService.theNativeSessionWasDeleted':
    workbenchCompositionZhCN.generated.workbenchEntityService.theNativeSessionWasDeleted,
  'workbenchEntityService.unableToDeleteTheSession':
    workbenchCompositionZhCN.generated.workbenchEntityService.unableToDeleteTheSession,
  'workbenchEntityService.deletingDisconnectsItAndRemovesItsServer':
    workbenchCompositionZhCN.generated.workbenchEntityService
      .deletingDisconnectsItAndRemovesItsServer,
  'workbenchEntityService.deleteNode':
    workbenchCompositionZhCN.generated.workbenchEntityService.deleteNode,
  'workbenchEntityService.deleteNode2':
    workbenchCompositionZhCN.generated.workbenchEntityService.deleteNode2,
  'workbenchEntityService.cancel4':
    workbenchCompositionZhCN.generated.workbenchEntityService.cancel4,
  'workbenchEntityService.nodeDeletedCreateANewRegistrationToken':
    workbenchCompositionZhCN.generated.workbenchEntityService
      .nodeDeletedCreateANewRegistrationToken,
  'workbenchEntityService.unableToDeleteTheNode':
    workbenchCompositionZhCN.generated.workbenchEntityService.unableToDeleteTheNode,
  'workbenchPresentationStateService.contextWindow':
    workbenchCompositionZhCN.generated.workbenchPresentationStateService.contextWindow,
  'workbenchPresentationStateService.stopping':
    workbenchCompositionZhCN.generated.workbenchPresentationStateService.stopping,

  'workbenchSessionMessageService.enterAMessageWhenAttachingFiles':
    composerZhCN.generated.workbenchSessionMessageService.enterAMessageWhenAttachingFiles,
  'workbenchSessionMessageService.attachmentsAreStillUploadingOrFailedWait':
    composerZhCN.generated.workbenchSessionMessageService.attachmentsAreStillUploadingOrFailedWait,
  'workbenchSessionMessageService.sendARegularMessageToCreateThe':
    composerZhCN.generated.workbenchSessionMessageService.sendARegularMessageToCreateThe,
  'workbenchSessionMessageService.selectAWorkspaceBeforeSendingAMessage':
    composerZhCN.generated.workbenchSessionMessageService.selectAWorkspaceBeforeSendingAMessage,
  'workbenchSessionMessageService.unableToSendTheMessage':
    composerZhCN.generated.workbenchSessionMessageService.unableToSendTheMessage,

  'workbenchPageInteractionService.filePreviewIsCurrentlyUnavailable':
    workbenchCompositionZhCN.generated.workbenchPageInteractionService
      .filePreviewIsCurrentlyUnavailable,
  'workbenchPageInteractionService.copyFailedCheckTheBrowserClipboardPermission':
    workbenchCompositionZhCN.generated.workbenchPageInteractionService
      .copyFailedCheckTheBrowserClipboardPermission,
  'workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe':
    workspaceZhCN.generated.workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe,
  'workbenchWorkspaceSelectionService.unableToLoadNodeWorkspaces':
    workspaceZhCN.generated.workbenchWorkspaceSelectionService.unableToLoadNodeWorkspaces,
  'workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe2':
    workspaceZhCN.generated.workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe2,
  'workbenchWorkspaceSelectionService.unableToRefreshNodeWorkspaces':
    workspaceZhCN.generated.workbenchWorkspaceSelectionService.unableToRefreshNodeWorkspaces,
  'workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe3':
    workspaceZhCN.generated.workbenchWorkspaceSelectionService.thisWorkspaceIsNoLongerInThe3,
  'workbenchWorkspaceSelectionService.unableToLoadTheNodeState':
    workspaceZhCN.generated.workbenchWorkspaceSelectionService.unableToLoadTheNodeState,
  'workbenchNewSessionController.foldersCannotBeAttachedCompressTheFolder':
    workbenchCompositionZhCN.generated.workbenchNewSessionController
      .foldersCannotBeAttachedCompressTheFolder,
  'workbenchPageController.noNodeSelected':
    workbenchPageZhCN.generated.workbenchPageController.noNodeSelected,
  'workbenchPageController.theNodeIsDisabledOnlyTheCurrent':
    workbenchPageZhCN.generated.workbenchPageController.theNodeIsDisabledOnlyTheCurrent,
  'workbenchPageController.theNodeIsOfflineLoadedContentIs':
    workbenchPageZhCN.generated.workbenchPageController.theNodeIsOfflineLoadedContentIs,
  'workbenchPageController.nodeWorkbenchCapabilitiesAreUnknownTheWorkspace':
    workbenchPageZhCN.generated.workbenchPageController
      .nodeWorkbenchCapabilitiesAreUnknownTheWorkspace,
  'workbenchPageController.nodeWorkbenchCapabilitiesAreUnavailable':
    workbenchPageZhCN.generated.workbenchPageController.nodeWorkbenchCapabilitiesAreUnavailable,
  'workbenchPageController.unableToOpenTheSessionLinkedTo':
    workbenchPageZhCN.generated.workbenchPageController.unableToOpenTheSessionLinkedTo,
  'workbenchPageController.aNewerInstanceWithTheSameIdentity':
    workbenchPageZhCN.generated.workbenchPageController.aNewerInstanceWithTheSameIdentity,
  'workbenchPageController.receivedAnUnreadableLiveUpdate':
    workbenchPageZhCN.generated.workbenchPageController.receivedAnUnreadableLiveUpdate,
  'workbenchPageController.unknown': workbenchPageZhCN.generated.workbenchPageController.unknown,
  'workbenchPageController.unableToCreateARegistrationToken':
    workbenchPageZhCN.generated.workbenchPageController.unableToCreateARegistrationToken,
  'workbenchPageController.createANewSessionBranchBeforeThis':
    workbenchPageZhCN.generated.workbenchPageController.createANewSessionBranchBeforeThis,
  'workbenchPageController.createANewSessionBranchThatRetains':
    workbenchPageZhCN.generated.workbenchPageController.createANewSessionBranchThatRetains,
  'workbenchPageController.createFallbackBranch':
    workbenchPageZhCN.generated.workbenchPageController.createFallbackBranch,
  'workbenchPageController.createBranch':
    workbenchPageZhCN.generated.workbenchPageController.createBranch,
  'workbenchPageController.cancel': workbenchPageZhCN.generated.workbenchPageController.cancel,
  'workbenchPageController.fallbackBranchCreated':
    workbenchPageZhCN.generated.workbenchPageController.fallbackBranchCreated,
  'workbenchPageController.unableToCreateAFallbackBranch':
    workbenchPageZhCN.generated.workbenchPageController.unableToCreateAFallbackBranch,
  'workbenchPageController.rollbackConversationWarning':
    workbenchPageZhCN.generated.workbenchPageController.rollbackConversationWarning,
  'workbenchPageController.rollbackConversation':
    workbenchPageZhCN.generated.workbenchPageController.rollbackConversation,
  'workbenchPageController.confirmRollbackConversation':
    workbenchPageZhCN.generated.workbenchPageController.confirmRollbackConversation,
  'workbenchPageController.unableToRollbackConversation':
    workbenchPageZhCN.generated.workbenchPageController.unableToRollbackConversation,
  'workspaceQueueService.theQueueOrderChangedTryAgain':
    composerZhCN.generated.workspaceQueueService.theQueueOrderChangedTryAgain,
  'workspaceQueueService.unableToEditTheQueuedMessage':
    composerZhCN.generated.workspaceQueueService.unableToEditTheQueuedMessage,
  'workspaceQueueService.unableToDeleteTheQueuedMessage':
    composerZhCN.generated.workspaceQueueService.unableToDeleteTheQueuedMessage,
  'workspaceQueueService.unableToRunTheQueuedMessageNow':
    composerZhCN.generated.workspaceQueueService.unableToRunTheQueuedMessageNow,
  'conversationUserInputService.answerEveryQuestionBeforeSubmitting':
    composerZhCN.generated.conversationUserInputService.answerEveryQuestionBeforeSubmitting,
  'conversationUserInputService.answersWereNotSubmitted':
    composerZhCN.generated.conversationUserInputService.answersWereNotSubmitted,
  'workbenchSessionSelectionService.unableToLoadConversationHistory':
    workspaceZhCN.generated.workbenchSessionSelectionService.unableToLoadConversationHistory,
  'runnerUsageService.usageCapabilityDetectionFailedCloseAndReopen':
    workbenchCompositionZhCN.generated.runnerUsageService
      .usageCapabilityDetectionFailedCloseAndReopen,
  'runnerUsageService.detectingUsageCapability':
    workbenchCompositionZhCN.generated.runnerUsageService.detectingUsageCapability,
  'runnerUsageService.usageQueriesRequireAnOfficialOAuthAccount':
    workbenchCompositionZhCN.generated.runnerUsageService.usageQueriesRequireAnOfficialOAuthAccount,
  'runnerUsageService.thisRunnerIsUnavailableSoUsageCannot':
    workbenchCompositionZhCN.generated.runnerUsageService.thisRunnerIsUnavailableSoUsageCannot,
  'runnerUsageService.thisRunnerDoesNotCurrentlySupportUsage':
    workbenchCompositionZhCN.generated.runnerUsageService.thisRunnerDoesNotCurrentlySupportUsage,
  'runnerUsageService.unableToQueryUsage':
    workbenchCompositionZhCN.generated.runnerUsageService.unableToQueryUsage,
  'runnerUsageService.notProvided':
    workbenchCompositionZhCN.generated.runnerUsageService.notProvided,
  'workbenchCapabilityService.unableToLoadNodes':
    workbenchCompositionZhCN.generated.workbenchCapabilityService.unableToLoadNodes,
  'workbenchCapabilityService.unknown':
    workbenchCompositionZhCN.generated.workbenchCapabilityService.unknown,
  'workbenchCapabilityService.unknown2':
    workbenchCompositionZhCN.generated.workbenchCapabilityService.unknown2,
  'environmentSecretService.enterAnEnvironmentVariableName':
    environmentSecretsZhCN.generated.environmentSecretService.enterAnEnvironmentVariableName,
  'environmentSecretService.theEnvironmentVariableNameCannotExceed128':
    environmentSecretsZhCN.generated.environmentSecretService
      .theEnvironmentVariableNameCannotExceed128,
  'environmentSecretService.theEnvironmentVariableNameMustStartWith':
    environmentSecretsZhCN.generated.environmentSecretService
      .theEnvironmentVariableNameMustStartWith,
  'environmentSecretService.theEnvironmentVariableNameCanContainOnly':
    environmentSecretsZhCN.generated.environmentSecretService
      .theEnvironmentVariableNameCanContainOnly,
  'environmentSecretService.enterASecretValue':
    environmentSecretsZhCN.generated.environmentSecretService.enterASecretValue,
  'environmentSecretService.theSecretValueCannotContainNullCharacters':
    environmentSecretsZhCN.generated.environmentSecretService
      .theSecretValueCannotContainNullCharacters,
  'environmentSecretService.theSecretValueCannotExceed16KiB':
    environmentSecretsZhCN.generated.environmentSecretService.theSecretValueCannotExceed16KiB,
  'enterpriseManagementService.systemAdministrator': '系统管理员',
  'enterpriseManagementService.organizationAdministrator': '组织管理员',
  'enterpriseManagementService.member': '成员',
  'workbenchPlanService.unableToImplementThePlan':
    composerZhCN.generated.workbenchPlanService.unableToImplementThePlan,
  'workbenchContextCommandService.compactOlderContextToFreeWindowSpace':
    composerZhCN.generated.workbenchContextCommandService.compactOlderContextToFreeWindowSpace,
  'workbenchContextCommandService.compactContext':
    composerZhCN.generated.workbenchContextCommandService.compactContext,
  'workbenchContextCommandService.compact':
    composerZhCN.generated.workbenchContextCommandService.compact,
  'workbenchContextCommandService.cancel':
    composerZhCN.generated.workbenchContextCommandService.cancel,
  'workbenchContextCommandService.unableToCompactContext':
    composerZhCN.generated.workbenchContextCommandService.unableToCompactContext,
  'mcpCenterPanel.thisAccountHasNoManageableNodes':
    skillConfigurationZhCN.generated.mcpCenterPanel.thisAccountHasNoManageableNodes,
  'mcpCenterPanel.selectANode': skillConfigurationZhCN.generated.mcpCenterPanel.selectANode,
  'mcpCenterPanel.theSelectedNodeIsUnavailableSelectAnother':
    skillConfigurationZhCN.generated.mcpCenterPanel.theSelectedNodeIsUnavailableSelectAnother,
  'mcpCenterPanel.theSelectedNodeIsDisabledAndCannot':
    skillConfigurationZhCN.generated.mcpCenterPanel.theSelectedNodeIsDisabledAndCannot,
  'mcpCenterPanel.theSelectedNodeIsOfflineMCPCan':
    skillConfigurationZhCN.generated.mcpCenterPanel.theSelectedNodeIsOfflineMCPCan,
  'mcpCenterPanel.nodeVersionDoesNotSupportMCPUpgrade':
    '所选节点版本 {value0} 不支持 MCP，请先升级节点。',
  'mcpCenterPanel.theSelectedNodeHasNoManageableWorkspaces':
    skillConfigurationZhCN.generated.mcpCenterPanel.theSelectedNodeHasNoManageableWorkspaces,
  'mcpCenterPanel.selectAWorkspace':
    skillConfigurationZhCN.generated.mcpCenterPanel.selectAWorkspace,
  'mcpCenterPanel.thisMCPServerWasRemovedFromThe':
    skillConfigurationZhCN.generated.mcpCenterPanel.thisMCPServerWasRemovedFromThe,
  'mcpCenterPanel.enterprise': '企业',
  'mcpCenterPanel.organization': '组织',
  'mcpCenterPanel.personal': skillConfigurationZhCN.generated.mcpCenterPanel.personal,
  'mcpCenterPanel.upToDate': skillConfigurationZhCN.generated.mcpCenterPanel.upToDate,
  'mcpCenterPanel.updateAvailable': skillConfigurationZhCN.generated.mcpCenterPanel.updateAvailable,
  'mcpCenterPanel.invalidConfiguration':
    skillConfigurationZhCN.generated.mcpCenterPanel.invalidConfiguration,
  'mcpCenterPanel.catalogEntryUnavailable':
    skillConfigurationZhCN.generated.mcpCenterPanel.catalogEntryUnavailable,
  'mcpCenterPanel.updateAvailable2':
    skillConfigurationZhCN.generated.mcpCenterPanel.updateAvailable2,
  'mcpCenterPanel.mCPInstallationWasValidatedOnTheNode':
    skillConfigurationZhCN.generated.mcpCenterPanel.mCPInstallationWasValidatedOnTheNode,
  'mcpCenterPanel.mCPServerDisabled':
    skillConfigurationZhCN.generated.mcpCenterPanel.mCPServerDisabled,
  'mcpCenterPanel.removeFromTheCurrentTarget':
    skillConfigurationZhCN.generated.mcpCenterPanel.removeFromTheCurrentTarget,
  'mcpCenterPanel.removeMCPServer': skillConfigurationZhCN.generated.mcpCenterPanel.removeMCPServer,
  'mcpCenterPanel.remove': skillConfigurationZhCN.generated.mcpCenterPanel.remove,
  'mcpCenterPanel.cancel': skillConfigurationZhCN.generated.mcpCenterPanel.cancel,
  'mcpCenterPanel.mCPServerRemoved':
    skillConfigurationZhCN.generated.mcpCenterPanel.mCPServerRemoved,
  'mcpCenterPanel.theNodeIsOfflineTryAgainAfter':
    skillConfigurationZhCN.generated.mcpCenterPanel.theNodeIsOfflineTryAgainAfter,
  'mcpCenterPanel.thisNodeVersionDoesNotSupportMCP':
    skillConfigurationZhCN.generated.mcpCenterPanel.thisNodeVersionDoesNotSupportMCP,
  'mcpCenterPanel.mCPManagementIsNotEnabledOnThis':
    skillConfigurationZhCN.generated.mcpCenterPanel.mCPManagementIsNotEnabledOnThis,
  'mcpCenterPanel.theWorkspaceNoLongerExistsSelectAnother':
    skillConfigurationZhCN.generated.mcpCenterPanel.theWorkspaceNoLongerExistsSelectAnother,
  'mcpCenterPanel.mCPInstallationValidationTimedOutCheckNode':
    skillConfigurationZhCN.generated.mcpCenterPanel.mCPInstallationValidationTimedOutCheckNode,
  'mcpCenterPanel.aSecretReferencedByMCPIsMissing':
    skillConfigurationZhCN.generated.mcpCenterPanel.aSecretReferencedByMCPIsMissing,
  'mcpCenterPanel.mCPAuthenticationFailedCheckTheReferencedSecrets':
    skillConfigurationZhCN.generated.mcpCenterPanel
      .mCPAuthenticationFailedCheckTheReferencedSecrets,
  'mcpCenterPanel.theNodeCouldNotStartTheMCP':
    skillConfigurationZhCN.generated.mcpCenterPanel.theNodeCouldNotStartTheMCP,
  'mcpCenterPanel.theNodeCouldNotConnectToThe':
    skillConfigurationZhCN.generated.mcpCenterPanel.theNodeCouldNotConnectToThe,
  'mcpCenterPanel.mCPProtocolValidationFailedAfterStartupCheck':
    skillConfigurationZhCN.generated.mcpCenterPanel.mCPProtocolValidationFailedAfterStartupCheck,
  'mcpCenterPanel.mCPConnectedButExposedNoToolsCheck':
    skillConfigurationZhCN.generated.mcpCenterPanel.mCPConnectedButExposedNoToolsCheck,
  'mcpCenterPanel.youDoNotHavePermissionToManage':
    skillConfigurationZhCN.generated.mcpCenterPanel.youDoNotHavePermissionToManage,
  'mcpCenterPanel.theMCPOperationDidNotCompleteTry': 'MCP 操作未完成，请稍后重试。',
  'mcpCenterPanel.mCPConfigurationTarget':
    skillConfigurationZhCN.generated.mcpCenterPanel.mCPConfigurationTarget,
  'mcpCenterPanel.configurationTarget':
    skillConfigurationZhCN.generated.mcpCenterPanel.configurationTarget,
  'mcpCenterPanel.selectWhereTheMCPServerWillBe':
    skillConfigurationZhCN.generated.mcpCenterPanel.selectWhereTheMCPServerWillBe,
  'mcpCenterPanel.node': skillConfigurationZhCN.generated.mcpCenterPanel.node,
  'mcpCenterPanel.workspace': skillConfigurationZhCN.generated.mcpCenterPanel.workspace,
  'mcpCenterPanel.selectANode2': skillConfigurationZhCN.generated.mcpCenterPanel.selectANode2,
  'mcpCenterPanel.disabled': skillConfigurationZhCN.generated.mcpCenterPanel.disabled,
  'mcpCenterPanel.online': skillConfigurationZhCN.generated.mcpCenterPanel.online,
  'mcpCenterPanel.offline': skillConfigurationZhCN.generated.mcpCenterPanel.offline,
  'mcpCenterPanel.selectAWorkspace2':
    skillConfigurationZhCN.generated.mcpCenterPanel.selectAWorkspace2,
  'mcpCenterPanel.availableMCPServers':
    skillConfigurationZhCN.generated.mcpCenterPanel.availableMCPServers,
  'mcpCenterPanel.installedMCPServers':
    skillConfigurationZhCN.generated.mcpCenterPanel.installedMCPServers,
  'mcpCenterPanel.searchMCPServers':
    skillConfigurationZhCN.generated.mcpCenterPanel.searchMCPServers,
  'mcpCenterPanel.mCPCategories': skillConfigurationZhCN.generated.mcpCenterPanel.mCPCategories,
  'mcpCenterPanel.all': skillConfigurationZhCN.generated.mcpCenterPanel.all,
  'mcpCenterPanel.updateAvailable3':
    skillConfigurationZhCN.generated.mcpCenterPanel.updateAvailable3,
  'mcpCenterPanel.noDescriptionIsAvailableForThisMCP':
    skillConfigurationZhCN.generated.mcpCenterPanel.noDescriptionIsAvailableForThisMCP,
  'mcpCenterPanel.featured': skillConfigurationZhCN.generated.mcpCenterPanel.featured,
  'mcpCenterPanel.inheritedFromNode':
    skillConfigurationZhCN.generated.mcpCenterPanel.inheritedFromNode,
  'mcpCenterPanel.downloadingAndValidatingMCPOnTheNode':
    skillConfigurationZhCN.generated.mcpCenterPanel.downloadingAndValidatingMCPOnTheNode,
  'mcpCenterPanel.details2': '详情',
  'mcpCenterPanel.disable': skillConfigurationZhCN.generated.mcpCenterPanel.disable,
  'mcpCenterPanel.enable': skillConfigurationZhCN.generated.mcpCenterPanel.enable,
  'mcpCenterPanel.update': skillConfigurationZhCN.generated.mcpCenterPanel.update,
  'mcpCenterPanel.reinstall': skillConfigurationZhCN.generated.mcpCenterPanel.reinstall,
  'mcpCenterPanel.delete': skillConfigurationZhCN.generated.mcpCenterPanel.delete,
  'mcpCenterPanel.details3': '详情',
  'mcpCenterPanel.update2': skillConfigurationZhCN.generated.mcpCenterPanel.update2,
  'mcpCenterPanel.reinstall2': skillConfigurationZhCN.generated.mcpCenterPanel.reinstall2,
  'mcpCenterPanel.install': skillConfigurationZhCN.generated.mcpCenterPanel.install,
  'mcpCenterPanel.thisTargetHasNoInstalledMCPServers':
    skillConfigurationZhCN.generated.mcpCenterPanel.thisTargetHasNoInstalledMCPServers,
  'mcpCenterPanel.noMCPServersAreAvailableAddOne':
    skillConfigurationZhCN.generated.mcpCenterPanel.noMCPServersAreAvailableAddOne,
  'workbenchNotificationService.fileUploadFailed':
    notificationsZhCN.generated.workbenchNotificationService.fileUploadFailed,
  'workbenchNotificationService.fileUploadCompleted':
    notificationsZhCN.generated.workbenchNotificationService.fileUploadCompleted,
  'workbenchNotificationService.uploadingFile':
    notificationsZhCN.generated.workbenchNotificationService.uploadingFile,
  'workbenchNotificationService.runCompleted':
    notificationsZhCN.generated.workbenchNotificationService.runCompleted,
  'workbenchNotificationService.runFailed':
    notificationsZhCN.generated.workbenchNotificationService.runFailed,
  'workbenchNotificationService.runCancelled':
    notificationsZhCN.generated.workbenchNotificationService.runCancelled,
  'workbenchNotificationService.runInterrupted':
    notificationsZhCN.generated.workbenchNotificationService.runInterrupted,
  'workbenchNotificationService.clickToOpenTheRelatedSession':
    notificationsZhCN.generated.workbenchNotificationService.clickToOpenTheRelatedSession,
  'workbenchNotificationService.approvalRequired':
    notificationsZhCN.generated.workbenchNotificationService.approvalRequired,
  'workbenchNotificationService.theAgentIsWaitingForYourConfirmation':
    notificationsZhCN.generated.workbenchNotificationService.theAgentIsWaitingForYourConfirmation,
  'workbenchNotificationService.planReadyToImplement':
    notificationsZhCN.generated.workbenchNotificationService.planReadyToImplement,
  'workbenchNotificationService.openTheSessionToViewTheImplementation':
    notificationsZhCN.generated.workbenchNotificationService.openTheSessionToViewTheImplementation,
  'workbenchNotificationService.yourAnswerIsRequired':
    notificationsZhCN.generated.workbenchNotificationService.yourAnswerIsRequired,
  'workbenchNotificationService.theAgentIsWaitingForYourAnswer':
    notificationsZhCN.generated.workbenchNotificationService.theAgentIsWaitingForYourAnswer,
  'workbenchNotificationService.session':
    notificationsZhCN.generated.workbenchNotificationService.session,
  'workbenchSelectionStateService.unknown':
    workbenchPageZhCN.generated.workbenchSelectionStateService.unknown,

  'workbenchWorkspaceTreeController.thisWorkspaceIsNoLongerInThe':
    workspaceZhCN.generated.workbenchWorkspaceTreeController.thisWorkspaceIsNoLongerInThe,
  'workbenchWorkspaceTreeController.unableToLoadNodeWorkspaces':
    workspaceZhCN.generated.workbenchWorkspaceTreeController.unableToLoadNodeWorkspaces,
  'workbenchWorkspaceTreeController.unregisterThisDoesNotDeleteTheLocal':
    workspaceZhCN.generated.workbenchWorkspaceTreeController.unregisterThisDoesNotDeleteTheLocal,
  'workbenchWorkspaceTreeController.unregisterWorkspace':
    workspaceZhCN.generated.workbenchWorkspaceTreeController.unregisterWorkspace,
  'workbenchWorkspaceTreeController.unregister':
    workspaceZhCN.generated.workbenchWorkspaceTreeController.unregister,
  'workbenchWorkspaceTreeController.cancel':
    workspaceZhCN.generated.workbenchWorkspaceTreeController.cancel,
  'workbenchWorkspaceTreeController.cleanupOldSessions': '清理会话',
  'workbenchWorkspaceTreeController.cleanupOldSessionsDescription':
    '输入清理多少天前的会话。此操作会永久删除符合条件的原生会话；置顶、活动、排队或正在查看的会话会保留。',
  'workbenchWorkspaceTreeController.inactiveDaysMustBeBetween': '请输入 1 到 365 之间的整数天数。',
  'workbenchWorkspaceTreeController.cleanup': '清理会话',
  'workbenchWorkspaceTreeController.oldSessionsCleanupCompleted':
    '旧会话清理完成：已删除 {value0} 个（{value3}），跳过 {value1} 个，失败 {value2} 个。',
  'workbenchWorkspaceTreeController.cleanupByRunner': '按 Agent：{value0}',
  'workbenchWorkspaceTreeController.noSessionsDeleted': '无 Agent 会话删除',
  'workbenchWorkspaceTreeController.unableToCleanUpOldSessions': '无法清理会话：{value0}',
  'workbenchWorkspaceTreeController.theWorkspaceWasUnregisteredItsLocalDirectory':
    workspaceZhCN.generated.workbenchWorkspaceTreeController
      .theWorkspaceWasUnregisteredItsLocalDirectory,
  'workbenchWorkspaceTreeController.unableToUnregisterTheWorkspace':
    workspaceZhCN.generated.workbenchWorkspaceTreeController.unableToUnregisterTheWorkspace,

  'workbenchApprovalService.approvalWasNotSubmitted':
    composerZhCN.generated.workbenchApprovalService.approvalWasNotSubmitted,

  'workspaceRegistrationService.unableToLoadAvailableDirectories':
    workspaceZhCN.generated.workspaceRegistrationService.unableToLoadAvailableDirectories,
  'workspaceRegistrationService.aDirectoryWithThisNameAlreadyExists':
    workspaceZhCN.generated.workspaceRegistrationService.aDirectoryWithThisNameAlreadyExists,
  'workspaceRegistrationService.theDirectoryNameIsInvalidEnterA':
    workspaceZhCN.generated.workspaceRegistrationService.theDirectoryNameIsInvalidEnterA,
  'workspaceRegistrationService.theSelectedDirectoryIsOutsideTheWorkspace':
    workspaceZhCN.generated.workspaceRegistrationService.theSelectedDirectoryIsOutsideTheWorkspace,
  'workspaceRegistrationService.unableToRegisterTheWorkspace':
    workspaceZhCN.generated.workspaceRegistrationService.unableToRegisterTheWorkspace,
  'skillDetailsDialog.skillDetails':
    skillConfigurationZhCN.generated.skillDetailsDialog.skillDetails,
  'skillDetailsDialog.noDescriptionIsAvailableForThisSkill':
    skillConfigurationZhCN.generated.skillDetailsDialog.noDescriptionIsAvailableForThisSkill,
  'skillDetailsDialog.source': skillConfigurationZhCN.generated.skillDetailsDialog.source,
  'skillDetailsDialog.availability':
    skillConfigurationZhCN.generated.skillDetailsDialog.availability,
  'skillDetailsDialog.skillPath': skillConfigurationZhCN.generated.skillDetailsDialog.skillPath,
  'skillDetailsDialog.version': skillConfigurationZhCN.generated.skillDetailsDialog.version,
  'skillDetailsDialog.updated': skillConfigurationZhCN.generated.skillDetailsDialog.updated,
  'skillDetailsDialog.status': skillConfigurationZhCN.generated.skillDetailsDialog.status,
  'skillDetailsDialog.installs': skillConfigurationZhCN.generated.skillDetailsDialog.installs,
  'skillDetailsDialog.tags': skillConfigurationZhCN.generated.skillDetailsDialog.tags,
  'skillDetailsDialog.featured': skillConfigurationZhCN.generated.skillDetailsDialog.featured,
  'skillDetailsDialog.close': skillConfigurationZhCN.generated.skillDetailsDialog.close,
  'workbenchRunnerChannelService.theMessageWasAddedToTheCurrent':
    composerZhCN.generated.workbenchRunnerChannelService.theMessageWasAddedToTheCurrent,
  'workbenchRunnerChannelService.theMessageWasNotDeliveredToThe':
    composerZhCN.generated.workbenchRunnerChannelService.theMessageWasNotDeliveredToThe,
  'workbenchRunnerChannelService.unableToSendThroughTheClaudeChannel':
    composerZhCN.generated.workbenchRunnerChannelService.unableToSendThroughTheClaudeChannel,

  'skillCenterPage.theSkillOperationDidNotCompleteTry':
    skillConfigurationZhCN.generated.skillCenterPage.theSkillOperationDidNotCompleteTry,
  'skillCenterPage.compatibleLink': skillConfigurationZhCN.generated.skillCenterPage.compatibleLink,
  'skillCenterPage.directoryJunction':
    skillConfigurationZhCN.generated.skillCenterPage.directoryJunction,
  'skillCenterPage.managedCopy': skillConfigurationZhCN.generated.skillCenterPage.managedCopy,
  'skillCenterPage.unavailable': skillConfigurationZhCN.generated.skillCenterPage.unavailable,
  'skillCenterPage.environmentModeSkillsFoundRequireAttention':
    skillConfigurationZhCN.generated.skillCenterPage.environmentModeSkillsFoundRequireAttention,
  'skillCenterPage.environmentCheckFoundIssues':
    skillConfigurationZhCN.generated.skillCenterPage.environmentCheckFoundIssues,
  'skillCenterPage.environmentCheckPassed':
    skillConfigurationZhCN.generated.skillCenterPage.environmentCheckPassed,
  'skillCenterPage.oK': skillConfigurationZhCN.generated.skillCenterPage.oK,
  'skillCenterPage.theEnvironmentCheckDidNotCompleteTry':
    skillConfigurationZhCN.generated.skillCenterPage.theEnvironmentCheckDidNotCompleteTry,
  'skillCenterPage.installing': skillConfigurationZhCN.generated.skillCenterPage.installing,
  'skillCenterPage.install': skillConfigurationZhCN.generated.skillCenterPage.install,
  'skillCenterPage.reinstall': skillConfigurationZhCN.generated.skillCenterPage.reinstall,
  'skillCenterPage.update': skillConfigurationZhCN.generated.skillCenterPage.update,
  'skillCenterPage.reinstallingWillOverwriteExistingFilesForManual':
    skillConfigurationZhCN.generated.skillCenterPage
      .reinstallingWillOverwriteExistingFilesForManual,
  'skillCenterPage.overwriteSkill': skillConfigurationZhCN.generated.skillCenterPage.overwriteSkill,
  'skillCenterPage.continue': skillConfigurationZhCN.generated.skillCenterPage.continue,
  'skillCenterPage.cancel': skillConfigurationZhCN.generated.skillCenterPage.cancel,
  'skillCenterPage.skillUpdated': skillConfigurationZhCN.generated.skillCenterPage.skillUpdated,
  'skillCenterPage.skillInstalled': skillConfigurationZhCN.generated.skillCenterPage.skillInstalled,
  'skillCenterPage.theTargetContainsGitTrackedFilesOverwritten':
    skillConfigurationZhCN.generated.skillCenterPage.theTargetContainsGitTrackedFilesOverwritten,
  'skillCenterPage.overwriteTrackedFiles':
    skillConfigurationZhCN.generated.skillCenterPage.overwriteTrackedFiles,
  'skillCenterPage.overwriteFiles': skillConfigurationZhCN.generated.skillCenterPage.overwriteFiles,
  'skillCenterPage.cancel2': skillConfigurationZhCN.generated.skillCenterPage.cancel2,
  'skillCenterPage.skillInstalled2':
    skillConfigurationZhCN.generated.skillCenterPage.skillInstalled2,
  'skillCenterPage.skillInstallationDidNotCompleteTryAgain':
    skillConfigurationZhCN.generated.skillCenterPage.skillInstallationDidNotCompleteTryAgain,
  'skillCenterPage.skillInstallationDidNotCompleteTryAgain2':
    skillConfigurationZhCN.generated.skillCenterPage.skillInstallationDidNotCompleteTryAgain2,
  'skillCenterPage.unknownVersion': skillConfigurationZhCN.generated.skillCenterPage.unknownVersion,
  'skillCenterPage.incompleteInstallation':
    skillConfigurationZhCN.generated.skillCenterPage.incompleteInstallation,
  'skillCenterPage.gitRulesNeedRepair':
    skillConfigurationZhCN.generated.skillCenterPage.gitRulesNeedRepair,
  'skillCenterPage.directoryError': skillConfigurationZhCN.generated.skillCenterPage.directoryError,
  'skillCenterPage.unknownVersion2':
    skillConfigurationZhCN.generated.skillCenterPage.unknownVersion2,
  'skillCenterPage.upToDate': skillConfigurationZhCN.generated.skillCenterPage.upToDate,
  'skillCenterPage.updateAvailable':
    skillConfigurationZhCN.generated.skillCenterPage.updateAvailable,
  'skillCenterPage.deleteFromTheCurrentTargetTheSystem':
    skillConfigurationZhCN.generated.skillCenterPage.deleteFromTheCurrentTargetTheSystem,
  'skillCenterPage.deleteSkill': skillConfigurationZhCN.generated.skillCenterPage.deleteSkill,
  'skillCenterPage.deleteDirectory':
    skillConfigurationZhCN.generated.skillCenterPage.deleteDirectory,
  'skillCenterPage.cancel3': skillConfigurationZhCN.generated.skillCenterPage.cancel3,
  'skillCenterPage.unableToConfirmDeletionTryAgainLater':
    skillConfigurationZhCN.generated.skillCenterPage.unableToConfirmDeletionTryAgainLater,
  'skillCenterPage.skillDeleted': skillConfigurationZhCN.generated.skillCenterPage.skillDeleted,
  'skillCenterPage.repairingTheEnvironmentUpdatesTheWorkspaceS':
    skillConfigurationZhCN.generated.skillCenterPage.repairingTheEnvironmentUpdatesTheWorkspaceS,
  'skillCenterPage.repairSkillEnvironment':
    skillConfigurationZhCN.generated.skillCenterPage.repairSkillEnvironment,
  'skillCenterPage.repair': skillConfigurationZhCN.generated.skillCenterPage.repair,
  'skillCenterPage.cancel4': skillConfigurationZhCN.generated.skillCenterPage.cancel4,
  'skillCenterPage.unableToConfirmRepairTryAgainLater':
    skillConfigurationZhCN.generated.skillCenterPage.unableToConfirmRepairTryAgainLater,
  'skillCenterPage.localGitExcludeRulesRepaired':
    skillConfigurationZhCN.generated.skillCenterPage.localGitExcludeRulesRepaired,
  'skillCenterPage.theSkillOperationDidNotCompleteTry2':
    skillConfigurationZhCN.generated.skillCenterPage.theSkillOperationDidNotCompleteTry2,
  'skillCenterPage.enterprise': '企业',
  'skillCenterPage.organization': '组织',
  'skillCenterPage.personal': skillConfigurationZhCN.generated.skillCenterPage.personal,
  'skillCenterPage.skillConfiguration':
    skillConfigurationZhCN.generated.skillCenterPage.skillConfiguration,
  'skillCenterPage.skillConfiguration2':
    skillConfigurationZhCN.generated.skillCenterPage.skillConfiguration2,
  'skillCenterPage.installAndMaintainSkillsForNodesOr':
    skillConfigurationZhCN.generated.skillCenterPage.installAndMaintainSkillsForNodesOr,
  'skillCenterPage.skillConfigurationTarget':
    skillConfigurationZhCN.generated.skillCenterPage.skillConfigurationTarget,
  'skillCenterPage.configurationTarget':
    skillConfigurationZhCN.generated.skillCenterPage.configurationTarget,
  'skillCenterPage.selectWhereTheSkillWillBeUsed':
    skillConfigurationZhCN.generated.skillCenterPage.selectWhereTheSkillWillBeUsed,
  'skillCenterPage.node': skillConfigurationZhCN.generated.skillCenterPage.node,
  'skillCenterPage.workspace': skillConfigurationZhCN.generated.skillCenterPage.workspace,
  'skillCenterPage.selectANode': skillConfigurationZhCN.generated.skillCenterPage.selectANode,
  'skillCenterPage.skillNode': skillConfigurationZhCN.generated.skillCenterPage.skillNode,
  'skillCenterPage.disabled': skillConfigurationZhCN.generated.skillCenterPage.disabled,
  'skillCenterPage.online': skillConfigurationZhCN.generated.skillCenterPage.online,
  'skillCenterPage.offline': skillConfigurationZhCN.generated.skillCenterPage.offline,
  'skillCenterPage.selectAWorkspace':
    skillConfigurationZhCN.generated.skillCenterPage.selectAWorkspace,
  'skillCenterPage.skillWorkspace': skillConfigurationZhCN.generated.skillCenterPage.skillWorkspace,
  'skillCenterPage.checkEnvironment':
    skillConfigurationZhCN.generated.skillCenterPage.checkEnvironment,
  'skillCenterPage.repairEnvironment':
    skillConfigurationZhCN.generated.skillCenterPage.repairEnvironment,
  'skillCenterPage.noManageableNodesAreAvailableForSkill':
    skillConfigurationZhCN.generated.skillCenterPage.noManageableNodesAreAvailableForSkill,
  'skillCenterPage.theCurrentNodeDoesNotSupportThis':
    skillConfigurationZhCN.generated.skillCenterPage.theCurrentNodeDoesNotSupportThis,
  'skillCenterPage.availableSkills':
    skillConfigurationZhCN.generated.skillCenterPage.availableSkills,
  'skillCenterPage.searchSkillNamesOrDescriptions2':
    skillConfigurationZhCN.generated.skillCenterPage.searchSkillNamesOrDescriptions2,
  'skillCenterPage.showAll': '显示全部',
  'skillCenterPage.skillCategories2':
    skillConfigurationZhCN.generated.skillCenterPage.skillCategories2,
  'skillCenterPage.all2': skillConfigurationZhCN.generated.skillCenterPage.all2,
  'skillCenterPage.noDescriptionIsAvailableForThisSkill2':
    skillConfigurationZhCN.generated.skillCenterPage.noDescriptionIsAvailableForThisSkill2,
  'skillCenterPage.featured2': skillConfigurationZhCN.generated.skillCenterPage.featured2,
  'skillCenterPage.installingAndValidatingTheSkillOnThe':
    skillConfigurationZhCN.generated.skillCenterPage.installingAndValidatingTheSkillOnThe,
  'skillCenterPage.details2': '详情',
  'skillCenterPage.noSkillsAreAvailableAddSkillsFrom2':
    skillConfigurationZhCN.generated.skillCenterPage.noSkillsAreAvailableAddSkillsFrom2,
  'skillCenterPage.noMatchingSkills2':
    skillConfigurationZhCN.generated.skillCenterPage.noMatchingSkills2,
  'skillCenterPage.installedSkills':
    skillConfigurationZhCN.generated.skillCenterPage.installedSkills,
  'skillCenterPage.noValidSkillDescriptionWasFound':
    skillConfigurationZhCN.generated.skillCenterPage.noValidSkillDescriptionWasFound,
  'skillCenterPage.installingAndValidatingTheSkillOnThe2':
    skillConfigurationZhCN.generated.skillCenterPage.installingAndValidatingTheSkillOnThe2,
  'skillCenterPage.details3': '详情',
  'skillCenterPage.update2': skillConfigurationZhCN.generated.skillCenterPage.update2,
  'skillCenterPage.reinstall2': skillConfigurationZhCN.generated.skillCenterPage.reinstall2,
  'skillCenterPage.delete': skillConfigurationZhCN.generated.skillCenterPage.delete,
  'skillCenterPage.thisTargetHasNoInstalledSkills':
    skillConfigurationZhCN.generated.skillCenterPage.thisTargetHasNoInstalledSkills,
  'skillSourceManagementPage.enterASourceName':
    catalogSourcesZhCN.generated.skillSourceManagementPage.enterASourceName,
  'skillSourceManagementPage.enterARepositoryURL':
    catalogSourcesZhCN.generated.skillSourceManagementPage.enterARepositoryURL,
  'skillSourceManagementPage.enterAnHTTPSOrGitSSHRepository':
    catalogSourcesZhCN.generated.skillSourceManagementPage.enterAnHTTPSOrGitSSHRepository,
  'skillSourceManagementPage.selectAnOrganization': '请选择组织',
  'skillSourceManagementPage.eachTagMustContain132Characters':
    catalogSourcesZhCN.generated.skillSourceManagementPage.eachTagMustContain132Characters,
  'skillSourceManagementPage.duplicateTagsAreNotAllowed':
    catalogSourcesZhCN.generated.skillSourceManagementPage.duplicateTagsAreNotAllowed,
  'skillSourceManagementPage.theSkillSourceOperationDidNotComplete':
    catalogSourcesZhCN.generated.skillSourceManagementPage.theSkillSourceOperationDidNotComplete,
  'skillSourceManagementPage.skillSourceAdded':
    catalogSourcesZhCN.generated.skillSourceManagementPage.skillSourceAdded,
  'skillSourceManagementPage.skillInformationUpdated':
    catalogSourcesZhCN.generated.skillSourceManagementPage.skillInformationUpdated,
  'skillSourceManagementPage.skillAddedToTheCatalog':
    catalogSourcesZhCN.generated.skillSourceManagementPage.skillAddedToTheCatalog,
  'skillSourceManagementPage.updateAvailable':
    catalogSourcesZhCN.generated.skillSourceManagementPage.updateAvailable,
  'skillSourceManagementPage.alreadyUpToDate':
    catalogSourcesZhCN.generated.skillSourceManagementPage.alreadyUpToDate,
  'skillSourceManagementPage.catalogSkillUpdated':
    catalogSourcesZhCN.generated.skillSourceManagementPage.catalogSkillUpdated,
  'skillSourceManagementPage.deleteSkillSource':
    catalogSourcesZhCN.generated.skillSourceManagementPage.deleteSkillSource,
  'skillSourceManagementPage.deleteSkillSource2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.deleteSkillSource2,
  'skillSourceManagementPage.delete': catalogSourcesZhCN.generated.skillSourceManagementPage.delete,
  'skillSourceManagementPage.cancel': catalogSourcesZhCN.generated.skillSourceManagementPage.cancel,
  'skillSourceManagementPage.unableToConfirmDeletionTryAgainLater':
    catalogSourcesZhCN.generated.skillSourceManagementPage.unableToConfirmDeletionTryAgainLater,
  'skillSourceManagementPage.skillSourceDeleted':
    catalogSourcesZhCN.generated.skillSourceManagementPage.skillSourceDeleted,
  'skillSourceManagementPage.removeFromTheSkillCatalogInstalledCopies':
    catalogSourcesZhCN.generated.skillSourceManagementPage.removeFromTheSkillCatalogInstalledCopies,
  'skillSourceManagementPage.removeSkill':
    catalogSourcesZhCN.generated.skillSourceManagementPage.removeSkill,
  'skillSourceManagementPage.remove': catalogSourcesZhCN.generated.skillSourceManagementPage.remove,
  'skillSourceManagementPage.cancel2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.cancel2,
  'skillSourceManagementPage.unableToConfirmRemovalTryAgainLater':
    catalogSourcesZhCN.generated.skillSourceManagementPage.unableToConfirmRemovalTryAgainLater,
  'skillSourceManagementPage.skillRemoved':
    catalogSourcesZhCN.generated.skillSourceManagementPage.skillRemoved,
  'skillSourceManagementPage.enterprise': '企业',
  'skillSourceManagementPage.organization': '组织',
  'skillSourceManagementPage.personal':
    catalogSourcesZhCN.generated.skillSourceManagementPage.personal,
  'skillSourceManagementPage.skillSources':
    catalogSourcesZhCN.generated.skillSourceManagementPage.skillSources,
  'skillSourceManagementPage.manageExternalSourcesAndAddSkillsTo':
    '管理外部来源，并将需要的技能加入个人、组织或企业可用目录。',
  'skillSourceManagementPage.addSkillSource':
    catalogSourcesZhCN.generated.skillSourceManagementPage.addSkillSource,
  'skillSourceManagementPage.name': skillConfigurationZhCN.generated.skillSourceManagementPage.name,
  'skillSourceManagementPage.scope': catalogSourcesZhCN.generated.skillSourceManagementPage.scope,
  'skillSourceManagementPage.uRL': catalogSourcesZhCN.generated.skillSourceManagementPage.uRL,
  'skillSourceManagementPage.status': catalogSourcesZhCN.generated.skillSourceManagementPage.status,
  'skillSourceManagementPage.enabled':
    catalogSourcesZhCN.generated.skillSourceManagementPage.enabled,
  'skillSourceManagementPage.disabled':
    catalogSourcesZhCN.generated.skillSourceManagementPage.disabled,
  'skillSourceManagementPage.actions':
    skillConfigurationZhCN.generated.skillSourceManagementPage.actions,
  'skillSourceManagementPage.skillSourceStatusUpdated':
    catalogSourcesZhCN.generated.skillSourceManagementPage.skillSourceStatusUpdated,
  'skillSourceManagementPage.updateSkillSourceStatus':
    catalogSourcesZhCN.generated.skillSourceManagementPage.updateSkillSourceStatus,
  'skillSourceManagementPage.confirmDisableSkillSource':
    catalogSourcesZhCN.generated.skillSourceManagementPage.confirmDisableSkillSource,
  'skillSourceManagementPage.confirmEnableSkillSource':
    catalogSourcesZhCN.generated.skillSourceManagementPage.confirmEnableSkillSource,
  'skillSourceManagementPage.unableToConfirmSourceStatusChange':
    catalogSourcesZhCN.generated.skillSourceManagementPage.unableToConfirmSourceStatusChange,
  'skillSourceManagementPage.disable':
    catalogSourcesZhCN.generated.skillSourceManagementPage.disable,
  'skillSourceManagementPage.enable': catalogSourcesZhCN.generated.skillSourceManagementPage.enable,
  'skillSourceManagementPage.delete2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.delete2,
  'skillSourceManagementPage.sourceSkills':
    catalogSourcesZhCN.generated.skillSourceManagementPage.sourceSkills,
  'skillSourceManagementPage.selectASkillSource':
    catalogSourcesZhCN.generated.skillSourceManagementPage.selectASkillSource,
  'skillSourceManagementPage.selectAnEnabledSkillSource':
    catalogSourcesZhCN.generated.skillSourceManagementPage.selectAnEnabledSkillSource,
  'skillSourceManagementPage.enterASkillNameOrDescription':
    catalogSourcesZhCN.generated.skillSourceManagementPage.enterASkillNameOrDescription,
  'skillSourceManagementPage.search': catalogSourcesZhCN.generated.skillSourceManagementPage.search,
  'skillSourceManagementPage.noDescriptionWasProvidedByThisSource':
    catalogSourcesZhCN.generated.skillSourceManagementPage.noDescriptionWasProvidedByThisSource,
  'skillSourceManagementPage.details': '详情',
  'skillSourceManagementPage.addToCatalog':
    catalogSourcesZhCN.generated.skillSourceManagementPage.addToCatalog,
  'skillSourceManagementPage.noPopularSkillsAreAvailableEnterA':
    catalogSourcesZhCN.generated.skillSourceManagementPage.noPopularSkillsAreAvailableEnterA,
  'skillSourceManagementPage.thisSourceHasNoAvailableSkills':
    catalogSourcesZhCN.generated.skillSourceManagementPage.thisSourceHasNoAvailableSkills,
  'skillSourceManagementPage.selectAnEnabledSkillSource2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.selectAnEnabledSkillSource2,
  'skillSourceManagementPage.catalogSkills':
    catalogSourcesZhCN.generated.skillSourceManagementPage.catalogSkills,
  'skillSourceManagementPage.searchSkillNamesOrDescriptions':
    catalogSourcesZhCN.generated.skillSourceManagementPage.searchSkillNamesOrDescriptions,
  'skillSourceManagementPage.catalogSkillCategories':
    catalogSourcesZhCN.generated.skillSourceManagementPage.catalogSkillCategories,
  'skillSourceManagementPage.all': catalogSourcesZhCN.generated.skillSourceManagementPage.all,
  'skillSourceManagementPage.noDescriptionIsAvailableForThisSkill':
    catalogSourcesZhCN.generated.skillSourceManagementPage.noDescriptionIsAvailableForThisSkill,
  'skillSourceManagementPage.version': '版本',
  'skillSourceManagementPage.updated':
    catalogSourcesZhCN.generated.skillSourceManagementPage.updated,
  'skillSourceManagementPage.featured':
    catalogSourcesZhCN.generated.skillSourceManagementPage.featured,
  'skillSourceManagementPage.details2': '详情',
  'skillSourceManagementPage.edit': catalogSourcesZhCN.generated.skillSourceManagementPage.edit,
  'skillSourceManagementPage.checkForUpdates':
    catalogSourcesZhCN.generated.skillSourceManagementPage.checkForUpdates,
  'skillSourceManagementPage.updateTo':
    catalogSourcesZhCN.generated.skillSourceManagementPage.updateTo,
  'skillSourceManagementPage.remove2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.remove2,
  'skillSourceManagementPage.noCatalogSkills':
    catalogSourcesZhCN.generated.skillSourceManagementPage.noCatalogSkills,
  'skillSourceManagementPage.noMatchingSkills':
    catalogSourcesZhCN.generated.skillSourceManagementPage.noMatchingSkills,
  'skillSourceManagementPage.addSkillSource2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.addSkillSource2,
  'skillSourceManagementPage.name2': catalogSourcesZhCN.generated.skillSourceManagementPage.name2,
  'skillSourceManagementPage.repositoryURL':
    catalogSourcesZhCN.generated.skillSourceManagementPage.repositoryURL,
  'skillSourceManagementPage.httpsGithubComOrgRepoOrGit':
    catalogSourcesZhCN.generated.skillSourceManagementPage.httpsGithubComOrgRepoOrGit,
  'skillSourceManagementPage.gitRepositoriesUseTheServerProcessUser':
    catalogSourcesZhCN.generated.skillSourceManagementPage.gitRepositoriesUseTheServerProcessUser,
  'skillSourceManagementPage.scope2': catalogSourcesZhCN.generated.skillSourceManagementPage.scope2,
  'skillSourceManagementPage.personal2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.personal2,
  'skillSourceManagementPage.organization2': '组织',
  'skillSourceManagementPage.enterprise2': '企业',
  'skillSourceManagementPage.organization3': '组织',
  'skillSourceManagementPage.selectAManageableOrganization': '选择可管理的组织',
  'skillSourceManagementPage.cancel3':
    catalogSourcesZhCN.generated.skillSourceManagementPage.cancel3,
  'skillSourceManagementPage.add': catalogSourcesZhCN.generated.skillSourceManagementPage.add,
  'skillSourceManagementPage.addToCatalog2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.addToCatalog2,
  'skillSourceManagementPage.availability':
    catalogSourcesZhCN.generated.skillSourceManagementPage.availability,
  'skillSourceManagementPage.personal3':
    catalogSourcesZhCN.generated.skillSourceManagementPage.personal3,
  'skillSourceManagementPage.organizationMembers': '组织成员',
  'skillSourceManagementPage.enterpriseMembers': '企业成员',
  'skillSourceManagementPage.organization4': '组织',
  'skillSourceManagementPage.selectAManageableOrganization2': '选择可管理的组织',
  'skillSourceManagementPage.featured2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.featured2,
  'skillSourceManagementPage.tags': catalogSourcesZhCN.generated.skillSourceManagementPage.tags,
  'skillSourceManagementPage.enterATagAndPressEnterUp':
    catalogSourcesZhCN.generated.skillSourceManagementPage.enterATagAndPressEnterUp,
  'skillSourceManagementPage.cancel4':
    catalogSourcesZhCN.generated.skillSourceManagementPage.cancel4,
  'skillSourceManagementPage.add2': catalogSourcesZhCN.generated.skillSourceManagementPage.add2,
  'skillSourceManagementPage.editSkillInformation':
    catalogSourcesZhCN.generated.skillSourceManagementPage.editSkillInformation,
  'skillSourceManagementPage.featured3':
    catalogSourcesZhCN.generated.skillSourceManagementPage.featured3,
  'skillSourceManagementPage.tags2': catalogSourcesZhCN.generated.skillSourceManagementPage.tags2,
  'skillSourceManagementPage.enterATagAndPressEnterUp2':
    catalogSourcesZhCN.generated.skillSourceManagementPage.enterATagAndPressEnterUp2,
  'skillSourceManagementPage.cancel5':
    catalogSourcesZhCN.generated.skillSourceManagementPage.cancel5,
  'skillSourceManagementPage.save': catalogSourcesZhCN.generated.skillSourceManagementPage.save,

  'mcpSourceManagementPage.enterASourceName':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.enterASourceName,
  'mcpSourceManagementPage.enterARegistryURL':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.enterARegistryURL,
  'mcpSourceManagementPage.enterAnHTTPSURL':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.enterAnHTTPSURL,
  'mcpSourceManagementPage.selectAnOrganization': '请选择组织',
  'mcpSourceManagementPage.selectAnOrganization2': '请选择组织',
  'mcpSourceManagementPage.addNoMoreThan10Tags':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.addNoMoreThan10Tags,
  'mcpSourceManagementPage.eachTagMustContain132Characters':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.eachTagMustContain132Characters,
  'mcpSourceManagementPage.duplicateTagsAreNotAllowed':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.duplicateTagsAreNotAllowed,
  'mcpSourceManagementPage.mCPSourceAdded':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.mCPSourceAdded,
  'mcpSourceManagementPage.deleteMCPSource':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.deleteMCPSource,
  'mcpSourceManagementPage.deleteMCPSource2':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.deleteMCPSource2,
  'mcpSourceManagementPage.delete': catalogSourcesZhCN.generated.mcpSourceManagementPage.delete,
  'mcpSourceManagementPage.cancel': catalogSourcesZhCN.generated.mcpSourceManagementPage.cancel,
  'mcpSourceManagementPage.mCPSourceDeleted':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.mCPSourceDeleted,
  'mcpSourceManagementPage.addedToMCPCenter':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.addedToMCPCenter,
  'mcpSourceManagementPage.mCPInformationUpdated':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.mCPInformationUpdated,
  'mcpSourceManagementPage.updateAvailable':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.updateAvailable,
  'mcpSourceManagementPage.alreadyUpToDate':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.alreadyUpToDate,
  'mcpSourceManagementPage.mCPCatalogVersionUpdated':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.mCPCatalogVersionUpdated,
  'mcpSourceManagementPage.removeFromMCPCenter':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.removeFromMCPCenter,
  'mcpSourceManagementPage.removeCatalogEntry':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.removeCatalogEntry,
  'mcpSourceManagementPage.remove': catalogSourcesZhCN.generated.mcpSourceManagementPage.remove,
  'mcpSourceManagementPage.cancel2': catalogSourcesZhCN.generated.mcpSourceManagementPage.cancel2,
  'mcpSourceManagementPage.removedFromMCPCenter':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.removedFromMCPCenter,
  'mcpSourceManagementPage.thisMCPServerIsAlreadyInThe':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.thisMCPServerIsAlreadyInThe,
  'mcpSourceManagementPage.theMCPSourceOperationDidNotComplete': 'MCP 源操作未完成。',
  'mcpSourceManagementPage.enterprise': '企业',
  'mcpSourceManagementPage.organization': '组织',
  'mcpSourceManagementPage.personal': catalogSourcesZhCN.generated.mcpSourceManagementPage.personal,
  'mcpSourceManagementPage.mCPSources':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.mCPSources,
  'mcpSourceManagementPage.manageRegistrySourcesAndAddMCPServers':
    '管理 Registry 来源，并将需要的 MCP Server 加入个人、组织或企业可用目录。',
  'mcpSourceManagementPage.addMCPSource':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.addMCPSource,
  'mcpSourceManagementPage.name': skillConfigurationZhCN.generated.mcpSourceManagementPage.name,
  'mcpSourceManagementPage.scope': skillConfigurationZhCN.generated.mcpSourceManagementPage.scope,
  'mcpSourceManagementPage.uRL': catalogSourcesZhCN.generated.mcpSourceManagementPage.uRL,
  'mcpSourceManagementPage.status': catalogSourcesZhCN.generated.mcpSourceManagementPage.status,
  'mcpSourceManagementPage.enabled': catalogSourcesZhCN.generated.mcpSourceManagementPage.enabled,
  'mcpSourceManagementPage.disabled': catalogSourcesZhCN.generated.mcpSourceManagementPage.disabled,
  'mcpSourceManagementPage.actions':
    skillConfigurationZhCN.generated.mcpSourceManagementPage.actions,
  'mcpSourceManagementPage.updateMCPSourceStatus':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.updateMCPSourceStatus,
  'mcpSourceManagementPage.confirmDisableMCPSource':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.confirmDisableMCPSource,
  'mcpSourceManagementPage.confirmEnableMCPSource':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.confirmEnableMCPSource,
  'mcpSourceManagementPage.disable': catalogSourcesZhCN.generated.mcpSourceManagementPage.disable,
  'mcpSourceManagementPage.enable': catalogSourcesZhCN.generated.mcpSourceManagementPage.enable,
  'mcpSourceManagementPage.delete2': catalogSourcesZhCN.generated.mcpSourceManagementPage.delete2,
  'mcpSourceManagementPage.sourceMCPServers':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.sourceMCPServers,
  'mcpSourceManagementPage.selectAnEnabledMCPSource':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.selectAnEnabledMCPSource,
  'mcpSourceManagementPage.enterAnMCPServerNameOrDescription':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.enterAnMCPServerNameOrDescription,
  'mcpSourceManagementPage.search': catalogSourcesZhCN.generated.mcpSourceManagementPage.search,
  'mcpSourceManagementPage.noDescriptionWasProvidedByThisSource':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.noDescriptionWasProvidedByThisSource,
  'mcpSourceManagementPage.version': '版本',
  'mcpSourceManagementPage.details': '详情',
  'mcpSourceManagementPage.added': catalogSourcesZhCN.generated.mcpSourceManagementPage.added,
  'mcpSourceManagementPage.addToCatalog':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.addToCatalog,
  'mcpSourceManagementPage.enterAKeywordToSearchThisSource':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.enterAKeywordToSearchThisSource,
  'mcpSourceManagementPage.selectAnEnabledMCPSource2':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.selectAnEnabledMCPSource2,
  'mcpSourceManagementPage.catalogMCPServers':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.catalogMCPServers,
  'mcpSourceManagementPage.noDescriptionIsAvailableForThisMCP':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.noDescriptionIsAvailableForThisMCP,
  'mcpSourceManagementPage.featured': catalogSourcesZhCN.generated.mcpSourceManagementPage.featured,
  'mcpSourceManagementPage.version2': '版本',
  'mcpSourceManagementPage.details2': '详情',
  'mcpSourceManagementPage.edit': catalogSourcesZhCN.generated.mcpSourceManagementPage.edit,
  'mcpSourceManagementPage.checkForUpdates':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.checkForUpdates,
  'mcpSourceManagementPage.updateTo': catalogSourcesZhCN.generated.mcpSourceManagementPage.updateTo,
  'mcpSourceManagementPage.remove2': catalogSourcesZhCN.generated.mcpSourceManagementPage.remove2,
  'mcpSourceManagementPage.noCatalogMCPServers':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.noCatalogMCPServers,
  'mcpSourceManagementPage.addMCPSource2':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.addMCPSource2,
  'mcpSourceManagementPage.name2': catalogSourcesZhCN.generated.mcpSourceManagementPage.name2,
  'mcpSourceManagementPage.scope2': catalogSourcesZhCN.generated.mcpSourceManagementPage.scope2,
  'mcpSourceManagementPage.personal2':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.personal2,
  'mcpSourceManagementPage.organization2': '组织',
  'mcpSourceManagementPage.enterprise2': '企业',
  'mcpSourceManagementPage.organization3': '组织',
  'mcpSourceManagementPage.cancel3': catalogSourcesZhCN.generated.mcpSourceManagementPage.cancel3,
  'mcpSourceManagementPage.confirm': catalogSourcesZhCN.generated.mcpSourceManagementPage.confirm,
  'mcpSourceManagementPage.addToMCPCenter':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.addToMCPCenter,
  'mcpSourceManagementPage.scope3': catalogSourcesZhCN.generated.mcpSourceManagementPage.scope3,
  'mcpSourceManagementPage.personal3':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.personal3,
  'mcpSourceManagementPage.organization4': '组织',
  'mcpSourceManagementPage.enterprise3': '企业',
  'mcpSourceManagementPage.organization5': '组织',
  'mcpSourceManagementPage.tags': catalogSourcesZhCN.generated.mcpSourceManagementPage.tags,
  'mcpSourceManagementPage.selectAnExistingTagOrEnterA':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.selectAnExistingTagOrEnterA,
  'mcpSourceManagementPage.featured2':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.featured2,
  'mcpSourceManagementPage.cancel4': catalogSourcesZhCN.generated.mcpSourceManagementPage.cancel4,
  'mcpSourceManagementPage.confirm2': catalogSourcesZhCN.generated.mcpSourceManagementPage.confirm2,
  'mcpSourceManagementPage.editMCPInformation':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.editMCPInformation,
  'mcpSourceManagementPage.featured3':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.featured3,
  'mcpSourceManagementPage.tags2': catalogSourcesZhCN.generated.mcpSourceManagementPage.tags2,
  'mcpSourceManagementPage.selectAnExistingTagOrEnterA2':
    catalogSourcesZhCN.generated.mcpSourceManagementPage.selectAnExistingTagOrEnterA2,
  'mcpSourceManagementPage.cancel5': catalogSourcesZhCN.generated.mcpSourceManagementPage.cancel5,
  'mcpSourceManagementPage.save': catalogSourcesZhCN.generated.mcpSourceManagementPage.save,

  'mcpDetailsDialog.mCPDetails': skillConfigurationZhCN.generated.mcpDetailsDialog.mCPDetails,
  'mcpDetailsDialog.noDescriptionIsAvailableForThisMCP':
    skillConfigurationZhCN.generated.mcpDetailsDialog.noDescriptionIsAvailableForThisMCP,
  'mcpDetailsDialog.serverName': skillConfigurationZhCN.generated.mcpDetailsDialog.serverName,
  'mcpDetailsDialog.source': skillConfigurationZhCN.generated.mcpDetailsDialog.source,
  'mcpDetailsDialog.availability': skillConfigurationZhCN.generated.mcpDetailsDialog.availability,
  'mcpDetailsDialog.version': skillConfigurationZhCN.generated.mcpDetailsDialog.version,
  'mcpDetailsDialog.transport': skillConfigurationZhCN.generated.mcpDetailsDialog.transport,
  'mcpDetailsDialog.updated': skillConfigurationZhCN.generated.mcpDetailsDialog.updated,
  'mcpDetailsDialog.status': skillConfigurationZhCN.generated.mcpDetailsDialog.status,
  'mcpDetailsDialog.tags': skillConfigurationZhCN.generated.mcpDetailsDialog.tags,
  'mcpDetailsDialog.featured': skillConfigurationZhCN.generated.mcpDetailsDialog.featured,
  'mcpDetailsDialog.close': skillConfigurationZhCN.generated.mcpDetailsDialog.close,

  'auditManagementPage.managementOperation': '管理操作',
  'auditManagementPage.conversationInput': '对话输入',
  'auditManagementPage.administratorInitialized': '管理员初始化',
  'auditManagementPage.signInSucceeded': '登录成功',
  'auditManagementPage.signInFailed': '登录失败',
  'auditManagementPage.signInRateLimited': '登录限流',
  'auditManagementPage.signInSessionEvicted': '登录会话自动淘汰',
  'auditManagementPage.signedOut': '退出登录',
  'auditManagementPage.userSessionRevoked': '撤销用户会话',
  'auditManagementPage.passwordChanged': '修改密码',
  'auditManagementPage.passwordReset': '重置密码',
  'auditManagementPage.userPasswordResetByAdministrator': '管理员重置用户密码',
  'auditManagementPage.userCreated': '创建用户',
  'auditManagementPage.userCreatedByAdministrator': '管理员创建用户',
  'auditManagementPage.userDeleted': '删除用户',
  'auditManagementPage.userDeletedByAdministrator': '管理员删除用户',
  'auditManagementPage.nodeRegistered': '登记节点',
  'auditManagementPage.nodeRegistrationTokenCreated': '创建节点注册密钥',
  'auditManagementPage.nodeRevoked': '撤销节点',
  'auditManagementPage.nodeDeleted': '删除节点',
  'auditManagementPage.environmentSecretCreated': '创建环境密钥',
  'auditManagementPage.environmentSecretReplaced': '替换环境密钥',
  'auditManagementPage.environmentSecretDeleted': '删除环境密钥',
  'auditManagementPage.approvalDecided': '完成审批',
  'auditManagementPage.agentInputRequestAnswered': '回应 Agent 输入请求',
  'auditManagementPage.sessionInterruptRequested': '请求中断会话',
  'auditManagementPage.licenseImported': 'License 导入',
  'auditManagementPage.resourceGrant': '资源授权',
  'auditManagementPage.resourceOwnershipChanged': '资源归属变更',
  'auditManagementPage.oAuthIdentityBound': '绑定 OAuth 身份',
  'auditManagementPage.oAuthIdentityUnbound': '解除 OAuth 身份绑定',
  'auditManagementPage.create': '创建',
  'auditManagementPage.update': '修改',
  'auditManagementPage.delete': '删除',
  'auditManagementPage.view': '查看',
  'auditManagementPage.sendMessage': '发送对话',
  'auditManagementPage.import': '导入',
  'auditManagementPage.export': '导出',
  'auditManagementPage.grant': '授权',
  'auditManagementPage.revokeGrant': '撤销授权',
  'auditManagementPage.workspace': '工作区',
  'auditManagementPage.session': '会话',
  'auditManagementPage.conversation': '对话',
  'auditManagementPage.terminal': '终端',
  'auditManagementPage.file': '文件',
  'auditManagementPage.node': '节点',
  'auditManagementPage.organization': '组织',
  'auditManagementPage.user': '用户',
  'auditManagementPage.oAuthProvider': 'OAuth 身份源',
  'auditManagementPage.resource': '资源',
  'auditManagementPage.create2': '创建',
  'auditManagementPage.start': '启动',
  'auditManagementPage.open': '打开',
  'auditManagementPage.update2': '修改',
  'auditManagementPage.save': '保存',
  'auditManagementPage.delete2': '删除',
  'auditManagementPage.remove': '移除',
  'auditManagementPage.close': '关闭',
  'auditManagementPage.cancel': '取消',
  'auditManagementPage.interrupt': '中断',
  'auditManagementPage.respond': '回应',
  'auditManagementPage.decide': '审批',
  'auditManagementPage.restore': '恢复',
  'auditManagementPage.execute': '执行',
  'auditManagementPage.reorder': '重排',
  'auditManagementPage.pause': '暂停',
  'auditManagementPage.resume': '继续',
  'auditManagementPage.sendMessage2': '发送消息',
  'auditManagementPage.success': '成功',
  'auditManagementPage.denied': '已拒绝',
  'auditManagementPage.failed': '失败',
  'auditManagementPage.user2': '用户',
  'auditManagementPage.organization2': '组织',
  'auditManagementPage.enterprise': '企业',
  'auditManagementPage.node2': '节点',
  'auditManagementPage.workspace2': '工作区',
  'auditManagementPage.session2': '会话',
  'auditManagementPage.run': '运行',
  'auditManagementPage.password': '密码',
  'auditManagementPage.system': '系统',
  'auditManagementPage.requestID': '请求 ID',
  'auditManagementPage.operationID': '操作 ID',
  'auditManagementPage.targetType': '目标类型',
  'auditManagementPage.targetID': '目标 ID',
  'auditManagementPage.organizationID': '组织 ID',
  'auditManagementPage.nodeID': '节点 ID',
  'auditManagementPage.workspaceID': '工作区 ID',
  'auditManagementPage.sessionID': '会话 ID',
  'auditManagementPage.runID': '运行 ID',
  'auditManagementPage.clientMessageID': '客户端消息 ID',
  'auditManagementPage.queueItemID': '队列项 ID',
  'auditManagementPage.inputMode': '输入方式',
  'auditManagementPage.insufficientPermissions': '权限不足',
  'auditManagementPage.licenseManagementFrozen': 'License 已冻结',
  'auditManagementPage.requestValidationFailed': '请求校验失败',
  'auditManagementPage.requestOriginNotAllowed': '请求来源不允许',
  'auditManagementPage.executeRunnerCommand': '执行 Agent 命令',
  'auditManagementPage.createNodeRegistrationToken': '创建节点注册密钥',
  'auditManagementPage.pushNodeUpgrade': '推送节点升级',
  'auditManagementPage.cancelNodeUpgrade': '取消节点升级',
  'auditManagementPage.createResourceGrant': '创建资源授权',
  'auditManagementPage.createOAuthProvider': '创建 OAuth 身份源',
  'auditManagementPage.importLicense': '导入 License',
  'auditManagementPage.createExecute': '创建/执行',
  'auditManagementPage.replace': '替换',
  'auditManagementPage.update3': '修改',
  'auditManagementPage.delete3': '删除',
  'auditManagementPage.organization3': '组织',
  'auditManagementPage.managedObject': '管理对象',
  'auditManagementPage.enterpriseUser': '企业用户',
  'auditManagementPage.node3': '节点',
  'auditManagementPage.workspace3': '工作区',
  'auditManagementPage.resourceGrant2': '资源授权',
  'auditManagementPage.oAuthProvider2': 'OAuth 身份源',
  'auditManagementPage.systemConfiguration': '系统配置',
  'auditManagementPage.secret': '密钥',
  'auditManagementPage.nodeRegistrationToken': '节点注册密钥',
  'auditManagementPage.runnerProfile': 'Agent 配置',
  'auditManagementPage.runnerCommand': 'Agent 命令',
  'auditManagementPage.auditEvent': '审计记录',
  'auditManagementPage.authentication': '认证',
  'auditManagementPage.systemOperation': '系统操作',
  'auditManagementPage.systemOperation2': '系统操作',
  'auditManagementPage.unableToLoadAuditEvents': '读取审计失败',
  'auditManagementPage.auditLog': '操作审计',
  'auditManagementPage.recordsOperationsAndRelatedIDsWithoutStoring':
    '记录操作事实和关联 ID，不记录对话或终端正文。',
  'auditManagementPage.timeRange': '时间范围：',
  'auditManagementPage.to': '至',
  'auditManagementPage.startTime': '开始时间',
  'auditManagementPage.endTime': '结束时间',
  'auditManagementPage.refresh': '刷新',
  'auditManagementPage.exportCSV': '导出 CSV',
  'auditManagementPage.time': '时间',
  'auditManagementPage.event': '事件',
  'auditManagementPage.actor': '操作人',
  'auditManagementPage.result': '结果',
  'auditManagementPage.actions': '操作',
  'auditManagementPage.view2': '查看',
  'auditManagementPage.loadMore': '加载更多',
  'auditManagementPage.auditDetails': '审计详情',
  'auditManagementPage.auditEventId': '审计记录 ID',
  'auditManagementPage.event2': '事件',
  'auditManagementPage.time2': '时间',
  'auditManagementPage.actor2': '操作人',
  'auditManagementPage.authentication2': '认证',
  'auditManagementPage.result2': '结果',
  'auditManagementPage.sharedConversationInputAccepted': '共享会话消息已接受',
  'auditManagementPage.sharedConversationInputRejected': '共享会话消息已拒绝',
  'auditManagementPage.sharedConversationQueueUpdated': '共享会话队列已更新',
  'auditManagementPage.sharedConversationQueueDeleted': '共享会话队列已删除',
  'auditManagementPage.sharedConversationQueueReordered': '共享会话队列已重排',
  'auditManagementPage.sharedConversationQueueExecuteRequested': '共享会话队列已请求立即执行',
  'auditManagementPage.conversationHostingDisabled': '托管对话已禁用',
  'auditManagementPage.conversationHostingStorageInspected': '已查看托管对话存储',
  'auditManagementPage.sessionPublicID': '会话公开 ID',
  'auditManagementPage.conversationTitle': '会话标题',
  'auditManagementPage.userMessage': '用户消息',
  'auditManagementPage.errorCode': '错误码',
  'auditManagementPage.inputModeNewSession': '新建会话',
  'auditManagementPage.inputModeSend': '发送消息',
  'auditManagementPage.inputModeContinue': '继续运行',
  'auditManagementPage.inputModeSteer': '引导运行',
  'auditManagementPage.inputModeQueue': '加入队列',
  'auditManagementPage.inputModeReplaceCurrent': '替换当前运行',
  'auditManagementPage.inputModeRunNow': '立即运行',
  'auditManagementPage.inputModeUserInputResponse': '回答运行输入',
  'auditManagementPage.inputModeEditQueue': '编辑队列消息',
  'auditManagementPage.inputModeDeleteQueue': '删除队列消息',
  'auditManagementPage.inputModeReorderQueue': '重排队列',
  'auditManagementPage.inputModeExecuteQueue': '立即执行队列消息',
  'auditManagementPage.inputModePauseQueue': '暂停队列',
  'auditManagementPage.inputModeResumeQueue': '恢复队列',

  'workspaceTree.collapseWorkspaces': workbenchShellZhCN.generated.workspaceTree.collapseWorkspaces,
  'workspaceTree.expandWorkspaces': workbenchShellZhCN.generated.workspaceTree.expandWorkspaces,
  'workspaceTree.addWorkspace': workbenchShellZhCN.generated.workspaceTree.addWorkspace,
  'workspaceTree.refreshWorkspaces': workbenchShellZhCN.generated.workspaceTree.refreshWorkspaces,
  'workspaceTree.nodeActions': workbenchShellZhCN.generated.workspaceTree.nodeActions,
  'workspaceTree.nodeDetails': workbenchShellZhCN.generated.workspaceTree.nodeDetails,
  'workspaceTree.workspaceActions': workbenchShellZhCN.generated.workspaceTree.workspaceActions,
  'workspaceTree.workspaceDetails': workbenchShellZhCN.generated.workspaceTree.workspaceDetails,
  'workspaceTree.rename': workbenchShellZhCN.generated.workspaceTree.rename,
  'workspaceTree.cleanupSessions': '清理会话',
  'workspaceTree.delete': workbenchShellZhCN.generated.workspaceTree.delete,
  'workspaceTree.enterWorkspaceName': workspaceZhCN.generated.workspaceTree.enterWorkspaceName,
  'workspaceTree.renameWorkspace': workspaceZhCN.generated.workspaceTree.renameWorkspace,
  'workspaceTree.workspaceNameRequired':
    workspaceZhCN.generated.workspaceTree.workspaceNameRequired,
  'workspaceTree.workspaceNameTooLong': workspaceZhCN.generated.workspaceTree.workspaceNameTooLong,
  'workspaceTree.save': workspaceZhCN.generated.workspaceTree.save,
  'workspaceTree.cancel': workspaceZhCN.generated.workspaceTree.cancel,
  'workspaceTree.unregister': '移除 {value0}',
  'workspaceTree.unregisterWorkspace': '移除工作区',
  'workspaceTree.selectAWorkspaceToContinueInThe':
    workbenchShellZhCN.generated.workspaceTree.selectAWorkspaceToContinueInThe,
  'workspaceTree.noNodes': workbenchShellZhCN.generated.workspaceTree.noNodes,
  'nodeManagementPage.unableToDeleteNode': '删除节点失败',
  'nodeManagementPage.deleteNodeItMustBeRegisteredAgain':
    '确定删除节点“{value0}”吗？删除后该节点需要重新登记才能使用。',
  'nodeManagementPage.deleteNode': '确认删除节点',
  'nodeManagementPage.deleteNode2': '删除节点',
  'nodeManagementPage.cancel': '取消',
  'nodeManagementPage.disabled': '禁用',
  'nodeManagementPage.online': '在线',
  'nodeManagementPage.offline': '离线',
  'nodeManagementPage.noHeartbeat': '暂无心跳',
  'nodeManagementPage.available': '可用',
  'nodeManagementPage.nodeManagement': '节点管理',
  'nodeManagementPage.viewNodeRegistrationStatusAndRemoveNodes': '查看节点登记状态并删除节点。',
  'nodeManagementPage.selectOwner': '请选择所属用户',
  'nodeManagementPage.selectStatus': '请选择状态',
  'nodeManagementPage.online2': '在线',
  'nodeManagementPage.offline2': '离线',
  'nodeManagementPage.disabled2': '禁用',
  'nodeManagementPage.node': '节点',
  'nodeManagementPage.owner': '所属用户',
  'nodeManagementPage.platform': '平台',
  'nodeManagementPage.nodeVersion': '节点版本',
  'nodeManagementPage.status': '状态',
  'nodeManagementPage.actions': '操作',
  'nodeManagementPage.details': '详情',
  'nodeManagementPage.delete': '删除',
  'nodeManagementPage.nodeDetails': '节点详情',
  'nodeManagementPage.name': '名称',
  'nodeManagementPage.owner2': '所属用户',
  'nodeManagementPage.registeredAddress': '注册地址',
  'nodeManagementPage.status2': '状态',
  'nodeManagementPage.system': '系统',
  'nodeManagementPage.nodeVersion2': '节点版本',
  'nodeManagementPage.toolEnvironment': '工具环境',
  'nodeManagementPage.supportedAgents': '支持的 Agent',
  'nodeManagementPage.none': '无',
  'nodeManagementPage.lastHeartbeat': '最近心跳',
  'workspaceTransferDock.fileTransfers': '文件传输',
  'workspaceTransferDock.fileTransfers2': '文件传输',
  'workspaceTransferDock.closeFileTransfers': '关闭文件传输',
  'workspaceTransferDock.bytes': '字节',
  'workspaceTransferDock.resume': '恢复',
  'workspaceTransferDock.retry': '重试',
  'workspaceTransferDock.cancel': '取消',
  'workspaceTransferDock.delete': '删除',

  'oAuthManagementPage.oAuthURLsMustUseHTTPS': 'OAuth 地址必须使用 HTTPS',
  'oAuthManagementPage.enterAValidOAuthURL': '请输入有效 OAuth 地址',
  'oAuthManagementPage.enterAProviderKey': '请输入来源标识',
  'oAuthManagementPage.theProviderKeyCanContainOnlyLowercase':
    '来源标识只能使用小写字母、数字和连字符',
  'oAuthManagementPage.enterADisplayName': '请输入显示名称',
  'oAuthManagementPage.theDisplayNameCannotExceed128Characters': '显示名称不能超过 128 个字符',
  'oAuthManagementPage.enterTheClientID': '请输入 Client ID',
  'oAuthManagementPage.theClientIDCannotExceed512Characters': 'Client ID 不能超过 512 个字符',
  'oAuthManagementPage.enterTheClientSecret': '请输入 Client Secret',
  'oAuthManagementPage.enterTheAuthorizationURL': '请输入授权地址',
  'oAuthManagementPage.enterTheTokenURL': '请输入 Token 地址',
  'oAuthManagementPage.enterTheUserInfoURL': '请输入 UserInfo 地址',
  'oAuthManagementPage.scopesCanContainUpTo32Entries': 'Scopes 最多 32 项，每项不超过 128 个字符',
  'oAuthManagementPage.selectAPKCEMode': '请选择 PKCE 模式',
  'oAuthManagementPage.selectHowToSendTheClientSecret': '请选择 Client Secret 发送方式',
  'oAuthManagementPage.enterTheExternalUserIDJSONPointer': '请输入外部用户 ID JSON Pointer',
  'oAuthManagementPage.enterAValidJSONPointerSuchAs': '请输入有效 JSON Pointer，例如 /data/open_id',
  'oAuthManagementPage.enterAValidJSONPointer': '请输入有效 JSON Pointer',
  'oAuthManagementPage.enterAValidJSONPointer2': '请输入有效 JSON Pointer',
  'oAuthManagementPage.unableToLoadOAuthProviders': '读取 OAuth 来源失败',
  'oAuthManagementPage.enterTheClientSecret2': '请输入 Client Secret',
  'oAuthManagementPage.oAuthProviderSavedTestItBeforeEnabling': 'OAuth 来源已保存，请测试后启用',
  'oAuthManagementPage.unableToSaveOAuthProvider': '保存 OAuth 来源失败',
  'oAuthManagementPage.configurationTestPassed': '配置测试通过',
  'oAuthManagementPage.oAuthConfigurationTestFailed': 'OAuth 配置测试失败',
  'oAuthManagementPage.unableToUpdateProviderStatus': '更新启用状态失败',
  'oAuthManagementPage.deleteOAuthProvider': '删除 OAuth 来源“{value0}”？',
  'oAuthManagementPage.deleteOAuthProvider2': '确认删除来源',
  'oAuthManagementPage.delete': '删除',
  'oAuthManagementPage.cancel': '取消',
  'oAuthManagementPage.unableToDeleteOAuthProvider': '删除 OAuth 来源失败',
  'oAuthManagementPage.oAuthConfiguration': 'OAuth 配置',
  'oAuthManagementPage.mapExternalIdentitiesOnlyFromTheToken':
    '仅从 Token Response 映射外部身份，每个来源使用独立标识和回调。',
  'oAuthManagementPage.provider': '来源：',
  'oAuthManagementPage.enterAProviderNameOrKey': '请输入来源名称或标识',
  'oAuthManagementPage.refresh': '刷新',
  'oAuthManagementPage.addProvider': '添加来源',
  'oAuthManagementPage.provider2': '来源',
  'oAuthManagementPage.providerKey': '来源标识',
  'oAuthManagementPage.autoProvisioning': '自动开户',
  'oAuthManagementPage.rootOrganizationMEMBER': '新用户将加入根组织并成为普通成员',
  'oAuthManagementPage.updateOAuthProviderStatus': '更新 OAuth 来源状态',
  'oAuthManagementPage.confirmDisableOAuthProvider':
    '停用 OAuth 来源“{value0}”？用户将无法通过该来源登录。',
  'oAuthManagementPage.confirmEnableOAuthProvider':
    '启用 OAuth 来源“{value0}”？用户可通过该来源登录。',
  'oAuthManagementPage.off': '关闭',
  'oAuthManagementPage.status': '状态',
  'oAuthManagementPage.enabled': '启用',
  'oAuthManagementPage.untested': '未测试',
  'oAuthManagementPage.disabled': '停用',
  'oAuthManagementPage.actions': '操作',
  'oAuthManagementPage.edit': '编辑',
  'oAuthManagementPage.test': '测试',
  'oAuthManagementPage.disable': '停用',
  'oAuthManagementPage.enable': '启用',
  'oAuthManagementPage.delete2': '删除',
  'oAuthManagementPage.editOAuthProvider': '编辑 OAuth 来源',
  'oAuthManagementPage.addOAuthProvider': '添加 OAuth 来源',
  'oAuthManagementPage.providerKey2': '来源标识',
  'oAuthManagementPage.forExampleFeishu': '例如 feishu',
  'oAuthManagementPage.displayName': '显示名称',
  'oAuthManagementPage.enterADisplayName2': '请输入显示名称',
  'oAuthManagementPage.callbackURL': '回调地址',
  'oAuthManagementPage.enterTheClientID2': '请输入 Client ID',
  'oAuthManagementPage.leaveBlankToKeepTheCurrentValue': '留空保留原值',
  'oAuthManagementPage.required': '必填',
  'oAuthManagementPage.authorizationURL': '授权地址',
  'oAuthManagementPage.enterTheOAuthAuthorizationURL': '请输入 OAuth 授权地址',
  'oAuthManagementPage.tokenURL': 'Token 地址',
  'oAuthManagementPage.enterTheOAuthTokenURL': '请输入 OAuth Token 地址',
  'oAuthManagementPage.userInfoURL': 'UserInfo 地址',
  'oAuthManagementPage.enterTheOAuthUserInfoURL': '请输入 OAuth UserInfo 地址',
  'oAuthManagementPage.scopesOnePerLine': 'Scopes（每行一个）',
  'oAuthManagementPage.enterOneScopePerLine': '请输入 Scopes，每行一个',
  'oAuthManagementPage.externalUserIDJSONPointer': '外部用户 ID JSON Pointer',
  'oAuthManagementPage.emailJSONPointerOptional': '邮箱 JSON Pointer（可选）',
  'oAuthManagementPage.leaveBlankToSkipExistingAccountMatching': '留空不匹配已有账号',
  'oAuthManagementPage.nameJSONPointerOptional': '姓名 JSON Pointer（可选）',
  'oAuthManagementPage.forExampleDataName': '例如 /data/name',
  'oAuthManagementPage.selectAPKCEMode2': '请选择 PKCE 模式',
  'oAuthManagementPage.required2': '必须',
  'oAuthManagementPage.supported': '支持',
  'oAuthManagementPage.disabled2': '关闭',
  'oAuthManagementPage.clientSecretMethod': 'Client Secret 发送方式',
  'oAuthManagementPage.selectAMethod': '请选择发送方式',
  'oAuthManagementPage.allowAutoProvisioningNewUsersAreCreated':
    '允许自动开户（新用户将加入根组织并成为普通成员）',
  'oAuthManagementPage.cancel2': '取消',
  'oAuthManagementPage.saveAndDisable': '保存并停用',

  'workbenchSurface.selectAWorkspace':
    workbenchPageZhCN.generated.workbenchSurface.selectAWorkspace,
  'workbenchSurface.selectANodeInTheResourceExplorer':
    workbenchPageZhCN.generated.workbenchSurface.selectANodeInTheResourceExplorer,
  'workbenchSurface.noNodeConnectedYetCreateARegistration':
    workbenchPageZhCN.generated.workbenchSurface.noNodeConnectedYetCreateARegistration,
  'workbenchSurface.openNodeManagement':
    workbenchPageZhCN.generated.workbenchSurface.openNodeManagement,
  'workbenchSurface.nodeWorkbenchCapabilitiesAreUnavailable':
    workbenchPageZhCN.generated.workbenchSurface.nodeWorkbenchCapabilitiesAreUnavailable,
  'workbenchSurface.openAWorkspace': workbenchPageZhCN.generated.workbenchSurface.openAWorkspace,
  'workbenchSurface.selectAWorkspaceOnTheCurrentNode':
    workbenchPageZhCN.generated.workbenchSurface.selectAWorkspaceOnTheCurrentNode,
  'workbenchSurface.agentConversation':
    workbenchPageZhCN.generated.workbenchSurface.agentConversation,
  'workbenchSurface.run': workbenchPageZhCN.generated.workbenchSurface.run,
  'workbenchSurface.thisSessionIsReadOnly':
    workbenchPageZhCN.generated.workbenchSurface.thisSessionIsReadOnly,
  'workbenchSurface.typeForCommandsToReferenceWorkspaceFiles':
    workbenchPageZhCN.generated.workbenchSurface.typeForCommandsToReferenceWorkspaceFiles,
  'workbenchSurface.readOnlyInspector':
    workbenchPageZhCN.generated.workbenchSurface.readOnlyInspector,
  'workbenchSurface.workspace': workbenchPageZhCN.generated.workbenchSurface.workspace,
  'workbenchSurface.theEnterpriseLicenseIsFrozenConfiguredResources':
    '企业 License 已冻结：已配置资源继续运行，管理写操作已停用；可在系统信息中导入新授权。',
  'workbenchSurface.theEnterpriseLicenseIsFrozenConfiguredResources2':
    '企业 License 已冻结：已配置资源继续运行，管理写操作已停用；请联系企业管理员更新授权。',
  'workspaceTabs.openWorkspaces': workbenchShellZhCN.generated.workspaceTabs.openWorkspaces,
  'workspaceTabs.close': workbenchShellZhCN.generated.workspaceTabs.close,
  'resourceSharingPage.enterAResourceName':
    resourceDetailsZhCN.generated.resourceSharingPage.enterAResourceName,
  'resourceSharingPage.theNodeNameCannotExceed128Characters':
    resourceDetailsZhCN.generated.resourceSharingPage.theNodeNameCannotExceed128Characters,
  'resourceSharingPage.theWorkspaceNameCannotExceed255Characters':
    resourceDetailsZhCN.generated.resourceSharingPage.theWorkspaceNameCannotExceed255Characters,
  'resourceSharingPage.enterANodeName':
    resourceDetailsZhCN.generated.resourceSharingPage.enterANodeName,
  'resourceSharingPage.theNodeNameCannotExceed128Characters2':
    resourceDetailsZhCN.generated.resourceSharingPage.theNodeNameCannotExceed128Characters2,
  'resourceSharingPage.selectATargetOrganization': '请选择目标组织',
  'resourceSharingPage.selectATargetUser': '请选择目标用户',
  'resourceSharingPage.personal': resourceDetailsZhCN.generated.resourceSharingPage.personal,
  'resourceSharingPage.unableToLoadResources':
    resourceDetailsZhCN.generated.resourceSharingPage.unableToLoadResources,
  'resourceSharingPage.disabled': resourceDetailsZhCN.generated.resourceSharingPage.disabled,
  'resourceSharingPage.online': resourceDetailsZhCN.generated.resourceSharingPage.online,
  'resourceSharingPage.offline': resourceDetailsZhCN.generated.resourceSharingPage.offline,
  'resourceSharingPage.waitingForRuns':
    resourceDetailsZhCN.generated.resourceSharingPage.waitingForRuns,
  'resourceSharingPage.readyToRestart':
    resourceDetailsZhCN.generated.resourceSharingPage.readyToRestart,
  'resourceSharingPage.upgradeFailed':
    resourceDetailsZhCN.generated.resourceSharingPage.upgradeFailed,
  'resourceSharingPage.unavailable': resourceDetailsZhCN.generated.resourceSharingPage.unavailable,
  'resourceSharingPage.upgradeTo': resourceDetailsZhCN.generated.resourceSharingPage.upgradeTo,
  'resourceSharingPage.upToDate': resourceDetailsZhCN.generated.resourceSharingPage.upToDate,
  'resourceSharingPage.nodeIsNewerThanServer':
    resourceDetailsZhCN.generated.resourceSharingPage.nodeIsNewerThanServer,
  'resourceSharingPage.unknownOrUnsupportedVersion':
    resourceDetailsZhCN.generated.resourceSharingPage.unknownOrUnsupportedVersion,
  'resourceSharingPage.enableSupervisorManually':
    resourceDetailsZhCN.generated.resourceSharingPage.enableSupervisorManually,
  'resourceSharingPage.targetNpmPackageUnavailable':
    resourceDetailsZhCN.generated.resourceSharingPage.targetNpmPackageUnavailable,
  'resourceSharingPage.upgradeToLimitedByTheLatestStable':
    resourceDetailsZhCN.generated.resourceSharingPage.upgradeToLimitedByTheLatestStable,
  'resourceSharingPage.pushNodeUpgrade':
    resourceDetailsZhCN.generated.resourceSharingPage.pushNodeUpgrade,
  'resourceSharingPage.pushUpgrade': resourceDetailsZhCN.generated.resourceSharingPage.pushUpgrade,
  'resourceSharingPage.pushAllUpgrades':
    resourceDetailsZhCN.generated.resourceSharingPage.pushAllUpgrades,
  'resourceSharingPage.confirmPushAllUpgrades':
    resourceDetailsZhCN.generated.resourceSharingPage.confirmPushAllUpgrades,
  'resourceSharingPage.pushAllUpgradesImpact':
    resourceDetailsZhCN.generated.resourceSharingPage.pushAllUpgradesImpact,
  'resourceSharingPage.pushAllUpgradesSucceeded':
    resourceDetailsZhCN.generated.resourceSharingPage.pushAllUpgradesSucceeded,
  'resourceSharingPage.pushAllUpgradesPartial':
    resourceDetailsZhCN.generated.resourceSharingPage.pushAllUpgradesPartial,
  'resourceSharingPage.cancel': resourceDetailsZhCN.generated.resourceSharingPage.cancel,
  'resourceSharingPage.upgradeRequestedTheNodeWillUpgradeWhen':
    resourceDetailsZhCN.generated.resourceSharingPage.upgradeRequestedTheNodeWillUpgradeWhen,
  'resourceSharingPage.pendingUpgradeCanceled':
    resourceDetailsZhCN.generated.resourceSharingPage.pendingUpgradeCanceled,
  'resourceSharingPage.unableToCancelUpgrade':
    resourceDetailsZhCN.generated.resourceSharingPage.unableToCancelUpgrade,
  'resourceSharingPage.resourceUpdated':
    resourceDetailsZhCN.generated.resourceSharingPage.resourceUpdated,
  'resourceSharingPage.unableToUpdateResource':
    resourceDetailsZhCN.generated.resourceSharingPage.unableToUpdateResource,
  'resourceSharingPage.unableToCreateRegistrationToken':
    resourceDetailsZhCN.generated.resourceSharingPage.unableToCreateRegistrationToken,
  'resourceSharingPage.deletingTheNodeRegistrationRequiresANew':
    resourceDetailsZhCN.generated.resourceSharingPage.deletingTheNodeRegistrationRequiresANew,
  'resourceSharingPage.unregisteringTheWorkspaceRemovesOnlyItsRegistration':
    resourceDetailsZhCN.generated.resourceSharingPage
      .unregisteringTheWorkspaceRemovesOnlyItsRegistration,
  'resourceSharingPage.deleteNode': resourceDetailsZhCN.generated.resourceSharingPage.deleteNode,
  'resourceSharingPage.unregisterWorkspace':
    resourceDetailsZhCN.generated.resourceSharingPage.unregisterWorkspace,
  'resourceSharingPage.deleteNode2': resourceDetailsZhCN.generated.resourceSharingPage.deleteNode2,
  'resourceSharingPage.unregisterWorkspace2':
    resourceDetailsZhCN.generated.resourceSharingPage.unregisterWorkspace2,
  'resourceSharingPage.cancel2': resourceDetailsZhCN.generated.resourceSharingPage.cancel2,
  'resourceSharingPage.unableToLoadUsage':
    resourceDetailsZhCN.generated.resourceSharingPage.unableToLoadUsage,
  'resourceSharingPage.usageUnavailable':
    resourceDetailsZhCN.generated.resourceSharingPage.usageUnavailable,
  'resourceSharingPage.type': resourceDetailsZhCN.generated.resourceSharingPage.type,
  'resourceSharingPage.branch': resourceDetailsZhCN.generated.resourceSharingPage.branch,
  'resourceSharingPage.unableToLoadGrants': '读取授权失败',
  'resourceSharingPage.unableToCreateGrant': '创建授权失败',
  'resourceSharingPage.afterRevocationTheTargetImmediatelyLosesDirect':
    '撤销后目标用户将立即失去该资源的直接使用权。',
  'resourceSharingPage.revokeGrant': '确认撤销授权',
  'resourceSharingPage.revoke': '撤销',
  'resourceSharingPage.cancel3': '取消',
  'resourceSharingPage.nodeManagement':
    resourceDetailsZhCN.generated.resourceSharingPage.nodeManagement,
  'resourceSharingPage.workspaceManagement':
    resourceDetailsZhCN.generated.resourceSharingPage.workspaceManagement,
  'resourceSharingPage.ownershipDeterminesManagementScopeGrantsProvideFull':
    '归属决定管理范围；授权授予完整使用权，节点授权自然覆盖其工作区。',
  'resourceSharingPage.keyword': resourceDetailsZhCN.generated.resourceSharingPage.keyword,
  'resourceSharingPage.enterANameOrID':
    resourceDetailsZhCN.generated.resourceSharingPage.enterANameOrID,
  'resourceSharingPage.ownerType': '归属类型：',
  'resourceSharingPage.ownershipType':
    resourceDetailsZhCN.generated.resourceSharingPage.ownershipType,
  'resourceSharingPage.selectAnOwnerType': '请选择归属类型',
  'resourceSharingPage.personal2': resourceDetailsZhCN.generated.resourceSharingPage.personal2,
  'resourceSharingPage.organization': '组织',
  'resourceSharingPage.organization2': '组织：',
  'resourceSharingPage.selectAnOwnerOrganization': '请选择归属组织',
  'resourceSharingPage.status': resourceDetailsZhCN.generated.resourceSharingPage.status,
  'resourceSharingPage.selectAStatus':
    resourceDetailsZhCN.generated.resourceSharingPage.selectAStatus,
  'resourceSharingPage.online2': resourceDetailsZhCN.generated.resourceSharingPage.online2,
  'resourceSharingPage.offline2': resourceDetailsZhCN.generated.resourceSharingPage.offline2,
  'resourceSharingPage.disabled2': resourceDetailsZhCN.generated.resourceSharingPage.disabled2,
  'resourceSharingPage.refresh': resourceDetailsZhCN.generated.resourceSharingPage.refresh,
  'resourceSharingPage.registerNode':
    resourceDetailsZhCN.generated.resourceSharingPage.registerNode,
  'resourceSharingPage.nodeName': resourceDetailsZhCN.generated.resourceSharingPage.nodeName,
  'resourceSharingPage.workspaceName':
    resourceDetailsZhCN.generated.resourceSharingPage.workspaceName,
  'resourceSharingPage.node': resourceDetailsZhCN.generated.resourceSharingPage.node,
  'resourceSharingPage.node5': resourceDetailsZhCN.generated.resourceSharingPage.node5,
  'resourceSharingPage.workspace4': resourceDetailsZhCN.generated.resourceSharingPage.workspace4,
  'resourceSharingPage.status2': resourceDetailsZhCN.generated.resourceSharingPage.status2,
  'resourceSharingPage.owner': resourceDetailsZhCN.generated.resourceSharingPage.owner,
  'resourceSharingPage.lastHeartbeat':
    resourceDetailsZhCN.generated.resourceSharingPage.lastHeartbeat,
  'resourceSharingPage.upgradeStatus':
    resourceDetailsZhCN.generated.resourceSharingPage.upgradeStatus,
  'resourceSharingPage.actions': resourceDetailsZhCN.generated.resourceSharingPage.actions,
  'resourceSharingPage.details': '详情',
  'resourceSharingPage.edit': resourceDetailsZhCN.generated.resourceSharingPage.edit,
  'resourceSharingPage.manageGrants': '管理授权',
  'resourceSharingPage.editNode': resourceDetailsZhCN.generated.resourceSharingPage.editNode,
  'resourceSharingPage.editWorkspace':
    resourceDetailsZhCN.generated.resourceSharingPage.editWorkspace,
  'resourceSharingPage.nodeName2': resourceDetailsZhCN.generated.resourceSharingPage.nodeName2,
  'resourceSharingPage.workspaceName2':
    resourceDetailsZhCN.generated.resourceSharingPage.workspaceName2,
  'resourceSharingPage.enterANodeName2':
    resourceDetailsZhCN.generated.resourceSharingPage.enterANodeName2,
  'resourceSharingPage.enterAWorkspaceName':
    resourceDetailsZhCN.generated.resourceSharingPage.enterAWorkspaceName,
  'resourceSharingPage.owner2': resourceDetailsZhCN.generated.resourceSharingPage.owner2,
  'resourceSharingPage.personal3': resourceDetailsZhCN.generated.resourceSharingPage.personal3,
  'resourceSharingPage.selectAnOrganization': '请选择组织',
  'resourceSharingPage.cancel4': resourceDetailsZhCN.generated.resourceSharingPage.cancel4,
  'resourceSharingPage.save': resourceDetailsZhCN.generated.resourceSharingPage.save,
  'resourceSharingPage.workspaceDetails':
    resourceDetailsZhCN.generated.resourceSharingPage.workspaceDetails,
  'resourceSharingPage.workspaceName3':
    resourceDetailsZhCN.generated.resourceSharingPage.workspaceName3,
  'resourceSharingPage.owner3': resourceDetailsZhCN.generated.resourceSharingPage.owner3,
  'resourceSharingPage.fullPath': resourceDetailsZhCN.generated.resourceSharingPage.fullPath,
  'resourceSharingPage.theNodeIsOfflineThePathIs':
    resourceDetailsZhCN.generated.resourceSharingPage.theNodeIsOfflineThePathIs,
  'resourceSharingPage.upgradeStatus2':
    resourceDetailsZhCN.generated.resourceSharingPage.upgradeStatus2,
  'resourceSharingPage.close': '关闭',
  'resourceSharingPage.pushUpgrade2':
    resourceDetailsZhCN.generated.resourceSharingPage.pushUpgrade2,
  'resourceSharingPage.cancelUpgrade':
    resourceDetailsZhCN.generated.resourceSharingPage.cancelUpgrade,
  'resourceSharingPage.deleteNode3': '删除节点',
  'resourceSharingPage.unregisterWorkspace3': '移除工作区',
  'resourceSharingPage.registerNode2':
    resourceDetailsZhCN.generated.resourceSharingPage.registerNode2,
  'resourceSharingPage.nodeName4': resourceDetailsZhCN.generated.resourceSharingPage.nodeName4,
  'resourceSharingPage.enterANodeName3':
    resourceDetailsZhCN.generated.resourceSharingPage.enterANodeName3,
  'resourceSharingPage.owner4': resourceDetailsZhCN.generated.resourceSharingPage.owner4,
  'resourceSharingPage.personal4': resourceDetailsZhCN.generated.resourceSharingPage.personal4,
  'resourceSharingPage.selectAnOwner': '请选择归属',
  'resourceSharingPage.personal5': '个人',
  'resourceSharingPage.docsEnUSDeploymentNodeInstallation':
    resourceDetailsZhCN.generated.resourceSharingPage.docsEnUSDeploymentNodeInstallation,
  'resourceSharingPage.viewNodeDeploymentAndAutostartGuide':
    resourceDetailsZhCN.generated.resourceSharingPage.viewNodeDeploymentAndAutostartGuide,
  'resourceSharingPage.close2': resourceDetailsZhCN.generated.resourceSharingPage.close2,
  'resourceSharingPage.createOneTimeRegistrationToken':
    resourceDetailsZhCN.generated.resourceSharingPage.createOneTimeRegistrationToken,
  'resourceSharingPage.resets': '重置时间：',
  'resourceSharingPage.updated': '更新时间',
  'resourceSharingPage.close3': '关闭',
  'resourceSharingPage.resourceGrants': '资源授权',
  'resourceSharingPage.targetType': '授权对象',
  'resourceSharingPage.selectATargetType': '请选择授权对象',
  'resourceSharingPage.organization3': '组织',
  'resourceSharingPage.user': '用户',
  'resourceSharingPage.entireEnterprise': '整个企业',
  'resourceSharingPage.targetOrganization': '目标组织',
  'resourceSharingPage.selectATargetOrganization2': '请选择目标组织',
  'resourceSharingPage.targetUser': '目标用户',
  'resourceSharingPage.selectATargetUser2': '请选择目标用户',
  'resourceSharingPage.targetType2': '目标类型',
  'resourceSharingPage.entireEnterprise2': '整个企业',
  'resourceSharingPage.user2': '用户',
  'resourceSharingPage.organization4': '组织',
  'resourceSharingPage.target': '目标',
  'resourceSharingPage.entireEnterprise3': '整个企业',
  'resourceSharingPage.actions2': '操作',
  'resourceSharingPage.revoke2': '撤销',
  'resourceSharingPage.close4': '关闭',
  'resourceSharingPage.grantAccess': '授予使用权',
  'workspaceSessionList.unableToLoadCurrentSkillsTryAgain':
    workbenchShellZhCN.generated.workspaceSessionList.unableToLoadCurrentSkillsTryAgain,
  'workspaceSessionList.unableToLoadCurrentMCPServersTry':
    workbenchShellZhCN.generated.workspaceSessionList.unableToLoadCurrentMCPServersTry,
  'workspaceSessionList.available': workbenchShellZhCN.generated.workspaceSessionList.available,
  'workspaceSessionList.incompleteInstallation':
    workbenchShellZhCN.generated.workspaceSessionList.incompleteInstallation,
  'workspaceSessionList.unknownVersion':
    workbenchShellZhCN.generated.workspaceSessionList.unknownVersion,
  'workspaceSessionList.invalidGitRules':
    workbenchShellZhCN.generated.workspaceSessionList.invalidGitRules,
  'workspaceSessionList.invalidDirectory':
    workbenchShellZhCN.generated.workspaceSessionList.invalidDirectory,
  'workspaceSessionList.workspaceSessions':
    workbenchShellZhCN.generated.workspaceSessionList.workspaceSessions,
  'workspaceSessionList.sessions': workbenchShellZhCN.generated.workspaceSessionList.sessions,
  'workspaceSessionList.newSession': workbenchShellZhCN.generated.workspaceSessionList.newSession,
  'workspaceSessionList.refreshWorkspaceSessions':
    workbenchShellZhCN.generated.workspaceSessionList.refreshWorkspaceSessions,
  'workspaceSessionList.resyncWorkspaceSessions':
    workbenchShellZhCN.generated.workspaceSessionList.resyncWorkspaceSessions,
  'workspaceSessionList.moreWorkspaceActions':
    workbenchShellZhCN.generated.workspaceSessionList.moreWorkspaceActions,
  'workspaceSessionList.loadedSkills':
    workbenchShellZhCN.generated.workspaceSessionList.loadedSkills,
  'workspaceSessionList.loadedMCP': workbenchShellZhCN.generated.workspaceSessionList.loadedMCP,
  'workspaceSessionList.cleanupSessions':
    workbenchShellZhCN.generated.workspaceSessionList.cleanupSessions,
  'workspaceSessionList.pinned': workbenchShellZhCN.generated.workspaceSessionList.pinned,
  'workspaceSessionList.pinned2': workbenchShellZhCN.generated.workspaceSessionList.pinned2,
  'workspaceSessionList.hasUnreadNotifications':
    workbenchShellZhCN.generated.workspaceSessionList.hasUnreadNotifications,
  'workspaceSessionList.hasUnreadNotifications2':
    workbenchShellZhCN.generated.workspaceSessionList.hasUnreadNotifications2,
  'workspaceSessionList.unread': workbenchShellZhCN.generated.workspaceSessionList.unread,
  'workspaceSessionList.moreSessionActions':
    workbenchShellZhCN.generated.workspaceSessionList.moreSessionActions,
  'workspaceSessionList.moreSessionActions2':
    workbenchShellZhCN.generated.workspaceSessionList.moreSessionActions2,
  'workspaceSessionList.pin': workbenchShellZhCN.generated.workspaceSessionList.pin,
  'workspaceSessionList.unpin': workbenchShellZhCN.generated.workspaceSessionList.unpin,
  'workspaceSessionList.moveUp': workbenchShellZhCN.generated.workspaceSessionList.moveUp,
  'workspaceSessionList.moveDown': workbenchShellZhCN.generated.workspaceSessionList.moveDown,
  'workspaceSessionList.rename': workbenchShellZhCN.generated.workspaceSessionList.rename,
  'workspaceSessionList.delete': workbenchShellZhCN.generated.workspaceSessionList.delete,
  'workspaceSessionList.loadMoreSessions':
    workbenchShellZhCN.generated.workspaceSessionList.loadMoreSessions,
  'workspaceSessionList.loading': workbenchShellZhCN.generated.workspaceSessionList.loading,
  'workspaceSessionList.loadMore': workbenchShellZhCN.generated.workspaceSessionList.loadMore,
  'workspaceSessionList.syncingOpenCodeCodexAndClaudeCodeSessions':
    workbenchShellZhCN.generated.workspaceSessionList.syncingOpenCodeCodexAndClaudeCodeSessions,
  'workspaceSessionList.currentSkills':
    workbenchShellZhCN.generated.workspaceSessionList.currentSkills,
  'workspaceSessionList.thisWorkspaceHasNoAvailableSkills':
    workbenchShellZhCN.generated.workspaceSessionList.thisWorkspaceHasNoAvailableSkills,
  'workspaceSessionList.noDescription':
    workbenchShellZhCN.generated.workspaceSessionList.noDescription,
  'workspaceSessionList.loadedMCP2': workbenchShellZhCN.generated.workspaceSessionList.loadedMCP2,
  'workspaceSessionList.thisWorkspaceHasNoLoadedMCPServers':
    workbenchShellZhCN.generated.workspaceSessionList.thisWorkspaceHasNoLoadedMCPServers,
  'workspaceSessionList.loaded': workbenchShellZhCN.generated.workspaceSessionList.loaded,
  'workspaceSessionList.marScheduleMcp':
    workbenchShellZhCN.generated.workspaceSessionList.marScheduleMcp,
  'workspaceSessionList.marNotificationMcp':
    workbenchShellZhCN.generated.workspaceSessionList.marNotificationMcp,
  'workspaceSessionList.executionInjected':
    workbenchShellZhCN.generated.workspaceSessionList.executionInjected,
  'workspaceSessionList.builtInMcp': workbenchShellZhCN.generated.workspaceSessionList.builtInMcp,
  'workspaceSessionCleanupDialog.title':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.title,
  'workspaceSessionCleanupDialog.description':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.description,
  'workspaceSessionCleanupDialog.inactiveDays':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.inactiveDays,
  'workspaceSessionCleanupDialog.inactiveDaysInvalid':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.inactiveDaysInvalid,
  'workspaceSessionCleanupDialog.cancel':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.cancel,
  'workspaceSessionCleanupDialog.cleanup':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.cleanup,
  'workspaceSessionCleanupDialog.cleaning':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.cleaning,
  'workspaceSessionCleanupDialog.cleanupFailed':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.cleanupFailed,
  'workspaceSessionCleanupDialog.completed':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.completed,
  'workspaceSessionCleanupDialog.deleted':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.deleted,
  'workspaceSessionCleanupDialog.skipped':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.skipped,
  'workspaceSessionCleanupDialog.failed':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.failed,
  'workspaceSessionCleanupDialog.byRunner':
    workbenchShellZhCN.generated.workspaceSessionCleanupDialog.byRunner,
  'environmentSecretManager.selectAnOrganization': '请选择组织',
  'environmentSecretManager.deleteEnvironmentSecretNewConversationRunsAnd':
    environmentSecretsZhCN.generated.environmentSecretManager
      .deleteEnvironmentSecretNewConversationRunsAnd,
  'environmentSecretManager.deleteSecret':
    environmentSecretsZhCN.generated.environmentSecretManager.deleteSecret,
  'environmentSecretManager.deleteSecret2':
    environmentSecretsZhCN.generated.environmentSecretManager.deleteSecret2,
  'environmentSecretManager.cancel':
    environmentSecretsZhCN.generated.environmentSecretManager.cancel,
  'environmentSecretManager.environmentSecrets':
    environmentSecretsZhCN.generated.environmentSecretManager.environmentSecrets,
  'environmentSecretManager.secretName':
    environmentSecretsZhCN.generated.environmentSecretManager.secretName,
  'environmentSecretManager.enterASecretName':
    environmentSecretsZhCN.generated.environmentSecretManager.enterASecretName,
  'environmentSecretManager.refresh':
    environmentSecretsZhCN.generated.environmentSecretManager.refresh,
  'environmentSecretManager.addSecret':
    environmentSecretsZhCN.generated.environmentSecretManager.addSecret,
  'environmentSecretManager.environmentSecretList':
    environmentSecretsZhCN.generated.environmentSecretManager.environmentSecretList,
  'environmentSecretManager.name': environmentSecretsZhCN.generated.environmentSecretManager.name,
  'environmentSecretManager.value': environmentSecretsZhCN.generated.environmentSecretManager.value,
  'environmentSecretManager.scope': environmentSecretsZhCN.generated.environmentSecretManager.scope,
  'environmentSecretManager.personal':
    environmentSecretsZhCN.generated.environmentSecretManager.personal,
  'environmentSecretManager.node': environmentSecretsZhCN.generated.environmentSecretManager.node,
  'environmentSecretManager.organization': '组织',
  'environmentSecretManager.owner': environmentSecretsZhCN.generated.environmentSecretManager.owner,
  'environmentSecretManager.personal2':
    environmentSecretsZhCN.generated.environmentSecretManager.personal2,
  'environmentSecretManager.visibility':
    environmentSecretsZhCN.generated.environmentSecretManager.visibility,
  'environmentSecretManager.public': '公开',
  'environmentSecretManager.private': '私有',
  'environmentSecretManager.actions':
    environmentSecretsZhCN.generated.environmentSecretManager.actions,
  'environmentSecretManager.updateValue':
    environmentSecretsZhCN.generated.environmentSecretManager.updateValue,
  'environmentSecretManager.delete':
    environmentSecretsZhCN.generated.environmentSecretManager.delete,
  'environmentSecretManager.addSecret2':
    environmentSecretsZhCN.generated.environmentSecretManager.addSecret2,
  'environmentSecretManager.updateSecretValue':
    environmentSecretsZhCN.generated.environmentSecretManager.updateSecretValue,
  'environmentSecretManager.scope2':
    environmentSecretsZhCN.generated.environmentSecretManager.scope2,
  'environmentSecretManager.selectAScope':
    environmentSecretsZhCN.generated.environmentSecretManager.selectAScope,
  'environmentSecretManager.personal3': '个人',
  'environmentSecretManager.node2': '节点',
  'environmentSecretManager.organization2': '组织',
  'environmentSecretManager.visibility2': '可见性',
  'environmentSecretManager.selectVisibility': '请选择可见性',
  'environmentSecretManager.privateThisOrganizationOnly': '私有（仅本组织）',
  'environmentSecretManager.publicInheritedByChildOrganizations': '公开（下级组织可继承）',
  'environmentSecretManager.organization3': '所属组织',
  'environmentSecretManager.selectAnOrganization2': '请选择组织',
  'environmentSecretManager.environmentVariableName':
    environmentSecretsZhCN.generated.environmentSecretManager.environmentVariableName,
  'environmentSecretManager.enterAnEnvironmentVariableName':
    environmentSecretsZhCN.generated.environmentSecretManager.enterAnEnvironmentVariableName,
  'environmentSecretManager.secretValue':
    environmentSecretsZhCN.generated.environmentSecretManager.secretValue,
  'environmentSecretManager.enterASecretValue':
    environmentSecretsZhCN.generated.environmentSecretManager.enterASecretValue,
  'environmentSecretManager.cancel2':
    environmentSecretsZhCN.generated.environmentSecretManager.cancel2,
  'environmentSecretManager.save': environmentSecretsZhCN.generated.environmentSecretManager.save,

  'systemConfigurationPage.unableToLoadSystemConfiguration':
    systemConfigurationZhCN.generated.systemConfigurationPage.unableToLoadSystemConfiguration,
  'systemConfigurationPage.skillTLSConfigurationSaved': 'Skill TLS 配置已保存',
  'systemConfigurationPage.unableToSaveSkillTLSConfiguration': '保存 Skill TLS 配置失败',
  'systemConfigurationPage.systemConfigurationSaved':
    systemConfigurationZhCN.generated.systemConfigurationPage.systemConfigurationSaved,
  'systemConfigurationPage.unableToSaveSystemConfiguration':
    systemConfigurationZhCN.generated.systemConfigurationPage.unableToSaveSystemConfiguration,
  'systemConfigurationPage.systemConfiguration':
    systemConfigurationZhCN.generated.systemConfigurationPage.systemConfiguration,
  'systemConfigurationPage.manageEnterpriseRuntimeSettings': '统一管理企业级运行参数。',
  'systemConfigurationPage.refresh':
    systemConfigurationZhCN.generated.systemConfigurationPage.refresh,
  'systemConfigurationPage.auditRetentionDays': '审计保留天数',
  'systemConfigurationPage.theServerRemovesExpiredEventsInBatches':
    '超过保留期的事件由 Server 分批清理，可设置 1–3650 天。',
  'systemConfigurationPage.setting':
    systemConfigurationZhCN.generated.systemConfigurationPage.setting,
  'systemConfigurationPage.description':
    systemConfigurationZhCN.generated.systemConfigurationPage.description,
  'systemConfigurationPage.value': systemConfigurationZhCN.generated.systemConfigurationPage.value,
  'systemConfigurationPage.enterRetentionDays': '请输入保留天数',
  'systemConfigurationPage.actions':
    systemConfigurationZhCN.generated.systemConfigurationPage.actions,
  'systemConfigurationPage.edit': systemConfigurationZhCN.generated.systemConfigurationPage.edit,
  'systemConfigurationPage.save': systemConfigurationZhCN.generated.systemConfigurationPage.save,
  'systemConfigurationPage.skillSourceTLSCertificateVerificationIsDisabled':
    systemConfigurationZhCN.generated.systemConfigurationPage
      .skillSourceTLSCertificateVerificationIsDisabled,
  'systemConfigurationPage.disableSkillSourceTLSVerification':
    systemConfigurationZhCN.generated.systemConfigurationPage.disableSkillSourceTLSVerification,
  'systemConfigurationPage.keepThisOffByDefaultUseIt':
    systemConfigurationZhCN.generated.systemConfigurationPage.keepThisOffByDefaultUseIt,
  'nodeDetailsDialogs.nodeDetails': resourceDetailsZhCN.generated.nodeDetailsDialogs.nodeDetails,
  'nodeDetailsDialogs.name': resourceDetailsZhCN.generated.nodeDetailsDialogs.name,
  'nodeDetailsDialogs.registeredAddress':
    resourceDetailsZhCN.generated.nodeDetailsDialogs.registeredAddress,
  'nodeDetailsDialogs.system': resourceDetailsZhCN.generated.nodeDetailsDialogs.system,
  'nodeDetailsDialogs.unknown': resourceDetailsZhCN.generated.nodeDetailsDialogs.unknown,
  'nodeDetailsDialogs.nodeVersion': resourceDetailsZhCN.generated.nodeDetailsDialogs.nodeVersion,
  'nodeDetailsDialogs.toolEnvironment':
    resourceDetailsZhCN.generated.nodeDetailsDialogs.toolEnvironment,
  'nodeDetailsDialogs.computerUse': resourceDetailsZhCN.generated.nodeDetailsDialogs.computerUse,
  'nodeDetailsDialogs.computerUseEnabled':
    resourceDetailsZhCN.generated.nodeDetailsDialogs.computerUseEnabled,
  'nodeDetailsDialogs.computerUseDisabled':
    resourceDetailsZhCN.generated.nodeDetailsDialogs.computerUseDisabled,
  'nodeDetailsDialogs.status': resourceDetailsZhCN.generated.nodeDetailsDialogs.status,
  'nodeDetailsDialogs.disabled': resourceDetailsZhCN.generated.nodeDetailsDialogs.disabled,
  'nodeDetailsDialogs.online': resourceDetailsZhCN.generated.nodeDetailsDialogs.online,
  'nodeDetailsDialogs.offline': resourceDetailsZhCN.generated.nodeDetailsDialogs.offline,
  'nodeDetailsDialogs.supportedAgents':
    resourceDetailsZhCN.generated.nodeDetailsDialogs.supportedAgents,
  'nodeDetailsDialogs.available': resourceDetailsZhCN.generated.nodeDetailsDialogs.available,
  'nodeDetailsDialogs.none': resourceDetailsZhCN.generated.nodeDetailsDialogs.none,
  'nodeDetailsDialogs.close': resourceDetailsZhCN.generated.nodeDetailsDialogs.close,
  'nodeDetailsDialogs.deleteNode': '删除节点',
  'nodeDetailsDialogs.resets': resourceDetailsZhCN.generated.nodeDetailsDialogs.resets,
  'nodeDetailsDialogs.updated': resourceDetailsZhCN.generated.nodeDetailsDialogs.updated,
  'nodeDetailsDialogs.close2': resourceDetailsZhCN.generated.nodeDetailsDialogs.close2,
  'settingsContent.unableToLoadOAuthBindings': '读取 OAuth 绑定失败',
  'settingsContent.unableToStartOAuthBinding': '发起 OAuth 绑定失败',
  'settingsContent.unbindFromTheCurrentAccount': '解除当前账号与“{value0}”的绑定？',
  'settingsContent.unbindOAuth': '解除 OAuth 绑定',
  'settingsContent.oAuthBindingRemoved': '已解除 OAuth 绑定',
  'settingsContent.unableToRemoveOAuthBinding': '解除 OAuth 绑定失败',
  'settingsContent.accountSecurity': personalSettingsZhCN.generated.settingsContent.accountSecurity,
  'settingsContent.currentAccountAdminUpTo5Devices':
    personalSettingsZhCN.generated.settingsContent.currentAccountAdminUpTo5Devices,
  'settingsContent.signInSessions': personalSettingsZhCN.generated.settingsContent.signInSessions,
  'settingsContent.signInSessions5': personalSettingsZhCN.generated.settingsContent.signInSessions5,
  'settingsContent.refreshSignInSessions':
    personalSettingsZhCN.generated.settingsContent.refreshSignInSessions,
  'settingsContent.noActiveSignInSessions':
    personalSettingsZhCN.generated.settingsContent.noActiveSignInSessions,
  'settingsContent.currentDevice': personalSettingsZhCN.generated.settingsContent.currentDevice,
  'settingsContent.signedInDevice': personalSettingsZhCN.generated.settingsContent.signedInDevice,
  'settingsContent.signedIn': personalSettingsZhCN.generated.settingsContent.signedIn,
  'settingsContent.expires': personalSettingsZhCN.generated.settingsContent.expires,
  'settingsContent.signOut': personalSettingsZhCN.generated.settingsContent.signOut,
  'settingsContent.confirmSignOutSession':
    personalSettingsZhCN.generated.settingsContent.confirmSignOutSession,
  'settingsContent.oAuthAccountBindings': 'OAuth 账户绑定',
  'settingsContent.oAuthAccountBindings2': 'OAuth 账户绑定',
  'settingsContent.refresh': '刷新',
  'settingsContent.identityProvider': '身份源',
  'settingsContent.status': '状态',
  'settingsContent.bound': '已绑定',
  'settingsContent.notBound': '未绑定',
  'settingsContent.actions': '操作',
  'settingsContent.bind': '绑定',
  'settingsContent.unbind': '解绑',
  'settingsContent.changePassword': personalSettingsZhCN.generated.settingsContent.changePassword,
  'settingsContent.signOut2': personalSettingsZhCN.generated.settingsContent.signOut2,
  'settingsContent.confirmSignOut': personalSettingsZhCN.generated.settingsContent.confirmSignOut,
  'settingsContent.changePassword2': personalSettingsZhCN.generated.settingsContent.changePassword2,
  'settingsContent.currentPassword': personalSettingsZhCN.generated.settingsContent.currentPassword,
  'settingsContent.enterCurrentPassword':
    personalSettingsZhCN.generated.settingsContent.enterCurrentPassword,
  'settingsContent.currentPassword2':
    personalSettingsZhCN.generated.settingsContent.currentPassword2,
  'settingsContent.newPassword': personalSettingsZhCN.generated.settingsContent.newPassword,
  'settingsContent.enterNewPassword':
    personalSettingsZhCN.generated.settingsContent.enterNewPassword,
  'settingsContent.newPassword2': personalSettingsZhCN.generated.settingsContent.newPassword2,
  'settingsContent.confirmNewPassword':
    personalSettingsZhCN.generated.settingsContent.confirmNewPassword,
  'settingsContent.enterTheNewPasswordAgain':
    personalSettingsZhCN.generated.settingsContent.enterTheNewPasswordAgain,
  'settingsContent.confirmNewPassword2':
    personalSettingsZhCN.generated.settingsContent.confirmNewPassword2,
  'settingsContent.cancel': personalSettingsZhCN.generated.settingsContent.cancel,
  'settingsContent.confirmChange': personalSettingsZhCN.generated.settingsContent.confirmChange,
  'settingsContent.nodeRegistration':
    personalSettingsZhCN.generated.settingsContent.nodeRegistration,
  'settingsContent.createAOneTimeTokenThenComplete':
    personalSettingsZhCN.generated.settingsContent.createAOneTimeTokenThenComplete,
  'settingsContent.viewNodeDeploymentAndAutoStartGuide':
    personalSettingsZhCN.generated.settingsContent.viewNodeDeploymentAndAutoStartGuide,
  'settingsContent.nodeOwnership': '节点归属',
  'settingsContent.selectOwnership': '请选择归属',
  'settingsContent.personal': '个人',
  'settingsContent.createOneTimeNodeRegistrationToken':
    personalSettingsZhCN.generated.settingsContent.createOneTimeNodeRegistrationToken,
  'settingsContent.keyboardShortcuts':
    personalSettingsZhCN.generated.settingsContent.keyboardShortcuts,
  'settingsContent.theFollowingShortcutsAreAvailableInThe':
    personalSettingsZhCN.generated.settingsContent.theFollowingShortcutsAreAvailableInThe,
  'settingsContent.quickOpenFilesInTheCurrentWorkspace': '快速打开工作区、会话、符号或文件',
  'settingsContent.switchTheInspectorToGitChanges': '切换检查器至 Git 变更',
  'settingsContent.searchFileContentsInTheCurrentWorkspace': '搜索当前工作区文件内容',
  'settingsContent.expandAndFocusTheSelectedWorkspaceTerminal': '展开并聚焦当前选中的工作区终端',
  'workbenchNotificationCenter.openNotificationCenter':
    notificationsZhCN.generated.workbenchNotificationCenter.openNotificationCenter,
  'workbenchNotificationCenter.notificationCenter':
    notificationsZhCN.generated.workbenchNotificationCenter.notificationCenter,
  'workbenchNotificationCenter.notifications':
    notificationsZhCN.generated.workbenchNotificationCenter.notifications,
  'workbenchNotificationCenter.markAllRead':
    notificationsZhCN.generated.workbenchNotificationCenter.markAllRead,
  'workbenchNotificationCenter.clearAll':
    notificationsZhCN.generated.workbenchNotificationCenter.clearAll,
  'workbenchNotificationCenter.fileTransfers':
    notificationsZhCN.generated.workbenchNotificationCenter.fileTransfers,
  'workbenchNotificationCenter.resume':
    notificationsZhCN.generated.workbenchNotificationCenter.resume,
  'workbenchNotificationCenter.retry':
    notificationsZhCN.generated.workbenchNotificationCenter.retry,
  'workbenchNotificationCenter.delete':
    notificationsZhCN.generated.workbenchNotificationCenter.delete,
  'workbenchNotificationCenter.cancel':
    notificationsZhCN.generated.workbenchNotificationCenter.cancel,
  'workbenchNotificationCenter.noNotifications':
    notificationsZhCN.generated.workbenchNotificationCenter.noNotifications,
  'workbenchNotificationCenter.unread':
    notificationsZhCN.generated.workbenchNotificationCenter.unread,
  'workbenchNotificationCenter.deleteNotification':
    notificationsZhCN.generated.workbenchNotificationCenter.deleteNotification,
  'workspaceRegistrationPicker.enterADirectoryName':
    workspaceZhCN.generated.workspaceRegistrationPicker.enterADirectoryName,
  'workspaceRegistrationPicker.enterASingleDirectoryNameWithoutPath':
    workspaceZhCN.generated.workspaceRegistrationPicker.enterASingleDirectoryNameWithoutPath,
  'workspaceRegistrationPicker.registerANewWorkspace':
    workspaceZhCN.generated.workspaceRegistrationPicker.registerANewWorkspace,
  'workspaceRegistrationPicker.resourceOwner': '资源归属',
  'workspaceRegistrationPicker.personal': '个人',
  'workspaceRegistrationPicker.mEMBERUsersCannotCreateOrganizationWorkspaces':
    'MEMBER 不能创建组织工作区',
  'workspaceRegistrationPicker.goToParentDirectory':
    workspaceZhCN.generated.workspaceRegistrationPicker.goToParentDirectory,
  'workspaceRegistrationPicker.goToParentDirectory2':
    workspaceZhCN.generated.workspaceRegistrationPicker.goToParentDirectory2,
  'workspaceRegistrationPicker.up': workspaceZhCN.generated.workspaceRegistrationPicker.up,
  'workspaceRegistrationPicker.roots': workspaceZhCN.generated.workspaceRegistrationPicker.roots,
  'workspaceRegistrationPicker.currentDirectory':
    workspaceZhCN.generated.workspaceRegistrationPicker.currentDirectory,
  'workspaceRegistrationPicker.refreshDirectory':
    workspaceZhCN.generated.workspaceRegistrationPicker.refreshDirectory,
  'workspaceRegistrationPicker.refreshDirectory2':
    workspaceZhCN.generated.workspaceRegistrationPicker.refreshDirectory2,
  'workspaceRegistrationPicker.newDirectory':
    workspaceZhCN.generated.workspaceRegistrationPicker.newDirectory,
  'workspaceRegistrationPicker.selectCurrentDirectory':
    workspaceZhCN.generated.workspaceRegistrationPicker.selectCurrentDirectory,
  'workspaceRegistrationPicker.pending':
    workspaceZhCN.generated.workspaceRegistrationPicker.pending,
  'workspaceRegistrationPicker.cancelNewDirectory':
    workspaceZhCN.generated.workspaceRegistrationPicker.cancelNewDirectory,
  'workspaceRegistrationPicker.cancelNewDirectory2':
    workspaceZhCN.generated.workspaceRegistrationPicker.cancelNewDirectory2,
  'workspaceRegistrationPicker.outsideAllowedRoots':
    workspaceZhCN.generated.workspaceRegistrationPicker.outsideAllowedRoots,
  'workspaceRegistrationPicker.open': workspaceZhCN.generated.workspaceRegistrationPicker.open,
  'workspaceRegistrationPicker.open2': workspaceZhCN.generated.workspaceRegistrationPicker.open2,
  'workspaceRegistrationPicker.loadingAllowedRoots':
    workspaceZhCN.generated.workspaceRegistrationPicker.loadingAllowedRoots,
  'workspaceRegistrationPicker.expandAndSelectADirectoryToRegister':
    workspaceZhCN.generated.workspaceRegistrationPicker.expandAndSelectADirectoryToRegister,
  'workspaceRegistrationPicker.onlyTheFirst200ChildDirectoriesAre':
    workspaceZhCN.generated.workspaceRegistrationPicker.onlyTheFirst200ChildDirectoriesAre,
  'workspaceRegistrationPicker.selected':
    workspaceZhCN.generated.workspaceRegistrationPicker.selected,
  'workspaceRegistrationPicker.createAndRegister':
    workspaceZhCN.generated.workspaceRegistrationPicker.createAndRegister,
  'workspaceRegistrationPicker.registerWorkspace':
    workspaceZhCN.generated.workspaceRegistrationPicker.registerWorkspace,
  'workspaceRegistrationPicker.newDirectory2':
    workspaceZhCN.generated.workspaceRegistrationPicker.newDirectory2,
  'workspaceRegistrationPicker.directoryName':
    workspaceZhCN.generated.workspaceRegistrationPicker.directoryName,
  'workspaceRegistrationPicker.enterADirectoryName2':
    workspaceZhCN.generated.workspaceRegistrationPicker.enterADirectoryName2,
  'workspaceRegistrationPicker.cancel': workspaceZhCN.generated.workspaceRegistrationPicker.cancel,
  'workspaceRegistrationPicker.confirm':
    workspaceZhCN.generated.workspaceRegistrationPicker.confirm,
  'secretManagementPage.unableToLoadOrganizations': '读取组织失败',
  'secretManagementPage.secretManagement':
    environmentSecretsZhCN.generated.secretManagementPage.secretManagement,
  'secretManagementPage.managePersonalAndOrganizationEnvironmentSecretsManage':
    '集中管理 Agent 和终端所需的个人及组织敏感信息，并在新建 Agent 运行和终端时通过环境变量注入；节点环境密钥请前往节点管理详情。',
  'userManagementPage.userCreated': '创建成功',
  'userManagementPage.userDetails': '用户详情',
  'userManagementPage.unableToCreateUser': '创建用户失败',
  'userManagementPage.passwordReset': '密码重置成功',
  'userManagementPage.unableToResetPassword': '重置密码失败',
  'userManagementPage.resetThePasswordForTheUserMust':
    '重置“{value0}”的密码后，该用户需要使用新的临时密码登录并修改密码。',
  'userManagementPage.resetPassword': '确认重置密码',
  'userManagementPage.resetPassword2': '重置密码',
  'userManagementPage.cancel': '取消',
  'userManagementPage.unableToDeleteUser': '删除用户失败',
  'userManagementPage.deleteUserNodesRegisteredByThisUser':
    '确定删除用户“{value0}”吗？该用户登记的节点也将一并删除。',
  'userManagementPage.deleteUser': '确认删除用户',
  'userManagementPage.deleteUser2': '删除用户',
  'userManagementPage.cancel2': '取消',
  'userManagementPage.usernamePassword': '用户名：{value0}\n密码：{value1}',
  'userManagementPage.userManagement': '用户管理',
  'userManagementPage.createUsersResetPasswordsOrDeleteUsers': '创建、重置密码或删除普通用户。',
  'userManagementPage.createUser': '创建用户',
  'userManagementPage.username': '用户名',
  'userManagementPage.email': '邮箱',
  'userManagementPage.nickname': '昵称',
  'userManagementPage.role': '身份',
  'userManagementPage.administrator': '管理员',
  'userManagementPage.user': '用户',
  'userManagementPage.actions': '操作',
  'userManagementPage.resetPassword3': '重置密码',
  'userManagementPage.delete': '删除',
  'userManagementPage.createUser2': '创建用户',
  'userManagementPage.username2': '用户名',
  'userManagementPage.usernameRequired': '请输入用户名。',
  'userManagementPage.textTooLong': '最多输入 {max} 个字符。',
  'userManagementPage.emailInvalid': '邮箱必须包含 @。',
  'userManagementPage.email2': '邮箱',
  'userManagementPage.nickname2': '昵称',
  'userManagementPage.cancel3': '取消',
  'userManagementPage.createUser3': '创建用户',
  'userManagementPage.copyAndSecurelyDeliverTheseCredentials':
    '{value0}，请复制并安全交付以下凭据。',
  'userManagementPage.username3': '用户名',
  'userManagementPage.temporaryPassword': '临时密码',
  'userManagementPage.copyUsernameAndPassword': '复制用户名和密码',
  'userManagementPage.theUserMustChangeThePasswordAfter': '用户首次登录后必须修改密码。',
  'organizationUserManagementPage.enterAnOrganizationName': '请输入组织名称',
  'organizationUserManagementPage.theOrganizationNameCannotExceed128Characters':
    '组织名称不能超过 128 个字符',
  'organizationUserManagementPage.enterAUsername': '请输入用户名',
  'organizationUserManagementPage.theUsernameCannotExceed80Characters': '用户名不能超过 80 个字符',
  'organizationUserManagementPage.enterAValidEmailAddress': '请输入有效邮箱',
  'organizationUserManagementPage.theEmailAddressCannotExceed254Characters':
    '邮箱不能超过 254 个字符',
  'organizationUserManagementPage.theDisplayNameCannotExceed80Characters':
    '显示名称不能超过 80 个字符',
  'organizationUserManagementPage.selectARole': '请选择角色',
  'organizationUserManagementPage.selectAnOrganization': '请选择组织',
  'organizationUserManagementPage.unableToLoadOrganizationsAndUsers': '读取组织与用户失败',
  'organizationUserManagementPage.unableToSaveOrganization': '保存组织失败',
  'organizationUserManagementPage.userCreated': '用户已创建',
  'organizationUserManagementPage.unableToCreateUser': '创建用户失败',
  'organizationUserManagementPage.userUpdated': '用户已更新',
  'organizationUserManagementPage.unableToUpdateUser': '更新用户失败',
  'organizationUserManagementPage.resetThePasswordForExistingSessionsWill':
    '重置“{value0}”的密码会立即撤销其现有会话。',
  'organizationUserManagementPage.resetPassword': '确认重置密码',
  'organizationUserManagementPage.resetPassword2': '重置密码',
  'organizationUserManagementPage.cancel': '取消',
  'organizationUserManagementPage.passwordReset': '密码已重置',
  'organizationUserManagementPage.usernamePassword': '用户名：{value0}\n密码：{value1}',
  'organizationUserManagementPage.usernameAndPasswordCopied': '已复制用户名和密码。',
  'organizationUserManagementPage.unableToAccessTheClipboardCopyThe':
    '无法访问剪贴板，请手动复制用户名和密码。',
  'organizationUserManagementPage.deletingRemovesPersonalNodesPersonalWorkspacesSessions':
    '删除“{value0}”将清理 Server 中的 {value1} 个个人节点、{value2} 个个人工作区、{value3} 个会话、{value4} 个外部身份和 {value5} 个直接授权；不会删除节点主机上的目录或文件。',
  'organizationUserManagementPage.deleteUser': '确认删除用户',
  'organizationUserManagementPage.deleteUser2': '删除用户',
  'organizationUserManagementPage.cancel2': '取消',
  'organizationUserManagementPage.deleteItsOrganizationResourcesWillBeTransferred':
    '删除“{value0}”后，其组织资源归属转移到上级组织。',
  'organizationUserManagementPage.deleteOrganization': '确认删除组织',
  'organizationUserManagementPage.deleteOrganization2': '删除组织',
  'organizationUserManagementPage.cancel3': '取消',
  'organizationUserManagementPage.organizationManagement': '组织管理',
  'organizationUserManagementPage.userManagement': '用户管理',
  'organizationUserManagementPage.theOrganizationTreeDefinesPermissionInheritanceChild':
    '组织树决定权限继承范围，可在任一可管理层级创建下级。',
  'organizationUserManagementPage.eachUserBelongsToOneOrganizationAnd':
    '每个用户只属于一个组织，加入时必须具有角色。',
  'organizationUserManagementPage.organization': '组织：',
  'organizationUserManagementPage.user': '用户：',
  'organizationUserManagementPage.enterAnOrganizationNameOrID': '请输入组织名称或 ID',
  'organizationUserManagementPage.enterAUsernameEmailOrDisplayName': '请输入用户、邮箱或显示名称',
  'organizationUserManagementPage.role': '角色：',
  'organizationUserManagementPage.selectARole2': '请选择角色',
  'organizationUserManagementPage.allRoles': '全部角色',
  'organizationUserManagementPage.organization2': '组织：',
  'organizationUserManagementPage.selectAnOrganization2': '请选择组织',
  'organizationUserManagementPage.status': '状态：',
  'organizationUserManagementPage.selectAStatus': '请选择状态',
  'organizationUserManagementPage.allStatuses': '全部状态',
  'organizationUserManagementPage.enabled': '启用',
  'organizationUserManagementPage.disabled': '停用',
  'organizationUserManagementPage.refresh': '刷新',
  'organizationUserManagementPage.createUser': '创建用户',
  'organizationUserManagementPage.organizationName': '组织名称',
  'organizationUserManagementPage.organizationID': '组织 ID',
  'organizationUserManagementPage.organizationDetails': '组织详情',
  'organizationUserManagementPage.userDetails': '用户详情',
  'organizationUserManagementPage.rootOrganization': '根组织',
  'organizationUserManagementPage.actions': '操作',
  'organizationUserManagementPage.edit': '编辑',
  'organizationUserManagementPage.addChild': '新增下级',
  'organizationUserManagementPage.delete': '删除',
  'organizationUserManagementPage.user2': '用户',
  'organizationUserManagementPage.email': '邮箱',
  'organizationUserManagementPage.displayName': '显示名称',
  'organizationUserManagementPage.role2': '角色',
  'organizationUserManagementPage.organization3': '所属组织',
  'organizationUserManagementPage.status2': '状态',
  'organizationUserManagementPage.enabled2': '启用',
  'organizationUserManagementPage.disabled2': '停用',
  'organizationUserManagementPage.actions2': '操作',
  'organizationUserManagementPage.edit2': '编辑',
  'organizationUserManagementPage.resetPassword3': '重置密码',
  'organizationUserManagementPage.delete2': '删除',
  'organizationUserManagementPage.createOrganization': '创建组织',
  'organizationUserManagementPage.editOrganization': '编辑组织',
  'organizationUserManagementPage.name': '名称',
  'organizationUserManagementPage.enterAnOrganizationName2': '请输入组织名称',
  'organizationUserManagementPage.parentOrganization': '上级组织',
  'organizationUserManagementPage.parentOrganization2': '上级组织',
  'organizationUserManagementPage.cancel4': '取消',
  'organizationUserManagementPage.createOrganization2': '创建组织',
  'organizationUserManagementPage.save': '保存',
  'organizationUserManagementPage.createUser2': '创建用户',
  'organizationUserManagementPage.editUser': '编辑用户',
  'organizationUserManagementPage.username': '用户名',
  'organizationUserManagementPage.enterAUsername2': '请输入用户名',
  'organizationUserManagementPage.email2': '邮箱',
  'organizationUserManagementPage.enterAnEmailAddressOptional': '请输入邮箱（可选）',
  'organizationUserManagementPage.displayName2': '显示名称',
  'organizationUserManagementPage.enterADisplayNameOptional': '请输入显示名称（可选）',
  'organizationUserManagementPage.role3': '角色',
  'organizationUserManagementPage.selectARole3': '请选择角色',
  'organizationUserManagementPage.organization4': '组织',
  'organizationUserManagementPage.selectAnOrganization3': '请选择组织',
  'organizationUserManagementPage.cancel5': '取消',
  'organizationUserManagementPage.createUser3': '创建用户',
  'organizationUserManagementPage.save2': '保存',
  'organizationUserManagementPage.temporaryCredentialsAreShownOnlyOnceThe':
    '临时凭据只显示一次，用户首次登录后必须修改密码。',
  'organizationUserManagementPage.username2': '用户名',
  'organizationUserManagementPage.temporaryPassword': '临时密码',
  'organizationUserManagementPage.copyUsernameAndPassword': '复制用户名和密码',
  'organizationUserManagementPage.done': '我已保存',
  'licenseManagementPage.enterprise': '企业版',
  'licenseManagementPage.personal': '社区版',
  'licenseManagementPage.permanent': '永久有效',
  'licenseManagementPage.unableToGenerateLicenseRequestCode': '生成 License 申请码失败',
  'licenseManagementPage.unableToLoadLicense': '读取 License 失败',
  'licenseManagementPage.licenseRequestCodeCopied': '已复制 License 申请码。',
  'licenseManagementPage.unableToCopyCheckBrowserClipboardPermissions':
    '复制失败，请检查浏览器剪贴板权限',
  'licenseManagementPage.licenseImported': 'License 已导入',
  'licenseManagementPage.unableToImportLicense': '导入 License 失败',
  'licenseManagementPage.viewTheCurrentLicenseStatusAndImport':
    '查看当前授权状态并导入绑定本机的新 License。',
  'licenseManagementPage.license': 'License 授权',
  'licenseManagementPage.licenseStatus': 'License 状态',
  'licenseManagementPage.edition': '版本',
  'licenseManagementPage.expired': '过期',
  'licenseManagementPage.organization': '企业',
  'licenseManagementPage.expires': '到期时间',
  'licenseManagementPage.statusReason': '状态原因',
  'licenseManagementPage.licenseRequestCode': 'License 申请码',
  'licenseManagementPage.generating': '生成中…',
  'licenseManagementPage.generationFailed': '生成失败',
  'licenseManagementPage.copyLicenseRequestCode': '复制 License 申请码',
  'licenseManagementPage.copy': '复制',
  'licenseManagementPage.sendThisCodeToTheLicenseIssuer':
    '将申请码交给授权方生成绑定当前部署的 License；重新进入本页会生成新申请码。',
  'licenseManagementPage.licenseDocument': 'License 文档',
  'licenseManagementPage.pasteTheCompleteLicenseDocument': '粘贴完整 License 文档',
  'licenseManagementPage.importLicense': '导入 License',
  'nodeRuntimeEnvironment.available':
    resourceDetailsZhCN.generated.nodeRuntimeEnvironment.available,
  'nodeRuntimeEnvironment.computerUseDisabled':
    resourceDetailsZhCN.generated.nodeRuntimeEnvironment.computerUseDisabled,
  'nodeRuntimeEnvironment.computerUseInitializing':
    resourceDetailsZhCN.generated.nodeRuntimeEnvironment.computerUseInitializing,
  'nodeRuntimeEnvironment.computerUseAvailable':
    resourceDetailsZhCN.generated.nodeRuntimeEnvironment.computerUseAvailable,
  'nodeRuntimeEnvironment.computerUseUnavailable':
    resourceDetailsZhCN.generated.nodeRuntimeEnvironment.computerUseUnavailable,
  'nodeRuntimeEnvironment.gui': resourceDetailsZhCN.generated.nodeRuntimeEnvironment.gui,
  'nodeRuntimeEnvironment.pyAutoGui':
    resourceDetailsZhCN.generated.nodeRuntimeEnvironment.pyAutoGui,
  'nodeRuntimeEnvironment.notFound': resourceDetailsZhCN.generated.nodeRuntimeEnvironment.notFound,
  'nodeRuntimeEnvironment.theNodeHasNotReportedItsEnvironment':
    resourceDetailsZhCN.generated.nodeRuntimeEnvironment.theNodeHasNotReportedItsEnvironment,
  'skillErrors.SKILL_SOURCE_IN_USE':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_IN_USE,
  'skillErrors.SKILL_SOURCE_LIMIT_EXCEEDED':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_LIMIT_EXCEEDED,
  'skillErrors.SKILL_SOURCE_QUERY_INVALID':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_QUERY_INVALID,
  'skillErrors.SKILL_SOURCE_PROVIDER_UNSUPPORTED':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_PROVIDER_UNSUPPORTED,
  'skillErrors.SKILL_SOURCE_UNAVAILABLE':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_UNAVAILABLE,
  'skillErrors.SKILL_SOURCE_ADDRESS_FORBIDDEN':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_ADDRESS_FORBIDDEN,
  'skillErrors.SKILL_SOURCE_RATE_LIMITED':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_RATE_LIMITED,
  'skillErrors.SKILL_SOURCE_RESPONSE_INVALID':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_RESPONSE_INVALID,
  'skillErrors.SKILL_SOURCE_DISABLED':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_DISABLED,
  'skillErrors.SKILL_SOURCE_NOT_FOUND':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_NOT_FOUND,
  'skillErrors.SKILL_SOURCE_FORBIDDEN':
    skillConfigurationZhCN.generated.skillErrors.SKILL_SOURCE_FORBIDDEN,
  'skillErrors.SKILL_FAVORITE_NOT_FOUND':
    skillConfigurationZhCN.generated.skillErrors.SKILL_FAVORITE_NOT_FOUND,
  'skillErrors.SKILL_FAVORITE_FORBIDDEN':
    skillConfigurationZhCN.generated.skillErrors.SKILL_FAVORITE_FORBIDDEN,
  'skillErrors.SKILL_INSTALL_FAILED':
    skillConfigurationZhCN.generated.skillErrors.SKILL_INSTALL_FAILED,
  'skillErrors.SKILL_INSTALL_STATUS_TIMEOUT':
    skillConfigurationZhCN.generated.skillErrors.SKILL_INSTALL_STATUS_TIMEOUT,
  'skillErrors.SKILL_CONTENT_INVALID':
    skillConfigurationZhCN.generated.skillErrors.SKILL_CONTENT_INVALID,
  'skillErrors.SKILL_INSTALL_INVALID_LINK':
    skillConfigurationZhCN.generated.skillErrors.SKILL_INSTALL_INVALID_LINK,
  'skillErrors.SKILL_INSTALL_RECOVERY_REQUIRED':
    skillConfigurationZhCN.generated.skillErrors.SKILL_INSTALL_RECOVERY_REQUIRED,
  'skillErrors.SKILL_NAME_CONFLICT':
    skillConfigurationZhCN.generated.skillErrors.SKILL_NAME_CONFLICT,
  'skillErrors.SKILL_TARGET_LIMIT_EXCEEDED':
    skillConfigurationZhCN.generated.skillErrors.SKILL_TARGET_LIMIT_EXCEEDED,
  'skillErrors.WORKSPACE_BUSY': skillConfigurationZhCN.generated.skillErrors.WORKSPACE_BUSY,
  'skillErrors.WORKSPACE_SKILL_GIT_EXCLUDE_FAILED':
    skillConfigurationZhCN.generated.skillErrors.WORKSPACE_SKILL_GIT_EXCLUDE_FAILED,
  'skillErrors.NODE_REQUEST_TIMEOUT':
    skillConfigurationZhCN.generated.skillErrors.NODE_REQUEST_TIMEOUT,
  'skillErrors.NODE_OFFLINE': skillConfigurationZhCN.generated.skillErrors.NODE_OFFLINE
};

export const generatedZhCN = expandGeneratedMessages(generatedZhCNFlat);
