import { randomUUID } from 'node:crypto';
import {
  CHATGPT_JWKS_ENDPOINT,
  CHATGPT_ISSUER,
  chatgptNodeLoginStatusSchema,
  codexLoginAttemptSchema,
  verifyChatgptIdentity,
  type CodexLoginAttempt
} from '@myagentroam/protocol';
import {
  CODEX_MAX_CREDENTIALS as MAX_CREDENTIALS,
  normalizeCredentialName as normalizeName,
  type CredentialRecord,
  type CredentialDocument
} from './credential-document.js';
import type { CredentialScopePolicy } from './credential-scope-policy.js';
import { asRecord, requiredString, safeJson, sameOwnership } from './credential-provider-values.js';
import type {
  CredentialLoginActor as LoginActor,
  CredentialLoginDraft as LoginDraft
} from './credential-login-contracts.js';
const LOGIN_TTL_MS = 15 * 60 * 1000;
interface ChatgptLoginAttemptRecord {
  readonly id: string;
  readonly actor: LoginActor;
  readonly draft: LoginDraft;
  readonly nodeId: string;
  readonly nonce: string;
  readonly targetRevision?: number | undefined;
  readonly clientId?: string | undefined;
  readonly subject?: string | undefined;
  expiresAt: number;
  timer: NodeJS.Timeout;
  pending?: CodexLoginAttempt;
  terminal?: CodexLoginAttempt;
  flight?: Promise<CodexLoginAttempt> | undefined;
}
export type ChatgptNodeRequest = (
  actor: LoginActor,
  nodeId: string,
  operation: string,
  data: unknown
) => Promise<unknown>;

/** Owns transient Node-mediated ChatGPT login attempts. */
export class ChatgptLoginService {
  private readonly attempts = new Map<string, ChatgptLoginAttemptRecord>();
  private closed = false;
  constructor(
    private readonly node: ChatgptNodeRequest | undefined,
    private readonly prepareDraft: (
      actor: LoginActor,
      raw: unknown,
      type: CredentialRecord['type']
    ) => Promise<{ draft: LoginDraft; target: CredentialRecord | undefined }>,
    private readonly requireManaged: (
      userId: number,
      credentialId: string
    ) => Promise<CredentialRecord>,
    private readonly scopes: CredentialScopePolicy,
    private readonly request: (
      url: string,
      method: string,
      proxy: string | undefined,
      headers: Record<string, string>
    ) => Promise<Response>,
    private readonly mutate: <T>(
      fn: (document: CredentialDocument) => T | Promise<T>
    ) => Promise<T>,
    private readonly recordAudit: (
      userId: number,
      credential: CredentialRecord,
      event: string
    ) => void,
    private readonly now: () => number,
    private readonly id: () => string
  ) {}
  get size(): number {
    return this.attempts.size;
  }
  has(id: string): boolean {
    return this.attempts.has(id);
  }
  close(): void {
    this.closed = true;
    for (const attempt of this.attempts.values()) {
      clearTimeout(attempt.timer);
      void this.node?.(attempt.actor, attempt.nodeId, 'chatgpt.login.cancel', {
        attemptId: attempt.id
      }).catch(() => undefined);
    }
    this.attempts.clear();
  }
  async cancel(actor: LoginActor, id: string): Promise<void> {
    const attempt = this.#ownedChatgptAttempt(actor, id);
    this.attempts.delete(id);
    clearTimeout(attempt.timer);
    await this.node!(actor, attempt.nodeId, 'chatgpt.login.cancel', { attemptId: id }).catch(
      () => undefined
    );
  }
  async start(actor: LoginActor, raw: unknown, registered: () => void): Promise<CodexLoginAttempt> {
    if (!this.node || this.closed) throw new Error('CHATGPT_LOGIN_UNAVAILABLE');
    const data = asRecord(raw);
    const nodeId = requiredString(data['nodeId'], 128);
    const { type: _type, nodeId: _nodeId, ...input } = data;
    const { draft, target } = await this.prepareDraft(actor, input, 'CHATGPT_OAUTH');
    if (this.closed) throw new Error('CHATGPT_LOGIN_UNAVAILABLE');
    const id = this.id();
    const nonce = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    const expiresAt = this.now() + LOGIN_TTL_MS;
    const expire = () => {
      this.attempts.delete(id);
      void this.node?.(actor, nodeId, 'chatgpt.login.cancel', { attemptId: id }).catch(
        () => undefined
      );
    };
    const timer = setTimeout(expire, LOGIN_TTL_MS);
    timer.unref();
    const attempt: ChatgptLoginAttemptRecord = {
      id,
      actor: { ...actor },
      draft,
      nodeId,
      nonce,
      expiresAt,
      timer,
      targetRevision: target?.revision,
      clientId: target?.chatgpt?.clientId,
      subject: target?.chatgpt?.subject
    };
    this.attempts.set(id, attempt);
    registered();
    try {
      const status = chatgptNodeLoginStatusSchema.parse(
        await this.node(actor, nodeId, 'chatgpt.login.start', {
          attemptId: id,
          nonce,
          ...(attempt.clientId ? { clientId: attempt.clientId, subject: attempt.subject } : {}),
          ...(draft.socks5Url ? { socks5Url: draft.socks5Url } : {})
        })
      );
      if (status.status !== 'PENDING') throw new Error('CHATGPT_LOGIN_RESPONSE_INVALID');
      const uri = new URL(status.verificationUri);
      if (
        uri.protocol !== 'http:' ||
        uri.hostname !== '127.0.0.1' ||
        uri.pathname !== '/auth/start' ||
        uri.username ||
        uri.password ||
        !uri.searchParams.get('ticket')
      )
        throw new Error('CHATGPT_LOGIN_RESPONSE_INVALID');
      attempt.expiresAt = Math.min(expiresAt, status.expiresAt);
      if (attempt.expiresAt <= this.now() || this.attempts.get(id) !== attempt)
        throw new Error('CHATGPT_LOGIN_RESPONSE_INVALID');
      clearTimeout(attempt.timer);
      attempt.timer = setTimeout(expire, attempt.expiresAt - this.now());
      attempt.timer.unref();
      attempt.pending = codexLoginAttemptSchema.parse({
        id,
        type: 'CHATGPT_OAUTH',
        status: 'PENDING',
        verificationUri: status.verificationUri,
        expiresAt: attempt.expiresAt,
        pollIntervalMs: 2000
      });
      return attempt.pending;
    } catch {
      this.attempts.delete(id);
      clearTimeout(attempt.timer);
      await this.node(actor, nodeId, 'chatgpt.login.cancel', { attemptId: id }).catch(
        () => undefined
      );
      throw new Error('CHATGPT_LOGIN_START_FAILED');
    }
  }

  #ownedChatgptAttempt(actor: LoginActor, id: string): ChatgptLoginAttemptRecord {
    const attempt = this.attempts.get(id);
    if (
      !attempt ||
      attempt.actor.userId !== actor.userId ||
      attempt.actor.sessionFingerprint !== actor.sessionFingerprint
    )
      throw new Error('CODEX_LOGIN_ATTEMPT_NOT_FOUND');
    return attempt;
  }

  async poll(
    actor: LoginActor,
    id: string,
    validateCommit?: () => void
  ): Promise<CodexLoginAttempt> {
    const attempt = this.#ownedChatgptAttempt(actor, id);
    if (attempt.draft.targetCredentialId)
      await this.requireManaged(actor.userId, attempt.draft.targetCredentialId);
    else await this.scopes.assertActorCanSelectOwnership(actor.userId, attempt.draft.ownership);
    if (attempt.terminal) return attempt.terminal;
    if (this.now() >= attempt.expiresAt)
      return codexLoginAttemptSchema.parse({ id, type: 'CHATGPT_OAUTH', status: 'EXPIRED' });
    if (attempt.flight) return attempt.flight;
    attempt.flight = this.#completeChatgptLogin(attempt, validateCommit).finally(() => {
      attempt.flight = undefined;
    });
    return attempt.flight;
  }

  async #completeChatgptLogin(
    attempt: ChatgptLoginAttemptRecord,
    validateCommit?: () => void
  ): Promise<CodexLoginAttempt> {
    try {
      const status = chatgptNodeLoginStatusSchema.parse(
        await this.node!(attempt.actor, attempt.nodeId, 'chatgpt.login.status', {
          attemptId: attempt.id
        })
      );
      if (status.status === 'PENDING') return attempt.pending!;
      if (status.status === 'FAILED') throw new Error(status.code);
      const result = status.result;
      if (
        result.attemptId !== attempt.id ||
        result.clientId === 'dynamic_agent_client' ||
        (attempt.clientId && result.clientId !== attempt.clientId) ||
        !result.tokens.id_token
      )
        throw new Error('CHATGPT_LOGIN_RESPONSE_INVALID');
      const jwks = await this.request(CHATGPT_JWKS_ENDPOINT, 'GET', attempt.draft.socks5Url, {});
      if (!jwks.ok) throw new Error('CHATGPT_IDENTITY_INVALID');
      const identity = await verifyChatgptIdentity(result.tokens.id_token, await safeJson(jwks), {
        clientId: result.clientId,
        nonce: attempt.nonce,
        subject: attempt.subject,
        now: this.now()
      });
      const candidate: CredentialRecord = {
        id: attempt.draft.targetCredentialId ?? attempt.id,
        name: attempt.draft.name,
        type: 'CHATGPT_OAUTH',
        ownership: attempt.draft.ownership,
        status: 'ACTIVE',
        accessToken: result.tokens.access_token,
        refreshToken: result.tokens.refresh_token ?? '',
        accountId: identity.subject,
        accessTokenExpiresAt: this.now() + result.tokens.expires_in * 1000,
        lastRefreshAt: this.now(),
        lastCheckedAt: this.now(),
        proxy: attempt.draft.socks5Url ?? null,
        revision: 1,
        createdAt: this.now(),
        updatedAt: this.now(),
        chatgpt: {
          clientId: result.clientId,
          issuer: CHATGPT_ISSUER,
          subject: identity.subject,
          idToken: result.tokens.id_token,
          scopes: result.tokens.scope.split(/\s+/u).filter(Boolean),
          earliestRefreshAt:
            result.tokens.earliest_refresh_at === undefined
              ? null
              : result.tokens.earliest_refresh_at * 1000,
          hostId: result.hostId
        }
      };
      // Recheck Node access and the live attempt after asynchronous identity validation.
      const currentStatus = chatgptNodeLoginStatusSchema.parse(
        await this.node!(attempt.actor, attempt.nodeId, 'chatgpt.login.status', {
          attemptId: attempt.id
        })
      );
      if (currentStatus.status !== 'SUCCEEDED') throw new Error('CHATGPT_LOGIN_RESPONSE_INVALID');
      const saved = await this.mutate(async (document) => {
        if (this.attempts.get(attempt.id) !== attempt || this.now() >= attempt.expiresAt)
          throw new Error('CHATGPT_LOGIN_EXPIRED');
        const index = document.credentials.findIndex((c) => c.id === candidate.id);
        const existing = document.credentials[index];
        if (
          attempt.targetRevision !== undefined &&
          (!existing ||
            existing.revision !== attempt.targetRevision ||
            existing.type !== 'CHATGPT_OAUTH')
        )
          throw new Error('CHATGPT_CREDENTIAL_CHANGED');
        if (
          existing &&
          !(await this.scopes.canActorManageOwnership(attempt.actor.userId, existing.ownership))
        )
          throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
        await this.scopes.assertActorCanSelectOwnership(attempt.actor.userId, candidate.ownership);
        if (existing && !sameOwnership(existing.ownership, candidate.ownership))
          await this.scopes.assertCredentialScopeChangeAllowed(existing.id, candidate.ownership);
        validateCommit?.();
        if (this.attempts.get(attempt.id) !== attempt || this.now() >= attempt.expiresAt)
          throw new Error('CHATGPT_LOGIN_EXPIRED');
        if (
          document.credentials.some(
            (credential) =>
              credential.id !== candidate.id &&
              sameOwnership(credential.ownership, candidate.ownership) &&
              normalizeName(credential.name) === normalizeName(candidate.name)
          )
        )
          throw new Error('CODEX_CREDENTIAL_NAME_CONFLICT');
        const next = {
          ...candidate,
          revision: (existing?.revision ?? 0) + 1,
          createdAt: existing?.createdAt ?? candidate.createdAt
        };
        if (index < 0) {
          if (document.credentials.length >= MAX_CREDENTIALS)
            throw new Error('CODEX_CREDENTIAL_LIMIT_REACHED');
          document.credentials.push(next);
        } else document.credentials[index] = next;
        return next;
      });
      this.recordAudit(attempt.actor.userId, saved, 'credential.saved');
      attempt.terminal = codexLoginAttemptSchema.parse({
        id: attempt.id,
        type: 'CHATGPT_OAUTH',
        status: 'SUCCEEDED',
        credentialId: saved.id
      });
      await this.node!(attempt.actor, attempt.nodeId, 'chatgpt.login.ack', {
        attemptId: attempt.id
      }).catch(() => undefined);
      return attempt.terminal;
    } catch (error) {
      const code =
        error instanceof Error && /^(CHATGPT|CODEX)_[A-Z0-9_]+$/u.test(error.message)
          ? error.message
          : 'CHATGPT_LOGIN_FAILED';
      attempt.terminal = codexLoginAttemptSchema.parse({
        id: attempt.id,
        type: 'CHATGPT_OAUTH',
        status: 'FAILED',
        code,
        message: 'ChatGPT login could not be saved.'
      });
      await this.node!(attempt.actor, attempt.nodeId, 'chatgpt.login.cancel', {
        attemptId: attempt.id
      }).catch(() => undefined);
      return attempt.terminal;
    }
  }
}
