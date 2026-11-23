<script setup lang="ts">
import '@myagentroam/mar-ui/surface-chrome.css';
import './composer-candidate-picker.css';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { translate } from '../../service/locale-preference-service.js';
import { computed, nextTick, ref, watch } from 'vue';
import type { ComposerReferenceCandidate } from '../../service/composer-reference-service.js';
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
    readonly sessionOnly?: boolean;
    readonly sessionLoading?: boolean;
    readonly fileError?: boolean;
    readonly capacityExceeded?: boolean;
    readonly sessionError?: boolean;
    readonly fileMore?: boolean;
    readonly sessionMore?: boolean;
  }>(),
  { fileReady: true, sessionReady: true }
);
const emit = defineEmits<{
  activate: [index: number];
  select: [entry: ComposerReferenceCandidate];
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
    class="command-picker file-reference-picker mar-composer-candidate-picker mar-compact-overlay"
  >
    <p v-if="capacityExceeded" role="status">{{ translate('errors.COMPOSER_TAG_INVALID') }}</p>
    <div role="listbox" :aria-label="pickerLabel">
      <template v-for="kind in ['session', 'file'] as const" :key="kind">
        <template
          v-if="(kind === 'file' && !sessionOnly) || (kind === 'session' && sessionEnabled)"
        >
          <p v-if="sessionEnabled" class="mar-composer-candidate-heading">
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
                : `${sessionTitle(candidate.session)} · ${runnerLabel(candidate.session.runner)}${candidate.session.lastActivityAt ? ` · ${formatDateTime(candidate.session.lastActivityAt)}` : ''}`
            "
            type="button"
            role="option"
            :class="{ 'session-candidate': kind === 'session' }"
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
            <span v-else class="candidate-meta"
              >{{ runnerLabel(candidate.session.runner)
              }}<template v-if="candidate.session.lastActivityAt">
                · {{ formatDateTime(candidate.session.lastActivityAt) }}</template
              ></span
            >
            <span v-if="candidate.type === 'file'" class="entry-kind">{{
              candidate.entry.kind === 'DIRECTORY'
                ? translate('generated.composerFileReferencePicker.folder')
                : translate('generated.composerFileReferencePicker.file')
            }}</span>
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
.file-reference-picker [role='option'] {
  grid-template-columns: 1rem var(--composer-candidate-name-width) minmax(0, 1fr) max-content;
}

.file-reference-picker .session-candidate {
  grid-template-columns: 1rem minmax(0, 1fr) fit-content(50%);
}

.candidate-meta {
  text-align: end;
}

.entry-kind {
  white-space: nowrap;
}

.file-reference-picker [role='status'] :deep(.mar-icon) {
  vertical-align: middle;
}
</style>
