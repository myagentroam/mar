import { withMysqlTransaction, lockMysqlUsers } from './mysql-reference-store.js';
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface QuickPrompt {
  readonly id: string;
  readonly phrase: string;
  readonly prompt: string;
  readonly updatedAt: number;
}

const MAX_PROMPTS_PER_USER = 100;

export class QuickPromptService {
  constructor(
    private readonly database: { readonly raw: Pool },
    private readonly now: () => number = Date.now
  ) {}

  async list(userId: number): Promise<readonly QuickPrompt[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id,phrase,prompt,updated_at FROM user_quick_prompts
       WHERE user_id=? ORDER BY updated_at DESC,id DESC`,
      [userId]
    );
    return rows.map(promptFromRow);
  }

  async create(userId: number, input: unknown): Promise<QuickPrompt> {
    const value = parseInput(input);
    const prompt: QuickPrompt = { id: randomUUID(), ...value, updatedAt: this.now() };
    try {
      await withMysqlTransaction(this.database.raw, async (connection) => {
        await lockMysqlUsers(connection, [userId]);
        const [rows] = await connection.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM user_quick_prompts WHERE user_id=?',
          [userId]
        );
        if (Number(rows[0]?.['total'] ?? 0) >= MAX_PROMPTS_PER_USER)
          throw new Error('QUICK_PROMPT_LIMIT_EXCEEDED');
        await connection.execute(
          `INSERT INTO user_quick_prompts (id,user_id,phrase,prompt,created_at,updated_at)
           VALUES (?,?,?,?,?,?)`,
          [prompt.id, userId, prompt.phrase, prompt.prompt, prompt.updatedAt, prompt.updatedAt]
        );
      });
    } catch (error) {
      throw duplicatePhrase(error);
    }
    return prompt;
  }

  async update(userId: number, id: string, input: unknown): Promise<QuickPrompt> {
    const value = parseInput(input);
    const updatedAt = this.now();
    let result: ResultSetHeader;
    try {
      [result] = await this.database.raw.execute<ResultSetHeader>(
        `UPDATE user_quick_prompts SET phrase=?,prompt=?,updated_at=?
         WHERE id=? AND user_id=?`,
        [value.phrase, value.prompt, updatedAt, id, userId]
      );
    } catch (error) {
      throw duplicatePhrase(error);
    }
    if (result.affectedRows === 0) throw new Error('QUICK_PROMPT_NOT_FOUND');
    return { id, ...value, updatedAt };
  }

  async remove(userId: number, id: string): Promise<void> {
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      'DELETE FROM user_quick_prompts WHERE id=? AND user_id=?',
      [id, userId]
    );
    if (result.affectedRows === 0) throw new Error('QUICK_PROMPT_NOT_FOUND');
  }
}

function parseInput(input: unknown): Pick<QuickPrompt, 'phrase' | 'prompt'> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('QUICK_PROMPT_INVALID');
  const value = input as Record<string, unknown>;
  const phrase = typeof value['phrase'] === 'string' ? value['phrase'].trim() : '';
  const prompt = typeof value['prompt'] === 'string' ? value['prompt'] : '';
  if (
    phrase.length === 0 ||
    phrase.length > 80 ||
    /[\s#]/u.test(phrase) ||
    prompt.length === 0 ||
    prompt.length > 10_000 ||
    prompt.trim().length === 0
  )
    throw new Error('QUICK_PROMPT_INVALID');
  return { phrase, prompt };
}

function duplicatePhrase(error: unknown): Error {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ER_DUP_ENTRY'
  )
    return new Error('QUICK_PROMPT_PHRASE_EXISTS');
  return error instanceof Error ? error : new Error(String(error));
}

function promptFromRow(row: RowDataPacket): QuickPrompt {
  return {
    id: String(row['id']),
    phrase: String(row['phrase']),
    prompt: String(row['prompt']),
    updatedAt: Number(row['updated_at'])
  };
}
