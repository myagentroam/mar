import type { WorkbenchUploadsView } from '../service/workspace-upload-service.js';
import type { WorkspaceSessionPaneView } from '../service/workspace-session-pane-controller.js';
import type { WorkbenchInteractionsView } from '../service/workbench-page-interaction-service.js';
import type { WorkbenchSettingsView } from '../service/node-registration-service.js';
import type { WorkbenchRegistrationView } from '../service/workspace-registration-service.js';
import type { WorkbenchResourcesView } from '../service/workbench-capability-service.js';
import type { WorkbenchIdentityView } from '../service/admin-auth-service.js';
import type { WorkbenchNotificationsView } from '../service/workbench-notification-service.js';
import type { WorkbenchFilesView } from '../service/workspace-file-tools-controller.js';
import type { WorkbenchAsideView } from '../service/workbench-aside-service.js';
import type { WorkbenchSelectionView } from '../service/workbench-session-selection-service.js';
import type { WorkbenchSessionListView } from '../service/workspace-session-service.js';
import type { WorkbenchHostedView } from '../service/hosted-conversation-workspace-service.js';
import type { WorkbenchTerminalView } from '../service/terminal-direct-client.js';
import type { WorkbenchTreeView } from '../service/workbench-workspace-tree-controller.js';
import type { WorkbenchLayoutView } from '../service/workbench-layout-service.js';
import type { WorkbenchApplicationView } from '../service/workbench-page-interaction-service.js';

export interface WorkbenchShellView<
  ManagementSection extends string,
  RegistrationContext,
  NodeRegistrationContext
> {
  readonly application: WorkbenchApplicationView<ManagementSection>;
  readonly files: WorkbenchFilesView;
  readonly hosted: WorkbenchHostedView;
  readonly identity: WorkbenchIdentityView;
  readonly interactions: WorkbenchInteractionsView;
  readonly layout: WorkbenchLayoutView;
  readonly notifications: WorkbenchNotificationsView;
  readonly registration: WorkbenchRegistrationView<RegistrationContext>;
  readonly resources: WorkbenchResourcesView;
  readonly selection: WorkbenchSelectionView;
  readonly sessionList: WorkbenchSessionListView;
  readonly tree: WorkbenchTreeView;
  readonly uploads: WorkbenchUploadsView;
}

export interface WorkbenchSurfaceView<
  ManagementSection extends string,
  RegistrationContext,
  NodeRegistrationContext
> {
  readonly application: WorkbenchApplicationView<ManagementSection>;
  readonly aside: WorkbenchAsideView;
  readonly files: WorkbenchFilesView;
  readonly hosted: WorkbenchHostedView;
  readonly identity: WorkbenchIdentityView;
  readonly interactions: WorkbenchInteractionsView;
  readonly layout: WorkbenchLayoutView;
  readonly mainPaneController: WorkspaceSessionPaneView;
  readonly notifications: WorkbenchNotificationsView;
  readonly registration: WorkbenchRegistrationView<RegistrationContext>;
  readonly resources: WorkbenchResourcesView;
  readonly selection: WorkbenchSelectionView;
  readonly sessionList: WorkbenchSessionListView;
  readonly settings: WorkbenchSettingsView<NodeRegistrationContext>;
  readonly terminal: WorkbenchTerminalView;
}
