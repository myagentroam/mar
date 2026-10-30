<script setup lang="ts">
import { reactive, ref } from 'vue';
import ConversationComposer from '../../../packages/web-core/src/view/composer/ConversationComposer.vue';
import ComposerReferencePicker from '../../../packages/web-core/src/view/composer/ComposerReferencePicker.vue';
import ComposerCommandPicker from '../../../packages/web-core/src/view/composer/ComposerCommandPicker.vue';
import { createComposerReferenceService } from '../../../packages/web-core/src/service/composer-reference-service.js';
import { createRunnerInteractionService } from '../../../packages/web-core/src/service/runner-interaction-service.js';
import { createWorkbenchComposerInteractionController } from '../../../packages/web-core/src/service/workbench-composer-interaction-controller.js';
import { serializeComposerMessage } from '../../../packages/web-core/src/service/composer-skill-token-service.js';

const input = ref('');
const mobile = ref(new URLSearchParams(location.search).get('mobile') === '1');
const filesReady = ref(true);
const nodeReady = ref(true);
const nodeId = ref('node');
const workspaceId = ref('workspace');
const currentSessionId = ref('current');
const composer = ref<InstanceType<typeof ConversationComposer>>();
const harness = reactive({
  calls: [] as string[],
  updates: 0,
  sends: 0,
  messages: [] as string[],
  aborted: 0,
  pending: false
});
Object.assign(window, { __referenceHarness: harness });

const completion = {
  enabled: true,
  contextKey: 'reference-fixture',
  request(_draft: unknown, signal: AbortSignal) {
    harness.pending = true;
    signal.addEventListener(
      'abort',
      () => {
        harness.pending = false;
        harness.aborted++;
      },
      { once: true }
    );
    return new Promise<never>(() => {});
  }
};
const references = createComposerReferenceService(input, {
  nodeId,
  workspaceId,
  ready: () => filesReady.value,
  sessions: { ready: () => nodeReady.value, currentSessionId },
  async request<T>(path: string): Promise<T> {
    harness.calls.push(path);
    const long = path.includes('long');
    if (path.includes('/files/search'))
      return {
        files: {
          entries: [
            {
              path: long ? `src/${'very-long-directory/'.repeat(6)}LongFile.ts` : 'src/alpha.ts',
              name: long ? `${'LongFile'.repeat(10)}.ts` : 'alpha.ts',
              kind: 'FILE'
            }
          ],
          nextCursor: null
        }
      } as T;
    return {
      sessions: path.includes('nonexistent')
        ? []
        : [
            { id: 'current', runner: 'codex', customTitle: 'Current' },
            {
              id: 'other-123456',
              runner: 'mar-agent',
              customTitle: long ? 'Long session title '.repeat(10) : 'Alpha session',
              lastActivityAt: 1700000000000
            }
          ],
      nextCursor: null
    } as T;
  }
});
const runner = createRunnerInteractionService({
  input,
  draftSessionOpen: ref(true),
  selectedSession: ref(undefined),
  profile: ref(undefined),
  quickPrompts: ref([{ id: 'review', phrase: 'review', prompt: 'Review\nchanges', updatedAt: 1 }])
});
const interactions = createWorkbenchComposerInteractionController({
  input,
  workspaceTarget: ref({ nodeId: 'node', workspaceId: 'workspace' }),
  filesReady,
  mobileViewport: mobile,
  canInterruptTurn: ref(false),
  runnerProfilesLoading: ref(false),
  runnerProfilesFailed: ref(false),
  commandPickerOpen: runner.commandPickerOpen,
  fileReferences: references,
  runnerInteractions: runner,
  hasRunnerProfile: () => true,
  loadRunnerProfiles: async () => {},
  ensureComposerSkills: () => {},
  ensureQuickPrompts: () => {},
  selectSkill: () => {},
  stopActiveRun: async () => {},
  sendMessage,
  loadOlderConversationTurns: async () => {},
  handleConversationScroll: () => {},
  scrollToLatest: () => {},
  scrollToLatestAfterLayout: async () => {},
  editRange: (start, end, text) => composer.value?.replaceRange(start, end, text) ?? false
});
function updateInput(value: string) {
  input.value = value;
  harness.updates++;
}
function sendMessage() {
  harness.sends++;
  harness.messages.push(serializeComposerMessage([], input.value, references.selected.value));
}
</script>

<template>
  <main class="fixture">
    <ConversationComposer
      ref="composer"
      :input="input"
      :readonly="false"
      :loading="false"
      :mobile-viewport="mobile"
      :command-states="[]"
      :skill-tokens="[]"
      :file-references="references.selected.value"
      :completion="completion"
      @update:input="updateInput"
      @input="interactions.onComposerInput"
      @cursor="interactions.onComposerCursor"
      @keydown="interactions.onComposerKeydown"
      @submit="sendMessage"
      @remove-reference="references.remove"
    >
      <template #picker>
        <ComposerReferencePicker
          :open="references.open.value"
          :candidates="references.candidates.value"
          :active-index="references.activeIndex.value"
          :loading="references.loading.value"
          :query="references.match.value?.query ?? ''"
          :session-enabled="true"
          :session-ready="nodeReady"
          :file-ready="filesReady"
          :session-only="references.match.value?.sessionOnly"
          :session-loading="references.sessionLoading.value"
          :file-error="references.fileError.value"
          :session-error="references.sessionError.value"
          :file-more="references.fileMore.value"
          :session-more="references.sessionMore.value"
          @activate="references.activeIndex.value = $event"
          @select="interactions.selectReference"
        />
        <ComposerCommandPicker
          :open="runner.commandPickerOpen.value"
          :commands="runner.visibleCommands.value"
          :skills="runner.visibleSkills.value"
          :quick-prompts="runner.visibleQuickPrompts.value"
          :picker-kind="runner.pickerKind.value"
          :active-index="runner.activeCommandIndex.value"
          :quick-prompts-loading="false"
          :quick-prompts-failed="false"
          :skills-enabled="false"
          :skills-loading="false"
          :skills-failed="false"
          :loading="false"
          :failed="false"
          @select-quick-prompt="interactions.selectQuickPrompt"
        />
      </template>
    </ConversationComposer>
    <button data-testid="send" @click="harness.sends++">Send</button>
  </main>
</template>
<style scoped>
.fixture {
  max-width: 780px;
  margin: 240px auto 0;
}
</style>
