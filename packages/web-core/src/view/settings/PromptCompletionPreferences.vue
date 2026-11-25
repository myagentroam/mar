<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import { MarOption, MarSelect } from '@myagentroam/mar-ui/select';

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
  <div class="mar-settings-option-row completion-preferences">
    <label id="appearance-prompt-completion-label" for="appearance-prompt-completion">
      {{ translate('promptCompletion.work') }}
    </label>
    <MarSelect
      id="appearance-prompt-completion"
      :model-value="service.enabled.value"
      aria-labelledby="appearance-prompt-completion-label"
      @update:model-value="setEnabled"
    >
      <MarOption :label="translate('promptCompletion.off')" :value="false" />
      <MarOption :label="translate('promptCompletion.on')" :value="true" />
    </MarSelect>
  </div>
</template>
