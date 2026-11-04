<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import { translate } from '../../service/locale-preference-service.js';
import type { RunnerId, Session } from '../../model/workbench.js';
import { sessionIsDraft } from '../../util/session-presentation.js';

defineProps<{
  readonly session: Session | undefined;
  readonly runner: RunnerId;
  readonly filesReady: boolean;
  readonly terminalReady: boolean;
  readonly asideReady?: boolean;
  readonly contentSearchReady: boolean;
  readonly runnerIcon: (runner: RunnerId) => string;
  readonly sessionTitle: (session: Session) => string;
}>();

const emit = defineEmits<{
  openSurface: [surface: 'sessions' | 'inspector' | 'terminal'];
}>();

async function copySessionId(sessionId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sessionId);
    showMessage(translate('generated.conversationHeader.sessionIdCopied'), 'info');
  } catch {
    showMessage(translate('generated.conversationHeader.copySessionIdFailed'), 'error');
  }
}
</script>

<template>
  <header
    :class="['conversation-header', { 'conversation-header-draft': sessionIsDraft(session) }]"
  >
    <div class="conversation-header-title">
      <div class="conversation-title-row">
        <img
          :src="runnerIcon(session?.runner ?? runner)"
          :data-runner="session?.runner ?? runner"
          alt=""
          aria-hidden="true"
          class="runner-brand-icon conversation-title-runner-icon"
        />
        <h2
          v-tooltip="{
            content: sessionIsDraft(session)
              ? translate('generated.conversationHeader.newSession')
              : sessionTitle(session!),
            touch: true
          }"
        >
          {{
            sessionIsDraft(session)
              ? translate('generated.conversationHeader.newSession2')
              : sessionTitle(session!)
          }}
        </h2>
      </div>
      <p v-if="session && !sessionIsDraft(session)" class="conversation-session-id">
        <button
          class="utility-control conversation-session-id-copy"
          v-tooltip="
            translate('generated.conversationHeader.copySessionId', { sessionId: session.id })
          "
          type="button"
          :aria-label="
            translate('generated.conversationHeader.copySessionId', { sessionId: session.id })
          "
          @click="copySessionId(session.id)"
        >
          <code>{{ session.id }}</code>
        </button>
        <slot name="tree" :session-id="session.id" />
      </p>
    </div>
    <div
      class="mobile-conversation-tools"
      :aria-label="translate('generated.conversationHeader.workspaceTools')"
    >
      <button
        class="utility-control"
        type="button"
        :aria-label="translate('generated.conversationHeader.openSessionList')"
        @click="emit('openSurface', 'sessions')"
      >
        {{ translate('generated.conversationHeader.sessions') }}
      </button>
      <button
        class="utility-control"
        v-if="asideReady || filesReady || terminalReady"
        type="button"
        :aria-label="translate('generated.conversationHeader.openAside')"
        @click="emit('openSurface', 'inspector')"
      >
        {{ translate('generated.conversationHeader.more') }}
      </button>
    </div>
  </header>
</template>

<style scoped>
.conversation-header p {
  margin: 0;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.conversation-title-runner-icon {
  width: 1rem;
  height: 1rem;
}

.conversation-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 49px;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 0.42rem 0.8rem;
}

.conversation-header > div {
  min-width: 0;
}

.conversation-header-title {
  display: grid;
  gap: 0.05rem;
}

.conversation-title-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.32rem;
}

.conversation-header p {
  margin: 0.18rem 0 0;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.conversation-header h2 {
  margin: 0;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: var(--mar-font-size-body);
}

.conversation-header-draft {
  justify-content: flex-start;
}

.conversation-header-draft > div {
  flex: 0 1 auto;
}

.conversation-header-draft .conversation-title-row h2 {
  flex: 0 0 auto;
  max-width: none;
  overflow: visible;
  text-overflow: clip;
}

.mobile-conversation-tools {
  display: none;
}

.conversation-session-id {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.25rem;
}

:global(.conversation-session-id code) {
  display: block;
  overflow: hidden;
  color: inherit;
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-meta);
  line-height: 1rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-session-id-copy {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  border: 0;
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  font: inherit;
  text-align: start;
}

@media (max-width: 767px) {
  .conversation-header {
    min-height: 47px;
    gap: 0.4rem;
    padding: 0.32rem 0.55rem;
  }

  .conversation-header-title {
    flex: 1 1 auto;
  }
}

@media (max-width: 767px) {
  .conversation-session-id-copy:focus-visible {
    outline-offset: -2px;
  }
}

@media (max-width: 767px) {
  .mobile-conversation-tools {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.2rem;
    margin-left: auto;
  }
}

@media (max-width: 767px) {
  .mobile-conversation-tools button {
    display: inline-flex;
    min-height: 36px;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    border: 0;
    border-radius: 5px;
    padding: 0.25rem 0.42rem;
    font: inherit;
    font-size: var(--mar-font-size-body);
  }
}
</style>
