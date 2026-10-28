import type { FastifyInstance } from 'fastify';
import {
  CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS,
  type CodexCredentialService
} from '@myagentroam/server-core/codex-credential-service';
import type { ModelUsageStore } from '@myagentroam/server-core/model-usage-store';
import type { SkillFavoriteService } from '@myagentroam/server-core/skill-favorite-service';
import type { AuditService } from '../audit/audit-service.js';

/** Owns Server maintenance timers and their in-flight work, not request-time audits. */
export class ServerMaintenance {
  private stopped = false;
  private readonly work = new Map<string, Promise<unknown>>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly app: FastifyInstance,
    private readonly usage: Pick<ModelUsageStore, 'cleanup'>,
    private readonly credentials: Pick<CodexCredentialService, 'maintain'>,
    private readonly audits: Pick<AuditService, 'cleanupBatch'>,
    private readonly skills: Pick<SkillFavoriteService, 'cleanupCache'>
  ) {}

  private start<T>(name: string, task: () => Promise<T>): Promise<T> | undefined {
    if (this.stopped || this.work.has(name)) return undefined;
    const operation = Promise.resolve().then(task);
    this.work.set(name, operation);
    void operation.then(
      () => this.work.delete(name),
      () => this.work.delete(name)
    );
    return operation;
  }

  private interval(task: () => void, period: number): void {
    const timer = setInterval(task, period);
    timer.unref();
    this.timers.push(timer);
  }

  registerModelUsage(): void {
    const cleanup = () =>
      this.start('model-usage', () => this.usage.cleanup())?.catch(() =>
        this.app.log.warn('MODEL_USAGE_CLEANUP_FAILED')
      );
    this.app.addHook('onReady', async () => {
      await cleanup();
      if (!this.stopped)
        this.interval(() => {
          void cleanup();
        }, 3_600_000);
    });
  }

  registerRemaining(): void {
    const observeCredentialMaintenance = (
      operation: ReturnType<CodexCredentialService['maintain']>
    ): void => {
      void operation
        .then((result) => {
          if (result.failed > 0)
            this.app.log.warn(
              {
                errorCode: 'CODEX_CREDENTIAL_BACKGROUND_CHECK_FAILED',
                attempted: result.attempted,
                deferred: result.deferred,
                failed: result.failed
              },
              'codex_credential_background_check_failed'
            );
        })
        .catch(() =>
          this.app.log.error(
            { errorCode: 'CODEX_CREDENTIAL_MAINTENANCE_FAILED' },
            'codex_credential_maintenance_failed'
          )
        );
    };
    this.app.addHook('onReady', async () => {
      const startup = this.start('credential-maintenance', () =>
        this.credentials.maintain('STARTUP')
      );
      if (startup === undefined) return;
      observeCredentialMaintenance(startup);
      this.interval(() => {
        const operation = this.start('credential-maintenance', () =>
          this.credentials.maintain('EXPIRING')
        );
        if (operation !== undefined) observeCredentialMaintenance(operation);
      }, CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS);
    });
    this.app.addHook('onReady', async () => {
      await this.start('audit-cleanup', () => this.audits.cleanupBatch());
      if (!this.stopped)
        this.interval(() => {
          void this.start('audit-cleanup', () => this.audits.cleanupBatch())?.catch(() =>
            this.app.log.error({ errorCode: 'AUDIT_CLEANUP_FAILED' }, 'audit_cleanup_failed')
          );
        }, 3_600_000);
    });
    this.app.addHook('onReady', async () => {
      await this.start('skill-cleanup', () => this.skills.cleanupCache());
      if (!this.stopped)
        this.interval(() => {
          void this.start('skill-cleanup', () => this.skills.cleanupCache())?.catch(() =>
            this.app.log.error(
              { errorCode: 'SKILL_CACHE_CLEANUP_FAILED' },
              'skill_cache_cleanup_failed'
            )
          );
        }, 3_600_000);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.work.values()]);
  }
}
