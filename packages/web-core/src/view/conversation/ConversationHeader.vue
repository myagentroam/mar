<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { translate } from '../../service/LocalePreferenceService.js';
import type { RunnerId, Session } from '../../model/workbench.js';
import { sessionIsDraft } from '../../util/session-presentation.js';

defineProps<{
  readonly session: Session | undefined;
  readonly runner: RunnerId;
  readonly filesReady: boolean;
  readonly terminalReady: boolean;
  readonly contentSearchReady: boolean;
  readonly runnerIcon: (runner: RunnerId) => string;
  readonly sessionTitle: (session: Session) => string;
  readonly activity: (session: Session) => string;
  readonly activityLabel: (session: Session) => string;
}>();

const emit = defineEmits<{
  openSurface: [surface: 'sessions' | 'inspector' | 'terminal'];
}>();

async function copySessionId(sessionId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sessionId);
    ElMessage.info(translate('generated.conversationHeader.sessionIdCopied'));
  } catch {
    ElMessage.error(translate('generated.conversationHeader.copySessionIdFailed'));
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
          :title="
            sessionIsDraft(session)
              ? translate('generated.conversationHeader.newSession')
              : sessionTitle(session!)
          "
        >
          {{
            sessionIsDraft(session)
              ? translate('generated.conversationHeader.newSession2')
              : sessionTitle(session!)
          }}
        </h2>
        <span
          v-if="session && !sessionIsDraft(session) && activity(session) === 'MANAGED_ACTIVE'"
          :class="['session-activity', activity(session).toLocaleLowerCase()]"
          :aria-label="activityLabel(session)"
          :title="activityLabel(session)"
          role="img"
          ><i aria-hidden="true"
        /></span>
      </div>
      <p v-if="session && !sessionIsDraft(session)" class="conversation-session-id">
        <button
          type="button"
          :aria-label="
            translate('generated.conversationHeader.copySessionId', { sessionId: session.id })
          "
          :title="
            translate('generated.conversationHeader.copySessionId', { sessionId: session.id })
          "
          @click="copySessionId(session.id)"
        >
          <code>{{ session.id }}</code>
        </button>
      </p>
    </div>
    <div
      class="mobile-conversation-tools"
      :aria-label="translate('generated.conversationHeader.workspaceTools')"
    >
      <button
        type="button"
        :aria-label="translate('generated.conversationHeader.openSessionList')"
        @click="emit('openSurface', 'sessions')"
      >
        {{ translate('generated.conversationHeader.sessions') }}
      </button>
      <button
        v-if="filesReady"
        type="button"
        :aria-label="translate('generated.conversationHeader.openFiles')"
        @click="emit('openSurface', 'inspector')"
      >
        {{ translate('generated.conversationHeader.files') }}
      </button>
      <button
        v-if="terminalReady"
        type="button"
        :aria-label="translate('generated.conversationHeader.openTerminal')"
        @click="emit('openSurface', 'terminal')"
      >
        {{ translate('generated.conversationHeader.terminal') }}
      </button>
    </div>
  </header>
</template>

<style scoped>
.conversation-header p {
  margin: 0;
  color: var(--mar-text-tertiary);
  font-size: 0.7rem;
}

.conversation-title-runner-icon {
  width: 1rem;
  height: 1rem;
}

.conversation-header {
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
  gap: 0.32rem;
}

.conversation-header h2 {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 0.875rem;
}

.conversation-title-row h2 {
  flex: 0 1 auto;
  max-width: calc(100% - 2rem);
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

:global(.conversation-session-id code) {
  color: var(--mar-text-muted);
  font-family: ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 0.6875rem;
  line-height: 1rem;
  white-space: nowrap;
}

.conversation-session-id button {
  display: inline-flex;
  max-width: 100%;
  border: 0;
  border-radius: 3px;
  background: transparent;
  padding: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: start;
}

.conversation-session-id button:hover code,
.conversation-session-id button:focus-visible code {
  color: var(--mar-color-brand-text);
}

.conversation-session-id button:focus-visible {
  outline: 1px solid var(--mar-color-brand-text);
  outline-offset: 2px;
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
  .conversation-session-id,
  .conversation-session-id button,
  :global(.conversation-header-title .conversation-session-id code) {
    display: block;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    background: transparent;
    color: var(--mar-text-secondary);
    padding: 0.25rem 0.42rem;
    font: inherit;
    font-size: 0.7rem;
  }
}

@media (max-width: 767px) {
  .mobile-conversation-tools button:focus-visible,
  .mobile-conversation-tools button:hover {
    background: var(--mar-color-brand-subtle);
    color: var(--mar-color-brand-text);
    outline: none;
  }
}
</style>
