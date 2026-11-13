<script setup lang="ts">
import { ref } from 'vue';
import ConversationScroll from '../../src/view/conversation/ConversationScroll.vue';
import ConversationComposer from '../../src/view/composer/ConversationComposer.vue';

const query = new URLSearchParams(location.search);
const kind = query.get('kind');
const state = query.get('state');
const input = ref('');
</script>

<template>
  <main class="fixture-conversation">
    <ConversationScroll
      :has-older="false"
      :loading-initial="state === 'loading'"
      :initial-load-failed="state === 'failed'"
      :loading-older="false"
      :has-turns="state === 'nonempty'"
      :following="false"
      :empty-prompt="kind === 'workspace' || kind === 'hosted' ? kind : undefined"
      ><p v-if="state === 'nonempty'">Existing message</p></ConversationScroll
    >
    <ConversationComposer
      v-model:input="input"
      placeholder="Message"
      :working="false"
      working-label="Working"
      :readonly="false"
      :drop-target="false"
      :mobile-viewport="false"
      :command-states="[]"
      :loading="false"
      :skill-tokens="[]"
    />
  </main>
</template>

<style scoped>
.fixture-conversation {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100vh;
}
</style>
