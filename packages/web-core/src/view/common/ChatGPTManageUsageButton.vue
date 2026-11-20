<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import { marIcon } from '../../util/mar-icons.js';
import { translate } from '../../service/locale-preference-service.js';
</script>

<template>
  <MarButton
    tag="a"
    class="manage-usage-button"
    href="https://chatgpt.com/settings/usage"
    target="_blank"
    rel="noopener noreferrer"
    :icon="marIcon('external-link')"
    >{{ translate('marAgentModels.chatgptManageUsage') }}</MarButton
  >
</template>

<style scoped>
.manage-usage-button {
  --mar-ui-button-hover-bg: var(--mar-control-color-primary-light-9);
  --mar-ui-button-hover-border: var(--mar-control-color-primary-light-7);
  --mar-ui-button-hover-fg: var(--mar-color-brand);
}
</style>
