<script setup lang="ts">
import WorkspaceLabelsFixture from './workspace-labels-fixture.vue';
import ChatGPTManageUsageButton from '../../src/view/common/ChatGPTManageUsageButton.vue';
import QuickPromptSettings from '../../src/view/settings/QuickPromptSettings.vue';
import { ref } from 'vue';
import MarIcon from '../../src/view/common/MarIcon.vue';
import { marIcon } from '../../src/util/mar-icons.js';
import AgentMarkdown from '../../src/view/common/AgentMarkdown.vue';
import LoadingPanel from '../../src/view/common/LoadingPanel.vue';
import { showMessage } from '../../src/service/message-feedback-service.js';
const value = ref('');
const selection = ref('one');
const selections = ref(['one', 'unavailable']);
const menuAction = ref('');
const sampleLoading = ref(true);
const activeTab = ref('settings');
const configurationScope = ref('node');
const scopeOptions = [
  { label: 'Node', value: 'node' },
  { label: 'Workspace', value: 'workspace' },
  { label: 'Unavailable', value: 'unavailable', disabled: true }
];
async function refreshPrompts(): Promise<void> {}
async function requestPrompt<T>(): Promise<T> {
  throw new Error('This visual fixture does not persist prompts');
}
const message =
  'Body text with **emphasis** and `inline code`.\n\n### Section heading\n\n| Item | Value |\n| --- | --- |\n| Example | Readable content |';
const linkMessage = [
  '[Windows protocol](E:/project/docs/design/BLE_PROTOCOL.md#L7)',
  'README.md:10',
  '[Relative file](docs/guide.md#L3)',
  '[Temporary file](sandbox:/tmp/note.txt)',
  '[External website](https://example.com/help)',
  '[Unsafe](javascript:alert(1))'
].join('\n\n');
const openedMarkdownFiles = ref<
  {
    path: string;
    line: number | undefined;
    column: number | undefined;
    external: boolean;
  }[]
>([]);

function recordMarkdownFile(
  path: string,
  line: number | undefined,
  column: number | undefined,
  external: boolean
): void {
  openedMarkdownFiles.value.push({ path, line, column, external });
}

const dialogOpen = ref(false);
const longFeedback = Array.from(
  { length: 36 },
  (_, index) => `Line ${index + 1}: long feedback remains readable and can be dismissed.`
).join('\n');

function showRepeatedFeedback(): void {
  showMessage('Repeated feedback event', 'info');
  showMessage('Repeated feedback event', 'info');
}

function saveFeedbackDialog(): void {
  dialogOpen.value = false;
  showMessage('Dialog settings saved', 'success');
}
</script>
<template>
  <WorkspaceLabelsFixture />
  <section aria-label="Real management actions">
    <QuickPromptSettings
      :prompts="[
        { id: 'visual-prompt', phrase: 'review', prompt: 'Review this change', updatedAt: 0 }
      ]"
      :loading="false"
      :failed="false"
      :refresh="refreshPrompts"
      :request="requestPrompt"
    />
  </section>
  <section aria-label="Real theme controls">
    <el-input v-model="value" aria-label="Sample input" />
    <el-select v-model="value" aria-label="Sample select">
      <el-option label="One" value="one" />
    </el-select>
    <el-button>Sample default</el-button>
    <el-button disabled>Sample disabled default</el-button>
    <el-button type="primary">Sample primary</el-button>
    <el-button type="primary" disabled>Sample disabled primary</el-button>
    <el-button type="primary" link>Sample link</el-button>
    <el-button type="primary" link disabled>Sample disabled link</el-button>
    <el-button link>Sample neutral action</el-button>
    <el-button link disabled>Sample disabled neutral action</el-button>
    <el-button link type="danger">Sample dangerous action</el-button>
    <div v-for="type in ['success', 'warning', 'danger', 'info'] as const" :key="type">
      <el-button :type="type" link :icon="marIcon('delete')">Sample {{ type }} action</el-button>
      <el-button :type="type" link disabled :icon="marIcon('delete')"
        >Sample disabled {{ type }} action</el-button
      >
    </div>
    <ChatGPTManageUsageButton />
    <el-link type="primary">Sample anchor</el-link>
    <el-table :data="[{ name: 'First' }, { name: 'Second' }]">
      <el-table-column prop="name" label="Name" />
    </el-table>
  </section>
  <section aria-label="Select state samples">
    <el-select v-model="selection" aria-label="Neutral select">
      <el-option label="One" value="one" />
      <el-option label="Two" value="two" />
      <el-option label="Unavailable" value="unavailable" disabled />
    </el-select>
    <el-select v-model="selections" aria-label="Multiple select" multiple>
      <el-option label="One" value="one" />
      <el-option label="Two" value="two" />
      <el-option label="Unavailable" value="unavailable" disabled />
    </el-select>
    <el-select v-model="selection" aria-label="Disabled select" disabled>
      <el-option label="One" value="one" />
    </el-select>
  </section>
  <section aria-label="Tabs state samples">
    <el-tabs v-model="activeTab">
      <el-tab-pane label="Settings" name="settings">Settings content</el-tab-pane>
      <el-tab-pane label="Permissions" name="permissions">Permissions content</el-tab-pane>
      <el-tab-pane label="Unavailable" name="unavailable" disabled />
      <el-tab-pane label="Long configuration tab name" name="configuration">
        Configuration content
      </el-tab-pane>
    </el-tabs>
  </section>
  <section class="segmented-surface-fixture" aria-label="Segmented state samples">
    <el-segmented
      v-model="configurationScope"
      aria-label="Configuration scope"
      :options="scopeOptions"
    />
    <el-segmented
      model-value="node"
      aria-label="Disabled configuration scope"
      :options="scopeOptions"
      disabled
    />
  </section>
  <section aria-label="Dropdown state samples">
    <el-dropdown trigger="click" @command="menuAction = $event">
      <button type="button" class="utility-control">Sample menu</button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="rename"><MarIcon name="edit" />Rename</el-dropdown-item>
          <el-dropdown-item command="copy"><MarIcon name="copy" />Copy</el-dropdown-item>
          <el-dropdown-item command="unavailable" disabled>Unavailable</el-dropdown-item>
          <el-dropdown-item command="delete" divided>
            <MarIcon name="delete" />Delete
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <output aria-label="Selected menu action">{{ menuAction }}</output>
  </section>
  <section class="conversation-typography-fixture" aria-label="Real conversation typography">
    <AgentMarkdown :content="message" />
    <p class="conversation-metadata">Run duration 11s</p>
  </section>
  <section aria-label="Conversation file links">
    <AgentMarkdown
      :content="linkMessage"
      workspace-root="E:/project"
      @open-file="recordMarkdownFile"
    />
    <output aria-label="Opened Markdown files">{{ JSON.stringify(openedMarkdownFiles) }}</output>
  </section>
  <section aria-label="Message feedback controls">
    <button
      type="button"
      data-testid="show-info-feedback"
      @click="showMessage('Theme-aware info feedback', 'info')"
    >
      Show info feedback
    </button>
    <button
      type="button"
      data-testid="show-success-feedback"
      @click="showMessage('Theme-aware success feedback', 'success')"
    >
      Show success feedback
    </button>
    <button
      type="button"
      data-testid="show-warning-feedback"
      @click="showMessage('Theme-aware warning feedback', 'warning')"
    >
      Show warning feedback
    </button>
    <button
      type="button"
      data-testid="show-error-feedback"
      @click="showMessage('Theme-aware error feedback', 'error')"
    >
      Show error feedback
    </button>
    <button
      type="button"
      data-testid="show-long-feedback"
      @click="showMessage(longFeedback, 'error')"
    >
      Show long feedback
    </button>
    <button
      type="button"
      data-testid="show-plain-text-feedback"
      @click="showMessage('Plain text <img data-feedback-payload=unsafe src=x>', 'warning')"
    >
      Show plain-text feedback
    </button>
    <button type="button" data-testid="show-repeated-feedback" @click="showRepeatedFeedback">
      Show repeated feedback
    </button>
    <button type="button" data-testid="open-feedback-dialog" @click="dialogOpen = true">
      Open feedback dialog
    </button>
    <el-dialog v-if="dialogOpen" v-model="dialogOpen" title="Message feedback dialog">
      <p>Dialog content</p>
      <button
        type="button"
        data-testid="show-dialog-feedback"
        @click="showMessage(longFeedback, 'error')"
      >
        Show dialog feedback
      </button>
      <button type="button" data-testid="save-feedback-dialog" @click="saveFeedbackDialog">
        Save and close
      </button>
    </el-dialog>
  </section>
  <section aria-label="Loading directive sample">
    <button type="button" @click="sampleLoading = !sampleLoading">Toggle sample loading</button>
    <LoadingPanel :loading="sampleLoading" variant="region">Content</LoadingPanel>
  </section>
</template>

<style scoped>
.segmented-surface-fixture {
  background: var(--mar-bg-panel);
  padding: 0.75rem;
}

.conversation-typography-fixture {
  margin-top: 1rem;
  background: var(--mar-conversation-canvas);
  padding: 1rem;
}

.conversation-metadata {
  color: var(--mar-conversation-muted);
}
</style>
