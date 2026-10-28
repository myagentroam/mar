import { describe, expect, it, vi } from 'vitest';
import {
  SessionQueryService,
  type SessionQueryServiceOptions
} from '../../src/session/session-query-service.js';

describe('Session tool resource workspace boundary', () => {
  it('checks the resolved Session workspace before reading any resource', async () => {
    const session = { id: 'session', workspaceId: 'private', runner: 'mar-agent' };
    const resourceRef = 'c10a59dd-680f-46f6-9b75-31bfbd520506';
    const page = {
      type: 'file_changes',
      version: 1,
      format: 'unified-diff',
      resourceRef,
      byteSize: 2,
      sha256: 'a'.repeat(64),
      content: '+a'
    };
    const readToolResultResource = vi.fn(async () => page);
    const service = new SessionQueryService({
      runtime: { getAgentSession: () => undefined },
      resolve: async () => session,
      runners: { product: () => ({ readToolResultResource }) }
    } as unknown as SessionQueryServiceOptions);
    const read = service.operations()['session.tool-resource.read']!;
    for (const workspaceId of [undefined, '', 'public']) {
      await expect(read({ sessionId: 'session', workspaceId, resourceRef })).rejects.toThrow(
        'SESSION_NOT_FOUND'
      );
    }
    expect(readToolResultResource).not.toHaveBeenCalled();
    await expect(
      read({ sessionId: 'session', workspaceId: 'private', resourceRef })
    ).resolves.toEqual(page);
    expect(readToolResultResource).toHaveBeenCalledWith(session, { resourceRef });
  });
});
