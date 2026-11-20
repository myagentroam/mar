<script
  setup
  lang="ts"
  generic="
    Value extends OptionValue,
    Multiple extends boolean = false,
    Clearable extends boolean = false
  "
>
import {
  computed,
  nextTick,
  provide,
  ref,
  shallowReactive,
  shallowRef,
  useId,
  useTemplateRef,
  watch
} from 'vue';
import { MarIconGraphic, resolveMarIcon } from '../../icons/mar-icons.js';
import { useMarUiLocale } from '../../locale/index.js';
import { useMarFormControl } from '../form/form-context.js';
import { usePopup } from '../popup/use-popup.js';
import '../popup/surface.css';
import MarOption from './MarOption.vue';
import { optionContext, type Choice, type OptionValue } from './option-context.js';
import type { MarSelection, MarSelectProps } from './select-types.js';

// Owns the transient query, active option and controlled selection. The popup owns positioning
// and outside dismissal; option children supply their own labels and presentation.
defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<MarSelectProps<Value, Multiple, Clearable>>(), {
  disabled: undefined,
  validateEvent: true
});
const {
  id: controlId,
  disabled: controlDisabled,
  ariaInvalid,
  describedBy,
  blur: validateBlur
} = useMarFormControl({
  id: () => props.id,
  disabled: () => props.disabled,
  validateEvent: () => props.validateEvent
});
type Selection = MarSelection<Value, Multiple, Clearable>;
const emit = defineEmits<{
  'update:modelValue': [value: Selection];
  change: [value: Selection];
  clear: [];
  blur: [event: FocusEvent];
}>();
const locale = useMarUiLocale();
const id = useId();
const createId = `${id}-create`;
const field = useTemplateRef<HTMLElement>('field');
const trigger = useTemplateRef<HTMLElement>('trigger');
const list = useTemplateRef<HTMLElement>('list');
const choices = shallowReactive(new Set<Choice>());
const active = shallowRef<Choice>();
const activeValue = computed(() => active.value?.value);
const query = ref('');
const normalizedQuery = computed(() => query.value.toLocaleLowerCase());
const selectedValues = computed<readonly OptionValue[]>(() => {
  const value = props.modelValue;
  if (props.multiple) return Array.isArray(value) ? value : [];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? [value]
    : [];
});
const choicesByValue = computed(() => new Map([...choices].map((item) => [item.value, item])));
const selected = computed(() =>
  selectedValues.value.map((value) => ({
    value,
    label: choicesByValue.value.get(value)?.label ?? String(value),
    disabled: choicesByValue.value.get(value)?.disabled
  }))
);
const singleLabel = computed(() => selected.value[0]?.label);
const hasSingleValue = computed(() => singleLabel.value !== undefined && singleLabel.value !== '');
const displayedTags = computed(() =>
  props.collapseTags ? selected.value.slice(0, 1) : selected.value
);
const hiddenTags = computed(() => selected.value.slice(displayedTags.value.length));
const canClear = computed(
  () =>
    props.clearable &&
    !controlDisabled.value &&
    (props.multiple ? selected.value.some((item) => !item.disabled) : hasSingleValue.value)
);
const canCreate = computed(
  () =>
    props.filterable &&
    props.allowCreate &&
    query.value !== '' &&
    !selectedValues.value.includes(query.value) &&
    ![...choices].some(
      (item) =>
        item.id !== createId && (String(item.label) === query.value || item.value === query.value)
    )
);
const visibleItems = computed(() => [...choices].filter(visible));
const available = computed(() => visibleItems.value.filter((item) => !disabled(item)));
const collapsedTagsOpen = ref(false);
const { open, show, close } = usePopup(() => {
  active.value = undefined;
  query.value = '';
});

function controlAttrs(attrs: Record<string, unknown>) {
  return {
    ...attrs,
    'aria-invalid': ariaInvalid(attrs['aria-invalid']),
    'aria-describedby': describedBy(attrs['aria-describedby']),
    class: 'mar-ui-select__trigger',
    style: undefined,
    id: controlId.value ?? `${id}-trigger`,
    role: 'combobox',
    'aria-label': props.ariaLabel,
    'aria-labelledby': props.ariaLabelledby,
    'aria-expanded': open.value,
    'aria-controls': id,
    'aria-activedescendant': open.value ? active.value?.id : undefined,
    'aria-busy': props.loading || undefined,
    disabled: controlDisabled.value
  };
}

function optionKey(value: OptionValue) {
  return `${typeof value}:${value}`;
}

function visible(item: Choice) {
  return (
    !props.loading &&
    (item.id === createId
      ? canCreate.value
      : !normalizedQuery.value ||
        String(item.label).toLocaleLowerCase().includes(normalizedQuery.value))
  );
}

function disabled(item: Choice) {
  return Boolean(
    item.disabled ||
    (props.multiple &&
      props.multipleLimit &&
      props.multipleLimit > 0 &&
      selectedValues.value.length >= props.multipleLimit &&
      !selectedValues.value.includes(item.value))
  );
}

function publish(value: OptionValue | OptionValue[] | undefined) {
  // The runtime selection branch and slotted option values follow the caller's model type.
  emit('update:modelValue', value as Selection);
  emit('change', value as Selection);
}

function choose(item: Choice) {
  if (controlDisabled.value || !visible(item) || disabled(item)) return;
  if (props.multiple) {
    const value = item.value;
    const values = selectedValues.value;
    publish(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
    if (item.id === createId) query.value = '';
  } else {
    if (item.value !== props.modelValue) publish(item.value);
    close();
  }
}

function focus() {
  trigger.value?.focus();
}

function clear() {
  if (!canClear.value) return;
  close();
  publish(
    props.multiple
      ? selected.value.filter((item) => item.disabled).map((item) => item.value)
      : undefined
  );
  emit('clear');
  focus();
}

function remove(value: OptionValue) {
  if (controlDisabled.value || choicesByValue.value.get(value)?.disabled) return;
  publish(selectedValues.value.filter((selectedValue) => selectedValue !== value));
  focus();
}

provide(optionContext, {
  register(item) {
    choices.add(item);
    return () => {
      choices.delete(item);
      if (active.value === item) active.value = undefined;
    };
  },
  visible,
  groupVisible: (group) => visibleItems.value.some((item) => item.group === group),
  selected: (item) => selectedValues.value.includes(item.value),
  active: (item) => item === active.value,
  disabled,
  multiple: () => Boolean(props.multiple),
  pointAt(item) {
    if (!disabled(item)) active.value = item;
  },
  choose
});

function orderedAvailable() {
  const rendered = list.value?.querySelectorAll<HTMLElement>('.mar-ui-option');
  if (!rendered) return available.value;
  // Keyed option components can be reordered in place without re-registering with the select.
  const byId = new Map(available.value.map((item) => [item.id, item]));
  return Array.from(rendered).flatMap((element) => {
    const item = byId.get(element.id);
    return item ? [item] : [];
  });
}

function revealActive() {
  const surface = list.value;
  if (!surface || !active.value) return;
  const option = surface.ownerDocument.getElementById(active.value.id);
  if (!option || !surface.contains(option)) return;
  // Reveal the row in its own scrolling group and listbox, never the underlying page.
  for (
    let parent = option.parentElement;
    parent && surface.contains(parent);
    parent = parent.parentElement
  ) {
    if (
      parent.scrollHeight <= parent.clientHeight ||
      !['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)
    )
      continue;
    const row = option.getBoundingClientRect();
    const top = parent.getBoundingClientRect().top + parent.clientTop;
    const bottom = top + parent.clientHeight;
    if (row.top < top) parent.scrollTop += row.top - top;
    else if (row.bottom > bottom) parent.scrollTop += row.bottom - bottom;
  }
}

function expand(key?: string) {
  if (!field.value || !list.value || controlDisabled.value) return;
  const items = orderedAvailable();
  const current = items.find((item) => item.value === selectedValues.value.at(-1));
  active.value =
    key === 'Home' ||
    key === 'End' ||
    (!current && (key || !props.filterable || props.defaultFirstOption))
      ? items.at(key === 'ArrowUp' || key === 'End' ? -1 : 0)
      : current;
  collapsedTagsOpen.value = false;
  show(field.value, list.value, true);
  if (open.value) revealActive();
}

function toggleMenu() {
  if (open.value) close();
  else expand();
}

function setActiveValue(value: OptionValue) {
  if (!open.value) return;
  const item = available.value.find((item) => item.value === value);
  if (!item) return;
  active.value = item;
  revealActive();
}

defineExpose({ focus, toggleMenu, expanded: open, activeValue, setActiveValue });

function move(key: string) {
  const items = orderedAvailable();
  if (!items.length) return;
  const index = active.value ? items.indexOf(active.value) : -1;
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : index === -1
          ? key === 'ArrowUp'
            ? items.length - 1
            : 0
          : (index + (key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
  active.value = items[next];
  revealActive();
}

function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
    return;
  if (event.key === 'Tab') {
    close();
    return;
  }
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (
    event.key === 'ArrowDown' ||
    event.key === 'ArrowUp' ||
    (!props.filterable && (event.key === 'Home' || event.key === 'End'))
  ) {
    event.preventDefault();
    if (!open.value) expand(event.key);
    else move(event.key);
  } else if (
    (open.value && (event.key === 'Enter' || (!props.filterable && event.key === ' '))) ||
    (props.filterable && event.key === 'Enter')
  ) {
    event.preventDefault();
    if (!open.value) expand();
    else if (active.value) choose(active.value);
  } else if (
    props.filterable &&
    props.multiple &&
    event.key === 'Backspace' &&
    query.value === ''
  ) {
    const last = selected.value.findLast((item) => !item.disabled);
    if (last) remove(last.value);
  }
}

function onQueryInput(event: Event) {
  if (!(event as InputEvent).isComposing && !open.value) expand();
}

function onFieldClick(event: MouseEvent) {
  if (
    controlDisabled.value ||
    !(event.target instanceof Element) ||
    event.target.closest('button, input')
  )
    return;
  event.preventDefault();
  focus();
  toggleMenu();
}

function onFocusOut(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && field.value?.contains(event.relatedTarget)) return;
  close();
  validateBlur();
  emit('blur', event);
}

watch(
  [query, available],
  ([text, items], [previous]) => {
    if (!open.value) return;
    if (text === previous && active.value && items.includes(active.value)) return;
    const ordered = orderedAvailable();
    active.value = props.defaultFirstOption
      ? (ordered.find((item) => item.id === createId) ?? ordered[0])
      : text
        ? undefined
        : (ordered.find((item) => item.value === selectedValues.value.at(-1)) ??
          (!props.filterable ? ordered[0] : undefined));
    if (active.value) void nextTick(revealActive);
  },
  { flush: 'post' }
);

watch(controlDisabled, (disabled) => {
  if (disabled) close();
});
</script>

<template>
  <div class="mar-ui-select" :class="$attrs.class" :style="$attrs.style">
    <div
      ref="field"
      class="mar-ui-select__field"
      :class="{
        'mar-ui-select__field--small': size === 'small',
        'mar-ui-select__field--multiple': multiple && selected.length > 0,
        'mar-ui-select__field--filterable': filterable
      }"
      :data-disabled="controlDisabled || undefined"
      :data-expanded="open || undefined"
      @click="onFieldClick"
      @focusout="onFocusOut"
    >
      <div class="mar-ui-select__selection">
        <input
          v-if="filterable"
          v-bind="controlAttrs($attrs)"
          ref="trigger"
          v-model="query"
          type="text"
          autocomplete="off"
          aria-autocomplete="list"
          :placeholder="
            multiple && selected.length
              ? undefined
              : hasSingleValue && !multiple
                ? String(singleLabel)
                : (placeholder ?? locale.select)
          "
          :class="{ 'mar-ui-select__trigger--selected': !multiple && hasSingleValue && !open }"
          @input="onQueryInput"
          @click="!open && expand()"
          @keydown="onKey"
        />
        <button
          v-else
          v-bind="controlAttrs($attrs)"
          ref="trigger"
          type="button"
          @click="toggleMenu"
          @keydown="onKey"
        >
          <span
            v-if="!multiple || selected.length === 0"
            class="mar-ui-select__label"
            :class="{ 'mar-ui-select__label--placeholder': !hasSingleValue }"
            >{{ hasSingleValue ? singleLabel : (placeholder ?? locale.select) }}</span
          >
        </button>
        <template v-if="multiple">
          <span
            v-for="(item, index) in displayedTags"
            :key="optionKey(item.value)"
            class="mar-ui-select__tag"
          >
            <span :id="`${id}-tag-${index}`" class="mar-ui-select__label">{{ item.label }}</span>
            <button
              v-if="!controlDisabled && !item.disabled"
              type="button"
              class="mar-ui-select__action mar-ui-select__tag-remove"
              :aria-labelledby="`${id}-clear-label ${id}-tag-${index}`"
              @mousedown.prevent
              @click="remove(item.value)"
            >
              <MarIconGraphic name="close" />
            </button>
          </span>
          <span v-if="hiddenTags.length" class="mar-ui-select__tag mar-ui-select__summary">
            <button
              v-if="collapseTagsTooltip"
              type="button"
              class="mar-ui-select__action"
              :aria-describedby="`${id}-summary`"
              :aria-expanded="collapsedTagsOpen"
              @click="collapsedTagsOpen = !collapsedTagsOpen"
              @blur="collapsedTagsOpen = false"
              @keydown.esc="collapsedTagsOpen = false"
            >
              +{{ hiddenTags.length }}
            </button>
            <span v-else>+{{ hiddenTags.length }}</span>
            <span
              v-if="collapseTagsTooltip"
              :id="`${id}-summary`"
              class="mar-ui-select__summary-content"
            >
              <span v-for="item in hiddenTags" :key="optionKey(item.value)"
                >{{ item.label }}{{ ' ' }}</span
              >
            </span>
          </span>
          <span :id="`${id}-clear-label`" hidden>{{ locale.clear }}</span>
        </template>
      </div>
      <button
        v-if="canClear"
        type="button"
        class="mar-ui-select__action mar-ui-select__clear"
        :aria-label="locale.clear"
        @mousedown.prevent
        @click="clear"
      >
        <component :is="resolveMarIcon(clearIcon ?? 'clear-input')" aria-hidden="true" />
      </button>
      <MarIconGraphic
        v-else-if="loading && !open"
        name="loading-content"
        class="mar-ui-select__icon mar-ui-select__loading"
      />
      <component
        v-else
        :is="resolveMarIcon(suffixIcon ?? 'chevron-down')"
        class="mar-ui-select__icon"
        aria-hidden="true"
      />
    </div>
    <div
      :id="id"
      ref="list"
      popover="manual"
      class="mar-ui-popup"
      :class="popperClass"
      role="listbox"
      :aria-label="ariaLabel"
      :aria-labelledby="ariaLabelledby"
      :aria-busy="loading || undefined"
      :aria-multiselectable="multiple || undefined"
    >
      <div class="mar-ui-popup__content">
        <MarOption v-if="canCreate" :id="createId" :value="query" />
        <MarOption
          v-for="item in options"
          :key="optionKey(item.value)"
          :value="item.value"
          :label="item.label"
        />
        <slot />
        <div v-if="loading" class="mar-ui-select__empty">
          <MarIconGraphic name="loading-content" class="mar-ui-select__loading" />
        </div>
        <div v-else-if="visibleItems.length === 0" class="mar-ui-select__empty">
          {{ locale.noData }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mar-ui-select {
  min-width: 0;
  width: 100%;
}
.mar-ui-select__field {
  --mar-ui-select-height: 32px;
  --mar-ui-select-padding: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-height: var(--mar-ui-select-height);
  padding-inline: var(--mar-ui-select-padding);
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-bg-panel);
  box-shadow: 0 0 0 1px var(--mar-ui-input-border) inset;
  color: var(--mar-ui-text-primary);
  font-size: var(--mar-ui-font-size-body);
  font-weight: 400;
  text-align: start;
  cursor: pointer;
}
.mar-ui-select__field--small {
  --mar-ui-select-height: var(--mar-ui-compact-control-size);
  --mar-ui-select-padding: 0.5rem;
  font-size: var(--mar-ui-font-size-meta);
}
.mar-ui-select__field--filterable:not(.mar-ui-select__field--small) {
  font-size: var(--mar-ui-font-size-input);
}
.mar-ui-select__field:hover {
  box-shadow: 0 0 0 1px var(--mar-ui-input-border-hover) inset;
}
.mar-ui-select__field:is(:focus-within, [data-expanded]) {
  box-shadow: 0 0 0 1px var(--mar-ui-color-brand) inset;
}
.mar-ui-select__field:has([aria-invalid='true']) {
  box-shadow: 0 0 0 1px var(--mar-ui-control-color-danger) inset;
}
.mar-ui-select__field[data-disabled] {
  background: var(--mar-ui-fill-soft);
  box-shadow: 0 0 0 1px var(--mar-ui-border-subtle) inset;
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
.mar-ui-select__field:has(.mar-ui-select__trigger:focus-visible) + .mar-ui-popup {
  --mar-ui-select-option-focus: 2px solid var(--mar-ui-color-brand);
}
.mar-ui-select__selection {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 0.25rem;
  min-width: 0;
}
.mar-ui-select__field--multiple .mar-ui-select__selection {
  flex-wrap: wrap;
  padding-block: 0.125rem;
}
.mar-ui-select__trigger,
.mar-ui-select__action {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: inherit;
  cursor: inherit;
}
.mar-ui-select__trigger {
  display: block;
  flex: 1 1 1em;
  order: 1;
  min-width: 0;
  min-height: var(--mar-ui-select-height);
  outline: none;
}
input.mar-ui-select__trigger {
  cursor: text;
}
.mar-ui-select__trigger:disabled {
  color: inherit;
  cursor: inherit;
}
.mar-ui-select__field--multiple .mar-ui-select__trigger {
  min-height: calc(var(--mar-ui-select-height) - 0.25rem);
}
.mar-ui-select__field--multiple input.mar-ui-select__trigger {
  flex-basis: 5ch;
}
.mar-ui-select__label {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mar-ui-select__trigger::placeholder {
  opacity: 1;
}
.mar-ui-select__trigger--selected::placeholder {
  color: inherit;
}
.mar-ui-select__action {
  display: inline-grid;
  place-items: center;
  flex: none;
  cursor: pointer;
  color: var(--mar-ui-text-secondary);
}
.mar-ui-select__action:focus-visible {
  outline: 2px solid var(--mar-ui-color-brand);
}
.mar-ui-select__clear {
  min-width: 1.25rem;
  min-height: var(--mar-ui-select-height);
}
.mar-ui-select__icon {
  flex: none;
  width: 1.25rem;
}
.mar-ui-select__trigger:not(.mar-ui-select__trigger--selected):enabled::placeholder,
.mar-ui-select__field:not([data-disabled])
  :is(.mar-ui-select__icon, .mar-ui-select__label--placeholder) {
  color: var(--mar-ui-text-secondary);
}
.mar-ui-select__tag {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  max-width: 100%;
  padding: 0.125rem 0.375rem;
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-fill-soft);
  font-size: var(--mar-ui-font-size-meta);
}
.mar-ui-select__tag-remove {
  min-height: 1rem;
  min-width: 1rem;
}
.mar-ui-select__summary {
  position: relative;
}
.mar-ui-select__summary-content {
  position: absolute;
  z-index: 1;
  inset-block-end: 100%;
  inset-inline-end: 0;
  display: none;
  width: max-content;
  max-width: min(16rem, 70vw);
  padding: 0.375rem;
  border: 1px solid var(--mar-ui-overlay-border);
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-overlay-surface);
  box-shadow: var(--mar-ui-overlay-shadow);
  color: var(--mar-ui-text-primary);
  overflow-wrap: anywhere;
}
.mar-ui-select__summary:is(:hover, :has(:focus-visible, [aria-expanded='true']))
  .mar-ui-select__summary-content {
  display: grid;
  gap: 0.125rem;
}
.mar-ui-select__loading {
  animation: mar-ui-select-loading 0.9s linear infinite;
}
.mar-ui-select__empty {
  padding: 0.375rem 0.75rem;
  color: var(--mar-ui-text-secondary);
  text-align: center;
}
@keyframes mar-ui-select-loading {
  to {
    transform: rotate(1turn);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mar-ui-select__loading {
    animation: none;
  }
}
@media (forced-colors: active) {
  .mar-ui-select__field {
    border: 1px solid ButtonText;
  }
  .mar-ui-select__field:is(:focus-within, [data-expanded]),
  .mar-ui-select__action:focus-visible {
    outline: 2px solid Highlight;
  }
  .mar-ui-select__field:has(.mar-ui-select__trigger:focus-visible) + .mar-ui-popup {
    --mar-ui-select-option-focus: 2px solid Highlight;
  }
}
</style>
