import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

const configuration = z.object({ useResourceUrl: z.boolean() }).strict();
const globalKey = 'mar_agent_resource_input';
const modelKey = (id: string) => `${globalKey}:model:${id}`;
type Executor = Pick<Pool | PoolConnection, 'execute'>;

/** Owns resource transport settings, independently of model SQL and credentials. */
export class MarAgentResourceInputService {
  constructor(private readonly database: { readonly raw: Executor }) {}

  async read(): Promise<{ useResourceUrl: boolean }> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT setting_value FROM system_settings WHERE setting_key=?',
      [globalKey]
    );
    return rows.length ? parse(rows[0]!.setting_value) : { useResourceUrl: true };
  }

  async models(ids: readonly string[]): Promise<Map<string, { useResourceUrl: boolean }>> {
    const result = new Map(ids.map((id) => [id, { useResourceUrl: false }]));
    if (!ids.length) return result;
    const keys = new Map(ids.map((id) => [modelKey(id), id]));
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT setting_key,setting_value FROM system_settings WHERE setting_key IN (${ids.map(() => '?').join(',')})`,
      [...keys.keys()]
    );
    for (const row of rows) {
      const id = keys.get(String(row.setting_key));
      if (id !== undefined) result.set(id, parse(row.setting_value));
    }
    return result;
  }

  async write(raw: unknown, executor: Executor = this.database.raw, id?: string): Promise<void> {
    const parsed = configuration.safeParse(raw);
    if (!parsed.success) throw new Error('MAR_AGENT_RESOURCE_INPUT_INVALID');
    await executor.execute(
      'INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)',
      [id === undefined ? globalKey : modelKey(id), JSON.stringify(parsed.data), Date.now()]
    );
  }

  async remove(id: string, executor: Executor): Promise<void> {
    await executor.execute('DELETE FROM system_settings WHERE setting_key=?', [modelKey(id)]);
  }
}

function parse(raw: unknown): { useResourceUrl: boolean } {
  try {
    return configuration.parse(
      typeof raw === 'string'
        ? JSON.parse(raw)
        : Buffer.isBuffer(raw)
          ? JSON.parse(raw.toString('utf8'))
          : raw
    );
  } catch {
    throw new Error('MAR_AGENT_RESOURCE_INPUT_INVALID');
  }
}
