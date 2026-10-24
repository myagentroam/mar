<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import { onMounted, ref } from 'vue';
import type { HostedConversationEntryService } from '../../service/hosted-conversation-entry-service.js';
import type { createHostedConversationWorkspaceService } from '../../service/hosted-conversation-workspace-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import HostedConversationComposer from './HostedConversationComposer.vue';

const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly workspace: ReturnType<typeof createHostedConversationWorkspaceService>;
  readonly mobileViewport: boolean;
  readonly connected?: boolean;
  readonly entry: HostedConversationEntryService;
}>();
const emit = defineEmits<{
  started: [];
}>();

const service = props.entry;
const loading = ref(false);
const loaded = ref(false);
let loadSequence = 0;
let modelLoadSequence = 0;

async function load(): Promise<void> {
  const sequence = ++loadSequence;
  loading.value = true;
  try {
    await service.loadTemplates();
    if (sequence !== loadSequence) return;
    loaded.value = true;
    await loadModels();
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

async function loadModels(): Promise<void> {
  const sequence = ++modelLoadSequence;
  try {
    await service.loadModelOptions();
  } catch (error) {
    if (sequence !== modelLoadSequence) return;
    showMessage(
      error instanceof Error ? errorMessage(error) : translate('hostedConversations.loadFailed'),
      'error',
      error
    );
  }
}
function refreshTemplatesOnOpen(visible: boolean): void {
  if (visible && !loading.value) void load();
}

function refreshModelsOnOpen(visible: boolean): void {
  if (visible) void loadModels();
}

onMounted(() => {
  if (service.templates.value.length === 0) void load();
  else if (!service.modelOptionsLoaded.value) void loadModels();
});
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
        :reload-templates="refreshTemplatesOnOpen"
        :reload-models="refreshModelsOnOpen"
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
