import { describe, expect, it, vi } from 'vitest';
import type { HostedConversationSnapshot } from '@myagentroam/protocol';
import { createHostedConversationSelectionService } from '../../src/service/HostedConversationSelectionService.js';

function fixture() {
  const events: string[] = [];
  const begin = vi.fn(async () => {
    events.push('begin');
  });
  const service = createHostedConversationSelectionService({
    workspace: {
      selectConversation: vi.fn((node: string, conversation: string) => {
        events.push(`select:${node}:${conversation}`);
      }),
      clearSelectedConversation: () => events.push('clear')
    },
    markRead: (node, conversation) => events.push(`read:${node}:${conversation}`),
    coordinator: () => ({
      beginHostedConversation: begin,
      stopHostedConversation: () => events.push('stop')
    })
  });
  return { service, events, begin };
}

describe('Hosted conversation selection', () => {
  it('passes a newly created conversation snapshot unchanged without requiring a coordinator', async () => {
    const snapshot: HostedConversationSnapshot = {
      conversation: {
        id: 'c',
        nodeId: 'n',
        sessionId: 's',
        templateId: 't',
        templateName: 'Template',
        activeVersionId: 'v',
        title: 'New conversation',
        titleSource: 'DEFAULT',
        pinnedAt: null,
        status: 'ACTIVE',
        modelId: 'm',
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
        activity: { status: 'IDLE', updatedAt: 1, version: 1 }
      },
      template: {
        id: 't',
        nodeId: 'n',
        name: 'Template',
        description: '',
        status: 'ACTIVE',
        currentVersionId: 'v',
        available: true,
        createdAt: 1,
        updatedAt: 1
      },
      run: null,
      turns: [],
      historyNextCursor: null,
      files: [],
      models: [],
      error: null,
      snapshotSequence: 0
    };
    const selectConversation = vi.fn();
    const markRead = vi.fn();
    const service = createHostedConversationSelectionService({
      workspace: { selectConversation, clearSelectedConversation: vi.fn() },
      markRead,
      coordinator: () => undefined
    });
    await service.select(snapshot.conversation, snapshot);
    expect(selectConversation).toHaveBeenCalledExactlyOnceWith('n', 'c', snapshot);
    expect(markRead).toHaveBeenCalledExactlyOnceWith('n', 'c');
    expect(() => service.clear()).not.toThrow();
  });

  it('uses the same ordered selection, read and Watch path for a direct target', async () => {
    const { service, events } = fixture();
    await service.openTarget('node', 'conversation');
    expect(events).toEqual(['select:node:conversation', 'read:node:conversation', 'begin']);
  });

  it('preserves direct selection failures for the caller', async () => {
    const { service, begin, events } = fixture();
    const error = new Error('watch failed');
    begin.mockRejectedValueOnce(error);
    await expect(service.openTarget('node', 'conversation')).rejects.toBe(error);
    expect(events).not.toContain('clear');
  });

  it('clears an invalid restored target and synchronizes its route', async () => {
    const { service, begin, events } = fixture();
    begin.mockRejectedValueOnce(new Error('not available'));
    await service.restoreTarget({ nodeId: 'n', conversationId: 'c' }, () => events.push('sync'));
    expect(events).toEqual(['select:n:c', 'read:n:c', 'stop', 'clear', 'sync']);
  });

  it('does not clear a newer selection when route restoration fails late', async () => {
    const { service, begin, events } = fixture();
    let reject!: (error: Error) => void;
    begin.mockImplementationOnce(() => new Promise<void>((_, fail) => (reject = fail)));
    const sync = vi.fn();
    const restoring = service.restoreTarget({ nodeId: 'old', conversationId: 'old' }, sync);
    await service.openTarget('new', 'new');
    reject(new Error('old request failed'));
    await restoring;
    expect(events).not.toContain('clear');
    expect(sync).not.toHaveBeenCalled();
  });

  it('invalidates a pending restore when selection is explicitly cleared', async () => {
    const { service, begin, events } = fixture();
    let reject!: (error: Error) => void;
    begin.mockImplementationOnce(() => new Promise<void>((_, fail) => (reject = fail)));
    const sync = vi.fn();
    const restoring = service.restoreTarget({ nodeId: 'n', conversationId: 'c' }, sync);
    service.clear();
    reject(new Error('cancelled'));
    await restoring;
    expect(events.filter((event) => event === 'clear')).toHaveLength(1);
    expect(sync).not.toHaveBeenCalled();
  });
});
