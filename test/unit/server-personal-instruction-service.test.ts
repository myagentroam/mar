import { describe, expect, it, vi } from 'vitest';
import {
  PersonalInstructionService,
  personalInstructionScope
} from '../../ee/server/src/service/personal-instruction-service.js';

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

describe('Account personalized instructions', () => {
  it('Reads five independent account-scoped entries and saves or clears each separately', async () => {
    const service = new PersonalInstructionService(
      database([
        [
          [
            { scope: 'COMMON', content: '始终使用中文' },
            { scope: 'CODEX', content: '先写测试' },
            { scope: 'CLAUDE_CODE', content: '保留 CLAUDE.md' },
            { scope: 'OPENCODE', content: '使用官方接口' },
            { scope: 'MAR_AGENT', content: '使用内置工具' }
          ]
        ],
        [{ affectedRows: 1 }],
        [
          [
            { scope: 'COMMON', content: '公共' },
            { scope: 'CODEX', content: '专属' }
          ]
        ],
        [{ affectedRows: 1 }],
        [[{ scope: 'COMMON', content: '公共' }]]
      ]),
      () => 9
    );

    await expect(service.get(7)).resolves.toEqual({
      common: '始终使用中文',
      codex: '先写测试',
      claudeCode: '保留 CLAUDE.md',
      openCode: '使用官方接口',
      marAgent: '使用内置工具'
    });
    await expect(service.save(7, 'CODEX', { content: ' 专属 ' })).resolves.toEqual({
      common: '公共',
      codex: '专属',
      claudeCode: '',
      openCode: '',
      marAgent: ''
    });
    await expect(service.remove(7, 'CODEX')).resolves.toEqual({
      common: '公共',
      codex: '',
      claudeCode: '',
      openCode: '',
      marAgent: ''
    });
  });

  it('Rejects invalid scopes and blank or oversized content', async () => {
    const service = new PersonalInstructionService(database());
    expect(personalInstructionScope('COMMON')).toBe('COMMON');
    expect(personalInstructionScope('MAR_AGENT')).toBe('MAR_AGENT');
    expect(personalInstructionScope('INVALID')).toBeUndefined();
    await expect(service.save(7, 'COMMON', { content: '  ' })).rejects.toThrow(
      'PERSONAL_INSTRUCTION_INVALID'
    );
    await expect(service.save(7, 'COMMON', { content: 'a'.repeat(20_001) })).rejects.toThrow(
      'PERSONAL_INSTRUCTION_INVALID'
    );
  });
});
