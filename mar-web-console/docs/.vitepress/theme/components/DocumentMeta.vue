<script setup lang="ts">
import { computed, ref } from 'vue';
import { useData } from 'vitepress';
import { useDocumentationMessages } from '../messages';

const { frontmatter } = useData();
const { t } = useDocumentationMessages();
const copied = ref(false);
const copyFailed = ref(false);
const lastUpdated = computed(() => {
  const value: unknown = frontmatter.value.lastUpdated;
  if (value instanceof Date && !Number.isNaN(value.valueOf()))
    return value.toISOString().slice(0, 10);
  const text = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}/u.exec(text)?.[0] ?? t('notSpecified');
});

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Sandboxed browsers may expose the API but reject the permission.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copiedByCommand = document.execCommand('copy');
  textarea.remove();
  if (!copiedByCommand) throw new Error('CLIPBOARD_WRITE_FAILED');
}

async function copyPage(): Promise<void> {
  const content = document.querySelector<HTMLElement>('.vp-doc');
  if (content === null) return;
  const text = [...content.children]
    .filter((element) => !element.classList.contains('document-meta'))
    .map((element) => (element as HTMLElement).innerText.trim())
    .filter(Boolean)
    .join('\n\n');
  try {
    await copyText(text);
    copied.value = true;
    copyFailed.value = false;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    copyFailed.value = true;
  }
}
</script>

<template>
  <div class="document-meta">
    <span>{{ t('lastUpdated') }} {{ lastUpdated }}</span>
    <button type="button" class="copy-page-button" @click="copyPage">
      {{ copyFailed ? t('copyFailed') : copied ? t('copied') : t('copyPage') }}
    </button>
  </div>
</template>
