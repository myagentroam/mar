import { withMysqlTransaction, lockMysqlUsers } from './mysql-reference-store.js';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';

export type PersonalInstructionScope =
  'COMMON' | 'CODEX' | 'CLAUDE_CODE' | 'OPENCODE' | 'MAR_AGENT';

export interface PersonalInstructions {
  readonly common: string;
  readonly codex: string;
  readonly claudeCode: string;
  readonly openCode: string;
  readonly marAgent: string;
}

const EMPTY: PersonalInstructions = Object.freeze({
  common: '',
  codex: '',
  claudeCode: '',
  openCode: '',
  marAgent: ''
});

const MAX_CONTENT_LENGTH = 20_000;

export class PersonalInstructionService {
  constructor(
    private readonly database: { readonly raw: Pool },
    private readonly now: () => number = Date.now
  ) {}

  async get(userId: number): Promise<PersonalInstructions> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT scope,content FROM user_personal_instructions
       WHERE user_id=? ORDER BY scope`,
      [userId]
    );
    const values = { ...EMPTY };
    for (const row of rows) {
      const content = typeof row['content'] === 'string' ? row['content'] : '';
      if (row['scope'] === 'COMMON') values.common = content;
      else if (row['scope'] === 'CODEX') values.codex = content;
      else if (row['scope'] === 'CLAUDE_CODE') values.claudeCode = content;
      else if (row['scope'] === 'OPENCODE') values.openCode = content;
      else if (row['scope'] === 'MAR_AGENT') values.marAgent = content;
    }
    return values;
  }

  async save(
    userId: number,
    scope: PersonalInstructionScope,
    input: unknown
  ): Promise<PersonalInstructions> {
    const content = parseContent(input);
    const updatedAt = this.now();
    await withMysqlTransaction(this.database.raw, async (connection) => {
      await lockMysqlUsers(connection, [userId]);
      await connection.execute(
        `INSERT INTO user_personal_instructions (user_id,scope,content,updated_at)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE content=VALUES(content),updated_at=VALUES(updated_at)`,
        [userId, scope, content, updatedAt]
      );
    });
    return this.get(userId);
  }

  async remove(userId: number, scope: PersonalInstructionScope): Promise<PersonalInstructions> {
    await this.database.raw.execute<ResultSetHeader>(
      'DELETE FROM user_personal_instructions WHERE user_id=? AND scope=?',
      [userId, scope]
    );
    return this.get(userId);
  }
}

export function personalInstructionScope(value: unknown): PersonalInstructionScope | undefined {
  return value === 'COMMON' ||
    value === 'CODEX' ||
    value === 'CLAUDE_CODE' ||
    value === 'OPENCODE' ||
    value === 'MAR_AGENT'
    ? value
    : undefined;
}

function parseContent(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('PERSONAL_INSTRUCTION_INVALID');
  const value = input as Record<string, unknown>;
  const content = typeof value['content'] === 'string' ? value['content'].trim() : '';
  if (content.length === 0 || content.length > MAX_CONTENT_LENGTH)
    throw new Error('PERSONAL_INSTRUCTION_INVALID');
  return content;
}
