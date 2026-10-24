import { createWorkbenchPageStateService } from '@myagentroam/web-core/base-state';
import type { Workspace } from '../model/workbench.js';
import { createWorkbenchNavigationService } from './workbench-navigation-service.js';

export function createWorkbenchBaseStateService(options: {
  readonly sessionPageSize: number;
  readonly onUnauthenticated: () => void;
}) {
  const navigation = createWorkbenchNavigationService();
  return createWorkbenchPageStateService<typeof navigation, Workspace>({ ...options, navigation });
}
