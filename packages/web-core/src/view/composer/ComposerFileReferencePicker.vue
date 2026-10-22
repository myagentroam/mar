<script setup lang="ts">
import { translate } from '../../service/LocalePreferenceService.js';
import { nextTick, ref, watch } from 'vue';
import type { FileReferenceEntry } from '../../service/FileReferenceService.js';
import FileTypeIcon from '../workspace/FileTypeIcon.vue';

const props = defineProps<{
  readonly open: boolean;
  readonly entries: readonly FileReferenceEntry[];
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly query: string;
}>();
const emit = defineEmits<{ activate: [index: number]; select: [entry: FileReferenceEntry] }>();
const picker = ref<HTMLElement>();

watch(
  [() => props.activeIndex, () => props.entries],
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
    role="listbox"
    :aria-label="translate('generated.composerFileReferencePicker.referenceAFileOrFolder')"
  >
    <p v-if="loading">
      {{ translate('generated.composerFileReferencePicker.searchingFilesAndFolders') }}
    </p>
    <template v-else>
      <button
        v-for="(entry, index) in entries"
        :key="entry.path"
        type="button"
        role="option"
        :class="{ active: index === activeIndex }"
        :aria-selected="index === activeIndex"
        @mouseenter="emit('activate', index)"
        @mousedown.prevent
        @click="emit('select', entry)"
      >
        <FileTypeIcon :name="entry.name" :kind="entry.kind" />
        <strong :title="entry.name">{{ entry.name }}</strong>
        <code :title="entry.path">{{ entry.path }}</code>
        <span class="entry-kind">{{
          entry.kind === 'DIRECTORY'
            ? translate('generated.composerFileReferencePicker.folder')
            : translate('generated.composerFileReferencePicker.file')
        }}</span>
      </button>
    </template>
    <p v-if="!loading && query.length > 0 && entries.length === 0">
      {{ translate('generated.composerFileReferencePicker.noMatchingPaths') }}
    </p>
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
  line-height: 1.4;
  display: grid;
  grid-template-columns: max-content 150px minmax(0, 1fr) max-content;
  gap: 0.55rem;
  border: 0;
  border-bottom: 1px solid var(--mar-fill-hover);
  border-radius: 0;
  background: var(--mar-control-bg-color-overlay);
  color: var(--mar-text-primary);
  cursor: pointer;
  padding: 0.55rem 0.65rem;
  text-align: left;
}

.command-picker button:hover,
.command-picker button.active {
  background: var(--mar-color-brand-selected);
}

.command-picker button strong {
  font-weight: 600;
}

.command-picker button:is(:hover, .active),
.command-picker button:is(:hover, .active) code,
.command-picker button:is(:hover, .active) .entry-kind {
  color: var(--mar-color-brand-text);
}

.command-picker p {
  margin: 0;
  color: var(--mar-text-tertiary);
  padding: 0.65rem;
  font-size: var(--mar-font-size-meta);
}

.file-reference-picker button code,
.file-reference-picker button strong {
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

  .command-picker button {
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    justify-self: stretch;
    grid-template-columns: max-content minmax(0, 0.45fr) minmax(0, 1fr) max-content;
    gap: 0.45rem;
    padding: 0.5rem 0.65rem;
  }

  .command-picker button.active {
    width: 100%;
  }

  .command-picker strong {
    white-space: nowrap;
  }

  .command-picker button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
