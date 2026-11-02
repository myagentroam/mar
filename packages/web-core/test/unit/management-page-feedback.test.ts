import { effectScope, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { showMessage } from '../../src/service/message-feedback-service.js';
import { watchManagementPageFailure } from '../../src/service/management-page-feedback.js';

vi.mock('../../src/service/message-feedback-service.js', () => ({ showMessage: vi.fn() }));

describe('management page failure feedback', () => {
  it('reports ordinary reads but leaves mobile incremental failures at the retry boundary', () => {
    const failure = ref<{ error: unknown; incremental: boolean }>();
    const mobileViewport = ref(false);
    const scope = effectScope();
    scope.run(() => watchManagementPageFailure({ failure, mobileViewport }));
    const error = new Error('List failed');

    failure.value = { error, incremental: false };
    expect(showMessage).toHaveBeenCalledWith('List failed', 'error', error);
    vi.mocked(showMessage).mockClear();
    mobileViewport.value = true;
    failure.value = { error, incremental: true };
    expect(showMessage).not.toHaveBeenCalled();
    failure.value = { error, incremental: false };
    expect(showMessage).toHaveBeenCalledWith('List failed', 'error', error);
    scope.stop();
  });
});
