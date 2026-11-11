<script setup lang="ts">
import { ref, shallowRef } from 'vue';
import HostedConversationComposer from '../../src/view/conversation/HostedConversationComposer.vue';
import { hostedConversationSubmissionContext } from '../../src/service/hosted-conversation-workspace-service.js';

const intents = ref<string[]>([]);
const composer = ref<InstanceType<typeof HostedConversationComposer>>();
const quoteSelection = new URL(location.href).searchParams.has('quote-selection');
const idleComposer = new URL(location.href).searchParams.has('idle-composer');
const snapshot = shallowRef({
  nodeAppVersion: '0.11.31',
  conversation: {
    id: 'conversation-a',
    nodeId: 'node-a',
    sessionId: 'session-a',
    modelId: 'model-a',
    templateId: 'template-a',
    templateName: 'Mobile template',
    status: 'ACTIVE',
    activity: { status: idleComposer ? 'IDLE' : 'RUNNING' }
  },
  run: idleComposer ? undefined : { id: 'run-a', status: 'RUNNING', startedAt: Date.now() },
  models: [{ id: 'model-a', name: 'Default model' }]
});
const workspace = {
  snapshot,
  selectedWatchId: () => 'conversation-a',
  turns: ref([]),
  templateChanging: ref(false),
  watchReady: ref(true),
  messageSubmitting: ref(false),
  messageSubmissionContext: ref(hostedConversationSubmissionContext('node-a', 'conversation-a')),
  sendMessage: async (message: { deliveryIntent?: string }) => {
    intents.value.push(message.deliveryIntent ?? 'SEND');
  },
  interrupt: async () => {
    intents.value.push('STOP');
  }
};
</script>

<template>
  <section class="hosted-gesture-fixture">
    <h1>Hosted conversation</h1>
    <output aria-label="Submitted intents">{{ intents.join(',') }}</output>
    <button
      v-if="quoteSelection"
      @click="
        composer?.quoteTarget.capture()?.({
          type: 'quote',
          source: 'assistant',
          messageId: 'reply',
          label: 'Reply excerpt',
          text: 'Hosted saved snapshot.'
        })
      "
    >
      Add saved quote
    </button>
    <HostedConversationComposer
      ref="composer"
      :workspace="workspace as never"
      :connected="true"
      :mobile-viewport="true"
      :readonly="false"
      readonly-reason=""
    />
  </section>
</template>

<style scoped>
.hosted-gesture-fixture {
  display: flex;
  flex-direction: column;
  height: 100dvh;
}
.hosted-gesture-fixture :deep(.composer-host) {
  margin-top: auto;
}
</style>
