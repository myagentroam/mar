<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import { computed, inject, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue';
import { marIconSvg } from '../../util/icon-shapes.js';
import DOMPurify from 'dompurify';

import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import 'highlight.js/styles/github.css';
import { localePreferenceService, translate } from '../../service/locale-preference-service.js';
import { workspaceFileTarget } from '../../util/file-preview.js';
import { TOOLTIP_SERVICE_KEY } from '../../service/tooltip-service.js';
import { conversationThumbnailUrl } from '../../util/conversation-image-url.js';
import { CONVERSATION_MARKDOWN_CACHE_KEY } from '../../util/conversation-markdown-cache.js';

const props = defineProps<{
  readonly content: string;
  readonly workspaceRoot?: string;
  readonly imageResourceUrl?: ((path: string) => string) | undefined;
  readonly cacheIdentity?: readonly string[] | undefined;
}>();
const emit = defineEmits<{
  'open-image': [source: string, name: string];
  'open-file': [
    path: string,
    line: number | undefined,
    column: number | undefined,
    external: boolean
  ];
}>();

const renderer = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  highlight(source, language) {
    if (language.length > 0 && hljs.getLanguage(language))
      return hljs.highlight(source, { language, ignoreIllegals: true }).value;
    return '';
  }
}).use(taskLists, { enabled: true, label: true, labelAfter: true });

const copyIconSvg = marIconSvg('copy').replace(
  'class="mar-icon"',
  'class="mar-icon agent-markdown-code-icon agent-markdown-code-icon--copy"'
);
const checkIconSvg = marIconSvg('check').replace(
  'class="mar-icon"',
  'class="mar-icon agent-markdown-code-icon agent-markdown-code-icon--check"'
);

const defaultFenceRenderer = renderer.renderer.rules.fence ?? (() => '');
renderer.renderer.rules.fence = (tokens, index, options, environment, self) => {
  const rendered = defaultFenceRenderer(tokens, index, options, environment, self);
  const label = renderer.utils.escapeHtml(translate('generated.conversationTimeline.copyCode'));
  return `<div class="agent-markdown-code" data-code-block>${rendered}<button type="button" class="agent-markdown-code-copy mar-icon-button mar-icon-action" data-code-copy aria-label="${label}">${copyIconSvg}${checkIconSvg}</button></div>`;
};

renderer.core.ruler.after('linkify', 'workspace-file-locations', (state) => {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || token.children === null) continue;
    const children = [];
    let insideLink = false;
    for (const child of token.children) {
      if (child.type === 'link_open') insideLink = true;
      if (child.type !== 'text' || insideLink) {
        children.push(child);
        if (child.type === 'link_close') insideLink = false;
        continue;
      }
      const pattern =
        /(^|[\s(])((?:(?:[\p{L}\p{N}_$@.-]+\/)+[\p{L}\p{N}_$.-]+|[\p{L}\p{N}_$@-]*\.[\p{L}\p{N}_$@.-]+):[1-9]\d*(?::[1-9]\d*)?)/gu;
      let cursor = 0;
      for (const match of child.content.matchAll(pattern)) {
        const index = match.index ?? 0;
        const prefix = match[1] ?? '';
        const location = match[2] ?? '';
        if (index > cursor) {
          const text = new state.Token('text', '', 0);
          text.content = child.content.slice(cursor, index);
          children.push(text);
        }
        if (prefix.length > 0) {
          const text = new state.Token('text', '', 0);
          text.content = prefix;
          children.push(text);
        }
        const open = new state.Token('link_open', 'a', 1);
        open.attrSet('href', location);
        const text = new state.Token('text', '', 0);
        text.content = location;
        children.push(open, text, new state.Token('link_close', 'a', -1));
        cursor = index + match[0].length;
      }
      if (cursor === 0) {
        children.push(child);
        continue;
      }
      if (cursor < child.content.length) {
        const text = new state.Token('text', '', 0);
        text.content = child.content.slice(cursor);
        children.push(text);
      }
    }
    token.children = children;
  }
  return false;
});

renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  const token = tokens[index]!;
  const href = String(token.attrGet('href') ?? '');
  const sandboxReference = /^sandbox:/iu.test(href);
  const fileTarget = workspaceFileTarget(href, props.workspaceRoot, window.location.origin);
  if (fileTarget !== undefined) {
    token.attrSet('href', '#');
    token.attrSet('data-workspace-file', fileTarget.path);
    if (fileTarget.line !== undefined)
      token.attrSet('data-workspace-line', String(fileTarget.line));
    if (fileTarget.column !== undefined)
      token.attrSet('data-workspace-column', String(fileTarget.column));
  } else if (sandboxReference) {
    token.attrSet('href', '#');
  } else {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return self.renderToken(tokens, index, options);
};
const defaultImageRenderer = renderer.renderer.rules.image;
renderer.renderer.rules.image = (tokens, index, options, environment, self) => {
  const token = tokens[index]!;
  const source = String(token.attrGet('src') ?? '');
  const label = self.renderInlineAsText(token.children ?? [], options, environment);
  const renderImage = () => {
    const fullSource = String(token.attrGet('src') ?? '');
    token.attrSet('src', conversationThumbnailUrl(fullSource));
    token.attrSet('data-image-source', fullSource);
    token.attrSet('loading', 'lazy');
    const image = defaultImageRenderer?.(tokens, index, options, environment, self) ?? '';
    // Preserve explicit image links rather than nesting a button inside an anchor.
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (tokens[previous]!.type === 'link_close') break;
      if (tokens[previous]!.type === 'link_open') return image;
    }
    const name = label || translate('generated.conversationTimeline.imageAttachment');
    const accessibleLabel = renderer.utils.escapeHtml(
      translate('generated.conversationTimeline.enlarge', { value0: name })
    );
    return `<button type="button" class="agent-markdown-image" data-image-preview aria-label="${accessibleLabel}">${image}</button>`;
  };
  if (/^https?:\/\//iu.test(source)) return renderImage();
  const fileTarget = workspaceFileTarget(source, props.workspaceRoot, window.location.origin);
  if (fileTarget === undefined) {
    if (!/^sandbox:/iu.test(source)) return renderImage();
    return renderer.utils.escapeHtml(label || source);
  }
  if (props.imageResourceUrl !== undefined) {
    token.attrSet('src', props.imageResourceUrl(fileTarget.path));
    return renderImage();
  }
  if (!/^sandbox:/iu.test(source)) return renderImage();
  const lineAttribute =
    fileTarget.line === undefined
      ? ''
      : ` data-workspace-line="${renderer.utils.escapeHtml(String(fileTarget.line))}"`;
  const columnAttribute =
    fileTarget.column === undefined
      ? ''
      : ` data-workspace-column="${renderer.utils.escapeHtml(String(fileTarget.column))}"`;
  return `<a href="#" data-workspace-file="${renderer.utils.escapeHtml(fileTarget.path)}"${lineAttribute}${columnAttribute}>${renderer.utils.escapeHtml(label || fileTarget.path)}</a>`;
};

const locale = localePreferenceService().locale;
const markdownRoot = ref<HTMLElement>();
const tooltipService = inject(TOOLTIP_SERVICE_KEY, undefined);
const markdownCache = inject(CONVERSATION_MARKDOWN_CACHE_KEY, undefined);
let codeCopyButtons = new Set<HTMLButtonElement>();
const copyResetTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();

// v-html buttons cannot use Vue directives; register only this rendered markdown's controls.
function syncCodeTooltips(): void {
  const nextButtons = new Set(
    markdownRoot.value?.querySelectorAll<HTMLButtonElement>('[data-code-copy]') ?? []
  );
  for (const button of codeCopyButtons) {
    if (nextButtons.has(button)) continue;
    tooltipService?.remove(button);
    const timer = copyResetTimers.get(button);
    if (timer !== undefined) clearTimeout(timer);
    copyResetTimers.delete(button);
  }
  codeCopyButtons = nextButtons;
  for (const button of codeCopyButtons)
    tooltipService?.update(button, button.getAttribute('aria-label'));
}

onMounted(syncCodeTooltips);
onUpdated(syncCodeTooltips);
onBeforeUnmount(() => {
  for (const button of codeCopyButtons) tooltipService?.remove(button);
  codeCopyButtons.clear();
  for (const timer of copyResetTimers.values()) clearTimeout(timer);
  copyResetTimers.clear();
});

const html = computed(() => {
  const language = locale.value;
  const render = () =>
    DOMPurify.sanitize(renderer.render(props.content), {
      ADD_ATTR: [
        'target',
        'rel',
        'checked',
        'disabled',
        'data-code-block',
        'data-code-copy',
        'data-image-preview',
        'data-image-source',
        'data-workspace-file',
        'data-workspace-line',
        'data-workspace-column'
      ]
    });
  // Resource callbacks can depend on live context; never reuse HTML containing image syntax.
  if (
    !markdownCache ||
    !props.cacheIdentity ||
    (props.imageResourceUrl && props.content.includes('!'))
  )
    return render();
  return markdownCache.render(
    [...props.cacheIdentity, props.content, props.workspaceRoot ?? '', language],
    render
  );
});

async function onCopyClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('[data-code-copy]');
  if (button === null) return;
  event.preventDefault();
  const code = button.closest('[data-code-block]')?.querySelector('pre code');
  const text = code?.textContent ?? '';
  try {
    if (navigator.clipboard?.writeText === undefined) throw new Error('CLIPBOARD_UNAVAILABLE');
    await navigator.clipboard.writeText(text);
    if (!codeCopyButtons.has(button)) return;
    const previous = copyResetTimers.get(button);
    if (previous !== undefined) clearTimeout(previous);
    button.dataset.copied = 'true';
    button.setAttribute('aria-label', translate('generated.conversationTimeline.copiedCode'));
    tooltipService?.update(button, translate('generated.conversationTimeline.copiedCode'));
    copyResetTimers.set(
      button,
      setTimeout(() => {
        delete button.dataset.copied;
        button.setAttribute('aria-label', translate('generated.conversationTimeline.copyCode'));
        tooltipService?.update(button, translate('generated.conversationTimeline.copyCode'));
        copyResetTimers.delete(button);
      }, 500)
    );
  } catch {
    showMessage(translate('generated.conversationTimeline.copyCodeFailed'), 'error');
  }
}

function onMarkdownClick(event: MouseEvent): void {
  if (event.target instanceof Element) {
    const image = event.target.closest('[data-image-preview]')?.querySelector('img');
    const source = image?.getAttribute('data-image-source');
    if (source) {
      event.preventDefault();
      emit(
        'open-image',
        source,
        image?.alt || translate('generated.conversationTimeline.imageAttachment')
      );
      return;
    }
  }
  onLinkClick(event);
  void onCopyClick(event);
}

function onLinkClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLAnchorElement>('a[data-workspace-file]');
  const path = link?.dataset.workspaceFile;
  if (path === undefined) return;
  event.preventDefault();
  const parsedLine = Number(link?.dataset.workspaceLine);
  const parsedColumn = Number(link?.dataset.workspaceColumn);
  emit(
    'open-file',
    path,
    Number.isSafeInteger(parsedLine) && parsedLine > 0 ? parsedLine : undefined,
    Number.isSafeInteger(parsedColumn) && parsedColumn > 0 ? parsedColumn : undefined,
    event.ctrlKey || event.metaKey
  );
}
</script>

<template>
  <div ref="markdownRoot" class="agent-markdown" v-html="html" @click="onMarkdownClick"></div>
</template>

<style scoped>
.agent-markdown {
  min-width: 0;
  color: var(--mar-conversation-text);
  font-size: var(--mar-font-size-body);
  line-height: 1.75;
  overflow-wrap: anywhere;
}

.agent-markdown :deep(> :first-child) {
  margin-top: 0;
}

.agent-markdown :deep(:is(img, svg)) {
  max-width: 100%;
  height: auto;
}

.agent-markdown :deep(.agent-markdown-image) {
  display: inline-flex;
  max-width: min(160px, 100%);
  max-height: 120px;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 6px;
  background: transparent;
  vertical-align: middle;
  cursor: pointer;
}

.agent-markdown :deep(.agent-markdown-image:focus-visible) {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.agent-markdown :deep(img) {
  display: inline-block;
  box-sizing: border-box;
  width: auto;
  height: auto;
  max-width: min(160px, 100%);
  max-height: 120px;
  border: 1px solid color-mix(in srgb, var(--mar-color-brand) 26%, transparent);
  border-radius: 6px;
  object-fit: contain;
}

.agent-markdown :deep(> :last-child) {
  margin-bottom: 0;
}

.agent-markdown :deep(p) {
  margin: 0 0 0.65rem;
}

.agent-markdown :deep(h1),
.agent-markdown :deep(h2),
.agent-markdown :deep(h3),
.agent-markdown :deep(h4),
.agent-markdown :deep(h5),
.agent-markdown :deep(h6) {
  margin: 1.1rem 0 0.5rem;
  color: var(--mar-conversation-text);
  font-weight: 650;
  line-height: 1.45;
}

.agent-markdown :deep(h1) {
  font-size: 1.12rem;
}

.agent-markdown :deep(h2) {
  font-size: 1rem;
}

.agent-markdown :deep(h3) {
  font-size: 0.92rem;
}

.agent-markdown :deep(h4),
.agent-markdown :deep(h5),
.agent-markdown :deep(h6) {
  font-size: inherit;
}

.agent-markdown :deep(ul),
.agent-markdown :deep(ol) {
  margin: 0.45rem 0 0.6rem;
  padding-left: 1.35rem;
}

.agent-markdown :deep(li + li) {
  margin-top: 0.2rem;
}

.agent-markdown :deep(li > :last-child) {
  margin-bottom: 0;
}

.agent-markdown :deep(.task-list-item) {
  list-style: none;
  margin-left: -1.2rem;
}

.agent-markdown :deep(.task-list-item input) {
  margin: 0 0.36rem 0 0;
  accent-color: var(--mar-color-brand);
  pointer-events: none;
}

.agent-markdown :deep(blockquote) {
  margin: 0.8rem 0;
  border-left: 3px solid color-mix(in srgb, var(--mar-color-brand) 45%, var(--mar-border-medium));
  border-radius: 0 5px 5px 0;
  background: color-mix(in srgb, var(--mar-color-brand) 4%, var(--mar-fill-subtle));
  color: color-mix(in srgb, var(--mar-conversation-text) 90%, var(--mar-text-secondary));
  padding: 0.6rem 0.8rem;
}

.agent-markdown :deep(blockquote > :first-child) {
  margin-top: 0;
}

.agent-markdown :deep(blockquote > :last-child) {
  margin-bottom: 0;
}

.agent-markdown :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  margin: 0.8rem 0;
  border: 1px solid var(--mar-border-default);
  border-radius: 6px;
  border-spacing: 0;
  border-collapse: separate;
}

.agent-markdown :deep(th),
.agent-markdown :deep(td) {
  min-width: 5.5rem;
  border-bottom: 1px solid var(--mar-border-default);
  padding: 0.45rem 0.7rem;
  text-align: left;
  vertical-align: top;
  /* Tables own horizontal overflow; do not split identifiers to fit the prose width. */
  overflow-wrap: normal;
}

.agent-markdown :deep(th) {
  background: var(--mar-fill-muted);
  color: var(--mar-conversation-text);
  font-weight: 650;
}

.agent-markdown :deep(tbody tr:nth-child(even)) {
  background: var(--mar-fill-subtle);
}

.agent-markdown :deep(tr:last-child td) {
  border-bottom: 0;
}

.agent-markdown :deep(:not(pre) > code) {
  border-radius: 3px;
  background: var(--mar-conversation-code);
  padding: 0.08rem 0.25rem;
  color: var(--mar-conversation-text);
  font-size: var(--mar-font-size-meta);
  word-break: normal;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}

.agent-markdown :deep(a > code) {
  color: inherit;
}

.agent-markdown :deep(pre) {
  margin: 0.8rem 0;
  border: 1px solid var(--mar-border-default);
  border-radius: 6px;
  background: var(--mar-fill-subtle);
  padding: 0.75rem 0.85rem;
  overflow: auto;
  white-space: pre;
  word-break: normal;
}

.agent-markdown :deep(pre code) {
  display: block;
  padding: 0;
  background: transparent;
  color: var(--mar-conversation-text);
  font-size: var(--mar-font-size-meta);
  word-break: normal;
}

.agent-markdown :deep(hr) {
  margin: 1rem 0;
  border: 0;
  border-top: 1px solid var(--mar-border-default);
}

.agent-markdown :deep(a) {
  color: var(--mar-color-brand-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.agent-markdown :deep(a[href]) {
  cursor: pointer;
}

.agent-markdown :deep(a:focus-visible) {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 2px;
}
.agent-markdown :deep(.task-list-item label) {
  display: inline;
  color: inherit;
  font: inherit;
}

.agent-markdown :deep(.agent-markdown-code) {
  position: relative;
  margin: 0.8rem 0;
}

.agent-markdown :deep(.agent-markdown-code > pre) {
  margin: 0;
}

.agent-markdown :deep(.agent-markdown-code-copy) {
  position: absolute;
  right: 0.35rem;
  bottom: 0.35rem;
  display: inline-flex;
  width: var(--mar-utility-control-size);
  height: var(--mar-utility-control-size);
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--mar-radius-control);
  opacity: 0;
  transition:
    opacity 0.12s ease,
    color 0.12s ease;
}

.agent-markdown :deep(.agent-markdown-code:hover > .agent-markdown-code-copy),
.agent-markdown :deep(.agent-markdown-code-copy:focus-visible) {
  opacity: 1;
}

.agent-markdown :deep(.agent-markdown-code-copy[data-copied='true']) {
  opacity: 1;
}

@media (hover: none) {
  .agent-markdown :deep(.agent-markdown-code-copy) {
    opacity: 1;
  }
}

@media (max-width: 767px) {
  .agent-markdown :deep(.agent-markdown-code-copy) {
    width: 36px;
    height: 36px;
    opacity: 1;
  }

  .agent-markdown :deep(pre) {
    padding-bottom: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-markdown :deep(.agent-markdown-code-copy) {
    transition: none;
  }
}

.agent-markdown :deep(.agent-markdown-code-icon) {
  width: 1em;
  height: 1em;
}

.agent-markdown :deep(.agent-markdown-code-icon--check),
.agent-markdown
  :deep(.agent-markdown-code-copy[data-copied='true'] .agent-markdown-code-icon--copy) {
  display: none;
}

.agent-markdown
  :deep(.agent-markdown-code-copy[data-copied='true'] .agent-markdown-code-icon--check) {
  display: block;
}
</style>
