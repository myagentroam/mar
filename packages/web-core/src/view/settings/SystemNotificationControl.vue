<script setup lang="ts">
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarButton } from '@myagentroam/mar-ui/button';
import { computed, ref } from 'vue';
import type { WorkbenchNotificationService } from '../../service/workbench-notification-service.js';
import { translate } from '../../service/locale-preference-service.js';

const props = defineProps<{
  readonly service: WorkbenchNotificationService['systemNotifications'];
}>();
const hasStateTag = computed(() => ['enabled', 'disabled'].includes(props.service.status.value));
const enablingPush = ref(false);
async function enablePush(): Promise<void> {
  if (enablingPush.value) return;
  enablingPush.value = true;
  try {
    await props.service.enablePush();
  } finally {
    enablingPush.value = false;
  }
}
const blocked = computed(
  () =>
    !props.service.enabled.value &&
    (['unsupported', 'denied'].includes(props.service.status.value) ||
      (props.service.mode === 'mobile-push' &&
        !props.service.pushReady() &&
        props.service.pushStatus.value !== 'unavailable'))
);
</script>

<template>
  <div class="system-notification-control">
    <div class="notification-channel">
      <h3 v-if="service.mode === 'mobile-push'">
        {{ translate('workbenchNotificationCenter.webPush.title') }}
      </h3>
      <div class="notification-channel-actions">
        <MarButton
          :icon="service.enabled.value ? 'power' : 'notification'"
          :loading="service.requesting.value"
          :disabled="blocked || enablingPush"
          @click="service.setEnabled(!service.enabled.value)"
        >
          {{
            translate(
              service.mode === 'mobile-push'
                ? service.enabled.value
                  ? 'workbenchNotificationCenter.webPush.disable'
                  : 'workbenchNotificationCenter.webPush.enable'
                : service.enabled.value
                  ? 'workbenchNotificationCenter.systemNotifications.disable'
                  : 'workbenchNotificationCenter.systemNotifications.enable'
            )
          }}
        </MarButton>
        <p role="status" :class="{ 'notification-channel-detail': !hasStateTag }">
          <MarTag
            v-if="hasStateTag"
            :type="service.status.value === 'enabled' ? 'success' : 'info'"
            effect="plain"
            >{{
              translate(`workbenchNotificationCenter.systemNotifications.${service.status.value}`)
            }}</MarTag
          >
          <template v-else>{{
            translate(`workbenchNotificationCenter.systemNotifications.${service.status.value}`)
          }}</template>
        </p>
        <MarButton
          v-if="
            service.mode === 'mobile-push' &&
            service.enabled.value &&
            (enablingPush || ['actionRequired', 'unavailable'].includes(service.pushStatus.value))
          "
          icon="notification"
          :loading="enablingPush"
          @click="enablePush"
          >{{ translate('workbenchNotificationCenter.webPush.enable') }}</MarButton
        >
      </div>
      <p v-if="service.mode === 'mobile-push'" class="notification-channel-detail" role="status">
        {{ translate(`workbenchNotificationCenter.webPush.${service.pushStatus.value}`) }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.system-notification-control {
  margin-block-start: 0.875rem;
  font-size: var(--mar-font-size-body);
}
.notification-channel {
  display: grid;
  gap: 0.5rem;
}
.notification-channel h3 {
  margin: 0;
  font-size: inherit;
  font-weight: 600;
}
.notification-channel p {
  margin: 0;
}
.notification-channel-detail {
  flex-basis: 100%;
  min-inline-size: 0;
  color: var(--mar-text-secondary);
  line-height: 1.5;
  overflow-wrap: break-word;
}
.notification-channel-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
@media (pointer: coarse) {
  .notification-channel-actions > button {
    min-block-size: 44px;
  }
}
</style>
