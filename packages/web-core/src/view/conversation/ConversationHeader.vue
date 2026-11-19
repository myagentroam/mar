<script setup lang="ts">
import { computed, ref } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import type { RunnerId, Session } from '../../model/workbench.js';
import { sessionIsDraft } from '../../util/session-presentation.js';
import MarIcon from '../common/MarIcon.vue';
import SessionNavigationMenu from '../common/SessionNavigationMenu.vue';

const props = defineProps<{
  readonly session: Session | undefined;
  readonly runner: RunnerId;
  readonly filesReady: boolean;
  readonly terminalReady: boolean;
  readonly asideReady?: boolean;
  readonly asideControls?: string | undefined;
  readonly asideExpanded?: boolean;
  readonly asideDisabled?: boolean;
  readonly contentSearchReady: boolean;
  readonly runnerIcon: (runner: RunnerId) => string;
  readonly sessionTitle: (session: Session) => string;
}>();

const emit = defineEmits<{
  openSurface: [surface: 'sessions' | 'inspector' | 'terminal'];
  openTree: [sessionId: string, anchor: HTMLElement];
  sessionMenuOpen: [];
}>();
const titleButton = ref<HTMLButtonElement>();
const asideLabel = computed(() =>
  props.asideExpanded
    ? translate('generated.conversationHeader.collapseAside')
    : translate('generated.conversationHeader.openAside')
);
</script>

<template>
  <header
    :class="['conversation-header', { 'conversation-header-draft': sessionIsDraft(session) }]"
  >
    <div class="conversation-header-title" role="heading" aria-level="2">
      <el-dropdown
        v-if="session && !sessionIsDraft(session)"
        :key="session.id"
        class="conversation-title-dropdown"
        popper-class="conversation-title-menu"
        placement="bottom-start"
        trigger="click"
        @visible-change="$event && emit('sessionMenuOpen')"
        @command="$event === 'tree' && titleButton && emit('openTree', session.id, titleButton)"
      >
        <button
          ref="titleButton"
          type="button"
          class="conversation-title-button conversation-title-row mar-icon-action"
        >
          <img
            :src="runnerIcon(session.runner)"
            :data-runner="session.runner"
            alt=""
            aria-hidden="true"
            class="mar-runner-brand-icon conversation-title-runner-icon"
          />
          <span class="conversation-title-text" v-tooltip="sessionTitle(session)">{{
            sessionTitle(session)
          }}</span>
          <MarIcon name="chevron-down" aria-hidden="true" />
        </button>
        <template #dropdown>
          <slot name="session-menu" :session="session">
            <SessionNavigationMenu :session-id="session.id" :can-navigate="false" />
          </slot>
        </template>
      </el-dropdown>
      <span v-else class="conversation-title-row">
        <img
          :src="runnerIcon(session?.runner ?? runner)"
          :data-runner="session?.runner ?? runner"
          alt=""
          aria-hidden="true"
          class="mar-runner-brand-icon conversation-title-runner-icon"
        />
        <span
          class="conversation-title-text"
          v-tooltip="{ content: translate('generated.conversationHeader.newSession'), touch: true }"
        >
          {{ translate('generated.conversationHeader.newSession2') }}
        </span>
      </span>
    </div>
    <div
      class="conversation-header-tools"
      role="group"
      :aria-label="translate('generated.conversationHeader.workspaceTools')"
    >
      <button
        class="mar-icon-button mar-icon-action conversation-header-tool conversation-header-tool-mobile-only"
        type="button"
        v-tooltip="translate('generated.conversationHeader.openSessionList')"
        :aria-label="translate('generated.conversationHeader.openSessionList')"
        @click="emit('openSurface', 'sessions')"
      >
        <MarIcon name="session-list" />
      </button>
      <slot v-if="session && !sessionIsDraft(session)" name="tree" :session-id="session.id" />
      <button
        v-if="asideReady || filesReady || terminalReady"
        class="mar-icon-button mar-icon-action conversation-header-tool"
        :class="{ 'conversation-header-tool-mobile-only': !asideControls }"
        type="button"
        v-tooltip="asideLabel"
        :aria-label="asideLabel"
        :aria-expanded="asideControls ? asideExpanded : undefined"
        :aria-controls="asideControls"
        :disabled="asideDisabled"
        @click="emit('openSurface', 'inspector')"
      >
        <MarIcon name="split" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.conversation-title-runner-icon {
  width: 1rem;
  height: 1rem;
}

.conversation-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  padding: 0.25rem 0.55rem;
  background: var(--mar-conversation-canvas);
}

.conversation-header-title {
  min-width: 0;
  max-inline-size: min(70%, 32rem);
  margin: 0;
  font-size: var(--mar-font-size-body);
  font-weight: 500;
}

.conversation-title-dropdown {
  max-width: 100%;
  vertical-align: middle;
}

.conversation-title-row {
  display: flex;
  min-width: 0;
  min-height: 2rem;
  align-items: center;
  gap: 0.38rem;
  padding-inline: 0.35rem;
  color: var(--mar-text-primary);
}

.conversation-title-button {
  max-width: 100%;
  font: inherit;
}

.conversation-title-button :deep(svg) {
  flex: none;
  width: 0.8rem;
  height: 0.8rem;
  color: var(--mar-text-secondary);
}

.conversation-title-text {
  min-width: 0;
  /* Leave room for glyph ink from fallback fonts inside the ellipsis clip. */
  padding-block: 0.125em;
  overflow: hidden;
  line-height: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-header-tools {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
}

.conversation-header-tool {
  display: inline-flex;
  flex: none;
  width: 2rem;
  height: 2rem;
  align-items: center;
  justify-content: center;
}

.conversation-header-tool .mar-icon {
  font-size: var(--mar-action-icon-size, 18px);
}

.conversation-header-tool-mobile-only {
  display: none;
}

@media (max-width: 767px) {
  .conversation-header {
    justify-content: flex-start;
    gap: 0.25rem;
  }

  .conversation-header-title {
    margin-inline-end: auto;
  }

  .conversation-title-row {
    min-height: 36px;
  }

  .conversation-header-tool {
    display: inline-flex;
    width: 36px;
    height: 36px;
  }
}
</style>
