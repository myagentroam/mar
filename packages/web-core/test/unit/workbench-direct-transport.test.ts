import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeWorkbenchManifest } from '../../src/model/workbench.js';
import { createWorkbenchDirectTransportCoordinator } from '../../src/service/WorkbenchDirectTransportCoordinator.js';
import { createTerminalDirectClient } from '../../src/service/TerminalDirectClient.js';

const clients = vi.hoisted(() => ({
  workspace: {
    ensureTransport: vi.fn(),
    invalidateNode: vi.fn(),
    invalidateControlConnection: vi.fn(),
    invalidateNetwork: vi.fn(),
    releaseTransport: vi.fn(),
    transportNodeIds: vi.fn((): string[] => []),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    networkInfo: vi.fn(),
    acquireTerminalTransport: vi.fn(),
    upload: vi.fn(),
    download: vi.fn(),
    handle: vi.fn()
  },
  terminal: { invalidate: vi.fn(), handle: vi.fn(), attach: vi.fn() }
}));
vi.mock('../../src/service/WorkspaceDirectTransferService.js', () => ({
  createWorkspaceDirectTransferService: vi.fn(() => clients.workspace)
}));
vi.mock('../../src/service/TerminalDirectClient.js', () => ({
  createTerminalDirectClient: vi.fn(() => clients.terminal)
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function manifest(generation = 'generation'): NodeWorkbenchManifest {
  return {
    nodeGeneration: generation,
    directTransfer: { apiVersion: 3, transport: true },
    terminalDirect: { apiVersion: 1 }
  } as NodeWorkbenchManifest;
}
function fixture() {
  const nodes = [
    { id: 'one', connected: true, disabled: false },
    { id: 'two', connected: true, disabled: false }
  ];
  const discover = vi.fn(async (_nodeId: string): Promise<NodeWorkbenchManifest | undefined> =>
    manifest()
  );
  const changed = vi.fn();
  const coordinator = createWorkbenchDirectTransportCoordinator({
    nodes: () => nodes,
    discover,
    sendDirect: () => true,
    sendTerminalDirect: () => true,
    onChange: changed
  });
  return { coordinator, nodes, discover, changed };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Workbench direct transport coordination', () => {
  it('waits for ready, coalesces discovery and ignores inactive Nodes', async () => {
    const f = fixture();
    f.coordinator.selectNode('one');
    expect(f.discover).not.toHaveBeenCalled();
    const pending = deferred<NodeWorkbenchManifest>();
    f.discover.mockReturnValue(pending.promise);
    f.coordinator.connectionReady('connection', false);
    const task = f.coordinator.refresh('one');
    await Promise.resolve();
    expect(f.discover).toHaveBeenCalledTimes(1);
    pending.resolve(manifest());
    await task;
    expect(clients.workspace.ensureTransport).toHaveBeenCalledWith('one', 'generation');
    expect(f.coordinator.isConnected('one')).toBe(true);
    expect(f.coordinator.isConnected('two')).toBe(false);
    f.coordinator.dispose();
  });

  it('does not let an old finally remove a replacement request or apply stale capabilities', async () => {
    const f = fixture();
    const old = deferred<NodeWorkbenchManifest>();
    const next = deferred<NodeWorkbenchManifest>();
    f.discover.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    f.coordinator.selectNode('one');
    f.coordinator.connectionReady('connection', false);
    await Promise.resolve();
    const replacement = f.coordinator.refresh('one', true);
    await Promise.resolve();
    old.resolve(manifest('old'));
    await Promise.resolve();
    await Promise.resolve();
    const shared = f.coordinator.refresh('one');
    await Promise.resolve();
    expect(f.discover).toHaveBeenCalledTimes(2);
    next.resolve(manifest('new'));
    await Promise.all([replacement, shared]);
    expect(clients.workspace.ensureTransport.mock.calls).toEqual([['one', 'new']]);
    f.coordinator.dispose();
  });

  it.each(['lost', 'reset', 'dispose'] as const)(
    'rejects capability responses after %s',
    async (action) => {
      const f = fixture();
      const pending = deferred<NodeWorkbenchManifest>();
      f.discover.mockReturnValue(pending.promise);
      f.coordinator.selectNode('one');
      f.coordinator.connectionReady('old', false);
      await Promise.resolve();
      if (action === 'lost') f.coordinator.connectionLost();
      else if (action === 'reset') f.coordinator.reset();
      else f.coordinator.dispose();
      pending.resolve(manifest());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(clients.workspace.ensureTransport).not.toHaveBeenCalled();
      expect(f.coordinator.isConnected('one')).toBe(false);
      f.coordinator.dispose();
    }
  );

  it('can log in again after reset but never after dispose', async () => {
    const f = fixture();
    f.coordinator.selectNode('one');
    f.coordinator.connectionReady('first', false);
    await f.coordinator.refresh('one');
    f.coordinator.reset();
    f.coordinator.selectNode('one');
    f.coordinator.connectionReady('second', true);
    await f.coordinator.refresh('one');
    expect(clients.workspace.ensureTransport).toHaveBeenCalledTimes(2);
    f.coordinator.dispose();
    f.coordinator.selectNode('one');
    f.coordinator.connectionReady('third', false);
    await f.coordinator.refresh('one');
    expect(clients.workspace.ensureTransport).toHaveBeenCalledTimes(2);
  });

  it('releases only the expired Node and keeps the selected Node active', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.coordinator.selectNode('one');
    f.coordinator.connectionReady('connection', false);
    await f.coordinator.refresh('one');
    f.coordinator.selectNode('two');
    await f.coordinator.refresh('two');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(clients.workspace.releaseTransport).toHaveBeenCalledWith('one');
    expect(f.coordinator.isConnected('one')).toBe(false);
    expect(f.coordinator.isConnected('two')).toBe(true);
    f.coordinator.nodeInvalidated('one');
    expect(clients.workspace.invalidateNode).toHaveBeenCalledWith('one');
    expect(clients.terminal.invalidate).toHaveBeenCalledTimes(1); // Initial non-resumed ready only.
    f.coordinator.dispose();
  });

  it.each(['disabled', 'removed'] as const)(
    'invalidates an expired but retained transport when its Node is %s',
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      f.coordinator.selectNode('one');
      f.coordinator.connectionReady('connection', false);
      await f.coordinator.refresh('one');
      f.coordinator.selectNode('two');
      await f.coordinator.refresh('two');
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(clients.workspace.releaseTransport).toHaveBeenCalledWith('one');
      // A running file task or Terminal reference defers the underlying release.
      clients.workspace.transportNodeIds.mockReturnValueOnce(['one', 'two']);
      if (reason === 'disabled') f.nodes[0]!.disabled = true;
      else f.nodes.splice(0, 1);
      await f.coordinator.reconcileNodes();
      expect(clients.workspace.invalidateNode).toHaveBeenCalledWith('one');
      expect(clients.workspace.invalidateNode).not.toHaveBeenCalledWith('two');
      expect(f.coordinator.isConnected('two')).toBe(true);
      expect(clients.terminal.invalidate).toHaveBeenCalledTimes(1);
      f.coordinator.dispose();
    }
  );

  it('rejects an old response after the replacement has already connected', async () => {
    const f = fixture();
    const old = deferred<NodeWorkbenchManifest>();
    f.discover.mockReturnValueOnce(old.promise).mockResolvedValueOnce(manifest('new'));
    f.coordinator.selectNode('one');
    f.coordinator.connectionReady('connection', false);
    await Promise.resolve();
    await f.coordinator.refresh('one', true);
    old.resolve(manifest('old'));
    await Promise.resolve();
    await Promise.resolve();
    expect(clients.workspace.ensureTransport.mock.calls).toEqual([['one', 'new']]);
    f.coordinator.dispose();
  });

  it.each(['missing', 'failed', 'disabled', 'removed'] as const)(
    'clears unusable Node capabilities: %s',
    async (reason) => {
      const f = fixture();
      f.coordinator.selectNode('one');
      f.coordinator.connectionReady('connection', false);
      await f.coordinator.refresh('one');
      expect(f.coordinator.isConnected('one')).toBe(true);
      if (reason === 'missing') f.discover.mockResolvedValue(undefined);
      if (reason === 'failed') f.discover.mockRejectedValue(new Error('UNAVAILABLE'));
      if (reason === 'disabled') f.nodes[0]!.disabled = true;
      if (reason === 'removed') f.nodes.splice(0, 1);
      if (reason === 'disabled' || reason === 'removed') await f.coordinator.reconcileNodes();
      else await f.coordinator.refresh('one', true);
      expect(f.coordinator.isConnected('one')).toBe(false);
      expect(clients.workspace.invalidateNode).toHaveBeenCalledWith('one');
      f.coordinator.dispose();
    }
  );

  it('does not continue an old batch after reconnecting with the same connection ID', async () => {
    const f = fixture();
    f.nodes.push(...['three', 'four'].map((id) => ({ id, connected: true, disabled: false })));
    for (const node of f.nodes) f.coordinator.selectNode(node.id);
    const pending = deferred<NodeWorkbenchManifest>();
    f.discover.mockReturnValue(pending.promise);
    f.coordinator.connectionReady('connection', false);
    await Promise.resolve();
    expect(f.discover).toHaveBeenCalledTimes(3);
    f.coordinator.connectionLost();
    f.coordinator.connectionReady('connection', true);
    await Promise.resolve();
    pending.resolve(manifest());
    await vi.waitFor(() => expect(f.discover).toHaveBeenCalledTimes(7));
    // Only the new batch may continue to Node four.
    expect(f.discover.mock.calls.filter(([id]) => id === 'four')).toHaveLength(1);
    f.coordinator.dispose();
  });

  it('fences old capabilities on a non-resumed ready even with the same connection ID', async () => {
    const f = fixture();
    const old = deferred<NodeWorkbenchManifest>();
    const next = deferred<NodeWorkbenchManifest>();
    f.discover.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    f.coordinator.selectNode('one');
    f.coordinator.connectionReady('connection', false);
    await Promise.resolve();
    // A new logical connection need not have a different public identifier.
    f.coordinator.connectionReady('connection', false);
    await Promise.resolve();
    old.resolve(manifest('old'));
    await Promise.resolve();
    await Promise.resolve();
    expect(clients.workspace.ensureTransport).not.toHaveBeenCalled();
    expect(f.discover).toHaveBeenCalledTimes(2);
    next.resolve(manifest('new'));
    await f.coordinator.refresh('one');
    expect(clients.workspace.ensureTransport.mock.calls).toEqual([['one', 'new']]);
    f.coordinator.dispose();
  });

  it('makes repeated connection loss and dispose idempotent', () => {
    const f = fixture();
    f.coordinator.connectionReady('connection', false);
    f.coordinator.connectionLost();
    f.coordinator.connectionLost();
    expect(clients.workspace.invalidateControlConnection).toHaveBeenCalledTimes(1);
    f.coordinator.dispose();
    f.coordinator.dispose();
    expect(clients.workspace.close).toHaveBeenCalledTimes(1);
  });

  it('invalidates only one Node and prevents its new Terminal acquisitions', async () => {
    const f = fixture();
    const acquire = vi.mocked(createTerminalDirectClient).mock.calls.at(-1)![0].acquire;
    f.coordinator.selectNode('one');
    f.coordinator.connectionReady('connection', false);
    await f.coordinator.refresh('one');
    f.coordinator.selectNode('two');
    await f.coordinator.refresh('two');
    acquire('one');
    acquire('two');
    expect(clients.workspace.acquireTerminalTransport.mock.calls).toEqual([
      ['one', 'generation'],
      ['two', 'generation']
    ]);
    f.coordinator.nodeInvalidated('one');
    acquire('one');
    expect(clients.workspace.acquireTerminalTransport).toHaveBeenCalledTimes(2);
    expect(f.coordinator.isConnected('one')).toBe(false);
    expect(f.coordinator.isConnected('two')).toBe(true);
    // Other Nodes must not lose their active Terminal sessions.
    expect(clients.terminal.invalidate).toHaveBeenCalledTimes(1);
    await f.coordinator.refresh('one');
    acquire('one');
    expect(clients.workspace.acquireTerminalTransport).toHaveBeenCalledTimes(3);
    f.coordinator.dispose();
  });
});
