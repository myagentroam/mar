import { emitAudit, resourceAuditEvent, type AuditObserver, type AuditEvent } from './audit.js';
import { XaiLoginService } from './xai-login-service.js';
import {
  XaiOAuthProvider,
  XaiOAuthError,
  xaiTokenFields,
  scopes as xaiScopes,
  normalizeXaiCatalog,
  normalizeXaiUsage,
  assertXaiResponse
} from './xai-oauth-provider.js';
import {
  CODEX_CREDENTIAL_SETTING_KEY as CREDENTIAL_SETTING_KEY,
  CODEX_CREDENTIAL_DOCUMENT_VERSION as DOCUMENT_VERSION,
  CODEX_MAX_CREDENTIALS as MAX_CREDENTIALS,
  CODEX_MAX_DOCUMENT_BYTES as MAX_DOCUMENT_BYTES,
  credentialRecordSchema,
  parseCredentialDocument,
  normalizeCredentialName as normalizeName,
  isValidSocks5Url,
  type CredentialRecord,
  type CredentialDocument
} from './credential-document.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { Socks5ProxyAgent, type Dispatcher } from 'undici';
import { z } from 'zod';
import type { ResourceOwnership } from '@myagentroam/protocol';
import {
  CHATGPT_RESOURCE,
  XAI_SUBSCRIPTION_BASE_URL,
  CHATGPT_TOKEN_ENDPOINT,
  CHATGPT_JWKS_ENDPOINT,
  CHATGPT_REVOKE_ENDPOINT,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_ISSUER,
  chatgptNodeLoginStatusSchema,
  chatgptTokenResponseSchema,
  verifyChatgptIdentity,
  codexCredentialDetailsSchema,
  codexCredentialSummarySchema,
  codexCredentialUsageSchema,
  codexLoginAttemptSchema,
  codexModelCatalogSchema,
  codexUsageProfileSchema,
  resolveMarAgentDefaultReasoningEffort,
  runnerUsageSchema,
  type CodexCredentialDetails,
  type CodexCredentialOwnership,
  type CodexCredentialSummary,
  type CodexCredentialUsage,
  type CodexLoginAttempt,
  type CodexModelCatalog,
  type ResolvedRuntimeCredential,
  type RunnerUsage,
  type RunnerUsageWindow
} from '@myagentroam/protocol';
import type {
  CredentialScopePolicy,
  CredentialOwnershipReader
} from './credential-scope-policy.js';

const LOGIN_TTL_MS = 15 * 60 * 1000;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const REFRESH_FALLBACK_MS = 8 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_CHECK_MS = 24 * 60 * 60 * 1000;
export const CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS = 60_000;
const BACKGROUND_CONCURRENCY = 4;
const BACKGROUND_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const ORIGINATOR = 'myagentroam';
const DEFAULT_AUTH_ISSUER = 'https://auth.openai.com';
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_CATALOG_CLIENT_VERSION = '99.99.99';
const USAGE_RESPONSE_MAX_BYTES = 256 * 1024;
const RESPONSE_BODY_LIMIT_EXCEEDED = 'CODEX_RESPONSE_BODY_LIMIT_EXCEEDED';
const SUPPORTED_REASONING = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const PERMANENT_REFRESH_CODES = new Set([
  'invalid_grant',
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated'
]);

const credentialOwnershipInputSchema = z.discriminatedUnion('ownerType', [
  z
    .object({
      ownerType: z.literal('PERSONAL'),
      ownerUserId: z.number().int().positive().optional()
    })
    .strict(),
  z
    .object({
      ownerType: z.literal('ORGANIZATION'),
      ownerOrganizationId: z.number().int().positive()
    })
    .strict()
]);
const loginDraftObjectSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    ownership: credentialOwnershipInputSchema,
    socks5Url: z.string().url().max(2048).optional(),
    targetCredentialId: z.string().trim().min(1).max(128).optional()
  })
  .strict();
const loginDraftSchema = loginDraftObjectSchema.superRefine((draft, context) => {
  if (draft.socks5Url !== undefined && !isValidSocks5Url(draft.socks5Url))
    context.addIssue({
      code: 'custom',
      path: ['socks5Url'],
      message: 'SOCKS5 proxy is required'
    });
});
const credentialUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    ownership: credentialOwnershipInputSchema.optional(),
    socks5Url: z.string().url().max(2048).nullable().optional()
  })
  .strict()
  .superRefine((draft, context) => {
    if (
      draft.socks5Url !== undefined &&
      draft.socks5Url !== null &&
      !isValidSocks5Url(draft.socks5Url)
    )
      context.addIssue({
        code: 'custom',
        path: ['socks5Url'],
        message: 'SOCKS5 proxy is required'
      });
  });

type LoginDraft = Omit<z.infer<typeof loginDraftSchema>, 'ownership'> & {
  readonly ownership: CodexCredentialOwnership;
};
type ResolveReason =
  'STARTUP' | 'ADMIN' | 'CATALOG' | 'USAGE' | 'TEST' | 'RUNTIME' | 'EXPIRING' | 'UNAUTHORIZED';
type BackgroundResolveReason = Extract<ResolveReason, 'STARTUP' | 'EXPIRING'>;

export interface CodexCredentialMaintenanceResult {
  readonly attempted: number;
  readonly deferred: number;
  readonly failed: number;
}

interface LoginActor {
  readonly userId: number;
  readonly sessionFingerprint: string;
}

interface LoginAttemptRecord {
  readonly id: string;
  readonly actor: LoginActor;
  readonly draft: LoginDraft;
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
  readonly pollIntervalMs: number;
  nextPollAt: number;
}

interface RefreshFlight {
  readonly force: boolean;
  readonly promise: Promise<CredentialRecord>;
}

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
  readonly timer: NodeJS.Timeout;
  pending?: CodexLoginAttempt;
  terminal?: CodexLoginAttempt;
  flight?: Promise<CodexLoginAttempt> | undefined;
}
type ChatgptNodeRequest = (
  actor: LoginActor,
  nodeId: string,
  operation: string,
  data: unknown
) => Promise<unknown>;

interface BackgroundFailure {
  readonly failures: number;
  readonly nextAttemptAt: number;
}

interface ConditionalCredentialMutation {
  readonly credential: CredentialRecord;
  readonly applied: boolean;
}

export interface CodexCredentialServiceOptions {
  readonly createScopePolicy: (readOwnership: CredentialOwnershipReader) => CredentialScopePolicy;
  readonly request?: typeof fetch;
  readonly now?: () => number;
  readonly id?: () => string;
  readonly authIssuer?: string;
  readonly codexBaseUrl?: string;
  readonly clientId?: string | undefined;
  readonly projectVersion?: string;
}

export class CodexCredentialService {
  readonly #xai: XaiOAuthProvider;
  readonly #xaiLogins: XaiLoginService;
  #chatgptNode: ChatgptNodeRequest | undefined;
  readonly #chatgptAttempts = new Map<string, ChatgptLoginAttemptRecord>();
  readonly #request: typeof fetch;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #authIssuer: string;
  readonly #codexBaseUrl: string;
  readonly #codexUsageUrl: string;
  readonly #codexProfileUsageUrl: string;
  readonly #clientId: string;
  readonly #userAgent: string;
  readonly #attempts = new Map<string, LoginAttemptRecord>();
  readonly #refreshFlights = new Map<string, RefreshFlight>();
  readonly #catalogFlights = new Map<string, Promise<CodexModelCatalog>>();
  readonly #backgroundFailures = new Map<string, BackgroundFailure>();
  readonly #scopes: CredentialScopePolicy;
  #maintenanceFlight: Promise<CodexCredentialMaintenanceResult> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  configureChatgptLogin(request: ChatgptNodeRequest): void {
    this.#chatgptNode = request;
  }

  closeChatgptLogins(): void {
    this.#xaiLogins.close();
    for (const attempt of this.#attempts.values()) this.#deleteAttempt(attempt);
    for (const attempt of this.#chatgptAttempts.values()) {
      clearTimeout(attempt.timer);
      void this.#chatgptNode?.(attempt.actor, attempt.nodeId, 'chatgpt.login.cancel', {
        attemptId: attempt.id
      }).catch(() => undefined);
    }
    this.#chatgptAttempts.clear();
  }

  async credentialTarget(actorUserId: number, credentialId: string): Promise<string> {
    const credential = await this.#requireManagedCredential(actorUserId, credentialId);
    if (credential.type === 'CHATGPT_OAUTH')
      await this.assertUserInScope(actorUserId, credentialId);
    return this.#credentialBaseUrl(credential.type);
  }

  #credentialBaseUrl(type: CredentialRecord['type']): string {
    return type === 'XAI_OAUTH'
      ? XAI_SUBSCRIPTION_BASE_URL
      : type === 'CHATGPT_OAUTH'
        ? CHATGPT_RESOURCE
        : this.#codexBaseUrl;
  }

  async assertCredentialTarget(
    actorUserId: number,
    credentialId: string,
    baseUrl: string,
    fastMode?: boolean
  ): Promise<void> {
    const credential = await this.#requireManagedCredential(actorUserId, credentialId);
    if (credential.type === 'CHATGPT_OAUTH')
      await this.assertUserInScope(actorUserId, credentialId);
    await this.assertStoredCredentialTarget(credentialId, baseUrl, fastMode);
  }

  async type(credentialId: string): Promise<CredentialRecord['type']> {
    return (await this.#requireCredential(credentialId)).type;
  }

  async assertStoredCredentialTarget(
    credentialId: string,
    baseUrl: string,
    _fastMode?: boolean
  ): Promise<void> {
    const expected = this.#credentialBaseUrl(await this.type(credentialId));
    if (baseUrl !== expected) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  }

  async #startChatgptLogin(actor: LoginActor, raw: unknown): Promise<CodexLoginAttempt> {
    if (!this.#chatgptNode) throw new Error('CHATGPT_LOGIN_UNAVAILABLE');
    const data = asRecord(raw);
    const nodeId = requiredString(data['nodeId'], 128);
    const { type: _type, nodeId: _nodeId, ...input } = data;
    const { draft, target } = await this.#prepareLoginDraft(actor, input, 'CHATGPT_OAUTH');
    const id = this.#id();
    const nonce = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    const expiresAt = this.#now() + LOGIN_TTL_MS;
    const timer = setTimeout(() => {
      this.#chatgptAttempts.delete(id);
      void this.#chatgptNode?.(actor, nodeId, 'chatgpt.login.cancel', { attemptId: id }).catch(
        () => undefined
      );
    }, LOGIN_TTL_MS);
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
    this.#chatgptAttempts.set(id, attempt);
    try {
      const status = chatgptNodeLoginStatusSchema.parse(
        await this.#chatgptNode(actor, nodeId, 'chatgpt.login.start', {
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
      if (attempt.expiresAt <= this.#now()) throw new Error('CHATGPT_LOGIN_RESPONSE_INVALID');
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
      this.#chatgptAttempts.delete(id);
      clearTimeout(timer);
      await this.#chatgptNode(actor, nodeId, 'chatgpt.login.cancel', { attemptId: id }).catch(
        () => undefined
      );
      throw new Error('CHATGPT_LOGIN_START_FAILED');
    }
  }

  #ownedChatgptAttempt(actor: LoginActor, id: string): ChatgptLoginAttemptRecord {
    const attempt = this.#chatgptAttempts.get(id);
    if (
      !attempt ||
      attempt.actor.userId !== actor.userId ||
      attempt.actor.sessionFingerprint !== actor.sessionFingerprint
    )
      throw new Error('CODEX_LOGIN_ATTEMPT_NOT_FOUND');
    return attempt;
  }

  async #chatgptLoginAttempt(
    actor: LoginActor,
    id: string,
    validateCommit?: () => void
  ): Promise<CodexLoginAttempt> {
    const attempt = this.#ownedChatgptAttempt(actor, id);
    if (attempt.draft.targetCredentialId)
      await this.#requireManagedCredential(actor.userId, attempt.draft.targetCredentialId);
    else await this.#scopes.assertActorCanSelectOwnership(actor.userId, attempt.draft.ownership);
    if (attempt.terminal) return attempt.terminal;
    if (this.#now() >= attempt.expiresAt)
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
        await this.#chatgptNode!(attempt.actor, attempt.nodeId, 'chatgpt.login.status', {
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
      const jwks = await this.#requestWithProxy(
        CHATGPT_JWKS_ENDPOINT,
        'GET',
        attempt.draft.socks5Url,
        {}
      );
      if (!jwks.ok) throw new Error('CHATGPT_IDENTITY_INVALID');
      const identity = await verifyChatgptIdentity(result.tokens.id_token, await safeJson(jwks), {
        clientId: result.clientId,
        nonce: attempt.nonce,
        subject: attempt.subject,
        now: this.#now()
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
        accessTokenExpiresAt: this.#now() + result.tokens.expires_in * 1000,
        lastRefreshAt: this.#now(),
        lastCheckedAt: this.#now(),
        proxy: attempt.draft.socks5Url ?? null,
        revision: 1,
        createdAt: this.#now(),
        updatedAt: this.#now(),
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
        await this.#chatgptNode!(attempt.actor, attempt.nodeId, 'chatgpt.login.status', {
          attemptId: attempt.id
        })
      );
      if (currentStatus.status !== 'SUCCEEDED') throw new Error('CHATGPT_LOGIN_RESPONSE_INVALID');
      const saved = await this.#mutateDocument(async (document) => {
        if (this.#chatgptAttempts.get(attempt.id) !== attempt || this.#now() >= attempt.expiresAt)
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
          !(await this.#scopes.canActorManageOwnership(attempt.actor.userId, existing.ownership))
        )
          throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
        await this.#scopes.assertActorCanSelectOwnership(attempt.actor.userId, candidate.ownership);
        if (existing && !sameOwnership(existing.ownership, candidate.ownership))
          await this.#scopes.assertCredentialScopeChangeAllowed(existing.id, candidate.ownership);
        validateCommit?.();
        if (this.#chatgptAttempts.get(attempt.id) !== attempt || this.#now() >= attempt.expiresAt)
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
      this.#recordAudit(attempt.actor.userId, saved, 'credential.saved');
      attempt.terminal = codexLoginAttemptSchema.parse({
        id: attempt.id,
        type: 'CHATGPT_OAUTH',
        status: 'SUCCEEDED',
        credentialId: saved.id
      });
      await this.#chatgptNode!(attempt.actor, attempt.nodeId, 'chatgpt.login.ack', {
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
      await this.#chatgptNode!(attempt.actor, attempt.nodeId, 'chatgpt.login.cancel', {
        attemptId: attempt.id
      }).catch(() => undefined);
      return attempt.terminal;
    }
  }

  constructor(
    private readonly database: { readonly raw: Pool } & Partial<AuditObserver>,
    options: CodexCredentialServiceOptions
  ) {
    this.#scopes = options.createScopePolicy(
      async (credentialId) =>
        (await this.#readDocument()).credentials.find((value) => value.id === credentialId)
          ?.ownership
    );
    this.#request = options.request ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#authIssuer = normalizedHttpsBase(options.authIssuer ?? DEFAULT_AUTH_ISSUER);
    this.#codexBaseUrl = normalizedHttpsBase(options.codexBaseUrl ?? DEFAULT_CODEX_BASE_URL);
    this.#codexUsageUrl = codexUsageUrl(this.#codexBaseUrl);
    this.#codexProfileUsageUrl = codexProfileUsageUrl(this.#codexBaseUrl);
    this.#clientId = boundedText(options.clientId ?? DEFAULT_CLIENT_ID, 512);
    const projectVersion = boundedText(options.projectVersion ?? 'unknown', 128);
    this.#userAgent = `MyAgentRoam/${projectVersion} (${process.platform}; ${process.arch})`;
    this.#xai = new XaiOAuthProvider(async (url, method, proxy, headers, body) => {
      try {
        return await this.#requestWithProxy(url, method, proxy, headers, body, {
          maxResponseBytes: 256 * 1024
        });
      } catch (error) {
        if (error instanceof Error && error.message === RESPONSE_BODY_LIMIT_EXCEEDED)
          throw new XaiOAuthError('XAI_RESPONSE_INVALID');
        throw new XaiOAuthError('XAI_REQUEST_FAILED');
      }
    }, projectVersion);
    this.#xaiLogins = new XaiLoginService(this.#xai, this.#now, this.#id);
  }

  async list(actorUserId: number): Promise<readonly CodexCredentialSummary[]> {
    const document = await this.#readDocument();
    const visible = await Promise.all(
      document.credentials.map(async (credential) =>
        (await this.#scopes.canActorManageOwnership(actorUserId, credential.ownership))
          ? codexCredentialSummarySchema.parse(summary(credential))
          : null
      )
    );
    return visible.filter(
      (credential): credential is CodexCredentialSummary => credential !== null
    );
  }

  async details(actorUserId: number, credentialId: string): Promise<CodexCredentialDetails> {
    const credential = await this.#requireManagedCredential(actorUserId, credentialId);
    return codexCredentialDetailsSchema.parse({
      credential: summary(credential),
      socks5Url: credential.proxy
    });
  }

  async usage(actorUserId: number, credentialId: string): Promise<CodexCredentialUsage> {
    const managed = await this.#requireManagedCredential(actorUserId, credentialId);
    if (managed.type === 'CHATGPT_OAUTH') throw new Error('CHATGPT_USAGE_UNAVAILABLE');
    if (managed.type === 'XAI_OAUTH') return this.#xaiUsage(credentialId);
    try {
      for (let freshnessAttempt = 0; freshnessAttempt < 2; freshnessAttempt++) {
        let credential = await this.#resolveRecord(credentialId, 'USAGE', false);
        let rateLimitResponse = await this.#usageResponse(credential);
        if (rateLimitResponse.status === 401) {
          credential = await this.#resolveRecord(credentialId, 'UNAUTHORIZED', true);
          rateLimitResponse = await this.#usageResponse(credential);
        }
        if (rateLimitResponse.status === 401) {
          const marked = await this.#markReauthenticationRequired(credentialId, credential);
          if (!marked.applied) continue;
          throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
        }
        if (rateLimitResponse.status === 429) throw new Error('CODEX_USAGE_RATE_LIMITED');
        if (!rateLimitResponse.ok) throw new Error('CODEX_USAGE_LOAD_FAILED');
        let profileResponse = await this.#profileUsageResponse(credential);
        if (profileResponse.status === 401) {
          credential = await this.#resolveRecord(credentialId, 'UNAUTHORIZED', true);
          rateLimitResponse = await this.#usageResponse(credential);
          if (rateLimitResponse.status === 401) {
            const marked = await this.#markReauthenticationRequired(credentialId, credential);
            if (!marked.applied) continue;
            throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
          }
          if (rateLimitResponse.status === 429) throw new Error('CODEX_USAGE_RATE_LIMITED');
          if (!rateLimitResponse.ok) throw new Error('CODEX_USAGE_LOAD_FAILED');
          profileResponse = await this.#profileUsageResponse(credential);
        }
        if (profileResponse.status === 401) {
          const marked = await this.#markReauthenticationRequired(credentialId, credential);
          if (!marked.applied) continue;
          throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
        }
        if (profileResponse.status === 429) throw new Error('CODEX_USAGE_RATE_LIMITED');
        if (!profileResponse.ok) throw new Error('CODEX_USAGE_LOAD_FAILED');
        try {
          return normalizeCredentialUsage(
            await safeJson(rateLimitResponse),
            await safeJson(profileResponse),
            this.#now()
          );
        } catch {
          throw new Error('CODEX_USAGE_RESPONSE_INVALID');
        }
      }
      throw new Error('CODEX_USAGE_LOAD_FAILED');
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'CODEX_CREDENTIAL_NOT_FOUND' ||
          error.message === 'CODEX_CREDENTIAL_REAUTH_REQUIRED' ||
          error.message === 'CODEX_CREDENTIAL_REFRESH_TRANSIENT' ||
          error.message === 'CODEX_CREDENTIAL_UNAVAILABLE' ||
          error.message === 'CODEX_USAGE_RATE_LIMITED' ||
          error.message === 'CODEX_USAGE_RESPONSE_INVALID' ||
          error.message === 'CODEX_USAGE_LOAD_FAILED')
      )
        throw error;
      throw new Error('CODEX_USAGE_LOAD_FAILED');
    }
  }

  maintain(reason: BackgroundResolveReason): Promise<CodexCredentialMaintenanceResult> {
    if (this.#maintenanceFlight !== undefined) return this.#maintenanceFlight;
    const flight = this.#runMaintenance(reason).finally(() => {
      if (this.#maintenanceFlight === flight) this.#maintenanceFlight = undefined;
    });
    this.#maintenanceFlight = flight;
    return flight;
  }

  async #prepareLoginDraft(actor: LoginActor, raw: unknown, type: CredentialRecord['type']) {
    const parsed = loginDraftSchema.safeParse(raw);
    if (!parsed.success) throw new Error('CODEX_CREDENTIAL_INPUT_INVALID');
    const ownership = credentialOwnership(actor.userId, parsed.data.ownership);
    const document = await this.#readDocument();
    const target =
      parsed.data.targetCredentialId === undefined
        ? undefined
        : document.credentials.find(
            (credential) => credential.id === parsed.data.targetCredentialId
          );
    if (parsed.data.targetCredentialId !== undefined && target === undefined)
      throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
    if (
      target !== undefined &&
      !(await this.#scopes.canActorManageOwnership(actor.userId, target.ownership))
    )
      throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
    if (target === undefined || !sameOwnership(target.ownership, ownership))
      await this.#scopes.assertActorCanSelectOwnership(actor.userId, ownership);
    if (target !== undefined && !sameOwnership(target.ownership, ownership))
      await this.#scopes.assertCredentialScopeChangeAllowed(target.id, ownership);
    const draft: LoginDraft = {
      ...parsed.data,
      ownership
    };
    const normalized = normalizeName(draft.name);
    if (
      document.credentials.some(
        (credential) =>
          normalizeName(credential.name) === normalized &&
          sameOwnership(credential.ownership, draft.ownership) &&
          credential.id !== draft.targetCredentialId
      )
    )
      throw new Error('CODEX_CREDENTIAL_NAME_CONFLICT');
    if (target !== undefined && target.type !== type)
      throw new Error('CODEX_CREDENTIAL_INPUT_INVALID');
    if (this.#attempts.size + this.#chatgptAttempts.size + this.#xaiLogins.size >= 128)
      throw new Error('CODEX_LOGIN_ATTEMPT_LIMIT_REACHED');
    return { draft, target };
  }

  async startLogin(actor: LoginActor, raw: unknown): Promise<CodexLoginAttempt> {
    if (asOptionalRecord(raw)?.['type'] === 'XAI_OAUTH') {
      const { type: _type, ...input } = asRecord(raw);
      const { draft, target } = await this.#prepareLoginDraft(actor, input, 'XAI_OAUTH');
      return this.#xaiLogins.start(actor, draft, target?.revision);
    }
    if (asOptionalRecord(raw)?.['type'] === 'CHATGPT_OAUTH')
      return this.#startChatgptLogin(actor, raw);
    const { draft } = await this.#prepareLoginDraft(actor, raw, 'CODEX_OAUTH');

    const response = await this.#requestWithProxy(
      `${this.#authIssuer}/api/accounts/deviceauth/usercode`,
      'POST',
      draft.socks5Url,
      {
        'content-type': 'application/json'
      },
      JSON.stringify({ client_id: this.#clientId })
    );
    if (!response.ok) throw new Error('CODEX_DEVICE_AUTH_UNAVAILABLE');
    const payload = asRecord(await safeJson(response));
    const deviceAuthId = requiredString(payload['device_auth_id'], 4096);
    const userCode = requiredString(payload['user_code'] ?? payload['usercode'], 128);
    const intervalSeconds = parsePositiveInteger(payload['interval'], 60) ?? 5;
    const id = this.#id();
    const timer = setTimeout(() => this.#deleteAttempt(attempt), LOGIN_TTL_MS);
    timer.unref();
    const attempt: LoginAttemptRecord = {
      id,
      actor: { ...actor },
      draft,
      deviceAuthId,
      userCode,
      verificationUri: `${this.#authIssuer}/codex/device`,
      expiresAt: this.#now() + LOGIN_TTL_MS,
      timer,
      pollIntervalMs: intervalSeconds * 1000,
      nextPollAt: this.#now()
    };
    this.#attempts.set(id, attempt);
    return publicPendingAttempt(attempt);
  }

  async loginAttempt(
    actor: LoginActor,
    attemptId: string,
    validateCommit?: () => void
  ): Promise<CodexLoginAttempt> {
    if (this.#xaiLogins.has(attemptId))
      return this.#xaiLogins.poll(
        actor,
        attemptId,
        async (draft, tokens, identity, targetRevision, assertCurrent, id) => {
          const saved = await this.#mutateDocument(async (document) => {
            const credentialId = draft.targetCredentialId ?? id;
            const index = document.credentials.findIndex((value) => value.id === credentialId);
            const current = document.credentials[index];
            if (
              draft.targetCredentialId !== undefined &&
              (!current || current.type !== 'XAI_OAUTH' || current.revision !== targetRevision)
            )
              throw new XaiOAuthError('XAI_LOGIN_CONFLICT');
            if (
              current &&
              !(await this.#scopes.canActorManageOwnership(actor.userId, current.ownership))
            )
              throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
            if (
              current &&
              (current.xai?.subject !== identity.subject ||
                current.accountId !== identity.accountId)
            )
              throw new XaiOAuthError('XAI_LOGIN_CONFLICT');
            await this.#scopes.assertActorCanSelectOwnership(actor.userId, draft.ownership);
            if (current && !sameOwnership(current.ownership, draft.ownership))
              await this.#scopes.assertCredentialScopeChangeAllowed(current.id, draft.ownership);
            if (
              document.credentials.some(
                (value) =>
                  value.id !== credentialId &&
                  sameOwnership(value.ownership, draft.ownership) &&
                  normalizeName(value.name) === normalizeName(draft.name)
              )
            )
              throw new Error('CODEX_CREDENTIAL_NAME_CONFLICT');
            if (!current && document.credentials.length >= MAX_CREDENTIALS)
              throw new Error('CODEX_CREDENTIAL_LIMIT_REACHED');
            assertCurrent();
            const now = this.#now();
            const next: CredentialRecord = {
              id: credentialId,
              type: 'XAI_OAUTH',
              name: draft.name,
              ownership: draft.ownership,
              status: 'ACTIVE',
              accountId: identity.accountId,
              xai: { subject: identity.subject, scopes: identity.scopes },
              ...xaiTokenFields(tokens, now),
              proxy: draft.socks5Url ?? null,
              revision: (current?.revision ?? 0) + 1,
              lastCheckedAt: null,
              createdAt: current?.createdAt ?? now,
              updatedAt: now
            };
            if (current) document.credentials[index] = next;
            else document.credentials.push(next);
            return next;
          });
          this.#recordAudit(actor.userId, saved, 'credential.saved');
          return saved.id;
        },
        validateCommit
      );
    if (this.#chatgptAttempts.has(attemptId))
      return this.#chatgptLoginAttempt(actor, attemptId, validateCommit);
    const attempt = this.#ownedAttempt(actor, attemptId);
    if (this.#now() >= attempt.expiresAt) {
      this.#deleteAttempt(attempt);
      return codexLoginAttemptSchema.parse({ id: attempt.id, status: 'EXPIRED' });
    }
    if (this.#now() < attempt.nextPollAt) return publicPendingAttempt(attempt);

    const poll = await this.#requestWithProxy(
      `${this.#authIssuer}/api/accounts/deviceauth/token`,
      'POST',
      attempt.draft.socks5Url,
      { 'content-type': 'application/json' },
      JSON.stringify({
        device_auth_id: attempt.deviceAuthId,
        user_code: attempt.userCode
      })
    );
    if (poll.status === 403 || poll.status === 404) {
      attempt.nextPollAt = this.#now() + attempt.pollIntervalMs;
      return publicPendingAttempt(attempt);
    }
    if (!poll.ok) {
      this.#deleteAttempt(attempt);
      return codexLoginAttemptSchema.parse({
        id: attempt.id,
        status: 'FAILED',
        code: 'CODEX_DEVICE_AUTH_FAILED',
        message: 'Codex device authorization failed.'
      });
    }

    try {
      const code = asRecord(await safeJson(poll));
      const authorizationCode = requiredString(code['authorization_code'], 8192);
      const codeVerifier = requiredString(code['code_verifier'], 8192);
      const tokenResponse = await this.#requestWithProxy(
        `${this.#authIssuer}/oauth/token`,
        'POST',
        attempt.draft.socks5Url,
        { 'content-type': 'application/x-www-form-urlencoded' },
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: authorizationCode,
          redirect_uri: `${this.#authIssuer}/deviceauth/callback`,
          client_id: this.#clientId,
          code_verifier: codeVerifier
        }).toString()
      );
      if (!tokenResponse.ok) throw new Error('CODEX_TOKEN_EXCHANGE_FAILED');
      const tokens = parseTokenResponse(await safeJson(tokenResponse), undefined);
      const credentialId = attempt.draft.targetCredentialId ?? attempt.id;
      const candidate = credentialFromTokens({
        id: credentialId,
        name: attempt.draft.name,
        ownership: attempt.draft.ownership,
        tokens,
        proxy: attempt.draft.socks5Url ?? null,
        now: this.#now(),
        revision: 1
      });
      await this.#requestCatalog(candidate);
      const saved = await this.#mutateDocument(async (document) => {
        const index = document.credentials.findIndex(
          (credential) => credential.id === credentialId
        );
        if (attempt.draft.targetCredentialId !== undefined && index < 0)
          throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
        const existing = index < 0 ? undefined : document.credentials[index];
        if (
          existing !== undefined &&
          !(await this.#scopes.canActorManageOwnership(attempt.actor.userId, existing.ownership))
        )
          throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
        if (existing === undefined || !sameOwnership(existing.ownership, attempt.draft.ownership)) {
          await this.#scopes.assertActorCanSelectOwnership(
            attempt.actor.userId,
            attempt.draft.ownership
          );
          if (existing !== undefined)
            await this.#scopes.assertCredentialScopeChangeAllowed(
              existing.id,
              attempt.draft.ownership
            );
        }
        const next = {
          ...candidate,
          revision: (existing?.revision ?? 0) + 1,
          createdAt: existing?.createdAt ?? candidate.createdAt,
          lastCheckedAt: this.#now(),
          updatedAt: this.#now()
        };
        if (index < 0) {
          if (document.credentials.length >= MAX_CREDENTIALS)
            throw new Error('CODEX_CREDENTIAL_LIMIT_REACHED');
          document.credentials.push(next);
        } else {
          document.credentials[index] = next;
        }
        return next;
      });
      this.#recordAudit(attempt.actor.userId, saved, 'credential.saved');
      this.#deleteAttempt(attempt);
      return codexLoginAttemptSchema.parse({
        id: attempt.id,
        status: 'SUCCEEDED',
        credentialId: saved.id
      });
    } catch (error) {
      this.#deleteAttempt(attempt);
      if (error instanceof Error && /^CODEX_[A-Z0-9_]+$/u.test(error.message))
        return codexLoginAttemptSchema.parse({
          id: attempt.id,
          status: 'FAILED',
          code: error.message,
          message: `Codex login failed (${error.message}).`
        });
      return codexLoginAttemptSchema.parse({
        id: attempt.id,
        status: 'FAILED',
        code: 'CODEX_LOGIN_FAILED',
        message: 'Codex login failed.'
      });
    }
  }

  async cancelLogin(actor: LoginActor, attemptId: string): Promise<void> {
    if (this.#xaiLogins.has(attemptId)) return this.#xaiLogins.cancel(actor, attemptId);
    if (this.#chatgptAttempts.has(attemptId)) {
      const attempt = this.#ownedChatgptAttempt(actor, attemptId);
      this.#chatgptAttempts.delete(attemptId);
      clearTimeout(attempt.timer);
      await this.#chatgptNode!(actor, attempt.nodeId, 'chatgpt.login.cancel', { attemptId }).catch(
        () => undefined
      );
      return;
    }
    const attempt = this.#ownedAttempt(actor, attemptId);
    this.#deleteAttempt(attempt);
  }

  async update(
    actorUserId: number,
    credentialId: string,
    raw: unknown
  ): Promise<CodexCredentialSummary> {
    const parsed = credentialUpdateSchema.safeParse(raw);
    if (!parsed.success || Object.keys(parsed.data).length === 0)
      throw new Error('CODEX_CREDENTIAL_INPUT_INVALID');
    const before = await this.#requireManagedCredential(actorUserId, credentialId);
    const updated = await this.#mutateDocument(async (document) => {
      const index = document.credentials.findIndex((credential) => credential.id === credentialId);
      if (index < 0) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
      const current = document.credentials[index]!;
      if (!(await this.#scopes.canActorManageOwnership(actorUserId, current.ownership)))
        throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
      const ownership =
        parsed.data.ownership === undefined
          ? current.ownership
          : credentialOwnership(actorUserId, parsed.data.ownership);
      if (!sameOwnership(current.ownership, ownership)) {
        await this.#scopes.assertActorCanSelectOwnership(actorUserId, ownership);
        await this.#scopes.assertCredentialScopeChangeAllowed(credentialId, ownership);
      }
      const name = parsed.data.name ?? current.name;
      if (
        document.credentials.some(
          (credential) =>
            credential.id !== credentialId &&
            sameOwnership(credential.ownership, ownership) &&
            normalizeName(credential.name) === normalizeName(name)
        )
      )
        throw new Error('CODEX_CREDENTIAL_NAME_CONFLICT');
      const next = credentialRecordSchema.parse({
        ...current,
        name,
        ownership,
        proxy:
          parsed.data.socks5Url === undefined ? current.proxy : (parsed.data.socks5Url ?? null),
        revision: current.revision + 1,
        updatedAt: this.#now()
      });
      document.credentials[index] = next;
      return next;
    });
    this.#recordAudit(actorUserId, updated, 'credential.updated', {
      before: {
        name: before.name,
        ownerType: before.ownership.ownerType,
        organizationId:
          before.ownership.ownerType === 'ORGANIZATION'
            ? before.ownership.ownerOrganizationId
            : undefined
      },
      after: {
        name: updated.name,
        ownerType: updated.ownership.ownerType,
        organizationId:
          updated.ownership.ownerType === 'ORGANIZATION'
            ? updated.ownership.ownerOrganizationId
            : undefined
      }
    });
    return codexCredentialSummarySchema.parse(summary(updated));
  }

  async remove(
    actorUserId: number,
    credentialId: string
  ): Promise<{ readonly warningCode?: string }> {
    await this.#requireManagedCredential(actorUserId, credentialId);
    const removed = await this.#mutateDocument(async (document) => {
      const index = document.credentials.findIndex((credential) => credential.id === credentialId);
      if (index < 0) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
      const current = document.credentials[index]!;
      if (!(await this.#scopes.canActorManageOwnership(actorUserId, current.ownership)))
        throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
      const count = (await this.#modelCounts()).get(credentialId) ?? 0;
      if (count > 0) throw new Error('CODEX_CREDENTIAL_IN_USE');
      return document.credentials.splice(index, 1)[0]!;
    });
    this.#recordAudit(actorUserId, removed, 'credential.deleted');
    try {
      const response =
        removed.type === 'XAI_OAUTH'
          ? await this.#xai.revoke(removed)
          : await this.#requestWithProxy(
              removed.type === 'CHATGPT_OAUTH'
                ? CHATGPT_REVOKE_ENDPOINT
                : `${this.#authIssuer}/oauth/revoke`,
              'POST',
              removed.proxy ?? undefined,
              { 'content-type': 'application/x-www-form-urlencoded' },
              new URLSearchParams({
                token: removed.refreshToken || removed.accessToken,
                token_type_hint: removed.refreshToken ? 'refresh_token' : 'access_token',
                client_id: removed.chatgpt?.clientId ?? this.#clientId
              }).toString()
            );
      const ok = response.ok;
      await response.body?.cancel().catch(() => undefined);
      return ok ? {} : { warningCode: 'CODEX_CREDENTIAL_REVOKE_FAILED' };
    } catch {
      return { warningCode: 'CODEX_CREDENTIAL_REVOKE_FAILED' };
    }
  }

  async refresh(actorUserId: number, credentialId: string): Promise<CodexCredentialSummary> {
    await this.#requireManagedCredential(actorUserId, credentialId);
    await this.#resolveRecord(credentialId, 'ADMIN', true);
    const value = (await this.list(actorUserId)).find(
      (credential) => credential.id === credentialId
    );
    if (!value) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
    this.#recordAudit(actorUserId, value, 'credential.refreshed');
    return value;
  }

  async test(
    actorUserId: number,
    credentialId: string
  ): Promise<{ readonly success: boolean; readonly code: string | null }> {
    const credential = await this.#requireManagedCredential(actorUserId, credentialId);
    try {
      await this.#resolveRecord(credentialId, 'TEST', true);
      await this.#loadCatalog(credentialId);
      this.#recordAudit(actorUserId, credential, 'credential.tested', {}, { result: 'SUCCESS' });
      return { success: true, code: null };
    } catch (error) {
      const result = {
        success: false,
        code:
          error instanceof Error && /^(CODEX|CHATGPT|XAI)_[A-Z0-9_]+$/u.test(error.message)
            ? error.message
            : 'CODEX_CREDENTIAL_TEST_FAILED'
      };
      this.#recordAudit(
        actorUserId,
        credential,
        'credential.tested',
        {},
        { result: 'FAILED', errorCode: result.code }
      );
      return result;
    }
  }

  async resolve(credentialId: string, reason: ResolveReason): Promise<ResolvedRuntimeCredential> {
    const credential = await this.#resolveRecord(
      credentialId,
      reason,
      reason === 'UNAUTHORIZED' || reason === 'ADMIN'
    );
    if (credential.chatgpt && !credential.chatgpt.scopes.includes(CHATGPT_PLAN_SCOPE))
      throw new Error('CHATGPT_PLAN_UNAUTHORIZED');
    return {
      bearer: credential.accessToken,
      headers:
        credential.type === 'XAI_OAUTH'
          ? this.#xai.headers(credential.accountId)
          : credential.type === 'CHATGPT_OAUTH'
            ? {}
            : {
                'ChatGPT-Account-ID': credential.accountId,
                originator: ORIGINATOR,
                'user-agent': this.#userAgent
              },
      ...(credential.proxy === null ? {} : { socks5Url: credential.proxy }),
      expiresAt: credential.accessTokenExpiresAt ?? this.#now() + REFRESH_FALLBACK_MS,
      revision: credential.revision
    };
  }

  async loadCatalog(actorUserId: number, credentialId: string): Promise<CodexModelCatalog> {
    await this.#requireManagedCredential(actorUserId, credentialId);
    return this.#loadCatalog(credentialId);
  }

  async assertUserInScope(userId: number, credentialId: string): Promise<void> {
    await this.#scopes.assertUserInCredentialScope(userId, credentialId);
    const credential = await this.#requireCredential(credentialId);
    if (credential.chatgpt && !credential.chatgpt.scopes.includes(CHATGPT_PLAN_SCOPE))
      throw new Error('CHATGPT_PLAN_UNAUTHORIZED');
  }

  async status(credentialId: string): Promise<CodexCredentialSummary['status']> {
    return (await this.#requireCredential(credentialId)).status;
  }

  async assertModelCredentialBinding(
    actorUserId: number,
    credentialId: string,
    modelId?: string
  ): Promise<void> {
    await this.#scopes.assertModelCredentialBinding(actorUserId, credentialId, modelId);
  }

  async #loadCatalog(credentialId: string): Promise<CodexModelCatalog> {
    const existing = this.#catalogFlights.get(credentialId);
    if (existing !== undefined) return existing;
    const flight = this.#loadCatalogUncached(credentialId).finally(() => {
      if (this.#catalogFlights.get(credentialId) === flight)
        this.#catalogFlights.delete(credentialId);
    });
    this.#catalogFlights.set(credentialId, flight);
    return flight;
  }

  async #loadCatalogUncached(credentialId: string): Promise<CodexModelCatalog> {
    for (let freshnessAttempt = 0; freshnessAttempt < 2; freshnessAttempt++) {
      let credential = await this.#resolveRecord(credentialId, 'CATALOG', false);
      let response = await this.#catalogResponse(credential);
      if (response.status === 401) {
        credential = await this.#resolveRecord(credentialId, 'UNAUTHORIZED', true);
        response = await this.#catalogResponse(credential);
      }
      if (response.status === 401) {
        const marked = await this.#markReauthenticationRequired(credentialId, credential);
        if (!marked.applied) continue;
        throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
      }
      if (credential.type === 'XAI_OAUTH') assertXaiResponse(response, 'XAI_CATALOG_LOAD_FAILED');
      if (!response.ok) throw new Error('CODEX_CATALOG_LOAD_FAILED');
      const catalog =
        credential.type === 'XAI_OAUTH'
          ? normalizeXaiCatalog(await safeJson(response), this.#now())
          : credential.type === 'CHATGPT_OAUTH'
            ? normalizeChatgptCatalog(await safeJson(response), this.#now())
            : normalizeCatalog(await safeJson(response), this.#now());
      const accepted = await this.#mutateDocument((document) => {
        const index = document.credentials.findIndex((value) => value.id === credentialId);
        if (index < 0) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
        const current = document.credentials[index]!;
        if (!sameCredentialRequest(current, credential)) return false;
        document.credentials[index] = {
          ...current,
          status: retainCredentialFailureStatus(current.status, credential.status),
          lastCheckedAt: this.#now(),
          revision: current.revision + 1,
          updatedAt: this.#now()
        };
        return true;
      });
      if (accepted) return catalog;
    }
    throw new Error('CODEX_CATALOG_LOAD_FAILED');
  }

  async #runMaintenance(
    reason: BackgroundResolveReason
  ): Promise<CodexCredentialMaintenanceResult> {
    const document = await this.#readDocument();
    const now = this.#now();
    const currentIds = new Set(document.credentials.map((credential) => credential.id));
    for (const credentialId of this.#backgroundFailures.keys())
      if (!currentIds.has(credentialId)) this.#backgroundFailures.delete(credentialId);

    let deferred = 0;
    const candidates = document.credentials.filter((credential) => {
      if (credential.status === 'REAUTH_REQUIRED' || !needsBackgroundMaintenance(credential, now))
        return false;
      const failure = this.#backgroundFailures.get(credential.id);
      if (failure !== undefined && failure.nextAttemptAt > now) {
        deferred++;
        return false;
      }
      return true;
    });
    let cursor = 0;
    let failed = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const credential = candidates[cursor++]!;
        try {
          const resolved = await this.#resolveRecord(credential.id, reason, false);
          if (resolved.status === 'DEGRADED') {
            this.#recordBackgroundFailure(credential.id);
            failed++;
          } else {
            this.#backgroundFailures.delete(credential.id);
          }
        } catch {
          this.#recordBackgroundFailure(credential.id);
          failed++;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BACKGROUND_CONCURRENCY, candidates.length) }, worker)
    );
    return {
      attempted: candidates.length,
      deferred,
      failed
    };
  }

  #recordBackgroundFailure(credentialId: string): void {
    const previous = this.#backgroundFailures.get(credentialId);
    const failures = (previous?.failures ?? 0) + 1;
    const delay = BACKGROUND_BACKOFF_MS[Math.min(failures - 1, BACKGROUND_BACKOFF_MS.length - 1)]!;
    this.#backgroundFailures.set(credentialId, {
      failures,
      nextAttemptAt: this.#now() + delay
    });
  }

  async #resolveRecord(
    credentialId: string,
    reason: ResolveReason,
    force: boolean
  ): Promise<CredentialRecord> {
    const existing = this.#refreshFlights.get(credentialId);
    if (existing !== undefined) {
      if (!force || existing.force) return existing.promise;
      await existing.promise.catch(() => undefined);
      return this.#resolveRecord(credentialId, reason, true);
    }
    const promise = this.#refreshAndCheck(credentialId, reason, force).finally(() => {
      if (this.#refreshFlights.get(credentialId)?.promise === promise)
        this.#refreshFlights.delete(credentialId);
    });
    this.#refreshFlights.set(credentialId, { force, promise });
    return promise;
  }

  async #refreshAndCheck(
    credentialId: string,
    reason: ResolveReason,
    force: boolean
  ): Promise<CredentialRecord> {
    let credential = await this.#requireCredential(credentialId);
    if (credential.status === 'REAUTH_REQUIRED')
      throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
    const now = this.#now();
    const due =
      force ||
      reason === 'UNAUTHORIZED' ||
      (credential.accessTokenExpiresAt !== null
        ? credential.accessTokenExpiresAt - now <= REFRESH_WINDOW_MS
        : credential.lastRefreshAt === null ||
          now - credential.lastRefreshAt >= REFRESH_FALLBACK_MS);
    if (due)
      credential = await this.#refreshCredential(credential, force || reason === 'UNAUTHORIZED');
    if (
      credential.type === 'CODEX_OAUTH' &&
      reason !== 'CATALOG' &&
      reason !== 'USAGE' &&
      (credential.lastCheckedAt === null ||
        this.#now() - credential.lastCheckedAt >= AUTHORIZATION_CHECK_MS)
    ) {
      const response = await this.#catalogResponse(credential);
      if (!response.ok) {
        if (response.status === 401) {
          const marked = await this.#markReauthenticationRequired(credentialId, credential);
          if (marked.applied) throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
          credential = marked.credential;
        } else {
          throw new Error('CODEX_CREDENTIAL_CHECK_FAILED');
        }
      } else
        credential = await this.#mutateDocument((document) => {
          const index = document.credentials.findIndex((value) => value.id === credentialId);
          if (index < 0) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
          const current = document.credentials[index]!;
          if (!sameCredentialRequest(current, credential)) return current;
          const next: CredentialRecord = {
            ...current,
            status: retainCredentialFailureStatus(current.status, credential.status),
            lastCheckedAt: this.#now(),
            revision: current.revision + 1,
            updatedAt: this.#now()
          };
          document.credentials[index] = next;
          return next;
        });
    }
    if (credential.accessTokenExpiresAt !== null && credential.accessTokenExpiresAt <= this.#now())
      throw new Error('CODEX_CREDENTIAL_UNAVAILABLE');
    return credential;
  }

  async #refreshCredential(
    credential: CredentialRecord,
    allowEarlyRefresh: boolean
  ): Promise<CredentialRecord> {
    if (credential.type === 'XAI_OAUTH')
      return this.#refreshXaiCredential(credential, allowEarlyRefresh);
    if (credential.type === 'CHATGPT_OAUTH')
      return this.#refreshChatgptCredential(credential, allowEarlyRefresh);
    try {
      const response = await this.#requestWithProxy(
        `${this.#authIssuer}/oauth/token`,
        'POST',
        credential.proxy ?? undefined,
        { 'content-type': 'application/json' },
        JSON.stringify({
          client_id: this.#clientId,
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken
        })
      );
      if (!response.ok) {
        const code = refreshFailureCode(await safeJson(response));
        if (response.status === 401 || (code !== undefined && PERMANENT_REFRESH_CODES.has(code))) {
          const marked = await this.#markReauthenticationRequired(credential.id, credential);
          if (!marked.applied) return marked.credential;
          throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
        }
        throw new Error('CODEX_CREDENTIAL_REFRESH_TRANSIENT');
      }
      const tokens = parseTokenResponse(await safeJson(response), credential);
      return this.#mutateDocument((document) => {
        const index = document.credentials.findIndex((value) => value.id === credential.id);
        if (index < 0) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
        const current = document.credentials[index]!;
        if (!sameCredentialRequest(current, credential)) return current;
        if (tokens.accountId !== current.accountId)
          throw new Error('CODEX_CREDENTIAL_ACCOUNT_MISMATCH');
        const next: CredentialRecord = {
          ...current,
          status: 'ACTIVE',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          lastRefreshAt: this.#now(),
          revision: current.revision + 1,
          updatedAt: this.#now()
        };
        document.credentials[index] = next;
        return next;
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'CODEX_CREDENTIAL_REAUTH_REQUIRED' ||
          error.message === 'CODEX_CREDENTIAL_ACCOUNT_MISMATCH')
      )
        throw error;
      if (credential.accessTokenExpiresAt === null || credential.accessTokenExpiresAt > this.#now())
        return this.#mutateDocument((document) => {
          const index = document.credentials.findIndex((value) => value.id === credential.id);
          if (index < 0) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
          const current = document.credentials[index]!;
          if (!sameCredentialRequest(current, credential)) return current;
          const next: CredentialRecord = {
            ...current,
            status: 'DEGRADED',
            revision: current.revision + 1,
            updatedAt: this.#now()
          };
          document.credentials[index] = next;
          return next;
        });
      throw new Error('CODEX_CREDENTIAL_UNAVAILABLE');
    }
  }

  async #markReauthenticationRequired(
    credentialId: string,
    expected?: CredentialRecord
  ): Promise<ConditionalCredentialMutation> {
    return this.#mutateDocument((document) => {
      const index = document.credentials.findIndex((value) => value.id === credentialId);
      if (index < 0) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
      const current = document.credentials[index]!;
      if (expected !== undefined && !sameCredentialRequest(current, expected))
        return { credential: current, applied: false };
      const next: CredentialRecord = {
        ...current,
        status: 'REAUTH_REQUIRED',
        revision: current.revision + 1,
        updatedAt: this.#now()
      };
      document.credentials[index] = next;
      return { credential: next, applied: true };
    });
  }

  async #xaiUsage(credentialId: string): Promise<CodexCredentialUsage> {
    let forcedRefresh = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let credential = await this.#resolveRecord(credentialId, 'USAGE', false);
      let response = await this.#xai.usageResponse(credential);
      if (response.status === 401 && !forcedRefresh) {
        forcedRefresh = true;
        credential = await this.#resolveRecord(credentialId, 'UNAUTHORIZED', true);
        response = await this.#xai.usageResponse(credential);
      }
      if (response.status === 401) {
        const marked = await this.#markReauthenticationRequired(credentialId, credential);
        if (!marked.applied) continue;
        throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
      }
      if (response.status === 429) throw new XaiOAuthError('XAI_USAGE_RATE_LIMITED');
      assertXaiResponse(response, 'XAI_USAGE_LOAD_FAILED');
      const usage = normalizeXaiUsage(await safeJson(response), this.#now());
      if (sameCredentialRequest(await this.#requireCredential(credentialId), credential))
        return usage;
    }
    throw new XaiOAuthError('XAI_USAGE_LOAD_FAILED');
  }

  async #refreshXaiCredential(
    credential: CredentialRecord,
    forced: boolean
  ): Promise<CredentialRecord> {
    try {
      const tokens = await this.#xai.refresh(credential);
      return await this.#mutateDocument((document) => {
        const index = document.credentials.findIndex((value) => value.id === credential.id);
        const current = document.credentials[index];
        if (!current) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
        // A concurrent proxy/name edit must not discard an already rotated refresh token.
        if (
          current.type !== 'XAI_OAUTH' ||
          current.accessToken !== credential.accessToken ||
          current.refreshToken !== credential.refreshToken ||
          current.accountId !== credential.accountId ||
          current.xai?.subject !== credential.xai?.subject
        )
          return current;
        const next: CredentialRecord = {
          ...current,
          status: 'ACTIVE',
          ...xaiTokenFields(tokens, this.#now()),
          xai: {
            subject: current.xai!.subject,
            scopes: tokens.scope === undefined ? current.xai!.scopes : xaiScopes(tokens.scope)
          },
          revision: current.revision + 1,
          updatedAt: this.#now()
        };
        document.credentials[index] = next;
        return next;
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'CODEX_CREDENTIAL_REAUTH_REQUIRED') {
        const marked = await this.#markReauthenticationRequired(credential.id, credential);
        if (!marked.applied) return marked.credential;
        throw error;
      }
      if (
        !forced &&
        error instanceof XaiOAuthError &&
        (error.code === 'XAI_REQUEST_FAILED' || error.code === 'XAI_REFRESH_FAILED') &&
        credential.accessTokenExpiresAt !== null &&
        credential.accessTokenExpiresAt > this.#now()
      )
        return this.#mutateDocument((document) => {
          const index = document.credentials.findIndex((value) => value.id === credential.id);
          const current = document.credentials[index];
          if (!current) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
          if (current.status === 'REAUTH_REQUIRED')
            throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
          if (!sameCredentialRequest(current, credential)) return current;
          const next: CredentialRecord = {
            ...current,
            status: 'DEGRADED',
            revision: current.revision + 1,
            updatedAt: this.#now()
          };
          document.credentials[index] = next;
          return next;
        });
      if (error instanceof XaiOAuthError) throw error;
      throw new XaiOAuthError('XAI_REFRESH_FAILED');
    }
  }

  async #refreshChatgptCredential(
    credential: CredentialRecord,
    allowEarlyRefresh: boolean
  ): Promise<CredentialRecord> {
    const metadata = credential.chatgpt!;
    if (
      !allowEarlyRefresh &&
      metadata.earliestRefreshAt !== null &&
      this.#now() < metadata.earliestRefreshAt &&
      credential.accessTokenExpiresAt !== null &&
      this.#now() < credential.accessTokenExpiresAt
    )
      return credential;
    if (!credential.refreshToken) {
      await this.#markReauthenticationRequired(credential.id, credential);
      throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
    }
    try {
      const response = await this.#requestWithProxy(
        CHATGPT_TOKEN_ENDPOINT,
        'POST',
        credential.proxy ?? undefined,
        { 'content-type': 'application/x-www-form-urlencoded' },
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: metadata.clientId,
          refresh_token: credential.refreshToken,
          resource: CHATGPT_RESOURCE
        }).toString()
      );
      if (!response.ok) {
        const code = refreshFailureCode(await safeJson(response));
        if (response.status === 401 || (code && PERMANENT_REFRESH_CODES.has(code))) {
          const marked = await this.#markReauthenticationRequired(credential.id, credential);
          if (!marked.applied) return marked.credential;
          throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
        }
        throw new Error('CODEX_CREDENTIAL_REFRESH_TRANSIENT');
      }
      const parsed = chatgptTokenResponseSchema.safeParse(await safeJson(response));
      if (!parsed.success || !parsed.data.refresh_token)
        throw new Error('CHATGPT_TOKEN_RESPONSE_INVALID');
      const tokens = parsed.data;
      if (tokens.id_token) {
        const jwks = await this.#requestWithProxy(
          CHATGPT_JWKS_ENDPOINT,
          'GET',
          credential.proxy ?? undefined,
          {}
        );
        if (!jwks.ok) throw new Error('CHATGPT_IDENTITY_INVALID');
        await verifyChatgptIdentity(tokens.id_token, await safeJson(jwks), {
          clientId: metadata.clientId,
          subject: metadata.subject,
          now: this.#now()
        });
      }
      return this.#mutateDocument((document) => {
        const index = document.credentials.findIndex((c) => c.id === credential.id);
        if (index < 0) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
        const current = document.credentials[index]!;
        if (!sameCredentialRequest(current, credential)) return current;
        const next: CredentialRecord = {
          ...current,
          status: 'ACTIVE',
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token!,
          accessTokenExpiresAt: this.#now() + tokens.expires_in * 1000,
          lastRefreshAt: this.#now(),
          revision: current.revision + 1,
          updatedAt: this.#now(),
          chatgpt: {
            ...metadata,
            idToken: tokens.id_token ?? metadata.idToken,
            scopes: tokens.scope.split(/\s+/u).filter(Boolean),
            earliestRefreshAt:
              tokens.earliest_refresh_at === undefined ? null : tokens.earliest_refresh_at * 1000
          }
        };
        document.credentials[index] = next;
        return next;
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'CODEX_CREDENTIAL_REAUTH_REQUIRED')
        throw error;
      if (credential.accessTokenExpiresAt !== null && credential.accessTokenExpiresAt > this.#now())
        return this.#mutateDocument((document) => {
          const index = document.credentials.findIndex((c) => c.id === credential.id);
          if (index < 0) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
          const current = document.credentials[index]!;
          if (!sameCredentialRequest(current, credential)) return current;
          const next = {
            ...current,
            status: 'DEGRADED' as const,
            revision: current.revision + 1,
            updatedAt: this.#now()
          };
          document.credentials[index] = next;
          return next;
        });
      throw new Error('CODEX_CREDENTIAL_UNAVAILABLE');
    }
  }

  async #requestCatalog(credential: CredentialRecord): Promise<CodexModelCatalog> {
    const response = await this.#catalogResponse(credential);
    if (!response.ok) throw new Error('CODEX_CREDENTIAL_CHECK_FAILED');
    return normalizeCatalog(await safeJson(response), this.#now());
  }

  #catalogResponse(credential: CredentialRecord): Promise<Response> {
    if (credential.type === 'XAI_OAUTH') return this.#xai.catalogResponse(credential);
    if (credential.chatgpt) {
      if (!credential.chatgpt.scopes.includes(CHATGPT_PLAN_SCOPE))
        return Promise.reject(new Error('CHATGPT_PLAN_UNAUTHORIZED'));
      return this.#requestWithProxy(
        `${CHATGPT_RESOURCE}/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`,
        'GET',
        credential.proxy ?? undefined,
        { authorization: `Bearer ${credential.accessToken}` }
      );
    }
    return this.#requestWithProxy(
      `${this.#codexBaseUrl}/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`,
      'GET',
      credential.proxy ?? undefined,
      catalogHeaders(credential, this.#userAgent)
    );
  }

  async #usageResponse(credential: CredentialRecord): Promise<Response> {
    try {
      return await this.#requestWithProxy(
        this.#codexUsageUrl,
        'GET',
        credential.proxy ?? undefined,
        catalogHeaders(credential, this.#userAgent),
        undefined,
        {
          maxResponseBytes: USAGE_RESPONSE_MAX_BYTES,
          discardBodyWhenNotOk: true
        }
      );
    } catch (error) {
      if (error instanceof Error && error.message === RESPONSE_BODY_LIMIT_EXCEEDED)
        throw new Error('CODEX_USAGE_RESPONSE_INVALID');
      throw error;
    }
  }

  async #profileUsageResponse(credential: CredentialRecord): Promise<Response> {
    try {
      return await this.#requestWithProxy(
        this.#codexProfileUsageUrl,
        'GET',
        credential.proxy ?? undefined,
        catalogHeaders(credential, this.#userAgent),
        undefined,
        {
          maxResponseBytes: USAGE_RESPONSE_MAX_BYTES,
          discardBodyWhenNotOk: true
        }
      );
    } catch (error) {
      if (error instanceof Error && error.message === RESPONSE_BODY_LIMIT_EXCEEDED)
        throw new Error('CODEX_USAGE_RESPONSE_INVALID');
      throw error;
    }
  }

  async #requestWithProxy(
    url: string,
    method: string,
    socks5Url: string | undefined,
    headers: Record<string, string>,
    body?: string,
    responsePolicy?: {
      readonly maxResponseBytes?: number;
      readonly discardBodyWhenNotOk?: boolean;
    }
  ): Promise<Response> {
    const request = requestOptions(method, headers, body);
    if (socks5Url === undefined) {
      const response = await this.#request(url, request);
      if (responsePolicy?.discardBodyWhenNotOk === true && !response.ok)
        return discardResponseBody(response);
      return response.ok && responsePolicy === undefined
        ? response
        : bufferResponse(response, responsePolicy?.maxResponseBytes);
    }
    validateSocks5Url(socks5Url);
    const dispatcher = new Socks5ProxyAgent(socks5Url);
    try {
      const response = await this.#request(url, {
        ...request,
        dispatcher
      } as RequestInit & { readonly dispatcher: Dispatcher });
      return responseWithDispatcherLifecycle(response, dispatcher, responsePolicy);
    } catch (error) {
      await dispatcher.destroy(error instanceof Error ? error : null).catch(() => undefined);
      throw error;
    }
  }

  #deleteAttempt(attempt: LoginAttemptRecord): void {
    clearTimeout(attempt.timer);
    this.#attempts.delete(attempt.id);
  }

  #ownedAttempt(actor: LoginActor, attemptId: string): LoginAttemptRecord {
    const attempt = this.#attempts.get(attemptId);
    if (
      attempt === undefined ||
      attempt.actor.userId !== actor.userId ||
      attempt.actor.sessionFingerprint !== actor.sessionFingerprint
    )
      throw new Error('CODEX_LOGIN_ATTEMPT_NOT_FOUND');
    return attempt;
  }

  #recordAudit(
    actorUserId: number,
    credential: {
      readonly id: string;
      readonly name: string;
      readonly ownership: ResourceOwnership;
    },
    eventType: string,
    metadata: Readonly<Record<string, unknown>> = {},
    outcome: Pick<AuditEvent, 'result' | 'errorCode'> = {}
  ): void {
    emitAudit(
      this.database,
      resourceAuditEvent(
        { eventType, actorUserId, targetType: 'CREDENTIAL', targetId: credential.id, ...outcome },
        { name: credential.name, ...credential.ownership },
        metadata
      )
    );
  }

  async #requireManagedCredential(
    actorUserId: number,
    credentialId: string
  ): Promise<CredentialRecord> {
    const credential = await this.#requireCredential(credentialId);
    if (!(await this.#scopes.canActorManageOwnership(actorUserId, credential.ownership)))
      throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
    return credential;
  }

  async #requireCredential(credentialId: string): Promise<CredentialRecord> {
    const credential = (await this.#readDocument()).credentials.find(
      (value) => value.id === credentialId
    );
    if (credential === undefined) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
    return credential;
  }

  async #modelCounts(): Promise<Map<string, number>> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(credential,'$.credentialId')) AS credential_id,
              COUNT(*) AS imported_model_count
       FROM mar_agent_models
       WHERE JSON_UNQUOTE(JSON_EXTRACT(credential,'$.type'))='CREDENTIAL_REF'
       GROUP BY credential_id`
    );
    return new Map(
      rows.flatMap((row) => {
        const id = row['credential_id'];
        const count = Number(row['imported_model_count']);
        return typeof id === 'string' && Number.isSafeInteger(count) && count >= 0
          ? [[id, count] as const]
          : [];
      })
    );
  }

  async #readDocument(): Promise<CredentialDocument> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT setting_value FROM system_settings WHERE setting_key='${CREDENTIAL_SETTING_KEY}'`
    );
    const raw = rows[0]?.['setting_value'];
    if (raw === undefined || raw === null) return { version: DOCUMENT_VERSION, credentials: [] };
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

  async #mutateDocument<T>(mutate: (document: CredentialDocument) => T | Promise<T>): Promise<T> {
    const prior = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const document = await this.#readDocument();
      const result = await mutate(document);
      const validated = parseCredentialDocument(document);
      const serialized = JSON.stringify(validated);
      if (Buffer.byteLength(serialized) > MAX_DOCUMENT_BYTES)
        throw new Error('CODEX_CREDENTIAL_STORE_LIMIT_REACHED');
      await this.database.raw.execute(
        `INSERT INTO system_settings (setting_key,setting_value,updated_at)
         VALUES ('${CREDENTIAL_SETTING_KEY}',CAST(? AS JSON),?)
         ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`,
        [serialized, this.#now()]
      );
      return result;
    } finally {
      release();
    }
  }
}

function needsBackgroundMaintenance(credential: CredentialRecord, now: number): boolean {
  if (credential.status === 'DEGRADED') return true;
  const refreshDue =
    credential.accessTokenExpiresAt === null
      ? credential.lastRefreshAt === null || now - credential.lastRefreshAt >= REFRESH_FALLBACK_MS
      : credential.accessTokenExpiresAt - now <= REFRESH_WINDOW_MS;
  const authorizationDue =
    credential.lastCheckedAt === null || now - credential.lastCheckedAt >= AUTHORIZATION_CHECK_MS;
  return refreshDue || authorizationDue;
}

function sameCredentialRequest(current: CredentialRecord, requested: CredentialRecord): boolean {
  return (
    current.accessToken === requested.accessToken &&
    current.refreshToken === requested.refreshToken &&
    current.accountId === requested.accountId &&
    current.proxy === requested.proxy
  );
}

function retainCredentialFailureStatus(
  current: CredentialRecord['status'],
  checked: CredentialRecord['status']
): CredentialRecord['status'] {
  if (current === 'REAUTH_REQUIRED' || checked === 'REAUTH_REQUIRED') return 'REAUTH_REQUIRED';
  if (current === 'DEGRADED' || checked === 'DEGRADED') return 'DEGRADED';
  return 'ACTIVE';
}

interface ParsedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string;
  readonly accessTokenExpiresAt: number | null;
}

function parseTokenResponse(raw: unknown, current: CredentialRecord | undefined): ParsedTokens {
  const value = asRecord(raw);
  const accessToken = requiredString(value['access_token'], 131_072);
  const refreshToken = optionalString(value['refresh_token'], 131_072) ?? current?.refreshToken;
  if (refreshToken === undefined) throw new Error('CODEX_TOKEN_RESPONSE_INVALID');
  const claims = jwtClaims(optionalString(value['id_token'], 131_072) ?? accessToken);
  const auth = asOptionalRecord(claims['https://api.openai.com/auth']);
  const accountId = optionalString(auth?.['chatgpt_account_id'], 512) ?? current?.accountId;
  if (accountId === undefined) throw new Error('CODEX_TOKEN_ACCOUNT_MISSING');
  const expiration = jwtExpiration(accessToken);
  return {
    accessToken,
    refreshToken,
    accountId,
    accessTokenExpiresAt: expiration
  };
}

function credentialFromTokens(input: {
  readonly id: string;
  readonly name: string;
  readonly ownership: CodexCredentialOwnership;
  readonly tokens: ParsedTokens;
  readonly proxy: string | null;
  readonly now: number;
  readonly revision: number;
}): CredentialRecord {
  return credentialRecordSchema.parse({
    id: input.id,
    name: input.name,
    type: 'CODEX_OAUTH',
    ownership: input.ownership,
    status: 'ACTIVE',
    accessToken: input.tokens.accessToken,
    refreshToken: input.tokens.refreshToken,
    accountId: input.tokens.accountId,
    accessTokenExpiresAt: input.tokens.accessTokenExpiresAt,
    lastRefreshAt: input.now,
    lastCheckedAt: null,
    proxy: input.proxy,
    revision: input.revision,
    createdAt: input.now,
    updatedAt: input.now
  });
}

function summary(credential: CredentialRecord): CodexCredentialSummary {
  const proxy =
    credential.proxy === null
      ? ({ configured: false } as const)
      : (() => {
          const value = new URL(credential.proxy);
          return {
            configured: true as const,
            host: value.hostname,
            port: Number(value.port || 1080),
            hasUsername: value.username.length > 0
          };
        })();
  return {
    id: credential.id,
    name: credential.name,
    type: credential.type,
    ...(credential.chatgpt === undefined
      ? {}
      : {
          authorization: credential.chatgpt.scopes.includes(CHATGPT_PLAN_SCOPE)
            ? ('AUTHORIZED' as const)
            : ('UNAUTHORIZED' as const),
          earliestRefreshAt: credential.chatgpt.earliestRefreshAt
        }),
    ownership: credential.ownership,
    status: credential.status,
    accessTokenExpiresAt: credential.accessTokenExpiresAt,
    lastRefreshAt: credential.lastRefreshAt,
    lastCheckedAt: credential.lastCheckedAt,
    accountId: credential.accountId,
    proxy,
    revision: credential.revision
  };
}

function publicPendingAttempt(attempt: LoginAttemptRecord): CodexLoginAttempt {
  return codexLoginAttemptSchema.parse({
    id: attempt.id,
    status: 'PENDING',
    userCode: attempt.userCode,
    verificationUri: attempt.verificationUri,
    expiresAt: attempt.expiresAt,
    pollIntervalMs: attempt.pollIntervalMs
  });
}

function normalizeChatgptCatalog(raw: unknown, fetchedAt: number): CodexModelCatalog {
  const payload = asOptionalRecord(raw);
  if (!payload || !Array.isArray(payload['models']) || payload['models'].length > 1000)
    throw new Error('CODEX_CATALOG_LOAD_FAILED');
  const models = payload['models'].flatMap((item) => {
    const model = asOptionalRecord(item);
    if (!model) return [];
    return [{ ...model, supported_in_api: model['supported_in_api'] ?? true }];
  });
  return normalizeCatalog({ models }, fetchedAt);
}

function normalizeCatalog(raw: unknown, fetchedAt: number): CodexModelCatalog {
  const value = asOptionalRecord(raw);
  if (value === undefined || !Array.isArray(value['models']))
    throw new Error('CODEX_CATALOG_LOAD_FAILED');
  const models = value['models'];
  const candidates = models.flatMap((rawModel) => {
    const model = asOptionalRecord(rawModel);
    if (model === undefined || model['visibility'] !== 'list' || model['supported_in_api'] !== true)
      return [];
    const upstreamModelId = optionalString(model['slug'], 256);
    const displayName = optionalString(model['display_name'], 256);
    if (upstreamModelId === undefined || displayName === undefined) return [];
    const reasoning = Array.isArray(model['supported_reasoning_levels'])
      ? model['supported_reasoning_levels']
          .map((entry) => optionalString(asOptionalRecord(entry)?.['effort'], 128))
          .filter((entry): entry is string => entry !== undefined)
      : [];
    const reasoningEfforts = unique(reasoning.filter((effort) => SUPPORTED_REASONING.has(effort)));
    const unsupportedReasoningEfforts = unique(
      reasoning.filter((effort) => !SUPPORTED_REASONING.has(effort))
    );
    const upstreamDefaultReasoningEffort = optionalString(model['default_reasoning_level'], 128);
    const defaultReasoningEffort = resolveMarAgentDefaultReasoningEffort(
      upstreamDefaultReasoningEffort,
      reasoningEfforts
    );
    const modalities = Array.isArray(model['input_modalities'])
      ? model['input_modalities']
      : ['text'];
    const inputCapabilities = unique(
      modalities.flatMap((modality) =>
        modality === 'text' ? ['TEXT' as const] : modality === 'image' ? ['IMAGE' as const] : []
      )
    );
    if (!inputCapabilities.includes('TEXT')) inputCapabilities.unshift('TEXT');
    const contextWindowTokens =
      parsePositiveInteger(model['context_window'], Number.MAX_SAFE_INTEGER) ??
      parsePositiveInteger(model['max_context_window'], Number.MAX_SAFE_INTEGER);
    const maxOutputTokens = parsePositiveInteger(
      model['max_output_tokens'],
      Number.MAX_SAFE_INTEGER
    );
    const requiredInputs =
      contextWindowTokens === undefined ? (['contextWindowTokens'] as const) : [];
    const warnings = unsupportedReasoningEfforts.map(
      (effort) => `Unsupported reasoning effort: ${effort}`
    );
    if (
      upstreamDefaultReasoningEffort !== undefined &&
      upstreamDefaultReasoningEffort !== defaultReasoningEffort
    )
      warnings.push(`Unsupported default reasoning effort: ${upstreamDefaultReasoningEffort}`);
    return [
      {
        upstreamModelId,
        displayName,
        ...(optionalString(model['description'], 4096) === undefined
          ? {}
          : { description: optionalString(model['description'], 4096) }),
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        reasoningEfforts,
        defaultReasoningEffort,
        unsupportedReasoningEfforts,
        inputCapabilities,
        hostedWebSearch:
          model['supports_search_tool'] === true ||
          (typeof model['web_search_tool_type'] === 'string' &&
            model['web_search_tool_type'] !== 'disabled'),
        warnings,
        requiredInputs
      }
    ];
  });
  const canonical = JSON.stringify(candidates);
  const parsed = codexModelCatalogSchema.safeParse({
    catalogHash: createHash('sha256').update(canonical).digest('hex'),
    fetchedAt,
    models: candidates
  });
  if (!parsed.success) throw new Error('CODEX_CATALOG_LOAD_FAILED');
  return parsed.data;
}

function normalizeCredentialUsage(
  rateLimitRaw: unknown,
  profileRaw: unknown,
  fetchedAt: number
): CodexCredentialUsage {
  const rateLimits = normalizeUsage(rateLimitRaw, fetchedAt);
  const profile = normalizeUsageProfile(profileRaw, fetchedAt);
  const parsed = codexCredentialUsageSchema.safeParse({
    ...rateLimits,
    profile
  });
  if (!parsed.success) throw new Error('CODEX_USAGE_RESPONSE_INVALID');
  return parsed.data;
}

function normalizeUsage(raw: unknown, fetchedAt: number): RunnerUsage {
  const rateLimit = asOptionalRecord(asOptionalRecord(raw)?.['rate_limit']);
  const windows = (
    [
      normalizeUsageWindow(rateLimit?.['primary_window'], 'primary_window'),
      normalizeUsageWindow(rateLimit?.['secondary_window'], 'secondary_window')
    ] as const
  ).filter((window): window is RunnerUsageWindow => window !== undefined);
  if (windows.length === 0) throw new Error('CODEX_USAGE_RESPONSE_INVALID');
  const parsed = runnerUsageSchema.safeParse({
    runner: 'codex',
    windows,
    fetchedAt,
    cached: false
  });
  if (!parsed.success) throw new Error('CODEX_USAGE_RESPONSE_INVALID');
  return parsed.data;
}

function normalizeUsageProfile(raw: unknown, fetchedAt: number): CodexCredentialUsage['profile'] {
  const root = asOptionalRecord(raw);
  if (root === undefined) throw new Error('CODEX_USAGE_RESPONSE_INVALID');
  const stats = asOptionalRecord(root['stats']) ?? root;
  const rawBuckets = Array.isArray(root['daily_usage_buckets'])
    ? root['daily_usage_buckets']
    : Array.isArray(stats['daily_usage_buckets'])
      ? stats['daily_usage_buckets']
      : undefined;
  if (
    stats === root &&
    rawBuckets === undefined &&
    !Object.prototype.hasOwnProperty.call(root, 'lifetime_tokens')
  )
    throw new Error('CODEX_USAGE_RESPONSE_INVALID');
  const buckets = new Map<string, number>();
  for (const rawBucket of rawBuckets ?? []) {
    const bucket = asOptionalRecord(rawBucket);
    if (bucket === undefined) continue;
    const startDate = optionalUsageDate(bucket['start_date'] ?? bucket['date']);
    const tokens = optionalUsageMetric(bucket['tokens']);
    if (startDate === undefined || tokens === undefined) continue;
    buckets.set(startDate, tokens);
  }
  const metadata = asOptionalRecord(root['metadata']);
  const upstreamStatsAsOf =
    optionalUsageDate(metadata?.['stats_as_of']) ??
    optionalUsageDate(root['stats_as_of']) ??
    optionalUsageDate(stats['stats_as_of']) ??
    null;
  const today = losAngelesUsageDate(fetchedAt);
  const statsAsOf = offsetUsageDate(today, -1);
  const sevenDaysAnchor = [...buckets.keys()].sort().at(-1) ?? upstreamStatsAsOf;
  const sevenDaysEnd =
    sevenDaysAnchor === today ? offsetUsageDate(sevenDaysAnchor, -1) : sevenDaysAnchor;
  const sevenDayBuckets =
    sevenDaysEnd === null
      ? []
      : (() => {
          const sevenDaysStart = offsetUsageDate(sevenDaysEnd, -6);
          return [...buckets.entries()].filter(
            ([startDate]) => startDate >= sevenDaysStart && startDate <= sevenDaysEnd
          );
        })();
  const parsed = codexUsageProfileSchema.safeParse({
    lifetimeTokens: usageMetric(stats, root, 'lifetime_tokens'),
    currentDayTokens: buckets.get(statsAsOf) ?? null,
    lastSevenDaysTokens:
      sevenDayBuckets.length === 0
        ? null
        : sevenDayBuckets.reduce((total, [, tokens]) => total + tokens, 0),
    statsAsOf,
    dailyUsageBuckets: [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([startDate, tokens]) => ({ startDate, tokens }))
  });
  if (!parsed.success) throw new Error('CODEX_USAGE_RESPONSE_INVALID');
  return parsed.data;
}

function usageMetric(
  stats: Record<string, unknown>,
  root: Record<string, unknown>,
  key: string
): number | null {
  const value = Object.prototype.hasOwnProperty.call(stats, key) ? stats[key] : root[key];
  if (value === undefined || value === null) return null;
  return (
    optionalUsageMetric(value) ??
    (() => {
      throw new Error('CODEX_USAGE_RESPONSE_INVALID');
    })()
  );
}

function optionalUsageMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalUsageDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value ? value : undefined;
}

function losAngelesUsageDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(timestamp);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function offsetUsageDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeUsageWindow(
  raw: unknown,
  fallbackId: 'primary_window' | 'secondary_window'
): RunnerUsageWindow | undefined {
  const window = asOptionalRecord(raw);
  if (window === undefined) return undefined;
  const usedPercentage = finiteNumber(
    window['used_percent'] ?? window['used_percentage'] ?? window['utilization']
  );
  if (usedPercentage === undefined || usedPercentage < 0 || usedPercentage > 100) return undefined;
  const durationSeconds = finiteNumber(window['limit_window_seconds']);
  if (durationSeconds === undefined || durationSeconds <= 0) return undefined;
  const identity = usageWindowIdentity(durationSeconds, fallbackId);
  return {
    ...identity,
    usedPercentage,
    resetsAt: usageTimestamp(window['reset_at'] ?? window['resets_at'])
  };
}

function usageWindowIdentity(
  durationSeconds: number,
  fallbackId: 'primary_window' | 'secondary_window'
): Pick<RunnerUsageWindow, 'id' | 'label'> {
  if (approximately(durationSeconds, 5 * 60 * 60))
    return { id: 'five_hour', label: '5-hour limit' };
  if (approximately(durationSeconds, 7 * 24 * 60 * 60))
    return { id: 'seven_day', label: '7-day limit' };
  const durationMinutes = Math.max(1, Math.round(durationSeconds / 60));
  if (durationMinutes % (24 * 60) === 0) {
    const days = durationMinutes / (24 * 60);
    return { id: fallbackId, label: `${days}-day limit` };
  }
  if (durationMinutes % 60 === 0) {
    const hours = durationMinutes / 60;
    return { id: fallbackId, label: `${hours}-hour limit` };
  }
  return { id: fallbackId, label: `${durationMinutes}-minute limit` };
}

function approximately(value: number, expected: number): boolean {
  return Math.abs(value - expected) / expected <= 0.1;
}

function usageTimestamp(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]+(?:\.[0-9]+)?$/u.test(value)
        ? Number(value)
        : undefined;
  if (numeric !== undefined && Number.isFinite(numeric) && numeric >= 0)
    return Math.floor(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function catalogHeaders(credential: CredentialRecord, userAgent: string): Record<string, string> {
  return {
    authorization: `Bearer ${credential.accessToken}`,
    'ChatGPT-Account-ID': credential.accountId,
    originator: ORIGINATOR,
    'user-agent': userAgent
  };
}

function codexUsageUrl(codexBaseUrl: string): string {
  const suffix = '/codex';
  if (!codexBaseUrl.endsWith(suffix)) throw new Error('CODEX_ENDPOINT_INVALID');
  return `${codexBaseUrl.slice(0, -suffix.length)}/wham/usage`;
}

function codexProfileUsageUrl(codexBaseUrl: string): string {
  const suffix = '/codex';
  if (!codexBaseUrl.endsWith(suffix)) throw new Error('CODEX_ENDPOINT_INVALID');
  return `${codexBaseUrl.slice(0, -suffix.length)}/wham/profiles/me`;
}

function requestOptions(
  method: string,
  headers: Record<string, string>,
  body?: string
): RequestInit {
  return {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  };
}

async function responseWithDispatcherLifecycle(
  response: Response,
  dispatcher: Dispatcher,
  policy?: {
    readonly maxResponseBytes?: number;
    readonly discardBodyWhenNotOk?: boolean;
  }
): Promise<Response> {
  try {
    const buffered =
      policy?.discardBodyWhenNotOk === true && !response.ok
        ? await discardResponseBody(response)
        : await bufferResponse(response, policy?.maxResponseBytes);
    await dispatcher.close().catch(() => undefined);
    return buffered;
  } catch (error) {
    await dispatcher.destroy(error instanceof Error ? error : null).catch(() => undefined);
    throw error;
  }
}

async function bufferResponse(response: Response, maxBytes?: number): Promise<Response> {
  const body =
    response.body === null
      ? null
      : maxBytes === undefined
        ? await response.arrayBuffer()
        : await boundedResponseBody(response.body, maxBytes);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

async function discardResponseBody(response: Response): Promise<Response> {
  await response.body?.cancel();
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

async function boundedResponseBody(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(RESPONSE_BODY_LIMIT_EXCEEDED);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new ArrayBuffer(bytes);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function validateSocks5Url(value: string): void {
  if (!isValidSocks5Url(value)) throw new Error('CODEX_CREDENTIAL_PROXY_INVALID');
}

function refreshFailureCode(raw: unknown): string | undefined {
  const value = asOptionalRecord(raw);
  if (value === undefined) return undefined;
  const error = value['error'];
  if (typeof error === 'string') return error.toLowerCase();
  const errorRecord = asOptionalRecord(error);
  const nested = optionalString(errorRecord?.['code'], 128);
  return (nested ?? optionalString(value['code'], 128))?.toLowerCase();
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function jwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('CODEX_TOKEN_RESPONSE_INVALID');
  try {
    return asRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    throw new Error('CODEX_TOKEN_RESPONSE_INVALID');
  }
}

function jwtExpiration(token: string): number | null {
  const exp = jwtClaims(token)['exp'];
  return typeof exp === 'number' && Number.isSafeInteger(exp) && exp >= 0 ? exp * 1000 : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('CODEX_UPSTREAM_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, maxLength: number): string {
  const parsed = optionalString(value, maxLength);
  if (parsed === undefined) throw new Error('CODEX_UPSTREAM_RESPONSE_INVALID');
  return parsed;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function parsePositiveInteger(value: unknown, maximum: number): number | undefined {
  const parsed =
    typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sameOwnership(left: CodexCredentialOwnership, right: CodexCredentialOwnership): boolean {
  if (left.ownerType !== right.ownerType) return false;
  if (left.ownerType === 'PERSONAL' && right.ownerType === 'PERSONAL')
    return left.ownerUserId === right.ownerUserId;
  if (left.ownerType === 'ORGANIZATION' && right.ownerType === 'ORGANIZATION')
    return left.ownerOrganizationId === right.ownerOrganizationId;
  return true;
}

function credentialOwnership(
  actorUserId: number,
  ownership: z.infer<typeof credentialOwnershipInputSchema>
): CodexCredentialOwnership {
  return ownership.ownerType === 'PERSONAL'
    ? { ownerType: 'PERSONAL', ownerUserId: ownership.ownerUserId ?? actorUserId }
    : ownership;
}

function normalizedHttpsBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('CODEX_ENDPOINT_INVALID');
  return url.toString().replace(/\/$/u, '');
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error('CODEX_CONFIGURATION_INVALID');
  return normalized;
}
