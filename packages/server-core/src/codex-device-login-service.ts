import { codexLoginAttemptSchema, type CodexLoginAttempt } from '@myagentroam/protocol';
import type {
  CredentialLoginActor as LoginActor,
  CredentialLoginDraft as LoginDraft
} from './credential-login-contracts.js';
import {
  asRecord,
  parsePositiveInteger,
  requiredString,
  safeJson
} from './credential-provider-values.js';

const LOGIN_TTL_MS = 15 * 60 * 1000;

export interface CodexDeviceCommit {
  readonly id: string;
  readonly actor: LoginActor;
  readonly draft: LoginDraft;
  readonly targetRevision: number | undefined;
}

interface CodexDeviceAttempt extends CodexDeviceCommit {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
  readonly pollIntervalMs: number;
  nextPollAt: number;
  flight?: Promise<CodexLoginAttempt> | undefined;
}

/** Owns Codex device attempts and their remote authorization lifecycle. */
export class CodexDeviceLoginService {
  private readonly attempts = new Map<string, CodexDeviceAttempt>();

  constructor(
    private readonly input: {
      readonly issuer: string;
      readonly clientId: string;
      readonly now: () => number;
      readonly id: () => string;
      readonly request: (
        url: string,
        method: 'POST',
        proxy: string | undefined,
        headers: Record<string, string>,
        body: string
      ) => Promise<Response>;
      readonly commit: (
        attempt: CodexDeviceCommit,
        tokenResponse: Response,
        assertCurrent: () => void
      ) => Promise<string>;
    }
  ) {}

  get size(): number {
    return this.attempts.size;
  }

  close(): void {
    for (const attempt of this.attempts.values()) this.remove(attempt);
  }

  async start(
    actor: LoginActor,
    draft: LoginDraft,
    targetRevision: number | undefined,
    registered: () => void
  ): Promise<CodexLoginAttempt> {
    const response = await this.input.request(
      `${this.input.issuer}/api/accounts/deviceauth/usercode`,
      'POST',
      draft.socks5Url,
      { 'content-type': 'application/json' },
      JSON.stringify({ client_id: this.input.clientId })
    );
    if (!response.ok) throw new Error('CODEX_DEVICE_AUTH_UNAVAILABLE');
    const payload = asRecord(await safeJson(response));
    const deviceAuthId = requiredString(payload['device_auth_id'], 4096);
    const userCode = requiredString(payload['user_code'] ?? payload['usercode'], 128);
    const intervalSeconds = parsePositiveInteger(payload['interval'], 60) ?? 5;
    const id = this.input.id();
    const timer = setTimeout(() => this.remove(attempt), LOGIN_TTL_MS);
    timer.unref();
    const attempt: CodexDeviceAttempt = {
      id,
      actor: { ...actor },
      draft,
      targetRevision,
      deviceAuthId,
      userCode,
      verificationUri: `${this.input.issuer}/codex/device`,
      expiresAt: this.input.now() + LOGIN_TTL_MS,
      timer,
      pollIntervalMs: intervalSeconds * 1000,
      nextPollAt: this.input.now()
    };
    this.attempts.set(id, attempt);
    registered();
    return pending(attempt);
  }

  async poll(
    actor: LoginActor,
    id: string,
    validateCommit?: () => void
  ): Promise<CodexLoginAttempt> {
    const attempt = this.owned(actor, id);
    if (this.input.now() >= attempt.expiresAt) {
      this.remove(attempt);
      return codexLoginAttemptSchema.parse({ id, status: 'EXPIRED' });
    }
    if (attempt.flight) return attempt.flight;
    if (this.input.now() < attempt.nextPollAt) return pending(attempt);
    const flight = this.complete(attempt, validateCommit).finally(() => {
      attempt.flight = undefined;
    });
    attempt.flight = flight;
    return flight;
  }

  cancel(actor: LoginActor, id: string): void {
    this.remove(this.owned(actor, id));
  }

  private async complete(
    attempt: CodexDeviceAttempt,
    validateCommit?: () => void
  ): Promise<CodexLoginAttempt> {
    const assertCurrent = () => {
      if (this.attempts.get(attempt.id) !== attempt || this.input.now() >= attempt.expiresAt)
        throw new Error('CODEX_LOGIN_ATTEMPT_NOT_FOUND');
      validateCommit?.();
    };
    const poll = await this.input.request(
      `${this.input.issuer}/api/accounts/deviceauth/token`,
      'POST',
      attempt.draft.socks5Url,
      { 'content-type': 'application/json' },
      JSON.stringify({ device_auth_id: attempt.deviceAuthId, user_code: attempt.userCode })
    );
    try {
      assertCurrent();
      if (poll.status === 403 || poll.status === 404) {
        attempt.nextPollAt = this.input.now() + attempt.pollIntervalMs;
        return pending(attempt);
      }
      if (!poll.ok) {
        this.remove(attempt);
        return codexLoginAttemptSchema.parse({
          id: attempt.id,
          status: 'FAILED',
          code: 'CODEX_DEVICE_AUTH_FAILED',
          message: 'Codex device authorization failed.'
        });
      }
      const code = asRecord(await safeJson(poll));
      assertCurrent();
      const tokenResponse = await this.input.request(
        `${this.input.issuer}/oauth/token`,
        'POST',
        attempt.draft.socks5Url,
        { 'content-type': 'application/x-www-form-urlencoded' },
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: requiredString(code['authorization_code'], 8192),
          redirect_uri: `${this.input.issuer}/deviceauth/callback`,
          client_id: this.input.clientId,
          code_verifier: requiredString(code['code_verifier'], 8192)
        }).toString()
      );
      if (!tokenResponse.ok) throw new Error('CODEX_TOKEN_EXCHANGE_FAILED');
      const credentialId = await this.input.commit(
        {
          id: attempt.id,
          actor: attempt.actor,
          draft: attempt.draft,
          targetRevision: attempt.targetRevision
        },
        tokenResponse,
        assertCurrent
      );
      this.remove(attempt);
      return codexLoginAttemptSchema.parse({ id: attempt.id, status: 'SUCCEEDED', credentialId });
    } catch (error) {
      this.remove(attempt);
      if (this.input.now() >= attempt.expiresAt)
        return codexLoginAttemptSchema.parse({ id: attempt.id, status: 'EXPIRED' });
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

  private remove(attempt: CodexDeviceAttempt): void {
    clearTimeout(attempt.timer);
    this.attempts.delete(attempt.id);
  }
  private owned(actor: LoginActor, id: string): CodexDeviceAttempt {
    const attempt = this.attempts.get(id);
    if (
      attempt === undefined ||
      attempt.actor.userId !== actor.userId ||
      attempt.actor.sessionFingerprint !== actor.sessionFingerprint
    )
      throw new Error('CODEX_LOGIN_ATTEMPT_NOT_FOUND');
    return attempt;
  }
}

function pending(attempt: CodexDeviceAttempt): CodexLoginAttempt {
  return codexLoginAttemptSchema.parse({
    id: attempt.id,
    status: 'PENDING',
    userCode: attempt.userCode,
    verificationUri: attempt.verificationUri,
    expiresAt: attempt.expiresAt,
    pollIntervalMs: attempt.pollIntervalMs
  });
}
