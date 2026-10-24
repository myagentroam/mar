<script setup lang="ts">
import { showMessage } from '@myagentroam/web-core/message-feedback';

import { onMounted, ref } from 'vue';

import type { OrganizationSummary } from '@/service/enterprise-management-service';
import EnvironmentSecretManager from './EnvironmentSecretManager.vue';
import CorePage from '@myagentroam/web-core/SecretManagementPage.vue';
import { translate } from '@/service/locale-preference-service';
import { errorMessage } from '@/util/workbench-presentation';

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly edition: 'COMMUNITY' | 'ENTERPRISE';
  readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
}>();
const organizations = ref<readonly OrganizationSummary[]>([]);

onMounted(async () => {
  if (props.edition !== 'ENTERPRISE' || props.role === 'MEMBER') return;
  try {
    organizations.value = (
      await props.request<{ organizations: readonly OrganizationSummary[] }>('/api/organizations')
    ).organizations;
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('generated.secretManagementPage.unableToLoadOrganizations'),
      'error',
      error
    );
  }
});
</script>

<template>
  <CorePage :request="request" :writable="writable">
    <EnvironmentSecretManager
      :request="request"
      :scopes="
        edition === 'ENTERPRISE' && role !== 'MEMBER' ? ['PERSONAL', 'ORGANIZATION'] : ['PERSONAL']
      "
      :organizations="organizations"
      :writable="writable"
      :active="true"
    />
  </CorePage>
</template>
