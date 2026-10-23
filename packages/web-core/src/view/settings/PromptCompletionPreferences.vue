<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { promptCompletionPreferenceService } from '../../service/PromptCompletionPreferenceService';
import { translate } from '../../service/LocalePreferenceService';
import { errorMessage } from '../../util/workbench-presentation';

const service = promptCompletionPreferenceService();
function setEnabled(value: boolean) {
  try {
    service.setEnabled(value);
  } catch (error) {
    ElMessage.error(errorMessage(error));
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
  font-weight: 600;
}
.theme-select {
  width: min(18rem, 100%);
}
</style>
