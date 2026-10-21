import { describe, expect, it, vi } from 'vitest';
import { ElMessageBox } from 'element-plus';
import { createResourceHostingService } from '../../src/service/ResourceHostingService.js';
vi.mock('element-plus', () => ({
  ElMessageBox: { confirm: vi.fn(async () => 'confirm') },
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() }
}));
import {
  conversationHostingEnablementAvailability,
  conversationHostingDisablementAvailability,
  createConversationHostingEnablementService
} from '../../src/service/ConversationHostingEnablementService.js';

const input = {
  platform: 'linux',
  connected: true,
  disabled: false,
  writable: true,
  capability: {
    state: 'DISABLED',
    apiVersion: 1,
    acceptsNewConversations: false,
    supportsExistingConversations: false,
    capacity: 'AVAILABLE'
  }
} as const;

describe('public hosting management', () => {
  it('does not submit after management becomes read-only while confirmation is open', async () => {
    let confirm!: () => void;
    vi.mocked(ElMessageBox.confirm).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = () => resolve('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>);
        })
    );
    let writable = true;
    const request = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return { capability: input.capability };
    });
    const service = createResourceHostingService(
      <T>(path: string, init?: RequestInit) => request(path, init) as Promise<T>,
      () => ({ writable })
    );
    const row = {
      ...input,
      resourceType: 'NODE',
      nodeId: 'node-1',
      capabilities: { conversationHosting: input.capability }
    } as never;
    const pending = service.enable(row, vi.fn());
    writable = false;
    confirm();
    await pending;
    expect(request).not.toHaveBeenCalled();
    expect(service.describe(row)?.changing).toBe(false);
  });

  it('allows personal hosting without organization or License input', () => {
    expect(conversationHostingEnablementAvailability(input)).toEqual({
      enabled: false,
      canEnable: true
    });
    for (const changes of [
      { platform: 'win32' },
      { connected: false },
      { disabled: true },
      { writable: false }
    ])
      expect(conversationHostingEnablementAvailability({ ...input, ...changes }).canEnable).toBe(
        false
      );
  });
  it('keeps the capability, platform, connection, and read-only disable policy', () => {
    const enabled = { ...input, capability: { ...input.capability, state: 'AVAILABLE' as const } };
    expect(conversationHostingDisablementAvailability(enabled).canDisable).toBe(true);
    expect(
      conversationHostingDisablementAvailability({ ...enabled, writable: false }).canDisable
    ).toBe(false);
    expect(
      conversationHostingDisablementAvailability({ ...enabled, platform: 'win32' }).canDisable
    ).toBe(false);
  });
  it('sends only fixed strict enable and disable inputs', async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return { capability: input.capability };
    });
    const service = createConversationHostingEnablementService(
      <T>(path: string, init?: RequestInit) => request(path, init) as Promise<T>
    );
    await service.enable('node-1');
    await service.disable('node-1');
    expect(request.mock.calls).toEqual([
      [
        '/api/management/nodes/node-1/conversation-hosting/enable',
        { method: 'POST', body: '{"enabled":true}' }
      ],
      ['/api/management/nodes/node-1/conversation-hosting/disable', { method: 'POST', body: '{}' }]
    ]);
  });
});
