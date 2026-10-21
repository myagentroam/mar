import { customRef, type Ref } from 'vue';
import type { WorkspaceTarget } from '../../../src/model/workbench.js';

/** Gives existing controller fixtures one stable identity, including plain value-ref inputs. */
export function workspaceTargetRef(
  nodeId: { readonly value: string | undefined },
  workspaceId?: { readonly value: string | undefined }
): Readonly<Ref<WorkspaceTarget | undefined>> {
  let current: WorkspaceTarget | undefined;
  return customRef((track) => ({
    get() {
      track();
      const host = nodeId.value;
      const workspace = workspaceId?.value ?? (workspaceId === undefined ? 'workspace' : undefined);
      if (host === undefined || workspace === undefined) current = undefined;
      else if (current?.nodeId !== host || current.workspaceId !== workspace)
        current = { nodeId: host, workspaceId: workspace };
      return current;
    },
    set() {
      throw new Error('Use the fixture routing inputs');
    }
  }));
}
