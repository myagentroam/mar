import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  CODEX_CREDENTIAL_SETTING_KEY,
  CODEX_CREDENTIAL_DOCUMENT_VERSION,
  CODEX_MAX_DOCUMENT_BYTES,
  parseCredentialDocument,
  type CredentialDocument,
  type CredentialDocumentAccess
} from './credential-document.js';

/** Owns reads and serialized writes of the credential document. */
export class CredentialDocumentStore implements CredentialDocumentAccess {
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: Pick<Pool, 'execute'>,
    private readonly now: () => number
  ) {}

  async read(): Promise<CredentialDocument> {
    const [rows] = await this.database.execute<RowDataPacket[]>(
      `SELECT setting_value FROM system_settings WHERE setting_key='${CODEX_CREDENTIAL_SETTING_KEY}'`
    );
    const raw = rows[0]?.['setting_value'];
    if (raw === undefined || raw === null)
      return { version: CODEX_CREDENTIAL_DOCUMENT_VERSION, credentials: [] };
    try {
      const parsed =
        typeof raw === 'string'
          ? JSON.parse(raw)
          : Buffer.isBuffer(raw)
            ? JSON.parse(raw.toString('utf8'))
            : raw;
      return parseCredentialDocument(parsed);
    } catch {
      throw new Error('CODEX_CREDENTIAL_STORE_INVALID');
    }
  }

  async mutate<T>(
    mutate: (document: CredentialDocument) => T | Promise<T>,
    validateCommit?: () => void
  ): Promise<T> {
    const prior = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const document = await this.read();
      const result = await mutate(document);
      const serialized = JSON.stringify(parseCredentialDocument(document));
      if (Buffer.byteLength(serialized) > CODEX_MAX_DOCUMENT_BYTES)
        throw new Error('CODEX_CREDENTIAL_STORE_LIMIT_REACHED');
      validateCommit?.();
      await this.database.execute(
        `INSERT INTO system_settings (setting_key,setting_value,updated_at)
         VALUES ('${CODEX_CREDENTIAL_SETTING_KEY}',CAST(? AS JSON),?)
         ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`,
        [serialized, this.now()]
      );
      return result;
    } finally {
      release();
    }
  }
}
