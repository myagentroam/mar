<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '../../util/mar-icons.js';

import { promptCompletionPreferenceService } from '../../service/prompt-completion-preference-service';
import { translate } from '../../service/locale-preference-service';
import { errorMessage } from '../../util/workbench-presentation';

const service = promptCompletionPreferenceService();
function setEnabled(value: boolean) {
  try {
    service.setEnabled(value);
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
  }
}
</script>

<template>
  <div class="theme-row completion-preferences">
    <label for="appearance-prompt-completion" class="theme-label">
      {{ translate('promptCompletion.work') }}
    </label>
    <el-select
      id="appearance-prompt-completion"
      :model-value="service.enabled.value"
      class="theme-select"
      :aria-label="translate('promptCompletion.work')"
      @update:model-value="setEnabled"
      :clear-icon="marIcon('clear-input')"
      :suffix-icon="marIcon('chevron-down')"
    >
      <el-option :label="translate('promptCompletion.off')" :value="false" />
      <el-option :label="translate('promptCompletion.on')" :value="true" />
    </el-select>
  </div>
</template>

<style scoped>
.theme-label {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-weight: 400;
}
.theme-select {
  width: 100%;
}
</style>
