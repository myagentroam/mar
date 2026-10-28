<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { translate } from '../../service/locale-preference-service.js';
import { computed, nextTick, ref, watch } from 'vue';
import type {
  ComposerReferenceCandidate,
  ComposerReferenceFilter
} from '../../service/composer-reference-service.js';
import FileTypeIcon from '../workspace/FileTypeIcon.vue';
import { sessionTitle } from '../../util/session-presentation.js';
import { runnerLabel } from '../../util/runner-presentation.js';
import { formatDateTime } from '../../util/time-presentation.js';

const props = withDefaults(
  defineProps<{
    readonly open: boolean;
    readonly candidates: readonly ComposerReferenceCandidate[];
    readonly activeIndex: number;
    readonly loading: boolean;
    readonly query: string;
    readonly sessionEnabled?: boolean;
    readonly sessionReady?: boolean;
    readonly fileReady?: boolean;
    readonly filter?: ComposerReferenceFilter;
    readonly sessionOnly?: boolean;
    readonly sessionLoading?: boolean;
    readonly fileError?: boolean;
    readonly sessionError?: boolean;
    readonly fileMore?: boolean;
    readonly sessionMore?: boolean;
  }>(),
  { fileReady: true, sessionReady: true }
);
const emit = defineEmits<{
  activate: [index: number];
  select: [entry: ComposerReferenceCandidate];
  filter: [filter: ComposerReferenceFilter];
}>();
const picker = ref<HTMLElement>();
const pickerLabel = computed(() =>
  translate(
    props.sessionEnabled
      ? 'composerReference.picker'
      : 'generated.composerFileReferencePicker.referenceAFileOrFolder'
  )
);
const groups = computed(() => {
  const indexed = props.candidates.map((candidate, index) => ({ candidate, index }));
  return {
    file: indexed.filter(({ candidate }) => candidate.type === 'file'),
    session: indexed.filter(({ candidate }) => candidate.type === 'session')
  };
});

watch(
  [() => props.activeIndex, () => props.candidates],
  () =>
    void nextTick(() => {
      picker.value
        ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    }),
  { flush: 'post' }
);
</script>

<template>
  <div
    v-if="open"
    ref="picker"
    class="command-picker file-reference-picker"
    :aria-label="pickerLabel"
  >
    <div
      v-if="sessionEnabled"
      class="reference-filters"
      role="group"
      :aria-label="translate('composerReference.filter')"
    >
      <button
        v-for="kind in ['all', 'file', 'session'] as const"
        :key="kind"
        type="button"
        :disabled="sessionOnly && kind !== 'session'"
        :aria-pressed="(filter ?? 'all') === kind"
        @mousedown.prevent
        @click="emit('filter', kind)"
      >
        {{ translate(`composerReference.${kind}`) }}
      </button>
    </div>
    <div role="listbox" :aria-label="pickerLabel">
      <template v-for="kind in ['file', 'session'] as const" :key="kind">
        <template
          v-if="
            (kind === 'file' && filter !== 'session') ||
            (kind === 'session' && sessionEnabled && filter !== 'file')
          "
        >
          <p v-if="sessionEnabled" class="source-heading">
            {{ translate(`composerReference.${kind}`) }}
          </p>
          <p v-if="kind === 'file' && fileReady === false">
            {{ translate('composerReference.fileUnavailable') }}
          </p>
          <p v-else-if="kind === 'file' && !query">
            {{ translate('composerReference.enterPath') }}
          </p>
          <p v-else-if="kind === 'file' && loading" role="status">
            <MarIcon name="loading-action" />
            {{ translate('generated.composerFileReferencePicker.searchingFilesAndFolders') }}
          </p>
          <p v-else-if="kind === 'file' && fileError" role="status">
            {{ translate('composerReference.fileError') }}
          </p>
          <p v-else-if="kind === 'session' && !sessionReady">
            {{ translate('composerReference.sessionUnavailable') }}
          </p>
          <p v-else-if="kind === 'session' && sessionLoading" role="status">
            <MarIcon name="loading-action" /> {{ translate('composerReference.sessionLoading') }}
          </p>
          <p v-else-if="kind === 'session' && sessionError" role="status">
            {{ translate('composerReference.sessionError') }}
          </p>
          <button
            v-for="{ candidate, index } in groups[kind]"
            :key="candidate.key"
            v-tooltip="
              candidate.type === 'file'
                ? candidate.entry.path
                : `${sessionTitle(candidate.session)} · ${runnerLabel(candidate.session.runner)} · ${candidate.session.id}`
            "
            type="button"
            role="option"
            :class="{ active: index === activeIndex }"
            :aria-selected="index === activeIndex"
            @mouseenter="emit('activate', index)"
            @mousedown.prevent
            @click="emit('select', candidate)"
          >
            <FileTypeIcon
              v-if="candidate.type === 'file'"
              :name="candidate.entry.name"
              :kind="candidate.entry.kind"
            />
            <MarIcon v-else name="recent-sessions" />
            <span class="candidate-name">{{
              candidate.type === 'file' ? candidate.entry.name : sessionTitle(candidate.session)
            }}</span>
            <code v-if="candidate.type === 'file'">{{ candidate.entry.path }}</code>
            <code v-else
              >{{ runnerLabel(candidate.session.runner)
              }}<template v-if="candidate.session.lastActivityAt">
                · {{ formatDateTime(candidate.session.lastActivityAt) }}</template
              ></code
            >
            <span v-if="candidate.type === 'file'" class="entry-kind">{{
              candidate.entry.kind === 'DIRECTORY'
                ? translate('generated.composerFileReferencePicker.folder')
                : translate('generated.composerFileReferencePicker.file')
            }}</span>
            <span v-else class="entry-kind">{{ candidate.session.id.slice(0, 8) }}</span>
          </button>
          <p
            v-if="
              kind === 'file' &&
              fileReady !== false &&
              query &&
              !loading &&
              !fileError &&
              !candidates.some((c) => c.type === 'file')
            "
          >
            {{ translate('generated.composerFileReferencePicker.noMatchingPaths') }}
          </p>
          <p
            v-if="
              kind === 'session' &&
              sessionReady &&
              !sessionLoading &&
              !sessionError &&
              !candidates.some((c) => c.type === 'session')
            "
          >
            {{ translate('composerReference.noSessions') }}
          </p>
          <p v-if="(kind === 'file' && fileMore) || (kind === 'session' && sessionMore)">
            {{ translate('composerReference.refine') }}
          </p>
        </template>
      </template>
    </div>
  </div>
</template>
<style scoped>
.command-picker {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.5rem);
  left: 0;
  display: grid;
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--mar-border-strong);
  border-radius: 5px;
  background: var(--mar-control-bg-color-overlay);
  box-shadow: 0 4px 12px var(--mar-shadow-soft);
}

.command-picker button {
  font-family: inherit;
  font-size: var(--mar-font-size-body);
  font-weight: 400;
  line-height: 1.4;
  display: grid;
  grid-template-columns: max-content 150px minmax(0, 1fr) max-content;
  gap: 0.55rem;
  border: 0;
  border-bottom: 1px solid var(--mar-fill-hover);
  border-radius: 0;
  background: var(--mar-control-bg-color-overlay);
  color: var(--mar-text-secondary);
  cursor: pointer;
  padding: 0.55rem 0.65rem;
  text-align: left;
}

.command-picker [role='option'] {
  box-sizing: border-box;
  width: 100%;
}

.command-picker button:hover {
  background: var(--mar-fill-row-hover);
}

.command-picker button.active {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}

.command-picker button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}

.reference-filters {
  display: flex;
  gap: 0.25rem;
  padding: 0.35rem;
}
.reference-filters button {
  display: block;
  border: 0;
  border-radius: var(--mar-radius-control);
  padding: 0.25rem 0.55rem;
}
.reference-filters button[aria-pressed='true'] {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}
.reference-filters button:disabled {
  opacity: 0.5;
  cursor: default;
}

.command-picker p {
  margin: 0;
  color: var(--mar-text-tertiary);
  padding: 0.65rem;
  font-size: var(--mar-font-size-meta);
}

.file-reference-picker button code,
.file-reference-picker button .candidate-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-reference-picker button code {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.entry-kind {
  color: var(--mar-text-faint);
  font-size: var(--mar-font-size-meta);
  white-space: nowrap;
}
</style>
<style scoped>
@media (max-width: 767px) {
  .command-picker {
    max-height: min(200px, 34dvh);
  }

  .command-picker [role='option'] {
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    justify-self: stretch;
    grid-template-columns: max-content minmax(0, 0.45fr) minmax(0, 1fr) max-content;
    gap: 0.45rem;
    padding: 0.5rem 0.65rem;
  }

  .command-picker .candidate-name {
    white-space: nowrap;
  }

  .command-picker button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
