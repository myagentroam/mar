<script setup lang="ts">
import '../../styles/region-retry-action.css';
import { MarCheckbox } from '@myagentroam/mar-ui/checkbox';
import { MarButton } from '@myagentroam/mar-ui/button';
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '@myagentroam/mar-ui/icons';
import { onUnmounted, ref, watch } from 'vue';

import { PersonalGitService } from '../../service/personal-git-service.js';
import { translate as t } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarRegionStatus } from '@myagentroam/mar-ui/region-status';

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly connected: boolean;
  readonly writable: boolean;
  readonly initialValue?: boolean | undefined;
}>();
const service = new PersonalGitService(props.request);
const preserve = ref(false);
const includeParent = ref<boolean>();
const loading = ref(false);
const retrying = ref(false);
const saving = ref(false);
const loaded = ref(false);
let generation = 0;
onUnmounted(() => {
  generation++;
});
watch(
  () => [props.nodeId, props.workspaceId, props.connected, props.writable],
  () => void load(),
  { immediate: true }
);
function retry(): void {
  if (!loading.value && !loaded.value) void load(true);
}
async function load(retry = false): Promise<void> {
  const current = ++generation;
  preserve.value = props.initialValue ?? false;
  includeParent.value = undefined;
  loaded.value = false;
  loading.value = false;
  retrying.value = false;
  saving.value = false;
  if (!props.connected) return;
  loading.value = true;
  retrying.value = retry;
  try {
    const result = await service.workspacePolicy(props.nodeId, props.workspaceId);
    if (current !== generation) return;
    preserve.value = result.preserveGitConfig;
    includeParent.value = result.includeParentRepository;
    loaded.value = true;
  } catch {
    // The current scope exposes an in-place retry rather than a second notification.
  } finally {
    if (current === generation) {
      loading.value = false;
      retrying.value = false;
    }
  }
}
async function save(): Promise<void> {
  if (!props.connected || !props.writable || !loaded.value || saving.value) return;
  const current = generation;
  saving.value = true;
  try {
    const result = await service.saveWorkspacePolicy(
      props.nodeId,
      props.workspaceId,
      preserve.value,
      includeParent.value
    );
    if (current === generation) {
      preserve.value = result.preserveGitConfig;
      includeParent.value = result.includeParentRepository;
      showMessage(t('personalGit.saved'), 'success');
    }
  } catch (error) {
    if (current === generation) showMessage(errorMessage(error), 'error', error);
  } finally {
    if (current === generation) saving.value = false;
  }
}
</script>
<template>
  <section class="workspace-git-settings">
    <h3>{{ t('personalGit.workspaceTitle') }}</h3>
    <p v-if="!connected">{{ t('personalGit.offline') }}</p>
    <template v-else>
      <div class="workspace-git-controls">
        <MarCheckbox v-if="loaded" v-model="preserve" :disabled="!writable || saving">{{
          t('personalGit.preserve')
        }}</MarCheckbox>
        <MarCheckbox
          v-if="loaded && includeParent !== undefined"
          v-model="includeParent"
          :disabled="!writable || saving"
          >{{ t('personalGit.includeParent') }}</MarCheckbox
        >
        <MarButton
          v-if="writable"
          type="primary"
          :icon="marIcon('check')"
          :disabled="!loaded || loading || saving"
          :loading="saving"
          @click="save"
          >{{ t('personalGit.save') }}</MarButton
        >
      </div>
      <p class="workspace-git-hint">{{ t('personalGit.preserveHint') }}</p>
      <p v-if="includeParent !== undefined" class="workspace-git-hint">
        {{ t('personalGit.includeParentHint') }}
      </p>
      <MarRegionStatus v-if="!loaded">
        <MarButton
          class="mar-region-retry-action"
          v-if="retrying || !loading"
          link
          :aria-disabled="retrying || undefined"
          :aria-busy="retrying || undefined"
          :aria-label="retrying ? t('common.loading') : undefined"
          @click="retry"
        >
          <MarBusyIndicator v-if="retrying" class="mar-read-loading-indicator" />
          <template v-else>{{ t('common.loadFailedRetry') }}</template>
        </MarButton>
        <span v-else role="progressbar" :aria-label="t('common.loading')">
          <MarBusyIndicator class="mar-read-loading-indicator" />
        </span>
      </MarRegionStatus>
    </template>
  </section>
</template>
<style scoped>
.workspace-git-settings {
  margin-top: 16px;
}
.workspace-git-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.workspace-git-hint {
  margin: 8px 0 0;
  color: var(--mar-text-secondary);
  line-height: 1.6;
}
</style>
