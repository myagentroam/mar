<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import { translate } from '../../service/LocalePreferenceService.js';
</script>

<template>
  <el-button
    tag="a"
    href="https://chatgpt.com/settings/usage"
    target="_blank"
    rel="noopener noreferrer"
    :icon="marIcon('external-link')"
    >{{ translate('marAgentModels.chatgptManageUsage') }}</el-button
  >
</template>
