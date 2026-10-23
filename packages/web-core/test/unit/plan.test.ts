import { workspaceTargetRef } from './support/workspace-fixture.js';
import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationTurn, RunnerCommandState, Session } from '../../src/model/workbench.js';
import { createWorkbenchPlanService } from '../../src/service/WorkbenchPlanService.js';

function fixture() {
  const selectedSessionId = ref<string | undefined>('session-1');
  const session = { id: 'session-1' } as Session;
  const input = ref('original');
  const notice = vi.fn();
  const execute = vi.fn(async () => ({}));
  const send = vi.fn(async () => {});
  const finish = vi.fn(() => true);
  const beginSubmission = vi.fn((): (() => boolean) | undefined => finish);
  const continuation = {
    commandId: 'plan',
    closeInput: '/plan',
    continuation: { prompt: 'implement' }
  } as RunnerCommandState;
  const service = createWorkbenchPlanService({
    workspaceTarget: workspaceTargetRef(ref('node-1')),
    selectedSessionId,
    selectedSession: computed(() => session),
    input,
    selectedCommand: ref(),
    commandPickerOpen: ref(true),
    notice,
    continuationFor: () => continuation,
    execute,
    send,
    errorMessage: () => 'denied',
    beginSubmission
  });
  const item = {} as ConversationTurn['items'][number];
  return {
    service,
    item,
    selectedSessionId,
    input,
    notice,
    execute,
    send,
    finish,
    beginSubmission,
    continuation
  };
}

describe('shared Plan continuation', () => {
  it('closes Plan before sending the continuation', async () => {
    const f = fixture();
    await f.service.implementPlan(f.item);
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      'plan',
      '/plan'
    );
    expect(f.finish).toHaveBeenCalledOnce();
    expect(f.input.value).toBe('implement');
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.execute.mock.invocationCallOrder[0]).toBeLessThan(f.send.mock.invocationCallOrder[0]!);
  });

  it('does not execute when another submission owns the gate', async () => {
    const f = fixture();
    f.beginSubmission.mockReturnValue(undefined);
    await f.service.implementPlan(f.item);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.input.value).toBe('original');
  });

  it('does not send after the close command times out', async () => {
    const f = fixture();
    f.finish.mockReturnValue(false);
    await f.service.implementPlan(f.item);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.input.value).toBe('original');
  });

  it('does not overwrite the selected session after switching during close', async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => {
      f.selectedSessionId.value = 'session-2';
      return {};
    });
    await f.service.implementPlan(f.item);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.input.value).toBe('original');
  });

  it('preserves input and reports a close failure without sending', async () => {
    const f = fixture();
    const error = new Error('failure');
    f.execute.mockRejectedValue(error);
    await f.service.implementPlan(f.item);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.input.value).toBe('original');
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('denied'), 'error', error);
    expect(f.finish).toHaveBeenCalledOnce();
  });
});
