import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { QuickPromptService } from '../../src/quick-prompt-service.js';

function transactional(execute: ReturnType<typeof vi.fn>) {
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  return {
    raw: { execute, getConnection: vi.fn(async () => connection) } as unknown as Pool,
    connection
  };
}

function database(responses: unknown[] = [], userRows: unknown[] = [{ id: 7 }]) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT id FROM users')) return [userRows, []];
    return responses.shift() ?? [{ affectedRows: 1 }, []];
  });
  return transactional(execute);
}

describe('Server quick prompts', () => {
  it('rejects the per-user limit and translates duplicate phrases', async () => {
    const limited = new QuickPromptService(database([[[{ total: 100 }]]]));
    await expect(limited.create(1, { phrase: 'review', prompt: 'Review' })).rejects.toThrow(
      'QUICK_PROMPT_LIMIT_EXCEEDED'
    );
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockRejectedValueOnce({ code: 'ER_DUP_ENTRY' });
    const duplicate = new QuickPromptService(transactional(execute) as never);
    await expect(duplicate.create(1, { phrase: 'review', prompt: 'Review' })).rejects.toThrow(
      'QUICK_PROMPT_PHRASE_EXISTS'
    );
  });

  it('scopes updates and deletion to the caller and rejects missing records', async () => {
    const execute = vi.fn(async () => [{ affectedRows: 0 }]);
    const service = new QuickPromptService({ raw: { execute } } as never, () => 10);
    await expect(
      service.update(7, 'other-user-prompt', { phrase: 'review', prompt: 'Review' })
    ).rejects.toThrow('QUICK_PROMPT_NOT_FOUND');
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('WHERE id=? AND user_id=?'), [
      'review',
      'Review',
      10,
      'other-user-prompt',
      7
    ]);
    await expect(service.remove(7, 'other-user-prompt')).rejects.toThrow('QUICK_PROMPT_NOT_FOUND');
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('WHERE id=? AND user_id=?'), [
      'other-user-prompt',
      7
    ]);
  });

  it('reads and saves prompts per account while enforcing phrase formatting', async () => {
    const service = new QuickPromptService(
      database([
        [[{ id: 'p1', phrase: 'review', prompt: 'Review this code', updated_at: 3 }]],
        [[{ total: 0 }]],
        [{ affectedRows: 1 }]
      ]),
      () => 9
    );
    await expect(service.list(7)).resolves.toEqual([
      { id: 'p1', phrase: 'review', prompt: 'Review this code', updatedAt: 3 }
    ]);
    await expect(
      service.create(7, { phrase: 'review', prompt: 'Review this code' })
    ).resolves.toMatchObject({
      phrase: 'review',
      updatedAt: 9
    });
    await expect(service.create(7, { phrase: '#invalid', prompt: 'x' })).rejects.toThrow(
      'QUICK_PROMPT_INVALID'
    );
  });

  it('rejects a missing user before counting or inserting and cleans up the transaction', async () => {
    const databaseFixture = database([], []);
    const service = new QuickPromptService(databaseFixture as never);

    await expect(service.create(7, { phrase: 'review', prompt: 'Review' })).rejects.toThrow(
      'USER_NOT_FOUND'
    );
    expect(databaseFixture.connection.commit).not.toHaveBeenCalled();
    expect(databaseFixture.connection.rollback).toHaveBeenCalledOnce();
    expect(databaseFixture.connection.release).toHaveBeenCalledOnce();
    expect(databaseFixture.connection.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
      databaseFixture.connection.release.mock.invocationCallOrder[0]!
    );
  });
});
