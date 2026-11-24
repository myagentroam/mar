<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarPopover } from '@myagentroam/mar-ui/popover';
import { BROWSER_HISTORY_SUGGESTION_LIMIT, type BrowserHistoryItem } from '@myagentroam/protocol';
import { browserAddress } from '../../service/browser-link-routing.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { translate as t } from '../../service/locale-preference-service.js';

/** Owns transient history suggestions and selection for one address field, not navigation or profile data. */
const props = defineProps<{
  modelValue: string;
  label: string;
  blank?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  errorId: string;
  historyContext?: string | undefined;
  lookup: (text: string) => Promise<readonly BrowserHistoryItem[]>;
}>();
const emit = defineEmits<{ edit: [value: string]; navigate: [url: string] }>();
const anchor = ref<HTMLElement>();
const listId = useId();
const query = ref('');
const results = shallowRef<readonly BrowserHistoryItem[]>([]);
const selection = ref(-1);
const pending = ref(false);
const open = computed(() => results.value.length > 0);
const dismissible = computed(() => open.value || pending.value);
const optionId = (index: number) => `${listId}-option-${index}`;

function dismiss(): void {
  query.value = '';
}
watch(() => [props.historyContext, props.disabled], dismiss, { flush: 'sync' });
watch(
  query,
  (text, _, onCleanup) => {
    selection.value = -1;
    results.value = [];
    pending.value = false;
    if (!props.historyContext || props.disabled || text.length < 2 || text.length > 512) return;
    pending.value = true;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const items = await props.lookup(text);
        if (!current) return;
        results.value = items
          .filter((item) => browserAddress(item.url))
          .slice(0, BROWSER_HISTORY_SUGGESTION_LIMIT);
      } catch {
        // History is supplemental; entering an address must still work if it is unavailable.
      } finally {
        if (current) pending.value = false;
      }
    }, 200);
    onCleanup(() => {
      current = false;
      clearTimeout(timer);
    });
  },
  { flush: 'sync' }
);

const unregisterEscape = consoleKeyboardShortcutService.register({
  command: 'browser.dismissAddressSuggestions',
  scope: 'workspace',
  priority: 70,
  owner: () => anchor.value,
  keys: [{ key: 'Escape' }],
  when: () => dismissible.value,
  execute: () => {
    dismiss();
    return 'HANDLED';
  }
});
onBeforeUnmount(unregisterEscape);

function edit(value: string): void {
  selection.value = -1;
  emit('edit', value);
  if (anchor.value?.contains(anchor.value.ownerDocument.activeElement)) query.value = value.trim();
}
function choose(index: number): void {
  const item = results.value[index];
  if (!item) return;
  dismiss();
  emit('navigate', item.url);
}
function keydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  if (event.key === 'Escape' && dismissible.value) {
    event.preventDefault();
    dismiss();
  } else if (event.key === 'Enter') {
    if (selection.value !== -1) {
      event.preventDefault();
      choose(selection.value);
    } else dismiss();
  } else if (open.value && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    const count = results.value.length;
    selection.value =
      event.key === 'ArrowDown'
        ? (selection.value + 1) % count
        : (selection.value <= 0 ? count : selection.value) - 1;
    anchor.value?.ownerDocument
      .getElementById(optionId(selection.value))
      ?.scrollIntoView({ block: 'nearest' });
  } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    selection.value = -1;
  }
}
</script>

<template>
  <div ref="anchor" class="browser-address-field">
    <MarInput
      :model-value="modelValue"
      v-bind="blank ? ({ prefixIcon: 'web' } as const) : {}"
      :disabled="disabled"
      :aria-label="label"
      :placeholder="label"
      :aria-invalid="invalid || undefined"
      :aria-describedby="invalid ? errorId : undefined"
      role="combobox"
      autocomplete="off"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="selection === -1 ? undefined : optionId(selection)"
      @update:model-value="edit"
      @blur="dismiss"
      @compositionstart="dismiss"
      @keydown="keydown"
    >
      <template v-if="$slots.prefix" #prefix><slot name="prefix" /></template>
    </MarInput>
    <MarPopover
      :virtual-ref="anchor"
      :visible="open"
      :show-arrow="false"
      placement="bottom-start"
      popper-class="mar-compact-popover"
      width="var(--mar-ui-popup-anchor-width)"
      @update:visible="(visible) => !visible && dismiss()"
    >
      <ul
        :id="listId"
        class="browser-address-history"
        role="listbox"
        :aria-label="t('browser.history')"
      >
        <li
          v-for="(item, index) in results"
          :id="optionId(index)"
          :key="item.url"
          role="option"
          :aria-selected="index === selection"
          @mousedown.prevent
          @click="choose(index)"
        >
          <span v-if="item.title" class="browser-address-title" dir="auto">{{ item.title }}</span>
          <span :class="{ 'browser-address-url': item.title }" dir="ltr">{{ item.url }}</span>
        </li>
      </ul>
    </MarPopover>
  </div>
</template>

<style scoped>
.browser-address-field > :deep(.mar-ui-input) {
  inline-size: 100%;
}
.browser-address-history {
  margin: 0;
  padding: 0.25rem;
  list-style: none;
}
.browser-address-history li {
  display: grid;
  gap: 0.125rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--mar-ui-radius-control);
  cursor: pointer;
}
.browser-address-history li:hover,
.browser-address-history li[aria-selected='true'] {
  background: var(--mar-ui-overlay-row-hover);
}
.browser-address-history li[aria-selected='true'] {
  outline: 1px solid var(--mar-ui-control-focus);
  outline-offset: -1px;
}
.browser-address-history span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-address-title {
  font-weight: 500;
}
.browser-address-url {
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-meta);
}
</style>
