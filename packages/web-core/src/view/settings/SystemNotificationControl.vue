<script setup lang="ts">
import { computed } from 'vue';
import { Bell, SwitchButton } from '@element-plus/icons-vue';
import type { WorkbenchNotificationService } from '../../service/WorkbenchNotificationService.js';
import { translate } from '../../service/LocalePreferenceService.js';

const props = defineProps<{
  readonly service: WorkbenchNotificationService['systemNotifications'];
}>();
const blocked = computed(
  () =>
    !props.service.enabled.value &&
    ['unsupported', 'insecure', 'denied'].includes(props.service.status.value)
);
</script>

<template>
  <div class="system-notification-control">
    <div class="notification-channel">
      <div class="notification-channel-info">
        <h3>{{ translate('workbenchNotificationCenter.systemNotifications.onlineTitle') }}</h3>
        <p role="status">
          {{ translate(`workbenchNotificationCenter.systemNotifications.${service.status.value}`) }}
        </p>
      </div>
      <div class="notification-channel-actions">
        <el-button
          link
          :icon="service.enabled.value ? SwitchButton : Bell"
          :loading="service.requesting.value"
          :disabled="blocked"
          @click="service.setEnabled(!service.enabled.value)"
        >
          {{
            translate(
              service.enabled.value
                ? 'workbenchNotificationCenter.systemNotifications.disable'
                : 'workbenchNotificationCenter.systemNotifications.enable'
            )
          }}
        </el-button>
      </div>
    </div>
    <div class="notification-channel">
      <div class="notification-channel-info">
        <h3>{{ translate('workbenchNotificationCenter.webPush.title') }}</h3>
        <p role="status">
          {{ translate(`workbenchNotificationCenter.webPush.${service.pushStatus.value}`) }}
        </p>
      </div>
      <div
        v-if="
          service.enabled.value &&
          ['actionRequired', 'unavailable'].includes(service.pushStatus.value)
        "
        class="notification-channel-actions"
      >
        <el-button link :icon="Bell" @click="service.enablePush()">
          {{ translate('workbenchNotificationCenter.webPush.enable') }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.system-notification-control {
  display: grid;
  max-inline-size: 48rem;
  font-size: var(--mar-font-size-body);
}
.notification-channel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 0.75rem 1.25rem;
  padding-block: 0.9rem;
}
.notification-channel + .notification-channel {
  border-top: 1px solid var(--mar-border-default);
}
.notification-channel-info {
  display: grid;
  min-inline-size: 0;
  gap: 0.35rem;
}
.notification-channel-info h3 {
  margin: 0;
  font-size: inherit;
  font-weight: 600;
}
.notification-channel-info p {
  margin: 0;
  color: var(--mar-text-secondary);
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.notification-channel-actions {
  display: flex;
  flex-wrap: wrap;
  max-inline-size: 100%;
  gap: 0.5rem;
}
@media (max-width: 767px) {
  .notification-channel {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
