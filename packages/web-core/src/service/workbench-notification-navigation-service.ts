import type { Ref } from 'vue';
import type { AsideSession } from './workbench-aside-service.js';
import type { Session } from '../model/workbench.js';
import type { WorkbenchView } from '../util/workbench-route.js';
import type { WorkbenchNotification } from './workbench-notification-service.js';
import type { MessageFeedback } from '../model/message-feedback.js';
import { errorMessage as message } from '../util/workbench-presentation.js';
import { translate } from './locale-preference-service.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { WorkbenchNotificationTarget } from './workbench-notification-service.js';

export async function navigateWorkbenchNotification(
  target: WorkbenchNotificationTarget,
  options: {
    readonly workspaceTarget: () => WorkspaceTarget | undefined;
    readonly hasSession: (sessionId: string) => boolean;
    readonly showNodes: () => void;
    readonly activateWorkspace: (target: WorkspaceTarget) => Promise<boolean>;
    readonly synchronizeSessions: (workspaceId: string) => Promise<void>;
    readonly openSession: (sessionId: string) => Promise<void>;
    readonly showConversations?: () => void;
    readonly openHostedConversation?: (nodeId: string, conversationId: string) => Promise<void>;
  }
): Promise<void> {
  if (target.targetType === 'HOSTED_CONVERSATION') {
    if (options.showConversations === undefined || options.openHostedConversation === undefined)
      throw new Error('NOTIFICATION_TARGET_NOT_SELECTED');
    options.showConversations();
    await options.openHostedConversation(target.nodeId, target.conversationId);
    return;
  }
  options.showNodes();
  if (target.workspaceId === undefined) return;
  if (
    !(await options.activateWorkspace({ nodeId: target.nodeId, workspaceId: target.workspaceId }))
  )
    throw new Error('NOTIFICATION_TARGET_NOT_SELECTED');
  const selected = options.workspaceTarget();
  if (selected?.nodeId !== target.nodeId || selected.workspaceId !== target.workspaceId)
    throw new Error('NOTIFICATION_TARGET_NOT_SELECTED');
  if (target.sessionId === undefined) return;
  if (!options.hasSession(target.sessionId)) await options.synchronizeSessions(target.workspaceId);
  if (options.workspaceTarget() !== selected) return;
  await options.openSession(target.sessionId);
}

export function createWorkbenchTargetNavigation(input: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly sessions: Readonly<Ref<readonly Session[]>>;
  readonly selectView: (view: WorkbenchView) => void;
  readonly applyWebUpdate: () => Promise<void>;
  readonly closeMobileSidebar: () => void;
  readonly selectWorkspace: (
    target: WorkspaceTarget,
    restoreSession?: import('./workbench-workspace-selection-service.js').WorkspaceSessionRestoration
  ) => Promise<boolean>;
  readonly syncWorkspaceSessions: (workspaceId: string) => Promise<void>;
  readonly openHostedConversationTarget: (nodeId: string, conversationId: string) => Promise<void>;
  readonly discovery: Pick<
    ReturnType<typeof import('./workspace-session-service.js').createWorkspaceSessionService>,
    'groupSelectionRevision' | 'selectGroup'
  >;
  readonly selection: () => Pick<
    ReturnType<
      typeof import('./workbench-session-selection-service.js').createWorkbenchSessionSelectionService
    >,
    'hasAsideSession' | 'openNavigatedSession' | 'selectSession'
  >;
  readonly onAsideRevealed: (target: AsideSession) => void;
  readonly notice: MessageFeedback;
}) {
  const {
    workspaceTarget,
    sessions,
    selectView,
    applyWebUpdate,
    closeMobileSidebar,
    selectWorkspace,
    syncWorkspaceSessions,
    openHostedConversationTarget,
    notice
  } = input;
  const workspaceSessionDiscovery = input.discovery;
  const selectWorkspaceSessionGroup = input.discovery.selectGroup;
  async function openWorkbenchNotification(notification: WorkbenchNotification): Promise<void> {
    if (notification.action === 'RELOAD_PAGE') {
      await applyWebUpdate();
      return;
    }
    const target = notification.target;
    if (target === undefined) return;
    await navigateWorkbenchTarget(target, 'reuse');
  }

  async function navigateWorkbenchTarget(
    target: NonNullable<WorkbenchNotification['target']>,
    destination: 'main' | 'reuse'
  ): Promise<void> {
    try {
      let groupRevision: number | undefined;
      await navigateWorkbenchNotification(target, {
        workspaceTarget: () => workspaceTarget.value,
        hasSession: (sessionId) =>
          (destination === 'reuse' &&
            workspaceTarget.value !== undefined &&
            input.selection().hasAsideSession(workspaceTarget.value, sessionId)) ||
          sessions.value.some(
            (session) =>
              session.id === sessionId &&
              (!('workspaceId' in target) ||
                target.workspaceId === undefined ||
                session.workspaceId === target.workspaceId)
          ),
        showNodes: () => selectView('nodes'),
        showConversations: () => selectView('conversations'),
        activateWorkspace: async (workspace) => {
          const current = workspaceTarget.value;
          const hasSessionTarget = 'sessionId' in target && target.sessionId !== undefined;
          if (
            hasSessionTarget &&
            current?.nodeId === workspace.nodeId &&
            current.workspaceId === workspace.workspaceId
          ) {
            closeMobileSidebar();
            groupRevision = workspaceSessionDiscovery.groupSelectionRevision();
            return true;
          }
          const activated = await selectWorkspace(
            workspace,
            !hasSessionTarget
              ? true
              : destination === 'reuse' &&
                  input.selection().hasAsideSession(workspace, target.sessionId) &&
                  'behind-aside'
          );
          if (activated) groupRevision = workspaceSessionDiscovery.groupSelectionRevision();
          return activated;
        },
        synchronizeSessions: syncWorkspaceSessions,
        openSession: (sessionId) => openNavigatedSession(sessionId, groupRevision, destination),
        openHostedConversation: openHostedConversationTarget
      });
    } catch (error) {
      notice(
        translate('generated.workbenchPageController.unableToOpenTheSessionLinkedTo', {
          value0: message(error)
        }),
        'error',
        error
      );
    }
  }

  async function openRecentRun(
    run: import('./workbench-notification-service.js').RecentRun
  ): Promise<void> {
    await navigateWorkbenchTarget(
      {
        targetType: 'WORKSPACE_SESSION',
        nodeId: run.nodeId,
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        sessionName: run.sessionTitle
      },
      'main'
    );
  }

  async function openSessionGroupTarget(target: {
    nodeId: string;
    workspaceId: string;
    sessionId: string;
  }): Promise<void> {
    await navigateWorkbenchTarget({ targetType: 'WORKSPACE_SESSION', ...target }, 'main');
  }

  function openNavigatedSession(
    sessionId: string,
    groupRevision = workspaceSessionDiscovery.groupSelectionRevision(),
    destination: 'main' | 'reuse' = 'reuse'
  ): Promise<void> {
    const target = workspaceTarget.value;
    const onSessionResolved = (session: Session) => {
      if (
        target !== undefined &&
        workspaceTarget.value?.nodeId === target.nodeId &&
        workspaceTarget.value.workspaceId === target.workspaceId &&
        session.workspaceId === target.workspaceId &&
        session.id === sessionId &&
        workspaceSessionDiscovery.groupSelectionRevision() === groupRevision
      )
        selectWorkspaceSessionGroup(session.sessionGroup ?? 'MAIN', true);
    };
    const selection = input.selection();
    return destination === 'main'
      ? selection.selectSession(sessionId, onSessionResolved)
      : selection.openNavigatedSession(sessionId, onSessionResolved, input.onAsideRevealed);
  }

  return { openWorkbenchNotification, openRecentRun, openSessionGroupTarget, openNavigatedSession };
}
