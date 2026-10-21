import { describe, expect, it, vi } from 'vitest';
import { QuickPromptService } from '../../ee/server/src/service/quick-prompt-service.js';

function database(responses: unknown[] = []) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT id FROM users')) return [[{ id: 7 }], []];
    return responses.shift() ?? [{ affectedRows: 1 }, []];
  });
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  return { raw: { execute, getConnection: vi.fn(async () => connection) }, connection } as never;
}

describe('Server quick prompts', () => {
  it('Reads and saves account-scoped prompts with phrase-format limits', async () => {
    const service = new QuickPromptService(
      database([
        [[{ id: 'p1', phrase: 'review', prompt: '审查这段代码', updated_at: 3 }]],
        [[{ total: 0 }]],
        [{ affectedRows: 1 }]
      ]),
      () => 9
    );
    await expect(service.list(7)).resolves.toEqual([
      { id: 'p1', phrase: 'review', prompt: '审查这段代码', updatedAt: 3 }
    ]);
    await expect(
      service.create(7, { phrase: 'review', prompt: '审查这段代码' })
    ).resolves.toMatchObject({
      phrase: 'review',
      updatedAt: 9
    });
    await expect(service.create(7, { phrase: '#invalid', prompt: 'x' })).rejects.toThrow(
      'QUICK_PROMPT_INVALID'
    );
  });
});
