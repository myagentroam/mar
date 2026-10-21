import { workspaceTargetRef } from './support/workspace-fixture.js';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchCapabilityService } from '../../src/service/WorkbenchCapabilityService.js';
import type { NodeSummary, NodeWorkbenchManifest } from '../../src/model/workbench.js';

function state(
  request: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>>,
  onNodeConnected = vi.fn<(nodeId: string) => void>()
) {
  const manifest = ref<NodeWorkbenchManifest>();
  const manifestLoading = ref(false);
  const serverVersion = ref('');
  const selectedNodeId = ref<string | undefined>('node');
  const nodes = ref<NodeSummary[]>([]);
  const service = createWorkbenchCapabilityService({
    nodes,
    manifest,
    manifestLoading,
    serverVersion,
    workspaceTarget: workspaceTargetRef(selectedNodeId),
    onNodeConnected,
    request: async <T>(path: string, init?: RequestInit) => (await request(path, init)) as T,
    notice: vi.fn(),
    errorMessage: String
  });
  return {
    service,
    nodes,
    onNodeConnected,
    manifest,
    manifestLoading,
    serverVersion,
    selectedNodeId
  };
}

describe('Public workbench capabilities', () => {
  it('reconciles a missed offline-to-online transition from the authoritative Node list', async () => {
    const node: NodeSummary = {
      id: 'node',
      displayName: null,
      registeredAddress: 'localhost',
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.9.73',
      nodeVersion: '0.9.73',
      connected: true,
      disabled: false,
      capabilities: {}
    };
    const request = vi.fn().mockResolvedValue({
      nodes: [node]
    });
    const current = state(request);
    current.nodes.value = [{ ...node, connected: false }];

    await current.service.refreshNodes();
    expect(current.nodes.value[0]).toMatchObject({ connected: true, nodeAppVersion: '0.9.73' });
    expect(current.onNodeConnected).toHaveBeenCalledExactlyOnceWith('node');
    await current.service.refreshNodes();
    expect(current.onNodeConnected).toHaveBeenCalledTimes(1);
  });

  it('ignores an older Node list arriving after reconnect reconciliation', async () => {
    let resolveOld!: (value: unknown) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce({ nodes: [] });
    const current = state(request);
    const old = current.service.refreshNodes();
    await current.service.refreshNodes();
    resolveOld({
      nodes: [{ id: 'node', connected: false }]
    });
    await old;
    expect(current.nodes.value).toEqual([]);
    expect(current.onNodeConnected).not.toHaveBeenCalled();
  });

  it('restores each Node manifest independently during background revalidation and prunes closed tabs', async () => {
    let completeRefresh!: (value: { manifest: NodeWorkbenchManifest }) => void;
    const request = vi.fn();
    const current = state(request);
    const first = { manifestVersion: 1 } as NodeWorkbenchManifest;
    const other = { manifestVersion: 1, files: { available: true } } as NodeWorkbenchManifest;
    const second = { manifestVersion: 1, files: { available: false } } as NodeWorkbenchManifest;
    request.mockResolvedValueOnce({ manifest: first });
    await current.service.refreshNodeManifest('node');
    current.selectedNodeId.value = 'other';
    request.mockResolvedValueOnce({ manifest: other });
    await current.service.refreshNodeManifest('other');
    current.selectedNodeId.value = 'node';
    current.manifest.value = current.service.restoreNodeManifest('node');
    expect(current.manifest.value).toEqual(first);
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeRefresh = resolve;
        })
    );
    const pending = current.service.refreshNodeManifest('node');
    expect(current.manifestLoading.value).toBe(false);
    expect(current.manifest.value).toEqual(first);
    completeRefresh({ manifest: second });
    await pending;
    expect(current.manifest.value).toEqual(second);
    expect(current.service.restoreNodeManifest('other')).toEqual(other);
    current.service.retainNodeManifests(new Set(['node']));
    expect(current.service.restoreNodeManifest('other')).toBeUndefined();
    expect(current.service.restoreNodeManifest('node')).toEqual(second);
  });

  it('discards a failed authoritative refresh and the selected cached manifest', async () => {
    const request = vi.fn().mockResolvedValueOnce({ manifest: { manifestVersion: 1 } });
    const current = state(request);
    await current.service.refreshNodeManifest('node');
    expect(current.service.restoreNodeManifest('node')).toBeDefined();
    request.mockRejectedValueOnce(new Error('offline'));
    await current.service.refreshNodeManifest('node');
    expect(current.service.restoreNodeManifest('node')).toBeUndefined();
    expect(current.manifest.value).toBeUndefined();
    expect(current.manifestLoading.value).toBe(false);
  });

  it('does not discard a newer cached manifest when an older refresh fails', async () => {
    let rejectOld!: (error: Error) => void;
    const request = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectOld = reject;
        })
    );
    const current = state(request);
    const oldRequest = current.service.refreshNodeManifest('node');
    const latest = { manifestVersion: 1 } as NodeWorkbenchManifest;
    request.mockResolvedValueOnce({ manifest: latest });
    await current.service.refreshNodeManifest('node');
    rejectOld(new Error('stale'));
    await oldRequest;
    expect(current.service.restoreNodeManifest('node')).toEqual(latest);
    expect(current.manifest.value).toEqual(latest);
    expect(current.manifestLoading.value).toBe(false);
  });

  it.each([false, true])('ignores an old manifest response (failure: %s)', async (failure) => {
    const pendingRequests: Array<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }> = [];
    const request = vi.fn(
      () =>
        new Promise((yes, no) => {
          pendingRequests.push({ resolve: yes, reject: no });
        })
    );
    const current = state(request);
    const pending = current.service.refreshNodeManifest('node');
    expect(current.manifestLoading.value).toBe(true);
    const latest = current.service.refreshNodeManifest('node');
    if (failure) pendingRequests[0]?.reject(new Error('offline'));
    else pendingRequests[0]?.resolve({ manifest: { manifestVersion: 1 } });
    await pending;
    expect(current.manifest.value).toBeUndefined();
    expect(current.manifestLoading.value).toBe(true);
    pendingRequests[1]?.resolve({ manifest: { manifestVersion: 1 } });
    await latest;
    expect(current.manifest.value).toEqual({ manifestVersion: 1 });
    expect(current.manifestLoading.value).toBe(false);
  });

  it('does not restore a manifest from a request invalidated by Node disconnection', async () => {
    let resolveRequest!: (value: unknown) => void;
    const current = state(
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          })
      )
    );
    const pending = current.service.refreshNodeManifest('node');
    expect(current.manifestLoading.value).toBe(true);

    current.service.invalidateNodeManifest('node');
    expect(current.manifest.value).toBeUndefined();
    expect(current.manifestLoading.value).toBe(false);

    resolveRequest({ manifest: { manifestVersion: 1 } });
    await pending;
    expect(current.service.restoreNodeManifest('node')).toBeUndefined();
    expect(current.manifest.value).toBeUndefined();
    expect(current.manifestLoading.value).toBe(false);
  });

  it('settles the current failed manifest request without stale capabilities', async () => {
    const current = state(vi.fn().mockRejectedValue(new Error('offline')));
    current.manifest.value = { manifestVersion: 1 } as NodeWorkbenchManifest;
    await current.service.refreshNodeManifest('node');
    expect(current.manifest.value).toBeUndefined();
    expect(current.manifestLoading.value).toBe(false);
  });

  it.each([
    ['0.9.63', 'v0.9.63'],
    ['V0.9.63', 'v0.9.63'],
    ['', ''],
    [42, '']
  ])('normalizes Server version %s', async (serverVersion, expected) => {
    const current = state(vi.fn().mockResolvedValue({ serverVersion }));
    await current.service.refreshServerCapabilities();
    expect(current.serverVersion.value).toBe(expected);
  });
});
