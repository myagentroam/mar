import { lockMysqlUsers } from './mysql-reference-store.js';
import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  gitCredentialInputSchema,
  gitCredentialUpdateSchema,
  gitCredentialScopeKey,
  parsePersonalGitRuntime,
  personalGitRuntimeSchema,
  type PersonalGitRuntime,
  type PersonalGitSummary
} from '@myagentroam/protocol';

const EMPTY: PersonalGitRuntime = { credentials: [] };

/** Account-private storage. Only the authorized Node execution path reads secrets. */
export class PersonalGitService {
  constructor(private readonly database: { readonly raw: Pool }) {}

  async get(userId: number): Promise<PersonalGitSummary> {
    return summary(await this.getRuntime(userId));
  }

  async getRuntime(userId: number): Promise<PersonalGitRuntime> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT configuration FROM user_git_configurations WHERE user_id=?',
      [userId]
    );
    return parseStored(rows[0]?.['configuration']);
  }

  createCredential(userId: number, input: unknown): Promise<PersonalGitSummary> {
    const parsed = gitCredentialInputSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error('GIT_CONFIGURATION_INVALID'));
    return this.mutate(userId, (value) => ({
      ...value,
      credentials: [...value.credentials, { ...parsed.data, id: randomUUID() }]
    }));
  }

  updateCredential(userId: number, id: string, input: unknown): Promise<PersonalGitSummary> {
    const parsed = gitCredentialUpdateSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error('GIT_CONFIGURATION_INVALID'));
    return this.mutate(userId, (value) => {
      const previous = value.credentials.find((entry) => entry.id === id);
      if (previous === undefined) throw new Error('GIT_CREDENTIAL_NOT_FOUND');
      if (previous.protocol !== parsed.data.protocol)
        throw new Error('GIT_CREDENTIAL_PROTOCOL_IMMUTABLE');
      const { passphrase: previousPassphrase, ...previousFields } = previous;
      const { passphrase, ...fields } = parsed.data;
      const nextPassphrase = passphrase === undefined ? previousPassphrase : passphrase;
      const updated = {
        ...previousFields,
        ...fields,
        secret: parsed.data.secret ?? previous.secret,
        ...(nextPassphrase == null ? {} : { passphrase: nextPassphrase })
      };
      return {
        ...value,
        credentials: value.credentials.map((entry) => (entry.id === id ? updated : entry))
      };
    });
  }

  removeCredential(userId: number, id: string): Promise<PersonalGitSummary> {
    return this.mutate(userId, (value) => {
      if (!value.credentials.some((entry) => entry.id === id))
        throw new Error('GIT_CREDENTIAL_NOT_FOUND');
      return { ...value, credentials: value.credentials.filter((entry) => entry.id !== id) };
    });
  }

  private async mutate(
    userId: number,
    update: (value: PersonalGitRuntime) => PersonalGitRuntime
  ): Promise<PersonalGitSummary> {
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockMysqlUsers(connection, [userId]);
      await connection.execute(
        'INSERT IGNORE INTO user_git_configurations (user_id,configuration,updated_at) VALUES (?,?,?)',
        [userId, JSON.stringify(EMPTY), Date.now()]
      );
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT configuration FROM user_git_configurations WHERE user_id=? FOR UPDATE',
        [userId]
      );
      const updated = update(parseStored(rows[0]?.['configuration']));
      const scopes = updated.credentials.map(gitCredentialScopeKey);
      if (new Set(scopes).size !== scopes.length) throw new Error('GIT_CREDENTIAL_SCOPE_CONFLICT');
      const parsed = personalGitRuntimeSchema.safeParse(updated);
      if (!parsed.success) throw new Error('GIT_CONFIGURATION_INVALID');
      await connection.execute(
        'UPDATE user_git_configurations SET configuration=?,updated_at=? WHERE user_id=?',
        [JSON.stringify(parsed.data), Date.now(), userId]
      );
      await connection.commit();
      return summary(parsed.data);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

function parseStored(input: unknown): PersonalGitRuntime {
  if (input === undefined) return { credentials: [] };
  try {
    return parsePersonalGitRuntime(typeof input === 'string' ? JSON.parse(input) : input);
  } catch {
    throw new Error('GIT_CONFIGURATION_INVALID');
  }
}
function summary(value: PersonalGitRuntime): PersonalGitSummary {
  return {
    credentials: value.credentials.map(({ secret, passphrase, ...metadata }) => ({
      ...metadata,
      hasSecret: secret.length > 0,
      hasPassphrase: Boolean(passphrase)
    }))
  };
}
