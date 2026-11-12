<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ConversationTurn } from '@myagentroam/protocol';
import ConversationComposer from '../../../packages/web-core/src/view/composer/ConversationComposer.vue';
import ConversationTimeline from '../../../packages/web-core/src/view/conversation/ConversationTimeline.vue';
import WorkspaceTextFilePage from '../../../packages/web-core/src/view/workspace/WorkspaceTextFilePage.vue';
import WorkspaceGitDiffPage from '../../../packages/web-core/src/view/workspace/WorkspaceGitDiffPage.vue';
import WorkspaceFileTabs from '../../../packages/web-core/src/view/workspace/WorkspaceFileTabs.vue';
import type { WorkspaceFileTab } from '../../../packages/web-core/src/util/workspace-file-tab.js';
import {
  createSessionDraftService,
  type DraftTarget
} from '../../../packages/web-core/src/service/session-draft-service.js';
import { appendComposerQuote } from '../../../packages/web-core/src/util/composer-quote.js';
import { composerReferenceKey } from '../../../packages/web-core/src/util/composer-reference.js';
import { serializeComposerMessage } from '../../../packages/web-core/src/service/composer-skill-token-service.js';
import type { ComposerQuoteTarget } from '../../../packages/web-core/src/model/composer-quote.js';

const target = ref<DraftTarget>({ kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 's' });
const drafts = createSessionDraftService({ target, storage: localStorage });
const pane = ref<'main' | 'aside'>('main');
const draft = computed(() => drafts.forTarget(target.value, pane.value));
const input = computed({
  get: () => draft.value.input.value,
  set: (value: string) => {
    draft.value.input.value = value;
  }
});
input.value = 'Keep my opinion unchanged.';
const references = computed(() => draft.value.references.value);
const locked = ref(false);
const surface = ref('chat');
const activeTabId = ref(1);
const previewTabs = computed<WorkspaceFileTab[]>(() => {
  const tab: WorkspaceFileTab = {
    id: 1,
    identity: surface.value,
    nodeId: 'n',
    workspaceId: 'w',
    path: 'src/example.ts',
    fileName: 'example.ts',
    repositoryPath: '',
    worktreePath: '',
    kind: surface.value.startsWith('file')
      ? 'WORKTREE_TEXT'
      : surface.value === 'working-diff'
        ? 'WORKTREE_DIFF'
        : 'HISTORY_DIFF',
    commit: 'abc123'
  };
  return surface.value === 'file-multiple'
    ? [tab, { ...tab, id: 2, identity: 'second', kind: 'HISTORY_DIFF' }]
    : [tab];
});
const payload = ref('');
const copied = ref('');
const failure = ref('');
const quoteTarget: ComposerQuoteTarget = {
  capture() {
    if (locked.value) return undefined;
    const origin = target.value;
    const slot = draft.value;
    return (quote) => {
      if (locked.value || origin !== target.value || slot !== draft.value) return false;
      try {
        slot.references.value = appendComposerQuote(slot.references.value, quote, slot.input.value);
        return true;
      } catch {
        failure.value = 'Quote rejected';
        return false;
      }
    };
  }
};
const file = ref({
  path: 'src/example.ts',
  encoding: 'utf-8' as const,
  content: 'const first = 1;\nconst second = 2;\nreturn first + second;',
  truncated: false,
  revision: 'r1'
});
const diff = {
  path: file.value.path,
  text: '@@ -2,2 +2,2 @@\n-old value\n+new value\n same value'
};
const workingDiff = ref({ ...diff, afterText: 'first value\nnew value\nsame value' });
const now = 1_700_000_000_000;
function turn(
  id: string,
  kind: 'assistant_message' | 'user_message',
  text: string
): ConversationTurn {
  return {
    id,
    sessionId: 's',
    runId: null,
    userItemId: null,
    status: 'SUCCEEDED',
    model: null,
    effort: null,
    access: null,
    startedAt: now,
    completedAt: now + 1000,
    items: [
      {
        id: `${id}-message`,
        kind,
        status: 'COMPLETED',
        payload: { text },
        startedAt: now,
        completedAt: now + 1000
      }
    ]
  };
}
const turns = ref<ConversationTurn[]>([
  turn(
    'reply',
    'assistant_message',
    'Select this reply excerpt.\n\nKeep the original opinion. [A link](https://example.invalid)'
  )
]);
function send() {
  if (!input.value.trim() && !references.value.length) return;
  payload.value = serializeComposerMessage([], input.value, references.value);
  turns.value = [...turns.value, turn('sent', 'user_message', payload.value)];
  input.value = '';
  draft.value.references.value = [];
  surface.value = 'chat';
}
Object.assign(window, {
  quoteFixture: {
    changeTarget() {
      target.value = { ...target.value, sessionId: 'other', kind: 'session' };
    },
    lock() {
      locked.value = true;
    },
    payload: () => payload.value,
    copied: () => copied.value,
    references: () => references.value,
    setSurface(value: string) {
      activeTabId.value = 1;
      surface.value = value;
    },
    replaceFile(text: string) {
      file.value = { ...file.value, content: text };
    },
    replaceWorkingDiff(value: { text: string; afterText: string }) {
      workingDiff.value = { ...workingDiff.value, ...value };
    },
    replaceReply(text: string) {
      turns.value = [turn('reply', 'assistant_message', text)];
    }
  }
});
</script>

<template>
  <nav>
    <button @click="surface = 'chat'">Chat</button><button @click="surface = 'file'">File</button
    ><button @click="surface = 'diff'">Diff</button>
    <button @click="pane = pane === 'main' ? 'aside' : 'main'">Switch pane</button>
  </nav>
  <main>
    <WorkspaceFileTabs
      v-if="surface !== 'chat'"
      :tabs="previewTabs"
      :active-tab-id="activeTabId"
      @activate="activeTabId = $event"
      @close-all="surface = 'chat'"
      v-slot="{ tab, active, registerPageHandle, requestClose, requestCloseAll }"
    >
      <WorkspaceTextFilePage
        v-if="tab.kind === 'WORKTREE_TEXT'"
        :ref="registerPageHandle"
        v-show="active"
        :active="active"
        :file="file"
        kind="text"
        :downloading="false"
        :target-line="undefined"
        :loading="false"
        :quote-target="quoteTarget"
        :write-enabled="true"
        :save-file="async () => 'r2'"
        @close="requestClose"
        @quoted="requestCloseAll"
      />
      <WorkspaceGitDiffPage
        v-else
        :ref="registerPageHandle"
        v-show="active"
        :active="active"
        :tab="tab"
        :load="async () => (tab.kind === 'WORKTREE_DIFF' ? workingDiff : diff)"
        :quote-target="quoteTarget"
        @close="requestClose"
        @quoted="requestCloseAll"
      />
    </WorkspaceFileTabs>
    <ConversationTimeline
      v-else
      :turns="turns"
      :workspace-root="undefined"
      :loading="false"
      :initializing="false"
      :initial-render-version="1"
      :image-attachments="() => []"
      :user-input-questions="() => []"
      :user-input-answer="() => ({})"
      :user-input-submitted="() => false"
      :plan-continuation="undefined"
      :node-ready="true"
      :rewind-enabled="false"
      :rollback-enabled="false"
      :capture-render-anchor="() => () => {}"
      :quote-target="quoteTarget"
      @copy="
        (text, done) => {
          copied = text;
          done();
        }
      "
    />
  </main>
  <ConversationComposer
    v-model:input="input"
    :file-references="references"
    :skill-tokens="[]"
    :command-states="[]"
    :readonly="locked"
    :loading="false"
    :working="false"
    working-label=""
    :drop-target="false"
    placeholder="Opinion"
    :mobile-viewport="false"
    @remove-reference="
      draft.references.value = references.filter(
        (reference) => composerReferenceKey(reference) !== $event
      )
    "
    @submit="send"
  >
    <template #toolbar
      ><button id="send" :disabled="!input.trim() && !references.length" @click="send">
        Send
      </button></template
    >
  </ConversationComposer>
  <p id="failure">{{ failure }}</p>
</template>

<style scoped>
nav {
  display: flex;
  gap: 0.4rem;
  padding: 1rem;
}
main {
  height: 420px;
  overflow: auto;
  position: relative;
}
:deep(.composer-shell) {
  max-width: 800px;
  margin: 1rem auto;
}
</style>
