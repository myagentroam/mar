<script setup lang="ts">
import { MarDropdownMenu, MarDropdownItem } from '@myagentroam/mar-ui/dropdown';
import { translate } from '../../service/locale-preference-service.js';
import { showMessage } from '../../service/message-feedback-service.js';
import { MarIcon } from '@myagentroam/mar-ui/icons';

const props = defineProps<{
  sessionId: string;
  canNavigate: boolean;
  navigationDisabled?: boolean;
}>();
const emit = defineEmits<{ open: [sessionId: string, destination: 'aside' | 'main'] }>();

async function copySessionId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.sessionId);
    showMessage(translate('generated.conversationHeader.sessionIdCopied'), 'info');
  } catch {
    showMessage(translate('generated.conversationHeader.copySessionIdFailed'), 'error');
  }
}
</script>

<template>
  <MarDropdownMenu class="session-navigation-menu">
    <template v-if="canNavigate">
      <MarDropdownItem :disabled="navigationDisabled" @click="emit('open', sessionId, 'aside')">
        <MarIcon name="split" />{{ translate('sessionGroups.openAside') }}
      </MarDropdownItem>
      <MarDropdownItem :disabled="navigationDisabled" @click="emit('open', sessionId, 'main')">
        <MarIcon name="conversation" />{{ translate('sessionGroups.openMain') }}
      </MarDropdownItem>
    </template>
    <slot name="actions" />
    <MarDropdownItem :divided="canNavigate && !$slots.actions" @click="copySessionId">
      <MarIcon name="copy" />{{ translate('generated.conversationHeader.copySessionId') }}
    </MarDropdownItem>
    <slot name="destructive" />
  </MarDropdownMenu>
</template>

<style scoped>
.session-navigation-menu :deep(.mar-ui-dropdown-item) {
  gap: 0.4rem;
}
</style>
