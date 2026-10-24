<script setup lang="ts">
import EnvironmentSecretManager from './EnvironmentSecretManager.vue';
import { translate } from '../../service/locale-preference-service';

defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
}>();
</script>

<template>
  <section class="management-page">
    <slot>
      <EnvironmentSecretManager
        :request="request"
        :scopes="['PERSONAL']"
        :writable="writable"
        :active="true"
      />
    </slot>
  </section>
</template>
