import { describe, expect, it } from 'vitest';
import { createComposerQueueService } from '../../src/service/ComposerQueueService.js';

describe('Web Composer Queue State', () => {
  it('Saves the target and content while editing a queue item, then clears local edit state', () => {
    const queue = createComposerQueueService();

    queue.startEditing({ queueItemId: 'queue-1', content: 'Confirm release' });
    expect(queue.editingQueueItemId.value).toBe('queue-1');
    expect(queue.editingContent.value).toBe('Confirm release');

    queue.finishEditing();
    expect(queue.editingQueueItemId.value).toBeUndefined();
    expect(queue.editingContent.value).toBe('');
  });
});
