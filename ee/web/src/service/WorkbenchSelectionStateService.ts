import { createWorkbenchSelectionStateService as createSharedSelection } from '@myagentroam/web-core/selection-state';
import type { Workspace } from '../model/workbench.js';

export function createWorkbenchSelectionStateService() {
  return createSharedSelection<Workspace>();
}
