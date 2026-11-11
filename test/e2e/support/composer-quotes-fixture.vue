<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ConversationTurn } from '@myagentroam/protocol';
import ConversationComposer from '../../../packages/web-core/src/view/composer/ConversationComposer.vue';
import ConversationTimeline from '../../../packages/web-core/src/view/conversation/ConversationTimeline.vue';
import WorkspaceTextFilePage from '../../../packages/web-core/src/view/workspace/WorkspaceTextFilePage.vue';
import GitDiffViewer from '../../../packages/web-core/src/view/workspace/GitDiffViewer.vue';
import FilePreviewSurface from '../../../packages/web-core/src/view/workspace/FilePreviewSurface.vue';
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
const payload = ref('');
const copied = ref('');
const failure = ref('');
const quoteTarget: ComposerQuoteTarget = {
  capture() {
    if (locked.value) return undefined;
    const origin = target.value;
    const slot = draft.value;
    return (quote) => {
      if (locked.value || origin !== target.value || slot !== draft.value) return;
      try {
        slot.references.value = appendComposerQuote(slot.references.value, quote, slot.input.value);
      } catch {
        failure.value = 'Quote rejected';
      }
    };
  }
};
const file = {
  path: 'src/example.ts',
  encoding: 'utf-8' as const,
  content: 'const first = 1;\nconst second = 2;\nreturn first + second;',
  truncated: false,
  revision: 'r1'
};
const diff = { path: file.path, text: '@@ -2,2 +2,2 @@\n-old value\n+new value\n same value' };
const workingDiff = { ...diff, afterText: 'first value\nnew value\nsame value' };
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
      surface.value = value;
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
    <FilePreviewSurface
      v-if="surface !== 'chat'"
      :overlay="true"
      label="Source file"
      @close="surface = 'chat'"
    >
      <WorkspaceTextFilePage
        v-if="surface === 'file'"
        :file="file"
        kind="text"
        :downloading="false"
        :target-line="undefined"
        :loading="false"
        :quote-target="quoteTarget"
      />
      <GitDiffViewer
        v-else-if="surface === 'diff'"
        :path="file.path"
        :paths="[file.path]"
        :diff="diff"
        :loading="false"
        source="HISTORY"
        revision="abc123"
        :preview-enabled="false"
        :quote-target="quoteTarget"
      />
      <GitDiffViewer
        v-else-if="surface === 'working-diff'"
        :path="file.path"
        :paths="[file.path]"
        :diff="workingDiff"
        :loading="false"
        source="WORKING_TREE"
        :preview-enabled="false"
        :quote-target="quoteTarget"
      />
    </FilePreviewSurface>
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
    :drop-target="false"
    placeholder="Opinion"
    :mobile-viewport="false"
    @remove-file-reference="
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
