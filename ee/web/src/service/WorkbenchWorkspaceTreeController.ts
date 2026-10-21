import type { Ref } from 'vue';
import type { WorkbenchView } from '../model/workbench.js';
import {
  createWorkbenchWorkspaceTreeController as createCore,
  type WorkbenchWorkspaceTreeControllerOptions as CoreOptions
} from '@myagentroam/web-core/workspace-tree-controller';

export interface WorkbenchWorkspaceTreeControllerOptions extends Omit<
  CoreOptions,
  'showWorkbench'
> {
  readonly view: Ref<WorkbenchView>;
}

export function createWorkbenchWorkspaceTreeController(
  options: WorkbenchWorkspaceTreeControllerOptions
) {
  const { view, ...common } = options;
  return createCore({
    ...common,
    showWorkbench: () => {
      view.value = 'nodes';
    }
  });
}
