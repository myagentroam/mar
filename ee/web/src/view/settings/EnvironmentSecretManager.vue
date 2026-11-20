<script setup lang="ts">
import { MarCascader } from '@myagentroam/mar-ui/cascader';
import { MarFormItem, type FormRules } from '@myagentroam/mar-ui/form';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';
import { marIcon } from '@myagentroam/web-core/icons';
import { computed, ref } from 'vue';
import type { EnvironmentSecretInput as CoreInput } from '@myagentroam/web-core/environment-secrets';
import CoreManager from '@myagentroam/web-core/EnvironmentSecretManager.vue';
import {
  createEnvironmentSecretService,
  type EnvironmentSecretScope,
  type EnvironmentSecretSummary,
  type OrganizationSecretVisibility
} from '@/service/environment-secret-service';
import {
  organizationCascaderOptions,
  organizationDisplayLabel,
  type OrganizationSummary
} from '@/service/enterprise-management-service';
import { translate } from '@/service/locale-preference-service';
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly scopes: readonly EnvironmentSecretScope[];
  readonly nodeId?: string;
  readonly active?: boolean;
  readonly writable?: boolean;
  readonly organizations?: readonly OrganizationSummary[];
}>();
const service = createEnvironmentSecretService(props.request);
const organizationId = ref<number>();
const visibility = ref<OrganizationSecretVisibility>('PRIVATE');
const organizationOptions = computed(() => organizationCascaderOptions(props.organizations ?? []));
const formRules = computed<FormRules>(() => ({
  organizationId: [
    {
      required: true,
      message: translate('generated.environmentSecretManager.selectAnOrganization'),
      trigger: 'change'
    }
  ]
}));
function clearForm(): void {
  organizationId.value = undefined;
  visibility.value = 'PRIVATE';
}
function openCreate(): void {
  clearForm();
  organizationId.value = props.organizations?.[0]?.id;
}
function scopeLabel(scope: string): string {
  return scope === 'PERSONAL'
    ? translate('generated.environmentSecretManager.personal')
    : scope === 'NODE'
      ? translate('generated.environmentSecretManager.node')
      : translate('generated.environmentSecretManager.organization');
}
function ownerLabel(secret: EnvironmentSecretSummary): string {
  return secret.scope === 'PERSONAL'
    ? translate('generated.environmentSecretManager.personal2')
    : secret.organizationId === null
      ? '-'
      : organizationDisplayLabel(props.organizations ?? [], secret.organizationId);
}
function visibilityLabel(secret: EnvironmentSecretSummary): string {
  return secret.scope !== 'ORGANIZATION'
    ? '-'
    : secret.visibility === 'PUBLIC'
      ? translate('generated.environmentSecretManager.public')
      : translate('generated.environmentSecretManager.private');
}
async function submitCreate(input: CoreInput<string>): Promise<void> {
  await service.create({
    ...input,
    scope: input.scope as EnvironmentSecretScope,
    ...(input.scope === 'ORGANIZATION' && organizationId.value !== undefined
      ? { organizationId: organizationId.value }
      : {}),
    ...(input.scope === 'ORGANIZATION' ? { visibility: visibility.value } : {})
  });
}
</script>
<template>
  <CoreManager
    :request="request"
    :scopes="scopes"
    v-bind="nodeId === undefined ? {} : { nodeId }"
    :active="active"
    :writable="writable"
    :scope-label="scopeLabel"
    :owner-label="ownerLabel"
    :visibility-label="visibilityLabel"
    :show-ownership="scopes.includes('ORGANIZATION')"
    :form-context="{ organizationId }"
    :form-rules="formRules"
    :submit-create="submitCreate"
    @create="openCreate"
    @clear-form="clearForm"
  >
    <template #create-fields="{ scope, disabled }">
      <MarFormItem
        v-if="scope === 'ORGANIZATION'"
        :label="translate('generated.environmentSecretManager.visibility2')"
        required
      >
        <MarSelect
          v-model="visibility"
          :placeholder="translate('generated.environmentSecretManager.selectVisibility')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <MarOption
            :label="translate('generated.environmentSecretManager.privateThisOrganizationOnly')"
            value="PRIVATE"
          />
          <MarOption
            :label="
              translate('generated.environmentSecretManager.publicInheritedByChildOrganizations')
            "
            value="PUBLIC"
          />
        </MarSelect>
      </MarFormItem>
      <MarFormItem
        v-if="scope === 'ORGANIZATION'"
        :label="translate('generated.environmentSecretManager.organization3')"
        prop="organizationId"
      >
        <div
          role="group"
          :aria-label="translate('generated.environmentSecretManager.organization3')"
        >
          <MarCascader
            v-model="organizationId"
            :disabled="disabled"
            style="width: 100%"
            filterable
            :placeholder="translate('generated.environmentSecretManager.selectAnOrganization2')"
            :options="organizationOptions"
            :props="{ checkStrictly: true, emitPath: false }"
            :clear-icon="marIcon('clear-input')"
          />
        </div>
      </MarFormItem>
    </template>
  </CoreManager>
</template>
