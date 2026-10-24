import { expect, it, vi } from 'vitest';
import { createSessionPromptService } from '../../src/service/session-prompt-service.js';

it('reads the authoritative Session and updates only its Session Prompt', async () => {
  const request = vi.fn().mockResolvedValue({ session: { sessionPrompt: 'Current rules' } });
  const service = createSessionPromptService({
    nodeId: 'node/one',
    sessionId: 'native/id',
    request
  });
  expect(await service.read()).toBe('Current rules');
  expect(request).toHaveBeenLastCalledWith('/api/agent-sessions/native%2Fid?nodeId=node%2Fone');
  await service.save('  Updated rules\nSecond line  ');
  expect(request).toHaveBeenLastCalledWith('/api/agent-sessions/native%2Fid/metadata', {
    method: 'PATCH',
    body: JSON.stringify({ nodeId: 'node/one', sessionPrompt: 'Updated rules\nSecond line' })
  });
  await service.save('  \n');
  expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({
    nodeId: 'node/one',
    sessionPrompt: null
  });
});

it('keeps failed reads and writes observable instead of replacing them with empty prompts', async () => {
  const error = new Error('RESOURCE_ACCESS_DENIED');
  const request = vi.fn().mockRejectedValue(error);
  const service = createSessionPromptService({ nodeId: 'node', sessionId: 'session', request });
  await expect(service.read()).rejects.toBe(error);
  await expect(service.save('Rules')).rejects.toBe(error);
});
