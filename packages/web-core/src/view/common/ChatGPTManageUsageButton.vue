<script setup lang="ts">
import { TopRight } from '@element-plus/icons-vue';
import { translate } from '../../service/LocalePreferenceService.js';
</script>

<template>
  <el-button
    tag="a"
    href="https://chatgpt.com/settings/usage"
    target="_blank"
    rel="noopener noreferrer"
    :icon="TopRight"
    >{{ translate('marAgentModels.chatgptManageUsage') }}</el-button
  >
</template>
