import { runnerDefaultConfigurationSchema, type NodeCapabilities } from '@myagentroam/protocol';
import type { NodeDatabase } from '../database.js';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import type { RunnerUsageReader } from '../runner-usage.js';
import { parseSecretEnvironment } from '../util/secret-environment.js';

export class RunnerService {
  constructor(
    private readonly database: () => NodeDatabase,
    private readonly capabilities: () => NodeCapabilities,
    private readonly runners: RunnerRegistry,
    private readonly usage: RunnerUsageReader
  ) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'runner.usage.status': () => this.usageStatuses(),
      'runner.usage.read': (data) => this.readUsage(data),
      'runner.profiles.list': (data) => this.listProfiles(data),
      'runner.defaults.save': (data) => this.saveDefaults(data)
    };
  }

  profiles(environment: Readonly<Record<string, string>> = {}) {
    return this.runners.profiles(this.capabilities(), environment);
  }

  private refreshProfiles(
    environment: Readonly<Record<string, string>> = {},
    waitForRefresh = false
  ) {
    return this.runners.refreshProfiles(
      this.capabilities(),
      undefined,
      environment,
      waitForRefresh
    );
  }

  private async usageStatuses(): Promise<unknown> {
    return {
      statuses: await Promise.all(
        this.runners
          .advertised()
          .flatMap((runner) =>
            runner.name === 'codex' || runner.name === 'claude-code'
              ? [this.usage.status(runner.name)]
              : []
          )
      )
    };
  }

  private async readUsage(data: unknown): Promise<unknown> {
    const input = data as Record<string, unknown>;
    const runner = this.runners.product(input.runner);
    if (runner === undefined || (runner.name !== 'codex' && runner.name !== 'claude-code'))
      throw new Error('RUNNER_USAGE_INVALID');
    return { usage: await this.usage.read(runner.name) };
  }

  private async listProfiles(data: unknown): Promise<unknown> {
    const input = data as {
      readonly secretEnvironment?: unknown;
      readonly marAgentModels?: unknown;
      readonly waitForRefresh?: unknown;
    };
    const marAgent = this.runners.optional('mar-agent');
    if (
      marAgent !== undefined &&
      'configureModels' in marAgent &&
      typeof marAgent.configureModels === 'function'
    )
      marAgent.configureModels(input.marAgentModels);
    const environment = parseSecretEnvironment(input.secretEnvironment);
    const defaults = this.database()
      .getRunnerDefaults()
      .map((configuration) => {
        const runner = this.runners.optional(configuration.runner);
        if (runner === undefined) return configuration;
        const access = runner.restoreStoredAccess(configuration.access, configuration.access);
        if (access === configuration.access) return configuration;
        const normalized = {
          ...configuration,
          access
        };
        this.database().saveRunnerDefaults(normalized);
        return normalized;
      });
    const cacheOnly = input.waitForRefresh === false;
    const waitForRefresh = !cacheOnly;
    const refresh = this.refreshProfiles(environment, waitForRefresh);
    if (cacheOnly) {
      void refresh.catch(() => undefined);
      return {
        profiles: this.profiles(environment),
        defaults
      };
    }
    return {
      profiles: await refresh,
      defaults
    };
  }

  private saveDefaults(data: unknown): unknown {
    const parsed = runnerDefaultConfigurationSchema.safeParse(data);
    if (!parsed.success) throw new Error('RUNNER_DEFAULT_INVALID');
    if (
      parsed.data.runner === 'mar-agent' &&
      parsed.data.access !== 'auto' &&
      parsed.data.access !== 'full-access'
    )
      throw new Error('RUNNER_DEFAULT_INVALID');
    return { defaults: this.database().saveRunnerDefaults(parsed.data) };
  }
}
