import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const readSource = (path: string) => readFile(resolve(process.cwd(), path), 'utf8');

describe('Web hosted conversation workspace composition', () => {
  it('Standalone chats reuse scrolling and base Composer and open history and files through mobile tool layers', async () => {
    const [
      surface,
      page,
      composer,
      workspaceService,
      controller,
      header,
      scrollService,
      watchCoordinator,
      previewService,
      filePageFrame,
      zhMessages,
      enMessages,
      navigation,
      workbenchPage
    ] = await Promise.all([
      readSource('packages/web-core/src/view/workbench/WorkbenchSurface.vue'),
      readSource('packages/web-core/src/view/conversation/HostedConversationWorkspacePage.vue'),
      readSource('packages/web-core/src/view/conversation/HostedConversationComposer.vue'),
      readSource('packages/web-core/src/service/HostedConversationWorkspaceService.ts'),
      readSource('packages/web-core/src/service/WorkbenchPageController.ts'),
      readSource('packages/web-core/src/view/workbench/WorkbenchHeader.vue'),
      readSource('packages/web-core/src/service/ConversationScrollService.ts'),
      readSource('packages/web-core/src/service/HostedConversationWatchCoordinator.ts'),
      readSource('packages/web-core/src/service/HostedConversationFilePreviewService.ts'),
      readSource('packages/web-core/src/view/workspace/WorkspaceFilePageFrame.vue'),
      readSource('packages/web-core/src/i18n/hosted-conversations.zh-CN.ts'),
      readSource('packages/web-core/src/i18n/hosted-conversations.en-US.ts'),
      readSource('packages/web-core/src/view/workbench/WorkbenchNavigation.vue'),
      readSource('packages/web-core/src/view/workbench/WorkbenchPage.vue')
    ]);

    expect(surface).toContain('HostedConversationWorkspacePage');
    expect(surface).toMatch(
      /hostedConversationHeader === undefined\s*\? translate\('hostedConversations\.temporaryTitle'\)\s*: hostedConversationTitle\(hostedConversationHeader\)/s
    );
    expect(surface).not.toContain(':conversation-subtitle=');
    expect(surface).not.toContain('transition: margin-left');
    expect(surface).toMatch(
      /\.workbench\.standalone\s*\{[^}]*margin-left: var\(--mar-workbench-sidebar-total-width\);/s
    );
    expect(surface).toMatch(
      /\.workbench\.standalone\.compact\s*\{[^}]*margin-left: var\(--mar-activity-rail-width\);/s
    );
    expect(surface).not.toContain('--mar-workbench-header-height: var(--sidebar-header-height)');
    expect(surface).toContain(':mobile-history-open="page.hostedConversationMobileHistoryOpen"');
    expect(surface).toContain(':sidebar-collapsed="page.sidebarCollapsed"');
    expect(surface).toContain('@close-mobile-history="page.closeHostedConversationMobileHistory"');
    expect(surface).toContain(':select-conversation="page.selectHostedConversation"');
    expect(surface).toContain(':route-target="page.hostedConversationRoute"');
    expect(surface).toContain(':restoring-route="page.restoringHostedConversationRoute"');
    expect(surface).toContain(':clear-conversation="page.clearHostedConversation"');
    expect(surface).not.toContain(
      '<HostedConversationWorkspacePage\n      v-else-if="page.view === \'conversations\'"\n      :workspace="page.hostedConversationWorkspace"\n      :request="page.request"\n      :nodes="page.nodes"'
    );
    expect(surface).toContain(
      ':has-unread-conversation="page.workbenchNotificationService.hasUnreadConversation"'
    );
    expect(header).toContain("view === 'conversations' && conversationTitle");
    expect(header).toContain('v-if="!mobileViewport"');
    expect(header).not.toContain('v-if="!mobileViewport && view !== \'conversations\'"');
    expect(header).not.toMatch(
      /\.workbench-header\.conversation-layout\s*\{[^}]*grid-template-columns:/s
    );
    expect(header).not.toContain('transform: translateX(var(--mar-workbench-sidebar-width))');
    expect(header).toContain('class="breadcrumb"');
    expect(header).toContain("$t('navigation.conversations')");
    expect(header).toContain('<strong :title="conversationTitle">{{ conversationTitle }}</strong>');
    expect(header).toContain('{{ conversationTitle }}');
    expect(header).not.toContain('conversationSubtitle');
    expect(header).not.toContain('class="conversation-heading"');
    expect(header).not.toContain('conversation-heading-subtitle');
    expect(header).not.toContain("'conversation-view': view === 'conversations'");
    expect(page).toContain('createConversationScrollService');
    expect(page).toContain('createConversationImageService');
    expect(page).toContain(
      '/hosted-conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageSelector)}'
    );
    expect(page).toContain('createHostedConversationFilePreviewService');
    expect(page).toContain('hostedConversationFileForPath');
    expect(page).toContain('buildHostedConversationFileTree');
    expect(page).toContain('visibleHostedConversationFileTreeRows');
    expect(page).toContain('readonly sidebarCollapsed: boolean;');
    expect(page).toContain("'history-collapsed': sidebarCollapsed");
    expect(page).toContain('await openConversation(initial, false)');
    expect(page).toContain('if (closePanels) closeMobilePanels();');
    expect(page).toMatch(
      /\.hosted-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(420px, 1fr\) minmax\(260px, 318px\);/s
    );
    expect(page).toMatch(
      /@media \(min-width: 768px\)\s*\{[^}]*\.hosted-conversation-history\s*\{[^}]*position: fixed;[^}]*inset:\s*var\(--sidebar-header-height\) auto 0 var\(--mar-activity-rail-width\);[^}]*width: var\(--mar-workbench-sidebar-width\);/s
    );
    expect(page).toMatch(
      /@media \(min-width: 768px\)\s*\{[\s\S]*?\.hosted-workspace\.history-collapsed\s+\.hosted-conversation-history\s*\{[^}]*display: none;/s
    );
    expect(page).toContain(':aria-expanded="fileDirectoryExpanded(group.category, row.node.path)"');
    expect(page).toContain('<ConversationScroll');
    expect(page).toContain(':has-older="workspace.historyNextCursor.value !== null"');
    expect(page).toContain(':loading-older="workspace.loadingOlderHistory.value"');
    expect(page).toContain('@load-older="loadOlderConversationHistory"');
    expect(page).toContain('await props.workspace.loadOlderHistory();');
    expect(page).toContain('<ConversationTimeline');
    expect(page).toContain(':rewind-enabled="false"');
    expect(page).toContain(':rollback-enabled="rollbackEnabled"');
    expect(page).toContain('@rollback="rollbackConversation"');
    expect(page).toContain(
      "props.workspace.snapshot.value?.conversation.activity.status === 'IDLE'"
    );
    expect(page).toContain('const boundary = turn.rewind.before;');
    expect(page.match(/!rollbackEnabled\.value/gu)).toHaveLength(2);
    expect(page).toContain("currentItem?.kind !== 'user_message'");
    expect(page).toContain('await props.workspace.rollback(turn.id, boundary);');
    expect(page).toContain('if (selectedConversationKey.value === conversationKeyAtConfirmation)');
    expect(page).toContain('composer.value?.restoreMessage(text);');
    expect(page).toContain('workspace-root="/workspace"');
    expect(page).toContain(':image-attachments="conversationImages.attachments"');
    expect(page).toContain('@open-image="conversationImages.open"');
    expect(page).toContain('@image-unavailable="conversationImages.markUnavailable"');
    expect(page).toContain('@open-file="openLinkedFile"');
    expect(page).toContain('<ImagePreviewDialogs');
    expect(page).toContain(':conversation-open="conversationImages.previewOpen.value"');
    expect(page).toContain(':conversation="conversationImages.preview.value"');
    expect(page).toContain('<WorkspaceTextFilePage');
    expect(page).toContain('<WorkspaceFormatFilePage');
    expect(page).toContain(':fullscreen="true"');
    expect(filePageFrame).toMatch(
      /\.workspace-file-page-frame\.is-fullscreen\s*\{[^}]*position: fixed;[^}]*z-index: 50;[^}]*inset: 0;/s
    );
    expect(page).not.toContain('<el-dialog');
    expect(page).toContain('workspace.conversationIsRunning(conversation)');
    expect(page).toContain('hostedConversationTitle(conversation)');
    expect(page).toContain('<h2>{{ hostedConversationTitle(selectedSummary) }}</h2>');
    expect(page).not.toContain('<h2>{{ selectedSummary.title }}</h2>');
    expect(page).toContain('hasUnreadConversation(conversation.nodeId, conversation.id)');
    expect(page).toContain('class="history-run-indicator"');
    expect(page).toContain('class="history-unread-indicator"');
    expect(page).not.toContain('props.workspace.beginSelectedConversationWatch');
    expect(page).not.toContain('props.workspace.selectConversation');
    expect(page).not.toContain('props.workspace.clearSelectedConversation');
    expect(page).not.toContain('props.workspace.readFile');
    expect(page).not.toContain('function base64Bytes(');
    expect(page).not.toContain('function textPreview(');
    expect(page).toContain('props.workspace.turns.value');
    expect(page).toContain('<HostedConversationComposer');
    expect(page).toContain('ref="composer"');
    expect(page).toContain(':key="selectedConversationKey"');
    expect(composer).toContain('defineExpose({ restoreMessage });');
    expect(composer).toContain('composer.value?.focusAt(text.length);');
    expect(zhMessages).toContain("rollbackTitle: '回滚对话？'");
    expect(enMessages).toContain("rollbackTitle: 'Roll back conversation?'");
    expect(page).toContain('watch(selectedConversationKey, closePreview)');
    expect(page).toContain('function setConversationScrollElement(');
    expect(page).toContain('@scroll-element="setConversationScrollElement"');
    expect(page).toContain('@scroll="handleConversationScroll"');
    expect(page).toContain('@latest="conversationScrollService.scrollToLatest"');
    expect(page).toContain(':following="conversationScrollService.following.value"');
    expect(page).not.toContain(':hidden="mobileViewport && !mobileHistoryOpen"');
    expect(page).not.toContain(':hidden="mobileViewport && !mobileFilesOpen"');
    expect(page).toContain('class="hosted-conversation-scrim"');
    expect(page).toContain('class="hosted-mobile-files-button"');
    expect(page).not.toContain('class="hosted-mobile-tabs"');
    expect(page).not.toContain('handleMobilePaneKeydown');
    expect(page).not.toContain('const mobilePane');
    expect(page).toContain('async function loadMoreHistory()');
    expect(page).toContain('@click="loadMoreHistory"');
    expect(page).toContain('class="history-create-button"');
    expect(page).toContain('<el-icon><ChatLineSquare /></el-icon>');
    expect(page).not.toContain(':icon="Plus"');
    expect(page).toContain('class="sidebar-heading session-heading history-header"');
    expect(page).not.toContain('class="pane-header history-header"');
    const historyHeaderStyles = page.match(/\.history-header\s*\{([^}]*)\}/s)?.[1];
    expect(historyHeaderStyles).toBeDefined();
    expect(historyHeaderStyles).not.toContain('height: var(--mar-workbench-header-height);');
    expect(historyHeaderStyles).toContain('flex: 0 0 auto;');
    expect(historyHeaderStyles).toContain('justify-content: flex-start;');
    expect(historyHeaderStyles).toContain('padding: 12px 20px;');
    expect(historyHeaderStyles).toContain('text-align: left;');
    expect(historyHeaderStyles).not.toContain('border-bottom');
    expect(page).toMatch(
      /\.history-header \.session-heading-meta\s*\{[^}]*justify-content: flex-start;/s
    );
    expect(page).toMatch(/\.history-controls\s*\{[^}]*padding: 0 12px 10px;/s);
    expect(page).toContain('class="history-search-row"');
    expect(page).toContain('class="history-refresh-button utility-control"');
    expect(page).toContain(':aria-label="translate(\'hostedConversations.refreshHistory\')"');
    expect(page).toContain(':title="translate(\'hostedConversations.refreshHistory\')"');
    expect(page).toContain(':disabled="loadingDirectory"');
    expect(page).toContain('<el-icon><Refresh /></el-icon>');
    expect(page).not.toContain('<footer class="history-footer">');
    expect(page).toMatch(
      /\.history-search-row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--mar-compact-control-size\);/s
    );
    expect(page).toMatch(
      /@media \(max-width: 767px\)[\s\S]*?\.history-refresh-button\s*\{[^}]*min-width: 36px;[^}]*min-height: 36px;/s
    );
    expect(page).toMatch(
      /@media \(max-width: 767px\)[\s\S]*?\.hosted-conversation-history,\s*\.hosted-conversation-files\s*\{[^}]*position: fixed;[^}]*inset: var\(--sidebar-header-height\) auto 0 0;[^}]*width: min\(300px, calc\(100vw - 48px\)\);[^}]*border-right: 1px solid var\(--mar-border-strong\);[^}]*box-shadow: 0 8px 24px var\(--mar-shadow-medium\);[^}]*transform: translateX\(-100%\);[^}]*visibility: hidden;[^}]*pointer-events: none;[^}]*transition:\s*transform 0\.16s ease,\s*visibility 0\.16s step-end;/s
    );
    expect(page).toMatch(
      /\.hosted-conversation-history\.mobile-open,\s*\.hosted-conversation-files\.mobile-open\s*\{[^}]*transform: translateX\(0\);[^}]*visibility: visible;[^}]*pointer-events: auto;[^}]*transition:\s*transform 0\.16s ease,\s*visibility 0s;/s
    );
    expect(surface).toMatch(
      /@media \(max-width: 767px\)\s*\{[\s\S]*?\.workbench\.standalone,\s*\.workbench\.standalone\.compact[\s\S]*?margin-left: 0;/s
    );
    expect(page).toMatch(
      /\.hosted-conversation-scrim\s*\{[^}]*position: fixed;[^}]*inset: var\(--sidebar-header-height\) 0 0;[^}]*background: var\(--mar-overlay-scrim\);/s
    );
    expect(navigation).toMatch(
      /\.workspace-tree\s*\{[^}]*width: min\(300px, calc\(100vw - 48px\)\);[^}]*border-right: 1px solid var\(--mar-border-strong\);[^}]*box-shadow: 0 8px 24px var\(--mar-shadow-medium\);[^}]*transform: translateX\(-100%\);[^}]*transition: transform 0\.16s ease;/s
    );
    expect(workbenchPage).toMatch(
      /\.sidebar-scrim\s*\{[^}]*position: fixed;[^}]*inset: var\(--sidebar-header-height\) 0 0;[^}]*background: var\(--mar-overlay-scrim\);/s
    );
    expect(page).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.hosted-conversation-history,\s*\.hosted-conversation-files\s*\{[^}]*transition: none;/s
    );
    expect(page).toContain('class="pane-header files-header"');
    expect(page).toMatch(/\.files-header\s*\{[^}]*min-height: 44px;[^}]*padding: 8px 14px;/s);
    const filesHeader = page.match(
      /<header class="pane-header files-header">([\s\S]*?)<\/header>/
    )?.[1];
    expect(filesHeader).toBeDefined();
    expect(filesHeader).not.toContain('FolderOpened');
    expect(page.indexOf('class="history-create-button"')).toBeLessThan(
      page.indexOf('v-model="filter"')
    );
    expect(page.indexOf('v-model="filter"')).toBeLessThan(
      page.indexOf('class="history-refresh-button utility-control"')
    );
    expect(page).toContain('workspace.updateMetadata');
    expect(page).toContain(
      'const deletingSelectedConversation =\n    conversation.nodeId === props.workspace.selectedNodeId.value &&\n    conversation.id === props.workspace.selectedConversationId.value;'
    );
    expect(page).toContain(
      'deletingSelectedConversation &&\n      props.workspace.selectedConversationId.value === undefined'
    );
    expect(page).toContain('await refreshDirectory();');
    expect(page).not.toContain('restoreConversation');
    expect(page).not.toContain('RECOVERABLE_DELETED');
    expect(page).not.toContain("conversation.status === 'UPGRADE_FAILED'");
    expect(workspaceService).not.toContain('restoreConversation');
    expect(workspaceService).not.toContain("conversation.status === 'UPGRADE_FAILED'");
    expect(page).toContain('<StarFilled');
    expect(page).toContain('@mouseenter="hoveredConversationKey = conversationKey(conversation)"');
    expect(page).toContain('@focusin="focusedConversationKey = conversationKey(conversation)"');
    expect(page).toContain('v-if="conversationActionsVisible(conversationKey(conversation))"');
    expect(page).toContain('@visible-change="');
    expect(page).toContain(
      'setConversationActionMenuVisible($event, conversationKey(conversation))'
    );
    expect(page).toContain('actionConversationKey.value = key;');
    expect(page).not.toContain('class="conversation-header"');
    expect(page).not.toContain('statusLabel(');
    expect(page).not.toContain("translate('hostedConversations.eyebrow')");
    expect(page).not.toContain('historyTemplateNode');
    expect(page).not.toContain('directoryFailureNodeIds');
    expect(page).not.toContain('historyPartialUnavailable');
    expect(page).not.toContain('props.nodes');
    expect(page).not.toContain('NodeSummary');
    expect(page).not.toContain('hostedConversationNavigationAvailable');
    expect(page).not.toContain('directoryRefreshKey');
    expect(page).not.toContain('const selectedNode');
    expect(page).not.toContain('nodeReady');
    expect(page).not.toContain('supportsExistingConversations');
    expect(page).not.toContain("translate('hostedConversations.relatedFiles')");
    expect(page).toContain('@dragenter.prevent');
    expect(page).toContain('@dragover.prevent');
    expect(page).toContain('@drop.prevent="handleFilesDrop"');
    expect(page).toContain('ref="relatedFilesInput"');
    expect(page).toContain('type="file"');
    expect(page).toContain('multiple');
    expect(page).toContain('@click="chooseRelatedFiles"');
    expect(page).toContain('@change="handleRelatedFilesSelected"');
    expect(page).toContain(':disabled="!filesWritable || uploadingDroppedFiles"');
    expect(page).toContain('const files = Array.from(input.files ?? []);');
    expect(page).toContain('workspace.uploadFile');
    expect(page).toContain('workspace.deleteFile');
    expect(page).toMatch(/\.file-open\s*\{[^}]*align-items: center;/s);
    expect(page).toContain('<time');
    expect(page).toContain('workspace.snapshot.value?.error');
    expect(page).toContain('const readonlyVisible = computed(() => {');
    expect(page).toContain(
      'return props.workspace.snapshot.value !== undefined && !interactionReady.value;'
    );
    expect(page).toContain('v-if="readonlyVisible"');
    expect(page).not.toContain('v-if="selectedSummary && !interactionReady"');
    expect(zhMessages).toContain("loadingConversation: '正在加载对话中…'");
    expect(enMessages).toContain("loadingConversation: 'Loading conversation…'");
    expect(page).toContain('hosted-conversation-history');
    expect(page).toContain('hosted-conversation-files');
    expect(page).toContain('class="history-empty-text"');
    expect(page).not.toContain('<el-empty');
    expect(composer).toContain('<ConversationComposer');
    expect(composer).not.toContain('ComposerToolbar');
    expect(composer).not.toContain('ComposerCommandPicker');
    expect(composer).not.toContain('ComposerFileReferencePicker');
    expect(composer).not.toContain('ComposerSkill');
    expect(composer).not.toContain('accessOptions');
    expect(composer).not.toContain('reasoningEffort');
    expect(composer).not.toContain('hosted-reasoning-select');
    expect(composer).not.toContain("translate('hostedConversations.fixedMode')");
    expect(composer).not.toContain('class="hosted-composer-mode"');
    expect(composer).toContain('class="hosted-model-slot"');
    expect(composer).toContain('class="hosted-model-trigger"');
    expect(composer).toContain(':aria-label="translate(\'hostedConversations.model\')"');
    expect(composer).toContain('<span>{{ selectedModelLabel }}</span>');
    expect(composer).toContain(
      "const templateName = computed(() => snapshot.value?.conversation.templateName ?? '')"
    );
    expect(composer).toContain('class="hosted-template-name"');
    expect(composer).toContain("translate('hostedConversations.loadedTemplateNamed'");
    expect(composer).toContain(':aria-label="loadedTemplateLabel"');
    expect(composer).toContain(
      'const modelUnavailable = computed(() => models.value.length === 0)'
    );
    expect(composer).toContain('class="hosted-model-unavailable"');
    expect(composer).toContain("translate('hostedConversations.modelUnavailable')");
    expect(composer).toContain('max-width: 100%;');
    expect(composer).not.toContain('width: min(180px, 30vw);');
    expect(composer).toContain('if (props.mobileViewport) return;');
    expect(composer).toContain('workspace.messageSubmitting');
    expect(composer).toContain('createWorkbenchClockService');
    expect(composer).toContain('workingElapsedLabel');
    expect(composer).toContain("translate('workbench.sending')");
    expect(composer).not.toContain("translate('hostedConversations.running')");
    expect(composer).toContain('if (errorCode(error) !== undefined) messageIntent = undefined');
    expect(composer).toContain('@click="retryAttachment(attachment.id)"');
    expect(composer).toContain('aria-live="polite"');
    expect(composer).toContain('createComposerAttachmentInputService');
    expect(composer).toContain(':drop-target="draggingAttachments"');
    expect(composer).toContain('@paste="attachmentInput.onPaste"');
    expect(composer).toContain('@dragenter="attachmentInput.onDragEnter"');
    expect(composer).toContain('@dragleave="attachmentInput.onDragLeave"');
    expect(composer).toContain('@drop="attachmentInput.onDrop"');
    expect(composer).toContain('folderAttachmentUnsupported');
    expect(workspaceService).toContain('createConversationProjectionService');
    expect(workspaceService).toContain('createWorkbenchSubmissionService');
    expect(workspaceService).toContain('turns: projectedTurns');
    expect(workspaceService).not.toContain('nodeAvailable');
    expect(workspaceService).not.toContain('function normalizeItem(');
    expect(previewService).toContain('shouldReadTextFilePreview');
    expect(previewService).toContain('readFilePreview');
    expect(previewService).toContain('TEXT_PREVIEW_LIMIT_BYTES');
    expect(previewService).toContain('options.source.contentUrl(nextFile)');
    expect(previewService).not.toContain('BINARY_PREVIEW_LIMIT_BYTES');
    expect(scrollService).toContain('const FOLLOW_THRESHOLD_PX = 28');
    expect(controller).toContain('const hostedConversationMobileHistoryOpen = ref(false);');
    expect(controller).toContain("if (mobileViewport.value && nextView === 'conversations') {");
    expect(controller).not.toContain("previousView === 'conversations' &&");
    expect(controller).toContain('hostedConversationMobileHistoryOpen.value = true;');
    expect(controller).toContain('function closeHostedConversationMobileHistory(): void');
    expect(controller).toContain(
      'const selectHostedConversation = hostedConversationSelection.select;'
    );
    expect(controller).toContain('workbenchNotificationService.markConversationRead(');
    expect(controller).toContain('hostedConversationWorkspace.projectActivityMessage(message)');
    expect(controller).toContain('async function restoreHostedConversationRoute(): Promise<void>');
    expect(controller).toContain(
      'await hostedConversationSelection.restoreTarget(target, syncWorkbenchRoute);'
    );
    expect(controller).not.toContain('hostedConversationNavigationAvailable');
    expect(controller).toContain('const restoringHostedConversationRoute = ref(');
    expect(controller).toContain(
      'const clearHostedConversation = hostedConversationSelection.clear;'
    );
    expect(controller).toContain('hostedConversationWorkspace.selectedNodeId');
    expect(controller).toContain('hostedConversationWorkspace.selectedConversationId');
    expect(controller).toContain('navigationWatchService.transition(previousView, nextView);');
    expect(watchCoordinator).toContain("from './WorkbenchWatchCoordinator.js'");
    expect(watchCoordinator).toContain('begin: () => hosted.beginSelectedConversationWatch()');
    expect(watchCoordinator).toContain('stop: () => hosted.stopSelectedConversationWatch()');
    expect(watchCoordinator).toContain('beginHostedConversation: beginExtension');
    expect(watchCoordinator).not.toMatch(/let reconcile|let trailing|function enqueue/u);
  });
});
