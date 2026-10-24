<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import { onMounted, ref } from 'vue';
import type { HostedConversationSnapshot } from '@myagentroam/protocol';
import { createHostedConversationEntryService } from '../../service/hosted-conversation-entry-service.js';
import type { createHostedConversationWorkspaceService } from '../../service/hosted-conversation-workspace-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import HostedConversationComposer from './HostedConversationComposer.vue';

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly workspace: ReturnType<typeof createHostedConversationWorkspaceService>;
  readonly mobileViewport: boolean;
  readonly connected?: boolean;
  readonly createConversation: (snapshot: HostedConversationSnapshot) => Promise<void>;
}>();
const emit = defineEmits<{
  started: [];
}>();

const service = createHostedConversationEntryService(props.request);
const loading = ref(false);
const loaded = ref(false);
let loadSequence = 0;

async function load(): Promise<void> {
  const sequence = ++loadSequence;
  loading.value = true;
  try {
    await service.loadTemplates();
    if (sequence !== loadSequence) return;
    loaded.value = true;
  } catch (error) {
    if (sequence !== loadSequence) return;
    showMessage(
      error instanceof Error ? errorMessage(error) : translate('hostedConversations.loadFailed'),
      'error',
      error
    );
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

async function createConversation(): Promise<boolean> {
  try {
    const snapshot = await service.create();
    await props.createConversation(snapshot);
    return true;
  } catch (error) {
    showMessage(
      error instanceof Error ? errorMessage(error) : translate('hostedConversations.createFailed'),
      'error',
      error
    );
    return false;
  }
}

function refreshTemplatesOnOpen(visible: boolean): void {
  if (visible && !loading.value) void load();
}

onMounted(load);
</script>

<template>
  <section
    v-loading="loading && !loaded"
    element-loading-custom-class="mar-page-loading"
    class="hosted-entry-page"
    :aria-busy="loading"
  >
    <div class="conversation-create-panel">
      <div class="conversation-create-heading">
        <h2>{{ translate('conversationEmpty.hosted.title') }}</h2>
        <p>{{ translate('hostedConversations.chooseTemplateHint') }}</p>
      </div>
      <HostedConversationComposer
        :connected="connected"
        :workspace="workspace"
        :mobile-viewport="mobileViewport"
        :readonly="false"
        readonly-reason=""
        draft
        :entry="service"
        :create-conversation="createConversation"
        :reload-templates="refreshTemplatesOnOpen"
        @started="emit('started')"
      />
    </div>
  </section>
</template>

<style scoped>
.hosted-entry-page {
  box-sizing: border-box;
  display: grid;
  width: 100%;
  min-height: 100%;
  min-width: 0;
  flex: 1 1 auto;
  place-items: center;
  padding: 24px;
}

.conversation-create-panel {
  box-sizing: border-box;
  display: grid;
  width: min(45rem, 100%);
  min-width: 0;
  gap: 1rem;
}

.conversation-create-heading {
  display: grid;
  justify-items: center;
  gap: 0.75rem;
  text-align: center;
}

.conversation-create-heading h2 {
  margin: 0;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-page-title);
  font-weight: 600;
  line-height: 1.4;
}

.conversation-create-heading p {
  max-width: 32rem;
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

@media (max-width: 767px) {
  .hosted-entry-page {
    place-items: end stretch;
    padding: 0;
  }

  .conversation-create-panel {
    width: 100%;
  }

  .conversation-create-heading {
    display: none;
  }
}
</style>
