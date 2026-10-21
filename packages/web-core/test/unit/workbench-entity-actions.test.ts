import { workspaceTargetRef } from './support/workspace-fixture.js';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const dialogs = vi.hoisted(() => ({ prompt: vi.fn(), confirm: vi.fn() }));
vi.mock('element-plus', () => ({ ElMessageBox: dialogs }));
import { createWorkbenchEntityService } from '../../src/service/WorkbenchEntityService.js';
import { createWorkbenchEntityController } from '../../src/service/WorkbenchEntityController.js';
import { ApiError } from '../../src/util/api-error.js';
import type { NodeSummary, Session } from '../../src/model/workbench.js';

const node = { id: 'node', displayName: 'before' } as NodeSummary;
function state(
  request: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>>
) {
  const loading = ref(false);
  const renewCsrfToken = vi.fn().mockResolvedValue('renewed');
  const notice = vi.fn();
  const canDeleteSession = vi.fn(() => true);
  const service = createWorkbenchEntityService({
    loading,
    workspaceTarget: workspaceTargetRef(ref('node')),
    request: async <T>(path: string, init?: RequestInit) => (await request(path, init)) as T,
    renewCsrfToken,
    sessionPathId: encodeURIComponent,
    nodeLabel: (value) => value.id,
    sessionTitle: (value) => value.id,
    canDeleteSession,
    notice,
    errorMessage: String
  });
  return { service, loading, renewCsrfToken, notice, canDeleteSession };
}

beforeEach(() => vi.resetAllMocks());

describe('Public workbench entity actions', () => {
  it('does not remove a same-ID session on another Node after deletion returns', async () => {
    const nodeId = ref('node-a');
    const session = { id: 'same-id', workspaceId: 'workspace', runner: 'codex' } as Session;
    const sessions = ref([session]);
    const selectedSessionId = ref<string | undefined>(session.id);
    const originalCache = {
      sessionDetails: new Map([[session.id, {}]]),
      selectedSessionId: session.id
    };
    const getCache = vi.fn(() => originalCache);
    const openDraft = vi.fn();
    const controller = createWorkbenchEntityController({
      workspaceTarget: workspaceTargetRef(nodeId),
      actions: {
        deleteSession: async () => {
          nodeId.value = 'node-b';
          return true;
        }
      },
      sessions,
      selectedSessionId,
      caches: { get: getCache },
      openDraft,
      replaceUrl: vi.fn()
    } as never);
    await controller.deleteSession(session);
    expect(getCache).toHaveBeenCalledWith('node-a', session.workspaceId);
    expect(originalCache.sessionDetails.has(session.id)).toBe(false);
    expect(sessions.value).toEqual([session]);
    expect(selectedSessionId.value).toBe(session.id);
    expect(openDraft).not.toHaveBeenCalled();
  });

  it.each(['before', 'during'] as const)(
    'rejects session deletion when Working starts %s confirmation',
    async (timing) => {
      const request = vi.fn();
      const current = state(request);
      if (timing === 'before') current.canDeleteSession.mockReturnValue(false);
      dialogs.confirm.mockImplementation(async () => {
        current.canDeleteSession.mockReturnValue(false);
        return 'confirm';
      });
      expect(
        await current.service.deleteSession({ id: 'session', runner: 'mar-agent' } as Session)
      ).toBe(false);
      if (timing === 'before') expect(dialogs.confirm).not.toHaveBeenCalled();
      else expect(dialogs.confirm).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
      expect(current.loading.value).toBe(false);
    }
  );

  it('does not send a request when confirmation is cancelled', async () => {
    dialogs.confirm.mockRejectedValue('cancel');
    const request = vi.fn();
    const current = state(request);
    expect(await current.service.deleteNode(node)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(current.loading.value).toBe(false);
  });

  it('renews CSRF once and preserves the rename payload', async () => {
    dialogs.prompt.mockResolvedValue({ value: ' after ' });
    const updated = { ...node, displayName: 'after' };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('CSRF_INVALID', 'Invalid CSRF token.'))
      .mockResolvedValueOnce({ node: updated });
    const current = state(request);
    expect(await current.service.renameNode(node)).toEqual(updated);
    expect(current.renewCsrfToken).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
    expect(request.mock.calls[0]?.[1]).toEqual({
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'after' })
    });
    expect(current.loading.value).toBe(false);
  });

  it('reports non-CSRF failure without retrying or leaving loading set', async () => {
    dialogs.prompt.mockResolvedValue({ value: 'after' });
    const request = vi.fn().mockRejectedValue(new Error('offline'));
    const current = state(request);
    expect(await current.service.renameNode(node)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(current.renewCsrfToken).not.toHaveBeenCalled();
    expect(current.notice).toHaveBeenCalledOnce();
    expect(current.loading.value).toBe(false);
  });
});
