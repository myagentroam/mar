<script setup lang="ts">
import WorkspaceLabelsFixture from './workspace-labels-fixture.vue';
import { ref } from 'vue';
import AgentMarkdown from '../../src/view/common/AgentMarkdown.vue';
const value = ref('');
const message =
  'Body text with **emphasis** and `inline code`.\n\n### Section heading\n\n| Item | Value |\n| --- | --- |\n| Example | Readable content |';
</script>
<template>
  <WorkspaceLabelsFixture />
  <section aria-label="Real theme controls">
    <el-input v-model="value" aria-label="Sample input" />
    <el-select v-model="value" aria-label="Sample select">
      <el-option label="One" value="one" />
    </el-select>
    <el-button>Sample default</el-button>
    <el-button type="primary">Sample primary</el-button>
    <el-button type="primary" disabled>Sample disabled primary</el-button>
    <el-button type="primary" link>Sample link</el-button>
    <el-button type="primary" link disabled>Sample disabled link</el-button>
    <el-link type="primary">Sample anchor</el-link>
    <el-table :data="[{ name: 'First' }, { name: 'Second' }]">
      <el-table-column prop="name" label="Name" />
    </el-table>
  </section>
  <section class="conversation-typography-fixture" aria-label="Real conversation typography">
    <AgentMarkdown :content="message" />
    <p class="conversation-metadata">Run duration 11s</p>
  </section>
</template>

<style scoped>
.conversation-typography-fixture {
  margin-top: 1rem;
  background: var(--mar-conversation-canvas);
  padding: 1rem;
}

.conversation-metadata {
  color: var(--mar-conversation-muted);
}
</style>
