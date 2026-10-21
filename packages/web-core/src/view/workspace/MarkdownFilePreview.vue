<script setup lang="ts">
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { computed, nextTick, ref, watch } from 'vue';
import {
  isExternalMarkdownImageUrl,
  resolveMarkdownWorkspacePath
} from '../../util/markdown-preview.js';

const props = defineProps<{
  readonly content: string;
  readonly path: string;
  readonly resourceUrl: (path: string) => string;
  readonly standardStyle?: boolean;
}>();
const emit = defineEmits<{ 'open-file': [path: string, external: boolean] }>();
const root = ref<HTMLElement>();
let mermaidSequence = 0;

const renderer = new MarkdownIt({ html: false, breaks: true, linkify: true }).use(taskLists, {
  enabled: true,
  label: true,
  labelAfter: true
});
renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  const token = tokens[index]!;
  const target = String(token.attrGet('href') ?? '');
  const path = resolveMarkdownWorkspacePath(props.path, target);
  if (path === undefined) token.attrSet('target', '_blank');
  else token.attrSet('data-workspace-file', path);
  token.attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, index, options);
};
renderer.renderer.rules.image = (tokens, index, options, environment, self) => {
  const token = tokens[index]!;
  const path = resolveMarkdownWorkspacePath(props.path, String(token.attrGet('src') ?? ''));
  if (path !== undefined) token.attrSet('src', props.resourceUrl(path));
  else if (!isExternalMarkdownImageUrl(String(token.attrGet('src') ?? '')))
    token.attrSet('src', '');
  return self.renderToken(tokens, index, options);
};
const html = computed(() =>
  DOMPurify.sanitize(renderer.render(props.content), {
    ADD_ATTR: ['target', 'rel', 'checked', 'disabled', 'data-workspace-file']
  })
);

async function renderMermaid(): Promise<void> {
  await nextTick();
  if (root.value === undefined) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false });
  for (const code of root.value.querySelectorAll<HTMLElement>('code.language-mermaid')) {
    const holder = document.createElement('div');
    holder.className = 'markdown-mermaid';
    try {
      const rendered = await mermaid.render(
        `mar-mermaid-${++mermaidSequence}`,
        code.textContent ?? ''
      );
      holder.innerHTML = DOMPurify.sanitize(rendered.svg, {
        USE_PROFILES: { svg: true, svgFilters: true }
      });
    } catch {
      holder.classList.add('markdown-mermaid-error');
      holder.textContent = code.textContent ?? '';
    }
    code.closest('pre')?.replaceWith(holder);
  }
}
watch(html, () => void renderMermaid(), { immediate: true });

function onClick(event: MouseEvent): void {
  const link =
    event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('a[data-workspace-file]')
      : null;
  const path = link?.dataset.workspaceFile;
  if (path === undefined) return;
  event.preventDefault();
  emit('open-file', path, event.ctrlKey || event.metaKey);
}
</script>

<template>
  <article
    ref="root"
    class="markdown-file-preview"
    :class="{ 'markdown-body': standardStyle }"
    v-html="html"
    @click="onClick"
  />
</template>

<style scoped>
.markdown-file-preview:not(.markdown-body) {
  min-width: 0;
  color: var(--mar-text-primary);
  line-height: 1.75;
  overflow-wrap: anywhere;
}

.markdown-file-preview:not(.markdown-body) :deep(> :first-child) {
  margin-top: 0;
}

.markdown-file-preview:not(.markdown-body) :deep(> :last-child),
.markdown-file-preview:not(.markdown-body) :deep(blockquote > :last-child) {
  margin-bottom: 0;
}

.markdown-file-preview:not(.markdown-body) :deep(h1),
.markdown-file-preview:not(.markdown-body) :deep(h2),
.markdown-file-preview:not(.markdown-body) :deep(h3) {
  margin: 1.2rem 0 0.55rem;
  line-height: 1.3;
}

.markdown-file-preview:not(.markdown-body) :deep(blockquote) {
  margin: 0.8rem 0;
  border-left: 3px solid color-mix(in srgb, var(--mar-color-brand) 45%, var(--mar-border-medium));
  border-radius: 0 5px 5px 0;
  background: color-mix(in srgb, var(--mar-color-brand) 4%, var(--mar-fill-subtle));
  color: color-mix(in srgb, var(--mar-text-primary) 90%, var(--mar-text-secondary));
  padding: 0.6rem 0.8rem;
}

.markdown-file-preview:not(.markdown-body) :deep(blockquote > :first-child) {
  margin-top: 0;
}

.markdown-file-preview:not(.markdown-body) :deep(:not(pre) > code) {
  border-radius: 3px;
  background: var(--mar-conversation-code);
  padding: 0.08rem 0.25rem;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  word-break: normal;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}

.markdown-file-preview:not(.markdown-body) :deep(a > code) {
  color: inherit;
}

.markdown-file-preview:not(.markdown-body) :deep(pre) {
  overflow: auto;
  margin: 0.8rem 0;
  padding: 0.8rem;
  border: 1px solid var(--mar-border-default);
  border-radius: 6px;
  background: var(--mar-fill-subtle);
  white-space: pre;
  word-break: normal;
}

.markdown-file-preview:not(.markdown-body) :deep(pre code) {
  color: var(--mar-text-primary);
  word-break: normal;
}

.markdown-file-preview:not(.markdown-body) :deep(table) {
  display: block;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}

.markdown-file-preview:not(.markdown-body) :deep(th),
.markdown-file-preview:not(.markdown-body) :deep(td) {
  border: 1px solid var(--mar-border-default);
  padding: 0.45rem 0.7rem;
  vertical-align: top;
}

.markdown-file-preview:not(.markdown-body) :deep(th) {
  background: var(--mar-fill-muted);
}

.markdown-file-preview:not(.markdown-body) :deep(img),
.markdown-file-preview:not(.markdown-body) :deep(svg) {
  max-width: 100%;
  height: auto;
}

.markdown-file-preview :deep(.task-list-item label) {
  display: inline;
  color: inherit;
  font: inherit;
}

.markdown-file-preview.markdown-body :deep(code) {
  color: inherit;
}

.markdown-file-preview :deep(.markdown-mermaid) {
  overflow: auto;
  padding: 0.75rem 0;
  text-align: center;
}
.markdown-file-preview :deep(.markdown-mermaid-error) {
  white-space: pre-wrap;
  text-align: left;
  color: var(--mar-color-danger-text);
}
</style>
