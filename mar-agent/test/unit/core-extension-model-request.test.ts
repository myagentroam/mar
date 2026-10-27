import { describe, expect, it, vi } from 'vitest';
import {
  ExtensionRequestBridge,
  ExtensionRequestSnapshots
} from '../../src/extensions/model-request.js';
import type { ModelRequest } from '../../src/model/contracts.js';

describe('Core neutral model request views', () => {
  it('stabilizes declaration fields changed only by middleware ordering without touching history', () => {
    const original: ModelRequest = {
      system: 'Stable.',
      messages: [{ role: 'user', content: 'History.' }],
      tools: ['zeta', 'alpha'].map((name) => ({
        name,
        description: 'Stable.',
        inputSchema: { type: 'object', additionalProperties: true }
      }))
    };
    const encoded = JSON.stringify(original);
    const bridge = new ExtensionRequestBridge('model', original);
    const lowered = bridge.lower({
      ...bridge.view,
      tools: [...bridge.view.tools].reverse().map((tool) => ({
        ...tool,
        inputSchema: { additionalProperties: true, type: 'object' }
      }))
    });
    expect(JSON.stringify(lowered.tools)).toBe(JSON.stringify(bridge.lower(bridge.view).tools));
    expect(JSON.stringify(bridge.view.tools)).toBe(JSON.stringify(original.tools));
    expect(lowered.messages[0]).toBe(original.messages[0]);
    expect(
      bridge
        .lower({ ...bridge.view, tools: [bridge.view.tools[1]!] })
        .tools.map((tool) => tool.name)
    ).toEqual(['alpha']);
    expect(JSON.stringify(original)).toBe(encoded);
  });

  it('retains dispatch data once and materializes a frozen public view only when read', () => {
    const snapshots = new ExtensionRequestSnapshots();
    const request: ModelRequest = {
      system: 'original system',
      tools: [],
      messages: [{ role: 'user', content: 'original message' }],
      onAttemptDiagnostic: () => undefined,
      onModelUsage: () => undefined,
      onModelUsageFailure: () => undefined,
      usageRequestId: 'original-request'
    };
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const snapshot = snapshots.record('model', request);
      expect(clone).toHaveBeenCalledTimes(1);
      snapshots.complete(snapshot);
      expect(snapshots.capture()).toBe(snapshot);
      expect(snapshots.capture({ completed: true })).toBe(snapshot);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(clone).toHaveBeenCalledTimes(1);
      request.system = 'changed system';
      request.messages[0]!.content = 'changed message';
      const view = snapshot.request;
      expect(clone.mock.calls.length).toBeGreaterThan(1);
      expect(view.system).toBe('original system');
      expect(view.messages[0]).toMatchObject({ content: 'original message' });
      expect(Object.isFrozen(view)).toBe(true);
      expect(Object.isFrozen(view.messages[0])).toBe(true);
      expect(view).not.toHaveProperty('onAttemptDiagnostic');
      clone.mockClear();
      expect(snapshot.request).toBe(view);
      expect(clone).not.toHaveBeenCalled();
      const resolved = snapshots.resolve(snapshot);
      expect(resolved.request).not.toHaveProperty('onModelUsage');
      expect(resolved.request).not.toHaveProperty('onModelUsageFailure');
      expect(resolved.request).not.toHaveProperty('usageRequestId');
      resolved.request.messages[0]!.content = 'changed fork';
      expect(snapshots.resolve(snapshot).request.messages[0]!.content).toBe('original message');
      expect(snapshot.request).toBe(view);
    } finally {
      clone.mockRestore();
    }
  });

  it.each([true, false, undefined])(
    'retains a source tool error marker %s when request middleware edits text',
    (isError) => {
      const bridge = new ExtensionRequestBridge('model', {
        system: '',
        tools: [],
        messages: [
          {
            role: 'tool',
            callId: 'call',
            name: 'probe',
            content: 'original',
            ...(isError === undefined ? {} : { isError })
          }
        ]
      });
      const original = bridge.view.messages[0]!;
      if (original.role === 'opaque') throw new Error('Expected a tool message.');
      const edited = { ...original, content: 'edited' };
      const { sourceRef: _sourceRef, ...unowned } = edited;
      const lowered = bridge.lower({ ...bridge.view, messages: [edited] }).messages[0]!;
      expect(lowered.content).toBe('edited');
      if (isError === undefined) expect(lowered).not.toHaveProperty('isError');
      else expect(lowered.isError).toBe(isError);
      for (const replacement of [
        unowned,
        { ...edited, role: 'user' as const },
        { ...edited, callId: 'other' },
        { ...edited, name: 'other' }
      ]) {
        expect(
          bridge.lower({ ...bridge.view, messages: [replacement] }).messages[0]
        ).not.toHaveProperty('isError');
      }
    }
  );

  it('reuses owned snapshot references while retaining opaque records and rejecting invalid selections', () => {
    const snapshots = new ExtensionRequestSnapshots();
    snapshots.record('model', {
      system: '',
      tools: [],
      messages: [
        { role: 'user', content: 'original' },
        {
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          item: { encrypted_content: 'private-context' }
        }
      ]
    });
    const snapshot = snapshots.capture()!;
    const resolved = snapshots.resolve(snapshot);
    const bridge = new ExtensionRequestBridge(
      resolved.modelId,
      resolved.request,
      resolved.view.messages
    );
    const opaque = snapshot.request.messages[1]!;
    expect(bridge.lower({ ...bridge.view, messages: [opaque] }).messages).toEqual([
      resolved.request.messages[1]
    ]);
    expect(JSON.stringify(bridge.view)).not.toContain('private-context');
    expect(() => bridge.lower({ ...bridge.view, messages: [opaque, opaque] })).toThrow(
      /REQUEST_INVALID/
    );
    expect(() =>
      bridge.lower({ ...bridge.view, messages: [{ ...opaque, sourceRef: 'foreign' }] })
    ).toThrow(/REQUEST_INVALID/);
    expect(() =>
      bridge.lower({
        ...bridge.view,
        messages: [{ ...opaque, role: 'opaque', extra: 'changed' } as unknown as typeof opaque]
      })
    ).toThrow(/REQUEST_INVALID/);
    const other = new ExtensionRequestBridge('model', resolved.request);
    expect(() => other.lower({ ...other.view, messages: [opaque] })).toThrow(/REQUEST_INVALID/);
  });

  it('lets request middleware remove optional candidate fields', () => {
    const bridge = new ExtensionRequestBridge('model', {
      system: 'system',
      messages: [],
      tools: [],
      toolChoice: 'none',
      reasoningEffort: 'high',
      images: [{ mimeType: 'image/png', dataBase64: 'eA==' }]
    });
    const { toolChoice: _choice, reasoningEffort: _effort, images: _images, ...view } = bridge.view;
    const lowered = bridge.lower(view);
    expect(lowered).not.toHaveProperty('toolChoice');
    expect(lowered).not.toHaveProperty('reasoningEffort');
    expect(lowered).not.toHaveProperty('images');
  });

  it('retains private context through opaque handles and never exposes provider payloads or callbacks', () => {
    const original: ModelRequest = {
      system: 'original',
      tools: [],
      onAttemptDiagnostic: () => {},
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'provider',
          content: '',
          provider: 'OPENAI_RESPONSES',
          item: { encrypted_content: 'private-context' }
        }
      ]
    };
    const bridge = new ExtensionRequestBridge('model', original);
    expect(JSON.stringify(bridge.view)).not.toContain('private-context');
    expect('onAttemptDiagnostic' in bridge.view).toBe(false);
    const lowered = bridge.lower({ ...bridge.view, system: 'changed' });
    expect(lowered.messages[1]).toBe(original.messages[1]);
    expect(lowered.onAttemptDiagnostic).toBe(original.onAttemptDiagnostic);
    expect(original.system).toBe('original');
  });

  it('changes only the candidate message view and rejects foreign references', () => {
    const original: ModelRequest = {
      system: '',
      tools: [],
      messages: [{ role: 'user', content: 'original' }]
    };
    const bridge = new ExtensionRequestBridge('model', original);
    const message = bridge.view.messages[0]!;
    expect(
      bridge.lower({
        ...bridge.view,
        messages: [{ ...message, role: 'user', content: 'candidate' }]
      }).messages[0]?.content
    ).toBe('candidate');
    expect(original.messages[0]?.content).toBe('original');
    expect(() =>
      bridge.lower({ ...bridge.view, messages: [{ role: 'opaque', sourceRef: 'foreign' }] })
    ).toThrow(/REQUEST_INVALID/);
  });
});
