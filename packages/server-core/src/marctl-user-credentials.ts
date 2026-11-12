import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { marctlUserTokenSchema } from '@myagentroam/protocol';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { UserNodeAuthorization } from './node-access-contracts.js';

const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'marctl_user_';
const id = z.string().min(1).max(256);
const credentialSchema = z
  .object({
    version: z.literal(1),
    userId: z.number().int().positive().safe(),
    sessionHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    expiresAt: z.number().int().safe(),
    scheduled: z.boolean(),
    channel: z.boolean(),
    scope: z.object({ nodeId: id, workspaceId: id }).strict().optional(),
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('terminal') }).strict(),
      z.object({ type: z.literal('delegation') }).strict(),
      z.object({ type: z.literal('execution'), sessionId: id, executionId: id }).strict()
    ]),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
  })
  .strict();

export interface MarctlExecutionScope {
  readonly nodeId: string;
  readonly workspaceId: string;
}

export type MarctlServerUrlForNode = (
  nodeId: string
) => string | undefined | Promise<string | undefined>;

export type MarctlCredentialSource =
  | { readonly type: 'terminal' }
  | { readonly type: 'delegation' }
  | { readonly type: 'execution'; readonly sessionId: string; readonly executionId: string };

/** Signed, user-scoped CLI credentials. No browser session secret leaves Server. */
export class MarctlUserCredentials {
  constructor(
    private readonly pool: Pool,
    private readonly hmacKey: Uint8Array,
    private readonly now: () => number = Date.now
  ) {
    if (hmacKey.byteLength !== 32) throw new Error('MARCTL_USER_CREDENTIAL_HMAC_KEY_INVALID');
  }

  issue(
    user: {
      readonly userId: number;
      readonly sessionHash?: string;
      readonly scheduled?: boolean;
      readonly channel?: boolean;
    },
    scope?: MarctlExecutionScope,
    source: MarctlCredentialSource = { type: 'terminal' },
    expiresAt = this.now() + TOKEN_LIFETIME_MS
  ): string {
    if (!Number.isSafeInteger(user.userId) || user.userId <= 0)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    if (user.sessionHash !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(user.sessionHash))
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    const nonce = randomBytes(32).toString('base64url');
    const credential = credentialSchema.parse({
      version: 1,
      userId: user.userId,
      sessionHash: user.sessionHash ?? nonce,
      expiresAt: Math.min(expiresAt, this.now() + TOKEN_LIFETIME_MS),
      scheduled: user.scheduled === true || user.sessionHash === undefined,
      channel: user.channel === true,
      source: { ...source },
      ...(scope === undefined ? {} : { scope: { ...scope } }),
      nonce
    });
    const body = Buffer.from(JSON.stringify(credential)).toString('base64url');
    return marctlUserTokenSchema.parse(`${TOKEN_PREFIX}${body}.${this.sign(body)}`);
  }

  async userEnvironment(user: {
    readonly userId: number;
    readonly username?: string;
  }): Promise<Readonly<Record<string, string>>> {
    if (!Number.isSafeInteger(user.userId) || user.userId <= 0)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    let username = user.username;
    if (username === undefined) {
      const [rows] = await this.pool.execute<RowDataPacket[]>(
        `SELECT username FROM users WHERE id=? AND enabled=TRUE AND must_change_password=FALSE`,
        [user.userId]
      );
      username = rows[0]?.['username'];
    }
    if (
      typeof username !== 'string' ||
      username.length === 0 ||
      username.length > 128 ||
      /[\r\n\0]/u.test(username)
    )
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    return { MAR_USERNAME: username };
  }

  async environment(
    user: {
      readonly userId: number;
      readonly sessionHash?: string;
      readonly username?: string;
      readonly scheduled?: boolean;
      readonly channel?: boolean;
    },
    serverUrl: string | undefined,
    scope?: MarctlExecutionScope,
    source: MarctlCredentialSource = { type: 'terminal' },
    expiresAt?: number
  ): Promise<Readonly<Record<string, string>>> {
    const identity = await this.userEnvironment(user);
    if (serverUrl === undefined) return { ...identity, MAR_CTL_CONTEXT_REQUIRED: '1' };
    const origin = new URL(serverUrl);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== serverUrl)
      throw new Error('MARCTL_SERVER_URL_INVALID');
    return {
      ...identity,
      MAR_CTL_CONTEXT_REQUIRED: '1',
      MAR_CTL_SERVER_URL: origin.origin,
      MAR_CTL_USER_TOKEN: this.issue(user, scope, source, expiresAt)
    };
  }

  /** Called only from the authenticated Node control channel after Node admission. */
  async deriveExecution(input: {
    readonly parentToken: string;
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly executionId: string;
    readonly userId: number;
    readonly authorize: (userId: number, nodeId: string, workspaceId: string) => Promise<boolean>;
  }): Promise<string> {
    const parent = await this.authenticateContext(`Bearer ${input.parentToken}`);
    if (
      !parent ||
      parent.source.type !== 'delegation' ||
      parent.user.userId !== input.userId ||
      parent.scope?.nodeId !== input.nodeId ||
      parent.scope.workspaceId !== input.workspaceId ||
      !input.sessionId ||
      !input.executionId ||
      !(await input.authorize(parent.user.userId, input.nodeId, input.workspaceId))
    )
      throw new Error('MARCTL_EXECUTION_AUTHORIZATION_INVALID');
    // Recheck after asynchronous authorization so expiration/revocation cannot be raced.
    if (
      parent.expiresAt <= this.now() ||
      !(await this.authenticateContext(`Bearer ${input.parentToken}`))
    )
      throw new Error('MARCTL_EXECUTION_AUTHORIZATION_INVALID');
    return this.issue(
      {
        ...parent.user,
        scheduled: parent.scheduled,
        channel: parent.channel === true
      },
      parent.scope,
      { type: 'execution', sessionId: input.sessionId, executionId: input.executionId },
      parent.expiresAt
    );
  }

  async authenticate(header: unknown): Promise<UserNodeAuthorization | undefined> {
    return (await this.authenticateContext(header))?.user;
  }

  async authenticateContext(header: unknown): Promise<
    | {
        readonly user: UserNodeAuthorization;
        readonly scheduled: boolean;
        readonly channel?: boolean;
        readonly scope?: MarctlExecutionScope;
        readonly source: MarctlCredentialSource;
        readonly expiresAt: number;
      }
    | undefined
  > {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice(7);
    const credential = this.verify(token);
    if (credential === undefined || credential.expiresAt <= this.now()) return undefined;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      credential.scheduled || credential.channel
        ? `SELECT u.id FROM users u WHERE u.id=? AND u.enabled=TRUE
             AND u.must_change_password=FALSE`
        : `SELECT u.id FROM user_sessions s JOIN users u ON u.id=s.user_id
             WHERE s.session_hash=? AND s.user_id=? AND s.revoked_at IS NULL
             AND s.expires_at>? AND u.enabled=TRUE AND u.must_change_password=FALSE`,
      credential.scheduled || credential.channel
        ? [credential.userId]
        : [credential.sessionHash, credential.userId, this.now()]
    );
    if (rows.length === 0) return undefined;
    return {
      user: { userId: credential.userId, sessionHash: credential.sessionHash },
      scheduled: credential.scheduled,
      source: { ...credential.source },
      expiresAt: credential.expiresAt,
      ...(credential.channel ? { channel: true } : {}),
      ...(credential.scope === undefined ? {} : { scope: { ...credential.scope } })
    };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.hmacKey)
      .update('mar:marctl-user:v1\0')
      .update(body)
      .digest('base64url');
  }

  private verify(token: string): z.infer<typeof credentialSchema> | undefined {
    if (!marctlUserTokenSchema.safeParse(token).success) return undefined;
    const [body, signature] = token.slice(TOKEN_PREFIX.length).split('.');
    if (!body || !signature) return undefined;
    const actual = Buffer.from(signature);
    const expected = Buffer.from(this.sign(body));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    try {
      return credentialSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    } catch {
      return undefined;
    }
  }
}
