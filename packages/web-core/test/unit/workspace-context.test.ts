import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { createWorkbenchWorkspaceContext } from '../../src/service/workspace-context-service.js';
import type {
  NodeSummary,
  NodeWorkbenchManifest,
  Workspace,
  WorkspaceTarget
} from '../../src/model/workbench.js';

describe('Workspace context without Pane construction', () => {
  it('derives selection and readiness directly from resource owners, including revocation and recovery', () => {
    const workspaceTarget = ref<WorkspaceTarget>();
    const nodes = ref<NodeSummary[]>([
      {
        id: 'node-a',
        displayName: 'Fixture',
        registeredAddress: 'fixture.invalid',
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.10.1',
        nodeVersion: '24',
        connected: true,
        disabled: false,
        capabilities: {}
      }
    ]);
    const workspaces = ref<Workspace[]>([{ id: 'workspace-a', path: '/a', kind: 'DIRECTORY' }]);
    const nodeManifest = ref<NodeWorkbenchManifest>({
      manifestVersion: 1,
      observedAt: 1,
      conversation: { available: true, reasonCode: null },
      files: { available: true, reasonCode: null },
      terminal: {
        available: true,
        reasonCode: null,
        supportsReplay: true,
        supportsConPty: false,
        supportsTakeover: false,
        profiles: []
      }
    });
    const context = createWorkbenchWorkspaceContext({
      workspaceTarget,
      nodes,
      workspaces,
      nodeManifest
    });
    expect(context.selectedWorkspace.value).toBeUndefined();
    expect(context.nodeReady.value).toBe(false);
    workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    expect(context.selectedWorkspace.value?.path).toBe('/a');
    expect([
      context.nodeReady.value,
      context.filesReady.value,
      context.terminalReady.value
    ]).toEqual([true, true, true]);
    nodes.value = [{ ...nodes.value[0]!, disabled: true }];
    expect([
      context.nodeReady.value,
      context.filesReady.value,
      context.terminalReady.value
    ]).toEqual([false, false, false]);
    nodes.value = [{ ...nodes.value[0]!, disabled: false, connected: false }];
    expect(context.nodeReady.value).toBe(false);
    nodes.value = [{ ...nodes.value[0]!, connected: true }];
    expect(context.nodeReady.value).toBe(true);
    nodeManifest.value = {
      ...nodeManifest.value,
      terminal: { ...nodeManifest.value.terminal!, supportsReplay: false }
    };
    expect(context.terminalReady.value).toBe(false);
    expect(context.filesReady.value).toBe(true);
    workspaces.value = [{ ...workspaces.value[0]!, path: '/updated' }];
    expect(context.selectedWorkspace.value?.path).toBe('/updated');
    workspaceTarget.value = undefined;
    expect(context.workspaceHost.value).toBeUndefined();
    expect(context.selectedWorkspace.value).toBeUndefined();
    expect(context.filesReady.value).toBe(false);
  });
});
