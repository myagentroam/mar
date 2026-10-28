import { computed, ref, type Ref } from 'vue';
import {
  createWorkbenchNotificationService,
  type WorkbenchNotification
} from './workbench-notification-service.js';
import type { Workspace } from '../model/workbench.js';
import { createAdminSessionStateService } from './admin-session-state-service.js';
import { createConversationStateService } from './conversation-state-service.js';
import { createRunService } from './run-service.js';
import { createSessionDraftService } from './session-draft-service.js';
import { createWorkbenchHttpService } from './workbench-http-service.js';
import { createWorkbenchSelectionStateService } from './workbench-selection-state-service.js';
import { createWorkbenchSurfaceStateService } from './workbench-surface-state-service.js';
import { createWorkspaceSessionPagingService } from './workspace-session-paging-service.js';

const USER_CSRF_STORAGE_KEY = 'mar.user.csrf-token';

/** Creates ordinary tab-local state; product navigation and extensions stay with the host. */
export function createWorkbenchBaseStateService<
  WorkspaceType extends Workspace = Workspace
>(options: {
  readonly sessionPageSize: number;
  readonly onUnauthenticated: () => void;
  readonly onConversationOverflow: () => void;
}) {
  const admin = createAdminSessionStateService();
  const http = createWorkbenchHttpService({
    csrfToken: admin.csrfToken,
    csrfStorageKey: USER_CSRF_STORAGE_KEY,
    onUnauthenticated: options.onUnauthenticated
  });
  const selection = createWorkbenchSelectionStateService<WorkspaceType>();
  const paging = createWorkspaceSessionPagingService(options.sessionPageSize);
  const run = createRunService(selection.selectedSessionId);
  const draft = createSessionDraftService({
    workspaceTarget: selection.workspaceTarget
  });
  const conversation = createConversationStateService(options.onConversationOverflow);
  const surface = createWorkbenchSurfaceStateService();
  return { admin, http, selection, paging, draft, run, conversation, surface };
}

/** Composes foreground targets without interpreting host management identifiers. */
export function createWorkbenchPageStateService<
  Navigation extends { readonly view: Ref<string> },
  WorkspaceType extends Workspace = Workspace
>(options: {
  readonly sessionPageSize: number;
  readonly onUnauthenticated: () => void;
  readonly onConversationOverflow: () => void;
  readonly navigation: Navigation;
  readonly onWorkspaceRunCompleted?: (nodeId: string, workspaceId: string) => void;
  readonly onNotificationClick?: (notification: WorkbenchNotification) => Promise<void>;
}) {
  const navigation = options.navigation;
  const core = createWorkbenchBaseStateService<WorkspaceType>(options);
  const { admin, http, selection } = core;
  const hostedSelection = {
    selectedNodeId: ref<string>(),
    selectedConversationId: ref<string>()
  };
  const notifications = createWorkbenchNotificationService(
    computed(() => admin.admin.value.username),
    {
      request: http.request,
      ...(options.onWorkspaceRunCompleted === undefined
        ? {}
        : { onWorkspaceRunCompleted: options.onWorkspaceRunCompleted }),
      ...(options.onNotificationClick === undefined
        ? {}
        : { onNotificationClick: options.onNotificationClick }),
      activeTarget: () => {
        if (navigation.view.value === 'conversations') {
          const nodeId = hostedSelection.selectedNodeId.value;
          const conversationId = hostedSelection.selectedConversationId.value;
          return nodeId === undefined || conversationId === undefined
            ? undefined
            : {
                targetType: 'HOSTED_CONVERSATION',
                nodeId,
                conversationId
              };
        }
        if (navigation.view.value !== 'nodes') return undefined;
        const nodeId = selection.workspaceTarget.value?.nodeId;
        const workspaceId = selection.workspaceTarget.value?.workspaceId;
        const sessionId = selection.selectedSessionId.value;
        return nodeId === undefined || workspaceId === undefined || sessionId === undefined
          ? undefined
          : {
              targetType: 'WORKSPACE_SESSION',
              nodeId,
              workspaceId,
              sessionId
            };
      }
    }
  );
  return {
    ...core,
    navigation,
    hostedSelection,
    notifications
  };
}
