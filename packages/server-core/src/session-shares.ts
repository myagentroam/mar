import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  sessionShareAuthInputSchema,
  sessionShareSchema,
  type SessionShare,
  type SessionShareAuthResult,
  type SessionShareTarget
} from '@myagentroam/protocol';
import { hashPassword, verifyPassword } from './password.js';
import type { SessionInputContext } from './session-input-service.js';
import type { SessionRunNodeControl } from './session-run-contracts.js';

export interface StoredSessionShare extends SessionShare {
  readonly userId: number;
  readonly passwordHash: string;
  readonly password: string | null;
  readonly credential: string;
}
export interface SessionShareStore {
  insert(share: StoredSessionShare): Promise<void>;
  get(id: string): Promise<StoredSessionShare | undefined>;
  list(target: SessionShareTarget): Promise<readonly StoredSessionShare[]>;
  delete(id: string): Promise<boolean>;
  savePassword(id: string, password: string): Promise<boolean>;
  workspaceName(nodeId: string, workspaceId: string): Promise<string | undefined>;
  executionUser(
    userId: number
  ): Promise<{ readonly username: string; readonly displayName: string } | undefined>;
}

interface Options {
  readonly store: SessionShareStore;
  readonly nodeControl: Pick<SessionRunNodeControl, 'requestNode'>;
  readonly authorize: (
    userId: number,
    target: SessionShareTarget,
    operation: string
  ) => Promise<boolean>;
  readonly invalidate: (shareId: string, code: string) => void;
  readonly now?: () => number;
}
export const sessionShareFingerprint = (credential: string): string =>
  createHash('sha256')
    .update('session-share:' + credential)
    .digest('base64url');

/** Persistent access is per link; visitors are display identities, not login accounts. */
export class SessionShares {
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  async create(
    user: SessionInputContext['user'],
    target: SessionShareTarget,
    expiration: string | null
  ): Promise<{ readonly share: SessionShare; readonly password: string }> {
    const expiresAt = expiration === null ? null : Date.parse(expiration);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= this.now()))
      throw new Error('SESSION_SHARE_INPUT_INVALID');
    await this.authorize(user.userId, target, 'session.get');
    const result = (await this.options.nodeControl.requestNode(
      target.nodeId,
      'session.get',
      { sessionId: target.sessionId, workspaceId: target.workspaceId },
      { userId: user.userId, sessionHash: user.sessionHash, workspaceId: target.workspaceId }
    )) as { readonly session?: { readonly id?: string; readonly workspaceId?: string } };
    if (
      result?.session?.id !== target.sessionId ||
      result.session.workspaceId !== target.workspaceId
    )
      throw new Error('SESSION_NOT_FOUND');
    const password = String(randomInt(1_000_000)).padStart(6, '0');
    const record: StoredSessionShare = {
      ...target,
      id: randomUUID(),
      userId: user.userId,
      passwordHash: hashPassword(password),
      password,
      credential: randomBytes(32).toString('base64url'),
      createdAt: this.now(),
      expiresAt
    };
    await this.options.store.insert(record);
    return { share: sessionShareSchema.parse(record), password };
  }

  async list(userId: number, target: SessionShareTarget): Promise<readonly SessionShare[]> {
    await this.authorize(userId, target, 'session.get');
    return (await this.options.store.list(target)).map((record) =>
      sessionShareSchema.parse(record)
    );
  }

  async delete(userId: number, target: SessionShareTarget, id: string): Promise<void> {
    await this.managedRecord(userId, target, id);
    await this.options.store.delete(id);
    this.options.invalidate(id, 'SESSION_SHARE_NOT_FOUND');
  }

  async copyPassword(
    userId: number,
    target: SessionShareTarget,
    id: string,
    password?: string
  ): Promise<string | null> {
    const record = await this.managedRecord(userId, target, id);
    if (record.password !== null) return record.password;
    if (password === undefined) return null;
    if (!/^[0-9]{6}$/u.test(password) || !verifyPassword(password, record.passwordHash))
      throw new Error('SESSION_SHARE_CREDENTIAL_INVALID');
    if (!(await this.options.store.savePassword(id, password)))
      throw new Error('SESSION_SHARE_NOT_FOUND');
    return password;
  }

  private async managedRecord(userId: number, target: SessionShareTarget, id: string) {
    await this.authorize(userId, target, 'session.get');
    const record = await this.options.store.get(id);
    if (
      record === undefined ||
      record.nodeId !== target.nodeId ||
      record.workspaceId !== target.workspaceId ||
      record.sessionId !== target.sessionId
    )
      throw new Error('SESSION_SHARE_NOT_FOUND');
    return record;
  }

  async authenticate(id: string, raw: unknown): Promise<SessionShareAuthResult> {
    const parsed = sessionShareAuthInputSchema.safeParse(raw);
    if (!parsed.success) throw new Error('SESSION_SHARE_CREDENTIAL_INVALID');
    const record = await this.validRecord(id);
    const valid =
      'password' in parsed.data
        ? verifyPassword(parsed.data.password, record.passwordHash)
        : matchesCredential(parsed.data.credential, record.credential);
    if (!valid) throw new Error('SESSION_SHARE_CREDENTIAL_INVALID');
    const { sharerName } = await this.execution(record);
    const workspaceName = await this.options.store.workspaceName(record.nodeId, record.workspaceId);
    return {
      share: sessionShareSchema.parse(record),
      credential: record.credential,
      sharerName,
      ...(workspaceName === undefined ? {} : { workspaceName })
    };
  }

  async resolve(id: string, credential: string | undefined) {
    const record = await this.validRecord(id);
    if (credential === undefined || !matchesCredential(credential, record.credential))
      throw new Error('SESSION_SHARE_CREDENTIAL_INVALID');
    return this.execution(record);
  }

  /** Only for existing short-lived HTML grants; never a browser login substitute. */
  async resolvePreview(id: string) {
    return this.execution(await this.validRecord(id));
  }

  private async validRecord(id: string): Promise<StoredSessionShare> {
    const record = await this.options.store.get(id);
    if (record === undefined) throw new Error('SESSION_SHARE_NOT_FOUND');
    if (record.expiresAt !== null && record.expiresAt <= this.now())
      throw new Error('SESSION_SHARE_EXPIRED');
    return record;
  }

  private async execution(record: StoredSessionShare) {
    const user = await this.options.store.executionUser(record.userId);
    if (user === undefined) throw new Error('NODE_NOT_AUTHORIZED');
    await this.authorize(record.userId, record, 'session.get');
    const context: SessionInputContext = {
      nodeId: record.nodeId,
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      user: {
        userId: record.userId,
        username: user.username,
        sessionHash: sessionShareFingerprint(record.credential),
        channel: true
      }
    };
    return { record, context, sharerName: user.displayName.trim() || user.username };
  }

  async participant(userId: number): Promise<{ userId: number; name: string } | undefined> {
    const user = await this.options.store.executionUser(userId);
    return user === undefined
      ? undefined
      : { userId, name: user.displayName.trim() || user.username };
  }

  private async authorize(
    userId: number,
    target: SessionShareTarget,
    operation: string
  ): Promise<void> {
    if (!(await this.options.authorize(userId, target, operation)))
      throw new Error('NODE_NOT_AUTHORIZED');
  }
}

function matchesCredential(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
