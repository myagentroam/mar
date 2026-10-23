import { marIcon } from '../util/mar-icons.js';
import { getCurrentScope, onScopeDispose, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { ResourceRow } from '../model/ResourceManagement.js';
import type { NodeDetailsHostingState } from '../model/NodeDetails.js';
import { translate } from './LocalePreferenceService.js';
import { errorCode } from '../util/api-error.js';
import { errorMessage } from '../util/workbench-presentation.js';
import {
  conversationHostingDisablementAvailability,
  conversationHostingEnablementAvailability,
  createConversationHostingEnablementService,
  type ConversationHostingEnablementAvailability
} from './ConversationHostingEnablementService.js';
type ResourceUpdate<Row> = (update: (row: Row) => Row) => void;
export function createResourceHostingService<Row extends ResourceRow>(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  context: () => {
    writable: boolean;
    visible?: (row: Row) => boolean;
    canEnable?: (row: Row) => boolean;
  }
) {
  const hostingChangingNodeId = ref<string>();
  let active = true;
  if (getCurrentScope())
    onScopeDispose(() => {
      active = false;
      hostingChangingNodeId.value = undefined;
    });
  const hostingEnablementService = createConversationHostingEnablementService(request);
  function availabilityFor(row: Row | undefined) {
    if (!active || row?.resourceType !== 'NODE' || context().visible?.(row) === false)
      return undefined;
    const capability = row.capabilities?.conversationHosting;
    return conversationHostingEnablementAvailability({
      platform: row.platform,
      connected: row.connected,
      disabled: row.disabled,
      capability,
      writable: context().writable && context().canEnable?.(row) !== false
    });
  }
  function describe(row: Row | undefined): NodeDetailsHostingState | undefined {
    const enablement = availabilityFor(row);
    if (enablement === undefined || row === undefined) return undefined;
    const disablement = conversationHostingDisablementAvailability({
      platform: row.platform,
      connected: row.connected,
      disabled: row.disabled,
      capability: row.capabilities?.conversationHosting,
      writable: context().writable
    });
    return {
      enabled: enablement.enabled,
      canEnable: enablement.canEnable,
      canDisable: disablement.canDisable,
      hint: hostingEnablementHint(enablement, disablement.reasonCode),
      changing: hostingChangingNodeId.value === row.nodeId
    };
  }
  function hostingEnablementHint(
    availability: ConversationHostingEnablementAvailability,
    disableReasonCode?: string
  ): string {
    if (
      availability.enabled &&
      availability.reasonCode === undefined &&
      disableReasonCode !== undefined
    ) {
      const disablementHint = {
        CONVERSATION_HOSTING_DISABLE_PLATFORM_UNSUPPORTED: translate(
          'conversationHostingEnablement.platformUnsupported'
        ),
        CONVERSATION_HOSTING_DISABLE_NODE_OFFLINE: translate(
          'conversationHostingEnablement.nodeOffline'
        ),
        CONVERSATION_HOSTING_DISABLE_READ_ONLY: translate('conversationHostingEnablement.readOnly')
      }[disableReasonCode];
      if (disablementHint !== undefined) return disablementHint;
    }
    if (availability.enabled && availability.reasonCode === undefined)
      return translate('conversationHostingEnablement.enabledHint');
    if (availability.enabled)
      return translate('conversationHostingEnablement.enabledUnavailableHint', {
        code: availability.reasonCode ?? 'CONVERSATION_HOSTING_UNAVAILABLE'
      });
    return (
      {
        CONVERSATION_HOSTING_ENABLE_PLATFORM_UNSUPPORTED: translate(
          'conversationHostingEnablement.platformUnsupported'
        ),
        CONVERSATION_HOSTING_ENABLE_NODE_OFFLINE: translate(
          'conversationHostingEnablement.nodeOffline'
        ),
        CONVERSATION_HOSTING_ENABLE_READ_ONLY: translate('conversationHostingEnablement.readOnly'),
        CONVERSATION_HOSTING_ENABLE_STATE_UNKNOWN: translate(
          'conversationHostingEnablement.stateUnknown'
        )
      }[availability.reasonCode ?? ''] ?? translate('conversationHostingEnablement.availableHint')
    );
  }
  async function enableConversationHosting(
    row: Row | undefined,
    update: ResourceUpdate<Row>
  ): Promise<void> {
    if (!active || row === undefined) return;
    const availability = conversationHostingEnablementAvailability({
      platform: row.platform,
      connected: row.connected,
      disabled: row.disabled,
      capability: row.capabilities?.conversationHosting,
      writable: context().writable && context().canEnable?.(row) !== false
    });
    if (
      !availability.canEnable ||
      hostingChangingNodeId.value !== undefined ||
      context().visible?.(row) === false
    )
      return;
    hostingChangingNodeId.value = row.nodeId;
    try {
      await ElMessageBox.confirm(
        translate('conversationHostingEnablement.enableConfirm'),
        translate('conversationHostingEnablement.enableConfirmTitle'),
        {
          closeIcon: marIcon('close'),
          icon: marIcon('warning'),
          type: 'warning',
          confirmButtonText: translate('conversationHostingEnablement.enable'),
          cancelButtonText: translate('common.cancel')
        }
      );
    } catch (error) {
      if (hostingChangingNodeId.value === row.nodeId) hostingChangingNodeId.value = undefined;
      if (error === 'cancel' || error === 'close') return;
      throw error;
    }
    if (!describe(row)?.canEnable) {
      hostingChangingNodeId.value = undefined;
      return;
    }
    try {
      const capability = await hostingEnablementService.enable(row.nodeId);
      if (!active) return;
      update((resource) => ({
        ...resource,
        capabilities: { ...resource.capabilities, conversationHosting: capability }
      }));
      if (capability.state === 'AVAILABLE')
        ElMessage.success({
          icon: marIcon('success'),
          message: translate('conversationHostingEnablement.enabled')
        });
      else
        ElMessage.warning({
          icon: marIcon('warning'),
          message: translate('conversationHostingEnablement.enabledUnavailable', {
            code: capability.reasonCode ?? 'CONVERSATION_HOSTING_UNAVAILABLE'
          })
        });
    } catch (error) {
      if (!active) return;
      ElMessage.error({
        icon: marIcon('error'),
        message:
          error instanceof Error
            ? errorMessage(error)
            : translate('conversationHostingEnablement.enableFailed')
      });
    } finally {
      if (hostingChangingNodeId.value === row.nodeId) hostingChangingNodeId.value = undefined;
    }
  }
  async function disableConversationHosting(
    row: Row | undefined,
    update: ResourceUpdate<Row>
  ): Promise<void> {
    if (!active || row === undefined) return;
    const availability = conversationHostingDisablementAvailability({
      platform: row.platform,
      connected: row.connected,
      disabled: row.disabled,
      capability: row.capabilities?.conversationHosting,
      writable: context().writable
    });
    if (
      !availability.canDisable ||
      hostingChangingNodeId.value !== undefined ||
      context().visible?.(row) === false
    )
      return;
    hostingChangingNodeId.value = row.nodeId;
    try {
      await ElMessageBox.confirm(
        translate('conversationHostingEnablement.disableConfirm'),
        translate('conversationHostingEnablement.disableConfirmTitle'),
        {
          closeIcon: marIcon('close'),
          icon: marIcon('warning'),
          type: 'warning',
          confirmButtonText: translate('conversationHostingEnablement.disable'),
          cancelButtonText: translate('common.cancel')
        }
      );
    } catch (error) {
      if (hostingChangingNodeId.value === row.nodeId) hostingChangingNodeId.value = undefined;
      if (error === 'cancel' || error === 'close') return;
      throw error;
    }
    if (!describe(row)?.canDisable) {
      hostingChangingNodeId.value = undefined;
      return;
    }
    try {
      const capability = await hostingEnablementService.disable(row.nodeId);
      if (!active) return;
      update((resource) => ({
        ...resource,
        capabilities: { ...resource.capabilities, conversationHosting: capability }
      }));
      ElMessage.success({
        icon: marIcon('success'),
        message: translate('conversationHostingEnablement.disabled')
      });
    } catch (error) {
      if (!active) return;
      ElMessage.error({
        icon: marIcon('error'),
        message:
          errorCode(error) === 'CONVERSATION_HOSTING_DISABLE_ACTIVE_RUNS'
            ? translate('conversationHostingEnablement.disableActiveRuns')
            : error instanceof Error
              ? errorMessage(error)
              : translate('conversationHostingEnablement.disableFailed')
      });
    } finally {
      if (hostingChangingNodeId.value === row.nodeId) hostingChangingNodeId.value = undefined;
    }
  }
  return { describe, enable: enableConversationHosting, disable: disableConversationHosting };
}
