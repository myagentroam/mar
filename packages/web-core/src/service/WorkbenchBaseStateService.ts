import { computed, customRef, ref, type Ref } from 'vue';
import {
  createWorkbenchNotificationService,
  type WorkbenchNotification
} from './WorkbenchNotificationService.js';
import type { Workspace } from '../model/workbench.js';
import { createAdminSessionStateService } from './AdminSessionStateService.js';
import { createConversationStateService } from './ConversationStateService.js';
import { createRunService } from './RunService.js';
import { createSessionDraftService } from './SessionDraftService.js';
import { createWorkbenchHttpService } from './WorkbenchHttpService.js';
import { createWorkbenchSelectionStateService } from './WorkbenchSelectionStateService.js';
import { createWorkbenchSurfaceStateService } from './WorkbenchSurfaceStateService.js';
import { createWorkspaceSessionPagingService } from './WorkspaceSessionPagingService.js';

const USER_CSRF_STORAGE_KEY = 'mar.user.csrf-token';

/** Creates ordinary tab-local state; product navigation and extensions stay with the host. */
export function createWorkbenchBaseStateService<
  WorkspaceType extends Workspace = Workspace
>(options: { readonly sessionPageSize: number; readonly onUnauthenticated: () => void }) {
  const admin = createAdminSessionStateService();
  const notice = customRef<string>((track, trigger) => {
    let value = '';
    return {
      get: () => {
        track();
        return value;
      },
      set: (next) => {
        value = next;
        trigger();
      }
    };
  });
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
  const conversation = createConversationStateService();
  const surface = createWorkbenchSurfaceStateService();
  return { admin, notice, http, selection, paging, draft, run, conversation, surface };
}

/** Composes foreground targets without interpreting host management identifiers. */
export function createWorkbenchPageStateService<
  Navigation extends { readonly view: Ref<string> },
  WorkspaceType extends Workspace = Workspace
>(options: {
  readonly sessionPageSize: number;
  readonly onUnauthenticated: () => void;
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
