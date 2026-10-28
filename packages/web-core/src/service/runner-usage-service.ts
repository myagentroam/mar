import { managementDateTime } from '../util/time-presentation.js';
import { ref } from 'vue';
import type { NodeSummary } from '../model/workbench.js';
import type {
  RunnerUsage,
  RunnerUsageName,
  RunnerUsageStatus,
  RunnerUsageWindow
} from '../model/runner-usage.js';
import { translate } from './locale-preference-service.js';

export function runnerUsageWindowLabel(window: RunnerUsageWindow): string {
  return (
    {
      five_hour: translate('nodeMessages.fiveHourLimit'),
      seven_day: translate('nodeMessages.sevenDayLimit'),
      seven_day_sonnet: translate('nodeMessages.sevenDaySonnetLimit')
    }[window.id] ?? window.label
  );
}

export function runnerUsageTitle(runner: RunnerUsageName | undefined): string {
  return runner === 'claude-code'
    ? translate('nodeMessages.claudeUsage')
    : translate('nodeMessages.codexUsage');
}

export function createRunnerUsageService(options: {
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly error: (message: string, cause?: unknown) => void;
  readonly errorMessage: (error: unknown) => string;
}) {
  const nodeDetails = ref<NodeSummary>();
  const detailsOpen = ref(false);
  const statuses = ref<readonly RunnerUsageStatus[]>();
  const statusFailed = ref(false);
  const loading = ref<RunnerUsageName>();
  const details = ref<RunnerUsage>();
  const usageOpen = ref(false);

  function openNode(node: NodeSummary): void {
    nodeDetails.value = node;
    detailsOpen.value = true;
    statuses.value = undefined;
    statusFailed.value = false;
    void loadStatuses(node.id);
  }

  async function loadStatuses(nodeId: string): Promise<void> {
    try {
      const result = await options.request<{ statuses: readonly RunnerUsageStatus[] }>(
        `/api/runner-usage/status?nodeId=${encodeURIComponent(nodeId)}`
      );
      if (nodeDetails.value?.id === nodeId) {
        statuses.value = result.statuses;
        statusFailed.value = false;
      }
    } catch {
      if (nodeDetails.value?.id === nodeId) {
        statuses.value = [];
        statusFailed.value = true;
      }
    }
  }

  function disabledReason(runner: RunnerUsageName): string {
    if (statusFailed.value)
      return translate('generated.runnerUsageService.usageCapabilityDetectionFailedCloseAndReopen');
    const status = statuses.value?.find((candidate) => candidate.runner === runner);
    if (status === undefined)
      return translate('generated.runnerUsageService.detectingUsageCapability');
    if (status.available) return '';
    if (status.reasonCode === 'OFFICIAL_OAUTH_REQUIRED')
      return translate('generated.runnerUsageService.usageQueriesRequireAnOfficialOAuthAccount');
    if (status.reasonCode === 'RUNNER_UNAVAILABLE')
      return translate('generated.runnerUsageService.thisRunnerIsUnavailableSoUsageCannot');
    return translate('generated.runnerUsageService.thisRunnerDoesNotCurrentlySupportUsage');
  }

  async function show(runner: RunnerUsageName): Promise<void> {
    const node = nodeDetails.value;
    if (node === undefined || loading.value !== undefined) return;
    loading.value = runner;
    try {
      const result = await options.request<{ usage: RunnerUsage }>(
        `/api/runner-usage?nodeId=${encodeURIComponent(node.id)}&runner=${encodeURIComponent(runner)}`
      );
      details.value = result.usage;
      usageOpen.value = true;
    } catch (error) {
      options.error(
        translate('generated.runnerUsageService.unableToQueryUsage', {
          value0: options.errorMessage(error)
        }),
        error
      );
      void loadStatuses(node.id);
    } finally {
      loading.value = undefined;
    }
  }

  function title(usage: RunnerUsage | undefined): string {
    return runnerUsageTitle(usage?.runner);
  }

  function formatTimestamp(value: number | null): string {
    return value === null
      ? translate('generated.runnerUsageService.notProvided')
      : managementDateTime(value);
  }

  function clearNode(): void {
    detailsOpen.value = false;
    nodeDetails.value = undefined;
    statuses.value = undefined;
    statusFailed.value = false;
  }

  return {
    nodeDetails,
    detailsOpen,
    statuses,
    loading,
    details,
    usageOpen,
    openNode,
    loadStatuses,
    disabledReason,
    show,
    title,
    formatTimestamp,
    clearNode
  };
}
