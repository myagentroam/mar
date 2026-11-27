import { describe, expect, it, vi } from 'vitest';
import {
  encodeNodeStreamFrame,
  type NodeStreamFrame
} from '@myagentroam/protocol/node-stream-wire';
import { NodeStreamRelay } from '../../src/node-stream-relay.js';

describe('Node stream relay', () => {
  it('forwards the final FIN before the authorization owner can observe it as revocation', async () => {
    const node = vi.fn<(frame: NodeStreamFrame) => void>();
    const client = vi.fn<(frame: NodeStreamFrame) => void>();
    const onEnd = vi.fn();
    const owner = new AbortController();
    const relay = new NodeStreamRelay(node, { perClient: 1, perNode: 1 });
    const port = relay.attachClient(client, async (_request, signal) => {
      signal.addEventListener('abort', () => owner.abort(), { once: true });
      return { grant: 'node-grant', revoked: owner.signal, onEnd };
    });
    port.receive(
      encodeNodeStreamFrame({ type: 'OPEN', kind: 'file-upload', grant: 'ticket', streamId: 1 })
    );
    await vi.waitFor(() =>
      expect(node).toHaveBeenCalledWith({
        type: 'OPEN',
        kind: 'file-upload',
        grant: 'node-grant',
        streamId: 1
      })
    );
    relay.receiveNode(encodeNodeStreamFrame({ type: 'OPENED', streamId: 1 }));
    port.receive(encodeNodeStreamFrame({ type: 'FIN', streamId: 1 }));
    relay.receiveNode(encodeNodeStreamFrame({ type: 'FIN', streamId: 1 }));
    expect(owner.signal.aborted).toBe(true);
    expect(client.mock.calls.map(([frame]) => frame.type)).toEqual(['OPENED', 'FIN']);
    expect(node.mock.calls.map(([frame]) => frame.type)).toEqual(['OPEN', 'FIN']);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(undefined);
    relay.close();
  });

  it('resets only the revoked stream, leaving the carrier usable', async () => {
    const node = vi.fn<(frame: NodeStreamFrame) => void>();
    const client = vi.fn<(frame: NodeStreamFrame) => void>();
    const owner = new AbortController();
    const relay = new NodeStreamRelay(node, { perClient: 2, perNode: 2 });
    const port = relay.attachClient(client, async ({ grant }) =>
      grant === 'revocable' ? { grant, revoked: owner.signal } : { grant }
    );
    port.receive(
      encodeNodeStreamFrame({
        type: 'OPEN',
        kind: 'file-download',
        grant: 'revocable',
        streamId: 1
      })
    );
    port.receive(
      encodeNodeStreamFrame({ type: 'OPEN', kind: 'terminal', grant: 'terminal', streamId: 2 })
    );
    await vi.waitFor(() => expect(node).toHaveBeenCalledTimes(2));
    relay.receiveNode(encodeNodeStreamFrame({ type: 'OPENED', streamId: 1 }));
    relay.receiveNode(encodeNodeStreamFrame({ type: 'OPENED', streamId: 2 }));
    owner.abort();
    const reset = { type: 'RESET', streamId: 1, code: 'RESOURCE_DENIED' };
    expect(node).toHaveBeenLastCalledWith(reset);
    expect(client).toHaveBeenLastCalledWith(reset);
    const data = { type: 'DATA', streamId: 2, bytes: Uint8Array.of(1) } as const;
    relay.receiveNode(encodeNodeStreamFrame(data));
    expect(client).toHaveBeenLastCalledWith(data);
    relay.close();
  });

  it('maps the same stream ID from two client carriers to distinct Node IDs', async () => {
    const node = vi.fn<(frame: NodeStreamFrame) => void>();
    const first = vi.fn<(frame: NodeStreamFrame) => void>();
    const second = vi.fn<(frame: NodeStreamFrame) => void>();
    const relay = new NodeStreamRelay(node, { perClient: 1, perNode: 2 });
    const authorize = async () => ({ grant: 'node-grant' });
    const request = encodeNodeStreamFrame({
      type: 'OPEN',
      kind: 'file-download',
      grant: 'ticket',
      streamId: 1
    });
    relay.attachClient(first, authorize).receive(request);
    relay.attachClient(second, authorize).receive(request);
    await vi.waitFor(() => expect(node).toHaveBeenCalledTimes(2));
    expect(node.mock.calls.map(([frame]) => frame.streamId)).toEqual([1, 2]);
    relay.receiveNode(encodeNodeStreamFrame({ type: 'OPENED', streamId: 2 }));
    expect(second).toHaveBeenCalledExactlyOnceWith({ type: 'OPENED', streamId: 1 });
    expect(first).not.toHaveBeenCalled();
    relay.close();
  });
});
