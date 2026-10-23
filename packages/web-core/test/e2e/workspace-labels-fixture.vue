<script setup lang="ts">
import { ref } from 'vue';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';

const branch = ref('develop');
const gitWorkspace = ref(true);
const workspaceProps = {
  sessions: [],
  selectedSessionId: undefined,
  mobileViewport: false,
  canLoadMore: false,
  loadingMore: false,
  active: false,
  watchStatus: 'ready' as const,
  nodeReady: false,
  loading: false,
  workspaceKindLabel: 'Git',
  title: () => '',
  runnerIcon: () => '',
  activity: () => '',
  activityLabel: () => '',
  activityDateTime: () => undefined,
  activityTitle: () => undefined,
  relativeActivity: () => '',
  nodeId: 'theme-fixture-node',
  workspaceId: 'theme-fixture-workspace',
  skillSupported: false,
  mcpSupported: false,
  cleanupSessionsSupported: false,
  searchSupported: false,
  searchQuery: '',
  searching: false,
  refreshing: false,
  workspaceManageable: false,
  request: async () => {
    throw new Error('Unexpected workspace fixture request');
  },
  hasUnread: () => false
};
</script>

<template>
  <section aria-label="Real workspace labels">
    <el-checkbox v-model="gitWorkspace">Git workspace</el-checkbox>
    <el-input v-model="branch" aria-label="Workspace branch" />
    <WorkspaceSessionList
      v-bind="workspaceProps"
      :workspace-kind="gitWorkspace ? 'GIT_WORKSPACE' : 'DIRECTORY'"
      :workspace-branch="gitWorkspace ? branch : undefined"
    />
  </section>
</template>
