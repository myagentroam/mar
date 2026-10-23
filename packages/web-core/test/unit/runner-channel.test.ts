import { workspaceTargetRef } from './support/workspace-fixture.js';
import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/model/workbench.js';
import { createWorkbenchRunnerChannelService } from '../../src/service/WorkbenchRunnerChannelService.js';
import { translate } from '../../src/service/LocalePreferenceService.js';

function fixture(runner: Session['runner'] = 'claude-code') {
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(async () => ({
    token: 'channel-token',
    delivery: 'STEERED'
  }));
  const token = ref<string>();
  const input = ref('  continue  ');
  const loading = ref(false);
  const notice = vi.fn();
  const service = createWorkbenchRunnerChannelService({
    workspaceTarget: workspaceTargetRef(ref('node/1')),
    selectedSession: computed(() => ({ id: 'session/1', runner }) as Session),
    token,
    input,
    loading,
    notice,
    request: request as never,
    sessionPathId: encodeURIComponent,
    errorMessage: () => 'denied'
  });
  return { service, request, token, input, loading, notice };
}

describe('shared Runner channel', () => {
  it('obtains a scoped token and sends trimmed content with a unique message identity', async () => {
    const f = fixture();
    await f.service.refreshClaudeChannelToken();
    expect(f.request).toHaveBeenCalledWith(
      '/api/agent-sessions/session%2F1/channel-token?nodeId=node%2F1'
    );
    expect(f.token.value).toBe('channel-token');
    await f.service.sendClaudeChannelMessage();
    const [path, init] = f.request.mock.calls[1]!;
    expect(path).toBe('/api/agent-sessions/session%2F1/channel-messages');
    expect(JSON.parse(String(init?.body))).toEqual({
      nodeId: 'node/1',
      token: 'channel-token',
      content: 'continue',
      clientMessageId: expect.any(String)
    });
    expect(f.input.value).toBe('');
    expect(f.loading.value).toBe(false);
    expect(f.notice).toHaveBeenCalledWith(
      translate('generated.workbenchRunnerChannelService.theMessageWasAddedToTheCurrent'),
      'info'
    );
  });

  it('does not request a token for other Runners or send without a token', async () => {
    const f = fixture('codex');
    await f.service.refreshClaudeChannelToken();
    await f.service.sendClaudeChannelMessage();
    expect(f.request).not.toHaveBeenCalled();
  });

  it('invalidates failed token reads and preserves the draft after delivery failure', async () => {
    const f = fixture();
    f.token.value = 'old';
    const error = new Error('failure');
    f.request.mockRejectedValue(error);
    await f.service.refreshClaudeChannelToken();
    expect(f.token.value).toBeUndefined();
    f.token.value = 'new';
    await f.service.sendClaudeChannelMessage();
    expect(f.input.value).toBe('  continue  ');
    expect(f.loading.value).toBe(false);
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('denied'), 'error', error);
  });

  it('keeps input while delivery is pending and does not claim a refused delivery succeeded', async () => {
    const f = fixture();
    f.token.value = 'token';
    let complete!: (result: unknown) => void;
    f.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = f.service.sendClaudeChannelMessage();
    expect(f.loading.value).toBe(true);
    expect(f.input.value).toBe('  continue  ');
    complete({ delivery: 'NOT_DELIVERED' });
    await pending;
    expect(f.loading.value).toBe(false);
    expect(f.notice).toHaveBeenCalledWith(
      'The message was not delivered to the current Claude turn.',
      'error'
    );
  });
});
