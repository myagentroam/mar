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
  inject,
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
import { marUiTooltipDirectiveKey, readOverflowText } from '../tooltip/tooltip-directive.js';
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
const vOverflowTooltip = inject(marUiTooltipDirectiveKey, {});
const id = useId();
const createId = `${id}-create`;
const field = useTemplateRef<HTMLElement>('field');
const trigger = useTemplateRef<HTMLElement>('trigger');
const list = useTemplateRef<HTMLElement>('list');
const label = useTemplateRef<HTMLElement>('label');
const tagLabels = useTemplateRef<HTMLElement[]>('tagLabels');
const overflowText = () =>
  readOverflowText(label.value ?? (compactTags.value ? (tagLabels.value?.[0] ?? null) : null));
const choices = shallowReactive(new Set<Choice>());
const active = shallowRef<Choice>();
const activeValue = computed(() => active.value?.value);
// A filterable input can match :focus-visible even during pointer interaction.
const pointerDriven = ref(false);
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
const compactTags = computed(() => props.multiple && props.collapseTags && !props.filterable);
const hasTags = computed(() => props.multiple && selected.value.length > 0);
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
const summaryButton = useTemplateRef<HTMLButtonElement>('summaryButton');
const summarySurface = useTemplateRef<HTMLElement>('summarySurface');
const {
  open: collapsedTagsOpen,
  show: showCollapsedTags,
  close: closeCollapsedTags
} = usePopup(() => {});
const { open, show, close } = usePopup(() => {
  active.value = undefined;
  pointerDriven.value = false;
  query.value = '';
});

function revealCollapsedTags() {
  if (summaryButton.value && summarySurface.value)
    showCollapsedTags(summaryButton.value, summarySurface.value, { placement: 'top', offset: 0 });
}

let dismissOnSummaryClick = false;
function onSummaryPointerDown(event: PointerEvent) {
  // Read the input type and open state before the click can move focus.
  dismissOnSummaryClick = event.pointerType === 'touch' && collapsedTagsOpen.value;
}

function onSummaryClick(event: MouseEvent) {
  const dismiss = dismissOnSummaryClick && event.detail > 0;
  dismissOnSummaryClick = false;
  if (dismiss) closeCollapsedTags();
  else revealCollapsedTags();
}

function onSummaryFocus(event: FocusEvent) {
  if ((event.currentTarget as HTMLElement).matches(':focus-visible')) revealCollapsedTags();
}

watch(summaryButton, (button) => {
  if (!button) closeCollapsedTags();
});

watch(
  collapsedTagsOpen,
  (visible, _, onCleanup) => {
    const document = summaryButton.value?.ownerDocument;
    if (!visible || !document) return;
    // Hover does not move focus to the preview; Escape must still dismiss it.
    const onEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeCollapsedTags();
    };
    document.addEventListener('keydown', onEscape, true);
    onCleanup(() => document.removeEventListener('keydown', onEscape, true));
  },
  { flush: 'sync' }
);

function controlAttrs(attrs: Record<string, unknown>) {
  const description = describedBy(attrs['aria-describedby']);
  return {
    ...attrs,
    'aria-invalid': ariaInvalid(attrs['aria-invalid']),
    'aria-describedby':
      compactTags.value && hasTags.value
        ? [description, `${id}-tag-0`].filter(Boolean).join(' ')
        : description,
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
    if (disabled(item)) return;
    pointerDriven.value = true;
    active.value = item;
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
  closeCollapsedTags();
  show(field.value, list.value);
  if (open.value) void nextTick(revealActive);
}

function toggleMenu() {
  if (open.value) close();
  else expand();
}

function setActiveValue(value: OptionValue) {
  if (!open.value) return;
  const item = available.value.find((item) => item.value === value);
  if (!item) return;
  pointerDriven.value = false;
  active.value = item;
  void nextTick(revealActive);
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
  void nextTick(revealActive);
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
    pointerDriven.value = false;
    if (!open.value) expand(event.key);
    else move(event.key);
  } else if (
    (open.value && (event.key === 'Enter' || (!props.filterable && event.key === ' '))) ||
    (props.filterable && event.key === 'Enter')
  ) {
    event.preventDefault();
    pointerDriven.value = false;
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
  if ((event as InputEvent).isComposing) return;
  pointerDriven.value = false;
  if (!open.value) expand();
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
        'mar-ui-select__field--tags': hasTags,
        'mar-ui-select__field--compact-tags': compactTags,
        'mar-ui-select__field--filterable': filterable
      }"
      :data-disabled="controlDisabled || undefined"
      :data-expanded="open || undefined"
      @click.capture="pointerDriven = $event.detail > 0"
      @click="onFieldClick"
      @focusout="onFocusOut"
    >
      <component
        v-if="prefixIcon"
        :is="resolveMarIcon(prefixIcon)"
        class="mar-ui-select__icon"
        aria-hidden="true"
      />
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
          v-overflow-tooltip="overflowText"
          ref="trigger"
          type="button"
          :class="{ 'mar-ui-select__trigger--with-tags': hasTags }"
          @click="toggleMenu"
          @keydown="onKey"
        >
          <span
            v-if="!hasTags"
            ref="label"
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
            <span :id="`${id}-tag-${index}`" ref="tagLabels" class="mar-ui-select__label">{{
              item.label
            }}</span>
            <button
              v-if="!controlDisabled && !item.disabled"
              type="button"
              class="mar-ui-select__action mar-ui-select__tag-remove"
              :aria-labelledby="`${id}-clear-label ${id}-tag-${index}`"
              @mousedown.prevent
              @click="remove(item.value)"
            >
              <MarIconGraphic name="close" class="mar-ui-select__tag-remove-icon" />
            </button>
          </span>
          <div
            v-if="hiddenTags.length"
            class="mar-ui-select__tag mar-ui-select__summary"
            @pointerenter="$event.pointerType === 'mouse' && revealCollapsedTags()"
            @pointerleave="$event.pointerType === 'mouse' && closeCollapsedTags()"
          >
            <button
              v-if="collapseTagsTooltip"
              ref="summaryButton"
              type="button"
              class="mar-ui-select__action"
              :aria-describedby="`${id}-summary`"
              :aria-expanded="collapsedTagsOpen"
              @pointerdown="onSummaryPointerDown"
              @click="onSummaryClick"
              @focus="onSummaryFocus"
              @blur="closeCollapsedTags"
            >
              +{{ hiddenTags.length }}
            </button>
            <span v-else>+{{ hiddenTags.length }}</span>
            <div
              v-if="collapseTagsTooltip"
              :id="`${id}-summary`"
              ref="summarySurface"
              class="mar-ui-popup mar-ui-select__summary-content"
              popover="manual"
            >
              <div class="mar-ui-popup__content">
                <span v-for="item in hiddenTags" :key="optionKey(item.value)"
                  >{{ item.label }}{{ ' ' }}</span
                >
              </div>
            </div>
          </div>
          <span :id="`${id}-clear-label`" hidden>{{ locale.clear }}</span>
        </template>
      </div>
      <span class="mar-ui-select__suffix" :data-clearable="clearable || undefined">
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
          v-if="loading && !open"
          name="loading-content"
          class="mar-ui-select__icon mar-ui-select__loading"
        />
        <component
          v-else
          :is="resolveMarIcon(suffixIcon ?? 'chevron-down')"
          class="mar-ui-select__icon"
          aria-hidden="true"
        />
      </span>
    </div>
    <div
      :id="id"
      ref="list"
      popover="manual"
      class="mar-ui-popup mar-ui-select__popup"
      :class="popperClass"
      :data-pointer-driven="pointerDriven || undefined"
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
.mar-ui-select__popup {
  --mar-ui-popup-min-width: var(--mar-ui-popup-anchor-width, 0px);
  width: max-content;
  min-width: min(var(--mar-ui-popup-min-width), var(--mar-ui-popup-width-limit));
  padding-inline: 0;
}
.mar-ui-select__field {
  --mar-ui-select-height: var(--mar-ui-compact-control-size, 24px);
  --mar-ui-select-padding: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-height: var(--mar-ui-select-height);
  padding-inline: var(--mar-ui-select-padding);
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-bg-panel);
  box-shadow: 0 0 0 1px var(--mar-ui-input-border) inset;
  color: var(--mar-ui-text-primary);
  font-size: var(--mar-ui-font-size-meta);
  font-weight: 400;
  text-align: start;
  cursor: pointer;
}
.mar-ui-select__field--filterable {
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
.mar-ui-select__field:has(.mar-ui-select__trigger:focus-visible)
  + .mar-ui-popup:not([data-pointer-driven]) {
  --mar-ui-select-option-focus: 2px solid
    light-dark(
      var(--mar-ui-color-brand),
      color-mix(in srgb, var(--mar-ui-color-brand), var(--mar-ui-text-primary) 24%)
    );
}
.mar-ui-select__field:focus-within + .mar-ui-popup:not([data-pointer-driven]) {
  --mar-ui-select-active-label-space: normal;
}
.mar-ui-select__selection {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  gap: 0.25rem;
  min-width: 0;
}
.mar-ui-select__field--tags .mar-ui-select__selection {
  flex-wrap: wrap;
  padding-block: 0.125rem;
}
.mar-ui-select__field--compact-tags .mar-ui-select__selection {
  flex-wrap: nowrap;
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
.mar-ui-select__field--tags input.mar-ui-select__trigger {
  order: 1;
  flex-basis: 5ch;
  min-height: calc(var(--mar-ui-select-height) - 0.25rem);
}
.mar-ui-select__trigger--with-tags {
  position: absolute;
  inset: 0;
  width: 100%;
  min-height: 0;
}
.mar-ui-select__field:not(.mar-ui-select__field--filterable)
  .mar-ui-select__tag:not(.mar-ui-select__summary) {
  pointer-events: none;
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
.mar-ui-select__suffix {
  display: grid;
  flex: none;
  place-items: center;
}
.mar-ui-select__suffix[data-clearable] {
  min-inline-size: 24px;
}
.mar-ui-select__suffix > * {
  grid-area: 1 / 1;
}
.mar-ui-select__suffix:has(.mar-ui-select__clear) > .mar-ui-select__icon {
  visibility: hidden;
}
@media (hover: hover) and (pointer: fine) {
  .mar-ui-select__field:not(:hover, :focus-within) .mar-ui-select__clear {
    opacity: 0;
    pointer-events: none;
  }
  .mar-ui-select__field:not(:hover, :focus-within)
    .mar-ui-select__suffix:has(.mar-ui-select__clear)
    > .mar-ui-select__icon {
    visibility: visible;
  }
}
.mar-ui-select__clear {
  justify-self: stretch;
  min-height: var(--mar-ui-select-height);
}
.mar-ui-select__clear:hover,
.mar-ui-select__tag-remove:hover {
  color: var(--mar-ui-text-primary);
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
  position: relative;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  max-width: 100%;
  min-height: calc(var(--mar-ui-select-height) - 0.5rem);
  padding-inline: 0.375rem;
  border-radius: var(--mar-ui-radius-control);
  background: color-mix(in srgb, var(--mar-ui-bg-panel), var(--mar-ui-text-secondary) 12%);
  font-size: var(--mar-ui-font-size-meta);
  line-height: 1.2;
}
.mar-ui-select__tag-remove {
  min-height: 1rem;
  min-width: 1rem;
  border-radius: 50%;
  pointer-events: auto;
}
.mar-ui-select__tag-remove-icon {
  width: 0.75rem;
  height: 0.75rem;
}
.mar-ui-select__summary {
  flex: none;
  color: var(--mar-ui-text-secondary);
  white-space: nowrap;
}
.mar-ui-select__summary-content {
  --mar-ui-popup-width: max-content;
  --mar-ui-popup-width-cap: 16rem;
  --mar-ui-popup-padding: 0.375rem;
  font-size: var(--mar-ui-font-size-meta);
  white-space: normal;
  overflow-wrap: anywhere;
}
.mar-ui-select__summary-content::before {
  display: none;
}
.mar-ui-select__summary-content .mar-ui-popup__content > span {
  display: block;
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
  .mar-ui-select__field:has(.mar-ui-select__trigger:focus-visible)
    + .mar-ui-popup:not([data-pointer-driven]) {
    --mar-ui-select-option-focus: 2px solid Highlight;
  }
}
</style>
