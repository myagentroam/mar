import type { CredentialRecord, CredentialDocument } from './credential-document.js';

export const REFRESH_WINDOW_MS = 5 * 60 * 1000;
export const REFRESH_FALLBACK_MS = 8 * 24 * 60 * 60 * 1000;
export const AUTHORIZATION_CHECK_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_CONCURRENCY = 4;
const BACKGROUND_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export type ResolveReason =
  'STARTUP' | 'ADMIN' | 'CATALOG' | 'USAGE' | 'TEST' | 'RUNTIME' | 'EXPIRING' | 'UNAUTHORIZED';
export type BackgroundResolveReason = Extract<ResolveReason, 'STARTUP' | 'EXPIRING'>;

export interface CodexCredentialMaintenanceResult {
  readonly attempted: number;
  readonly deferred: number;
  readonly failed: number;
}

interface RefreshFlight {
  readonly force: boolean;
  readonly promise: Promise<CredentialRecord>;
}

interface BackgroundFailure {
  readonly failures: number;
  readonly nextAttemptAt: number;
}

export class CredentialRefreshCoordinator {
  readonly #refreshFlights = new Map<string, RefreshFlight>();
  readonly #backgroundFailures = new Map<string, BackgroundFailure>();
  #maintenanceFlight: Promise<CodexCredentialMaintenanceResult> | undefined;

  constructor(
    private readonly readDocument: () => Promise<CredentialDocument>,
    private readonly refreshAndCheck: (
      id: string,
      reason: ResolveReason,
      force: boolean
    ) => Promise<CredentialRecord>,
    private readonly now: () => number
  ) {}

  maintain(reason: BackgroundResolveReason): Promise<CodexCredentialMaintenanceResult> {
    if (this.#maintenanceFlight !== undefined) return this.#maintenanceFlight;
    const flight = this.#runMaintenance(reason).finally(() => {
      if (this.#maintenanceFlight === flight) this.#maintenanceFlight = undefined;
    });
    this.#maintenanceFlight = flight;
    return flight;
  }

  async #runMaintenance(
    reason: BackgroundResolveReason
  ): Promise<CodexCredentialMaintenanceResult> {
    const document = await this.readDocument();
    const now = this.now();
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
          const resolved = await this.resolve(credential.id, reason, false);
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
      nextAttemptAt: this.now() + delay
    });
  }

  async resolve(
    credentialId: string,
    reason: ResolveReason,
    force: boolean
  ): Promise<CredentialRecord> {
    const existing = this.#refreshFlights.get(credentialId);
    if (existing !== undefined) {
      if (!force || existing.force) return existing.promise;
      await existing.promise.catch(() => undefined);
      return this.resolve(credentialId, reason, true);
    }
    const promise = this.refreshAndCheck(credentialId, reason, force).finally(() => {
      if (this.#refreshFlights.get(credentialId)?.promise === promise)
        this.#refreshFlights.delete(credentialId);
    });
    this.#refreshFlights.set(credentialId, { force, promise });
    return promise;
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
