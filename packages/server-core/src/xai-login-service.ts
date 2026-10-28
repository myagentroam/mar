import type { CodexLoginAttempt } from '@myagentroam/protocol';
import { XaiOAuthError, XaiOAuthProvider, type XaiTokens } from './xai-oauth-provider.js';
import type {
  CredentialLoginActor as Actor,
  CredentialLoginDraft as XaiLoginDraft
} from './credential-login-contracts.js';
interface Attempt {
  readonly id: string;
  readonly actor: Actor;
  readonly expiresAt: number;
  readonly userCode: string;
  readonly verificationUri: string;
  interval: number;
  nextPollAt: number;
  timer: NodeJS.Timeout;
  secret?:
    { deviceCode: string; draft: XaiLoginDraft; targetRevision?: number | undefined } | undefined;
  terminal?: CodexLoginAttempt;
  flight?: Promise<CodexLoginAttempt> | undefined;
}
type Save = (
  draft: XaiLoginDraft,
  tokens: XaiTokens,
  identity: { subject: string; accountId: string; scopes: string[] },
  targetRevision: number | undefined,
  assertCurrent: () => void,
  attemptId: string
) => Promise<string>;

/** Process-local device authorization; never persists device codes or unfinished credentials. */
export class XaiLoginService {
  readonly #attempts = new Map<string, Attempt>();
  #closed = false;
  constructor(
    private readonly provider: XaiOAuthProvider,
    private readonly now: () => number,
    private readonly id: () => string
  ) {}

  get size(): number {
    return this.#attempts.size;
  }
  has(id: string): boolean {
    return this.#attempts.has(id);
  }
  close(): void {
    this.#closed = true;
    for (const attempt of this.#attempts.values()) {
      clearTimeout(attempt.timer);
      attempt.secret = undefined;
    }
    this.#attempts.clear();
  }

  async start(
    actor: Actor,
    draft: XaiLoginDraft,
    targetRevision: number | undefined,
    registered: () => void
  ): Promise<CodexLoginAttempt> {
    if (this.#closed) throw new XaiOAuthError('XAI_LOGIN_FAILED');
    const device = await this.provider.start(draft.socks5Url);
    if (this.#closed) throw new XaiOAuthError('XAI_LOGIN_FAILED');
    if (this.size >= 128) throw new Error('CODEX_LOGIN_ATTEMPT_LIMIT_REACHED');
    const id = this.id();
    const expiresAt = this.now() + device.expires_in * 1000;
    const timer = setTimeout(() => {
      const attempt = this.#attempts.get(id);
      if (attempt) this.finish(attempt, 'EXPIRED');
    }, device.expires_in * 1000);
    timer.unref();
    const attempt: Attempt = {
      id,
      actor: { ...actor },
      expiresAt,
      timer,
      userCode: device.user_code,
      verificationUri: device.verification_uri_complete ?? device.verification_uri,
      interval: device.interval * 1000,
      nextPollAt: this.now() + device.interval * 1000,
      secret: { deviceCode: device.device_code, draft, targetRevision }
    };
    this.#attempts.set(id, attempt);
    registered();
    return this.pending(attempt);
  }

  async poll(
    actor: Actor,
    id: string,
    save: Save,
    validateCommit?: () => void
  ): Promise<CodexLoginAttempt> {
    const attempt = this.owned(actor, id);
    if (attempt.terminal) return attempt.terminal;
    if (this.now() >= attempt.expiresAt) return this.finish(attempt, 'EXPIRED');
    if (attempt.flight) return attempt.flight;
    if (this.now() < attempt.nextPollAt) return this.pending(attempt);
    const flight = this.complete(attempt, save, validateCommit).finally(() => {
      attempt.flight = undefined;
    });
    attempt.flight = flight;
    return flight;
  }

  cancel(actor: Actor, id: string): void {
    const attempt = this.owned(actor, id);
    if (!attempt.terminal) this.finish(attempt, 'CANCELLED');
  }

  private async complete(
    attempt: Attempt,
    save: Save,
    validateCommit?: () => void
  ): Promise<CodexLoginAttempt> {
    const secret = attempt.secret!;
    const assertCurrent = () => {
      if (
        this.#closed ||
        this.#attempts.get(attempt.id) !== attempt ||
        attempt.terminal ||
        this.now() >= attempt.expiresAt
      )
        throw new XaiOAuthError('XAI_LOGIN_CONFLICT');
      validateCommit?.();
    };
    try {
      const result = await this.provider.poll(secret.deviceCode, secret.draft.socks5Url);
      assertCurrent();
      if (result.state === 'expired') return this.finish(attempt, 'EXPIRED');
      if (result.state !== 'success') {
        // Stop rather than polling faster than the provider when our public interval bound is exceeded.
        if (result.state === 'slow_down') {
          if (attempt.interval > 55_000) throw new XaiOAuthError('XAI_LOGIN_FAILED');
          attempt.interval += 5000;
        }
        attempt.nextPollAt = this.now() + attempt.interval;
        return this.pending(attempt);
      }
      const identity = await this.provider.identity(result.tokens, secret.draft.socks5Url);
      assertCurrent();
      const credentialId = await save(
        secret.draft,
        result.tokens,
        identity,
        secret.targetRevision,
        assertCurrent,
        attempt.id
      );
      return this.finish(attempt, 'SUCCEEDED', { credentialId });
    } catch (error) {
      if (attempt.terminal) return attempt.terminal;
      if (this.now() >= attempt.expiresAt) return this.finish(attempt, 'EXPIRED');
      const failure =
        error instanceof XaiOAuthError ? error : new XaiOAuthError('XAI_LOGIN_FAILED');
      return this.finish(attempt, 'FAILED', { code: failure.code, message: failure.publicMessage });
    }
  }

  private owned(actor: Actor, id: string): Attempt {
    const attempt = this.#attempts.get(id);
    if (
      !attempt ||
      attempt.actor.userId !== actor.userId ||
      attempt.actor.sessionFingerprint !== actor.sessionFingerprint
    )
      throw new Error('CODEX_LOGIN_ATTEMPT_NOT_FOUND');
    return attempt;
  }
  private pending(attempt: Attempt): CodexLoginAttempt {
    return {
      id: attempt.id,
      type: 'XAI_OAUTH',
      status: 'PENDING',
      userCode: attempt.userCode,
      verificationUri: attempt.verificationUri,
      expiresAt: attempt.expiresAt,
      pollIntervalMs: attempt.interval
    };
  }
  private finish(
    attempt: Attempt,
    status: CodexLoginAttempt['status'],
    extra: Partial<CodexLoginAttempt> = {}
  ): CodexLoginAttempt {
    attempt.secret = undefined;
    clearTimeout(attempt.timer);
    attempt.terminal = { id: attempt.id, type: 'XAI_OAUTH', status, ...extra };
    attempt.timer = setTimeout(() => {
      this.#attempts.delete(attempt.id);
    }, 60_000);
    attempt.timer.unref();
    return attempt.terminal;
  }
}
