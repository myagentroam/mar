<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useDocumentationMessages } from '../messages';

const props = withDefaults(
  defineProps<{
    action?: 'install' | 'registry';
    platform?: 'bash' | 'powershell';
  }>(),
  { action: 'install', platform: 'bash' }
);
const { t } = useDocumentationMessages();

const version = ref<string>();
const versionLabel = computed(() => version.value ?? t('versionPending'));
const command = computed(() => {
  if (props.platform === 'powershell') {
    const value = version.value ?? t('versionPlaceholder');
    const install = `& npm.cmd install --global "@myagentroam/node@$serverVersion"`;
    const installed = `& npm.cmd list --global "@myagentroam/node@$serverVersion" --depth=0`;
    const registry = `& npm.cmd view "@myagentroam/node@$serverVersion" version`;
    return `$serverVersion = '${value}'\n${props.action === 'install' ? `${install}\n${installed}` : registry}`;
  }
  const value = version.value ?? t('versionPlaceholder');
  const install = 'npm install --global "@myagentroam/node@${server_version}"';
  const installed = 'npm list --global "@myagentroam/node@${server_version}" --depth=0';
  const registry = 'npm view "@myagentroam/node@${server_version}" version';
  return `server_version='${value}'\n${props.action === 'install' ? `${install}\n${installed}` : registry}`;
});

onMounted(async () => {
  try {
    const response = await fetch('/api/workbench-capabilities', {
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (!response.ok) return;
    const result: unknown = await response.json();
    if (
      typeof result === 'object' &&
      result !== null &&
      typeof (result as { serverVersion?: unknown }).serverVersion === 'string' &&
      /^\d+\.\d+\.\d+$/u.test((result as { serverVersion: string }).serverVersion)
    )
      version.value = (result as { serverVersion: string }).serverVersion;
  } catch {
    // Keep an actionable placeholder when public docs are signed out or offline.
  }
});
</script>

<template>
  <div class="server-version-command" data-testid="server-version-command">
    <p>
      {{ t('currentServerVersion') }} <code>{{ versionLabel }}</code>
      <span v-if="version === undefined">{{ t('versionPendingHint') }}</span>
    </p>
    <pre><code>{{ command }}</code></pre>
  </div>
</template>
