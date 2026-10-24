<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '../../util/mar-icons.js';
import { onUnmounted, ref, watch } from 'vue';

import { PersonalGitService } from '../../service/personal-git-service.js';
import { translate as t } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/error-presentation.js';

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
async function load(): Promise<void> {
  const current = ++generation;
  preserve.value = props.initialValue ?? false;
  includeParent.value = undefined;
  loaded.value = false;
  loading.value = false;
  saving.value = false;
  if (!props.connected) return;
  loading.value = true;
  try {
    const result = await service.workspacePolicy(props.nodeId, props.workspaceId);
    if (current !== generation) return;
    preserve.value = result.preserveGitConfig;
    includeParent.value = result.includeParentRepository;
    loaded.value = true;
  } catch (error) {
    if (current === generation) showMessage(errorMessage(error), 'error', error);
  } finally {
    if (current === generation) loading.value = false;
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
  <section class="workspace-git-settings" v-loading="loading">
    <h3>{{ t('personalGit.workspaceTitle') }}</h3>
    <p v-if="!connected">{{ t('personalGit.offline') }}</p>
    <template v-else>
      <div class="workspace-git-controls">
        <el-checkbox v-if="loaded" v-model="preserve" :disabled="!writable || saving">{{
          t('personalGit.preserve')
        }}</el-checkbox>
        <el-checkbox
          v-if="loaded && includeParent !== undefined"
          v-model="includeParent"
          :disabled="!writable || saving"
          >{{ t('personalGit.includeParent') }}</el-checkbox
        >
        <el-button
          v-if="writable"
          type="primary"
          :icon="marIcon('check')"
          :disabled="!loaded || loading || saving"
          :loading="saving"
          @click="save"
          :loading-icon="marIcon('loading-action')"
          >{{ t('personalGit.save') }}</el-button
        >
      </div>
      <p class="workspace-git-hint">{{ t('personalGit.preserveHint') }}</p>
      <p v-if="includeParent !== undefined" class="workspace-git-hint">
        {{ t('personalGit.includeParentHint') }}
      </p>
      <el-button v-if="!loaded && !loading" @click="load">{{ t('personalGit.reload') }}</el-button>
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
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
</style>
