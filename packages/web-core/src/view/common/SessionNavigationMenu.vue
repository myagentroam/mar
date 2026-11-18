<script setup lang="ts">
import { translate } from '../../service/locale-preference-service.js';
import { showMessage } from '../../service/message-feedback-service.js';
import MarIcon from './MarIcon.vue';

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
  <el-dropdown-menu class="session-navigation-menu">
    <template v-if="canNavigate">
      <el-dropdown-item :disabled="navigationDisabled" @click="emit('open', sessionId, 'aside')">
        <MarIcon name="split" />{{ translate('sessionGroups.openAside') }}
      </el-dropdown-item>
      <el-dropdown-item :disabled="navigationDisabled" @click="emit('open', sessionId, 'main')">
        <MarIcon name="conversation" />{{ translate('sessionGroups.openMain') }}
      </el-dropdown-item>
    </template>
    <slot name="actions" />
    <el-dropdown-item :divided="canNavigate && !$slots.actions" @click="copySessionId">
      <MarIcon name="copy" />{{ translate('generated.conversationHeader.copySessionId') }}
    </el-dropdown-item>
    <slot name="destructive" />
  </el-dropdown-menu>
</template>

<style scoped>
.session-navigation-menu :deep(.el-dropdown-menu__item) {
  gap: 0.4rem;
}
</style>
