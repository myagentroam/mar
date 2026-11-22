<script setup lang="ts">
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarButton } from '@myagentroam/mar-ui/button';
import { useI18n } from 'vue-i18n';
import { themeColorScheme } from '../../util/custom-theme.js';
defineProps<{ name: string; colors: Record<string, string>; expanded?: boolean }>();
const { t } = useI18n();
</script>

<template>
  <div
    class="mar-theme-preview"
    :class="{ expanded }"
    :data-theme="themeColorScheme(colors)"
    :style="colors"
    role="group"
    :aria-label="t('customThemes.preview')"
  >
    <div class="preview-toolbar">
      <span class="status-dot"></span><strong>{{ name }}</strong>
    </div>
    <div class="preview-workbench">
      <div class="preview-sidebar">
        <span class="caption">{{ t('customThemes.previewFiles') }}</span>
        <button type="button" class="file selected" aria-current="true">
          {{ t('customThemes.previewItemOne') }}
        </button>
        <button type="button" class="file">{{ t('customThemes.previewItemTwo') }}</button>
        <button type="button" class="file">{{ t('customThemes.previewItemThree') }}</button>
      </div>
      <div class="preview-content">
        <div class="preview-tabs">
          <span class="tab active">{{ t('customThemes.previewChat') }}</span
          ><span class="tab">{{ t('customThemes.previewChanges') }}</span>
        </div>
        <div class="conversation">
          <div class="user-message">{{ t('customThemes.previewRequest') }}</div>
          <div class="assistant-message">
            <strong>{{ t('customThemes.previewHeading') }}</strong>
            <p>{{ t('customThemes.previewText') }}</p>
            <pre
              class="code"
            ><span class="syntax-keyword">const</span> value = <span class="syntax-value">42</span>;</pre>
            <div class="diff">
              <code class="diff-remove">- value: 1;</code><code class="diff-add">+ value: 2;</code>
            </div>
          </div>
          <div class="process"><MarBusyIndicator />{{ t('customThemes.previewProcess') }}</div>
        </div>
      </div>
    </div>
    <div class="preview-controls">
      <div class="statuses">
        <span class="status success">{{ t('customThemes.previewSuccess') }}</span>
        <span class="status warning">{{ t('customThemes.previewWarning') }}</span>
        <span class="status danger">{{ t('customThemes.previewError') }}</span>
        <span class="status accent">{{ t('customThemes.previewInfo') }}</span>
      </div>
      <label class="preview-label"
        >{{ t('customThemes.previewInput') }}
        <input
          type="text"
          :placeholder="t('customThemes.previewPlaceholder')"
          :aria-label="t('customThemes.previewInput')"
        />
      </label>
      <div class="control-actions">
        <MarButton type="primary" class="preview-button primary">
          {{ t('customThemes.previewAction') }}
        </MarButton>
        <MarButton class="preview-button secondary">
          {{ t('customThemes.previewSecondary') }}
        </MarButton>
        <MarButton class="preview-button" disabled>
          {{ t('customThemes.previewDisabled') }}
        </MarButton>
      </div>
      <p class="caption">{{ t('customThemes.previewStateHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.mar-theme-preview {
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-surface);
  overflow: hidden;
  background: var(--mar-bg-page);
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}
.preview-toolbar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.55rem 0.65rem;
  background: var(--mar-bg-panel);
  border-bottom: 1px solid var(--mar-border-default);
  overflow-wrap: anywhere;
}
.status-dot {
  display: inline-block;
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--mar-color-success-text);
}
.preview-workbench {
  display: grid;
  grid-template-columns: minmax(5.8rem, 1fr) 3fr;
}
.preview-sidebar {
  padding: 0.6rem 0.35rem;
  background: var(--mar-bg-subtle);
  border-right: 1px solid var(--mar-border-default);
  min-width: 0;
}
.caption {
  color: var(--mar-text-muted);
}
.preview-sidebar > .caption {
  display: block;
  padding: 0 0.25rem;
}
.file {
  display: block;
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.25rem;
  border: 1px solid transparent;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-primary);
  text-align: left;
  font: inherit;
  font-family: var(--mar-font-mono);
  cursor: pointer;
  overflow-wrap: anywhere;
}
.file.selected {
  background: var(--mar-fill-selection);
}
.file:not(.selected):hover {
  background: var(--mar-fill-row-hover);
}
.preview-content {
  min-width: 0;
  background: var(--mar-conversation-canvas);
}
.preview-tabs {
  display: flex;
  flex-wrap: wrap;
  background: var(--mar-bg-subtle);
  border-bottom: 1px solid var(--mar-border-subtle);
}
.tab {
  padding: 0.35rem 0.55rem;
  background: var(--mar-bg-tab-inactive);
  color: var(--mar-text-secondary);
  border-radius: var(--mar-radius-selection);
}
.tab.active {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}
.conversation {
  padding: 0.6rem;
}
.user-message {
  margin-left: 0.7rem;
  margin-bottom: 0.5rem;
  padding: 0.4rem 0.5rem;
  background: var(--mar-conversation-surface);
  color: var(--mar-text-primary);
  border: 1px solid var(--mar-conversation-border);
  border-radius: var(--mar-radius-surface);
}
.assistant-message {
  padding: 0.5rem;
  background: var(--mar-conversation-surface);
  color: var(--mar-text-primary);
  border: 1px solid var(--mar-conversation-border);
  border-radius: var(--mar-radius-surface);
}
.assistant-message p {
  margin: 0.3rem 0;
}
.code {
  font: inherit;
  font-family: var(--mar-font-mono);
  padding: 0.35rem;
  margin: 0.4rem 0;
  background: var(--mar-conversation-code);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.syntax-keyword {
  color: var(--mar-text-primary);
  font-weight: 600;
}
.syntax-value {
  color: var(--mar-color-accent);
}
.diff {
  padding: 0.35rem;
  background: var(--mar-conversation-code);
}
.diff code {
  display: block;
  font-family: var(--mar-font-mono);
  overflow-wrap: anywhere;
}
.diff-add {
  color: var(--mar-color-diff-add-text);
}
.diff-remove {
  color: var(--mar-color-diff-del-text);
}
.process {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.5rem;
  padding: 0.35rem 0.5rem;
  background: var(--mar-conversation-process);
  border: 1px solid var(--mar-conversation-process-border);
  border-radius: var(--mar-radius-surface);
}
.process > .mar-busy-indicator {
  color: var(--mar-conversation-activity-fg);
  animation: none;
}
.preview-controls {
  padding: 0.65rem;
  border-top: 1px solid var(--mar-border-default);
  background: var(--mar-bg-panel);
  box-shadow: 0 -2px 8px var(--mar-shadow-soft);
}
.statuses,
.control-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.control-actions > .preview-button {
  margin-inline-start: 0;
}
.status {
  padding: 0.2rem 0.45rem;
  border-radius: var(--mar-radius-marker);
}
.success {
  color: var(--mar-color-success-text);
  background: var(--mar-color-success-bg);
}
.warning {
  color: var(--mar-color-warning-text);
  background: var(--mar-color-warning-bg);
}
.danger {
  color: var(--mar-color-danger-text);
  background: var(--mar-color-danger-bg);
}
.accent {
  color: var(--mar-color-accent);
  background: var(--mar-color-accent-bg);
}
.preview-label {
  display: block;
  margin: 0.65rem 0 0.45rem;
  color: var(--mar-text-secondary);
}
input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  padding: 0.35rem 0.5rem;
  margin-top: 0.2rem;
  border: 1px solid var(--mar-input-border);
  border-radius: var(--mar-radius-control);
  background: var(--mar-bg-panel);
  color: var(--mar-text-primary);
  font: inherit;
}
input:hover {
  border-color: var(--mar-input-border-hover, var(--mar-input-border));
}
input::placeholder {
  color: var(--mar-text-secondary);
}
.file:focus-visible,
input:focus-visible {
  outline: 2px solid var(--mar-control-focus);
  outline-offset: 1px;
}
.preview-controls > .caption {
  margin: 0.5rem 0 0;
}
.mar-theme-preview.expanded {
  font-size: var(--mar-font-size-body);
}
.expanded .preview-workbench {
  grid-template-columns: minmax(8rem, 1fr) 3fr;
}
</style>
