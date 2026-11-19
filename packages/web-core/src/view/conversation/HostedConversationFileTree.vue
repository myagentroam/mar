<script setup lang="ts">
// Renders the related-file hierarchy; the workspace page owns expansion state and file actions.
import type { ConversationFileProjection } from '@myagentroam/protocol';
import type { HostedConversationFileTreeNode } from '../../service/hosted-conversation-file-tree-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { fileSizeLabel } from '../../util/file-presentation.js';
import MarIcon from '../common/MarIcon.vue';

const props = withDefaults(
  defineProps<{
    nodes: readonly HostedConversationFileTreeNode[];
    depth?: number;
    directoryExpanded: (path: string) => boolean;
    directoryLabel: (path: string) => string;
    toggleDirectory: (path: string) => void;
    openFile: (file: ConversationFileProjection) => void;
    deleteFile: (file: ConversationFileProjection) => void;
    deleteDisabled: boolean;
  }>(),
  { depth: 0 }
);

function disableLeavingBranch(branch: Element): void {
  (branch as HTMLElement).inert = true;
}
</script>

<template>
  <template v-for="node in nodes" :key="`${node.kind}:${node.path}`">
    <template v-if="node.kind === 'DIRECTORY'">
      <button
        v-tooltip="node.path"
        class="file-directory"
        :style="{ '--file-depth': depth }"
        type="button"
        :aria-expanded="directoryExpanded(node.path)"
        :aria-label="directoryLabel(node.path)"
        @click="toggleDirectory(node.path)"
      >
        <MarIcon name="chevron-right" class="file-directory-chevron" />
        <MarIcon
          :name="directoryExpanded(node.path) ? 'folder-open' : 'folder'"
          class="file-directory-kind"
        />
        <span>{{ node.name }}</span>
      </button>
      <Transition name="file-branch" @before-leave="disableLeavingBranch">
        <div v-if="directoryExpanded(node.path)" class="file-branch">
          <div class="file-branch-content">
            <HostedConversationFileTree v-bind="props" :nodes="node.children" :depth="depth + 1" />
          </div>
        </div>
      </Transition>
    </template>
    <div
      v-else
      class="file-row"
      :class="{ 'is-nested': depth > 0 }"
      :style="{ '--file-depth': depth }"
    >
      <button
        v-tooltip="node.file.relativePath"
        :aria-label="node.file.relativePath"
        class="file-open"
        type="button"
        @click="openFile(node.file)"
      >
        <span>{{ node.file.displayName }}</span>
        <small>{{ fileSizeLabel(node.file.size) }}</small>
      </button>
      <button
        v-tooltip="
          translate('hostedConversations.fileDeleteNamed', { name: node.file.displayName })
        "
        class="file-delete mar-icon-action mar-icon-action--inline"
        type="button"
        :disabled="deleteDisabled"
        :aria-label="
          translate('hostedConversations.fileDeleteNamed', { name: node.file.displayName })
        "
        @click="deleteFile(node.file)"
      >
        <MarIcon name="delete" />
      </button>
    </div>
  </template>
</template>

<style scoped>
.file-directory {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 30px;
  grid-template-columns: 12px 16px minmax(0, 1fr);
  align-items: center;
  gap: 4px;
  border: 0;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-secondary);
  padding: 4px 8px 4px calc(8px + var(--file-depth) * 16px);
  text-align: left;
  font-weight: 400;
  cursor: pointer;
}

.file-directory:hover,
.file-directory:focus-visible {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.file-directory:focus-visible {
  outline: 1px solid var(--mar-color-brand);
  outline-offset: -1px;
}

.file-directory > span {
  margin-inline-start: 2px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-directory-chevron {
  font-size: 12px;
  transition: transform var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
}

.file-directory[aria-expanded='true'] .file-directory-chevron {
  transform: rotate(90deg);
}

.file-directory-kind {
  font-size: 16px;
  color: var(--mar-text-tertiary);
}

.file-branch {
  display: grid;
  grid-template-rows: 1fr;
}

.file-branch-content {
  min-height: 0;
  min-width: 0;
}

.file-branch-enter-active,
.file-branch-leave-active {
  overflow: clip;
  transition: grid-template-rows var(--mar-motion-duration-collapse)
    var(--mar-motion-easing-collapse);
}

.file-branch-enter-from,
.file-branch-leave-to {
  grid-template-rows: 0fr;
}

.file-row {
  display: grid;
  box-sizing: border-box;
  grid-template-columns: minmax(0, 1fr) 30px;
  align-items: center;
  border-radius: 6px;
}

.file-row.is-nested {
  padding-inline-start: calc(22px + var(--file-depth) * 16px);
}

.file-row:hover {
  background: var(--mar-fill-hover);
}

.file-open {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 7px 8px;
  color: var(--mar-text-primary);
  text-align: left;
  cursor: pointer;
}

.file-open:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--mar-color-brand-border);
}

.file-open span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-open small {
  justify-self: end;
  color: var(--mar-text-tertiary);
  line-height: 1.35;
  text-align: right;
}

.file-delete {
  --mar-action-icon-size: 14px;
  display: inline-grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 0;
  border-radius: var(--mar-radius-control);
  background: transparent;
  cursor: pointer;
}

.file-delete:hover:not(:disabled) {
  color: var(--mar-color-danger-text);
}

.file-delete:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

@media (max-width: 767px) {
  .file-directory {
    min-height: 36px;
  }

  .file-directory > span {
    white-space: normal;
    overflow-wrap: anywhere;
  }
}

@media (prefers-reduced-motion: reduce) {
  .file-directory-chevron,
  .file-branch-enter-active,
  .file-branch-leave-active {
    transition: none;
  }
}
</style>
