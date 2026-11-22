<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import { marIcon } from '@myagentroam/mar-ui/icons';
import { translate } from '../../service/locale-preference-service.js';
</script>

<template>
  <MarButton
    tag="a"
    href="https://chatgpt.com/settings/usage"
    target="_blank"
    rel="noopener noreferrer"
    :icon="marIcon('external-link')"
    >{{ translate('marAgentModels.chatgptManageUsage') }}</MarButton
  >
</template>
