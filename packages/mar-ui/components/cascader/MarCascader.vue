<script setup lang="ts" generic="Value extends string | number">
import {
  computed,
  nextTick,
  ref,
  shallowRef,
  useId,
  useTemplateRef,
  watch,
  type Component
} from 'vue';
import { MarIcon } from '../../icons/index.js';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';
import { useMarUiLocale } from '../../locale/index.js';
import { useMarFormControl } from '../form/form-context.js';
import '../form/field-frame.css';
import { usePopup } from '../popup/use-popup.js';
import '../popup/surface.css';

type Option = {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
  readonly children?: readonly Option[];
};

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue?: Value | undefined;
    id?: string;
    options: readonly Option[];
    props?: { checkStrictly?: boolean; emitPath?: false };
    disabled?: boolean | undefined;
    placeholder?: string;
    filterable?: boolean;
    clearable?: boolean;
    clearIcon?: MarIconName | Component;
  }>(),
  { disabled: undefined }
);
const emit = defineEmits<{
  'update:modelValue': [value: Value | undefined];
  change: [value: Value | undefined];
}>();
const locale = useMarUiLocale();
const form = useMarFormControl({ id: () => props.id, disabled: () => props.disabled });
const anchor = useTemplateRef<HTMLElement>('anchor');
const input = useTemplateRef<HTMLInputElement>('input');
const surface = useTemplateRef<HTMLElement>('surface');
const popupId = useId();
const search = ref<string>();
const path = shallowRef<Value[]>([]);
const popup = usePopup(() => {
  search.value = undefined;
});
const { open } = popup;
const flat = computed(() => {
  function visit(
    options: readonly Option[],
    parents: readonly Option[]
  ): { option: Option; path: readonly Option[]; label: string }[] {
    return options.flatMap((option) => {
      const trail = [...parents, option];
      return [
        { option, path: trail, label: trail.map((node) => node.label).join(' / ') },
        ...visit(option.children ?? [], trail)
      ];
    });
  }
  return visit(props.options, []);
});
const selected = computed(() => flat.value.find(({ option }) => option.value === props.modelValue));
const query = computed(() => search.value?.trim().toLocaleLowerCase() ?? '');
const results = computed(() =>
  flat.value.filter(
    ({ option, label }) =>
      (props.props?.checkStrictly || !option.children?.length) &&
      label.toLocaleLowerCase().includes(query.value)
  )
);
const columns = computed(() => {
  const result = [props.options];
  let options = props.options;
  for (const key of path.value) {
    const child = options.find((option) => option.value === key)?.children;
    if (!child?.length) break;
    result.push(child);
    options = child;
  }
  return result;
});
const clearIcon = computed(() => resolveMarIcon(props.clearIcon ?? 'clear-input'));

function focus() {
  input.value?.focus();
}
function show() {
  if (open.value || form.disabled.value || !anchor.value || !surface.value) return;
  path.value = selected.value?.path.map(({ value }) => value) ?? [];
  popup.show(anchor.value, surface.value);
}
function togglePopperVisible(visible: boolean) {
  if (visible) show();
  else popup.close();
}
defineExpose({ focus, togglePopperVisible });
watch(form.disabled, (disabled) => {
  if (disabled) popup.close();
});

function select(value: Value | undefined) {
  if (value !== props.modelValue) {
    emit('update:modelValue', value);
    emit('change', value);
  }
  popup.close();
  focus();
}
async function expand(option: Option, index: number, enter = false) {
  path.value = [...path.value.slice(0, index), option.value];
  await nextTick();
  const column = surface.value?.querySelectorAll('.mar-ui-cascader__column')[index + 1];
  column?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (enter) column?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
function onInput(event: Event) {
  show();
  search.value = (event.currentTarget as HTMLInputElement).value;
}
async function keydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    event.stopPropagation();
    popup.close();
    focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const from = event.target as HTMLElement;
    show();
    await nextTick();
    const scope = from.closest('.mar-ui-cascader__column') ?? surface.value;
    const buttons = Array.from(
      scope?.querySelectorAll<HTMLButtonElement>('button[data-option]:not(:disabled)') ?? []
    );
    const index = buttons.indexOf(from as HTMLButtonElement);
    const target =
      event.key === 'ArrowDown'
        ? (index + 1) % buttons.length
        : index <= 0
          ? buttons.length - 1
          : index - 1;
    buttons[target]?.focus();
  } else if (event.key === 'Enter' && event.target === input.value) {
    event.preventDefault();
    const match = open.value && query.value && results.value.find(({ option }) => !option.disabled);
    if (match) select(match.option.value);
    else show();
  } else if (event.key === 'Tab' && open.value && event.target === input.value && event.shiftKey) {
    popup.close();
  }
}
function onFocusOut(event: FocusEvent) {
  const related = event.relatedTarget as Node | null;
  if (anchor.value?.contains(related) || surface.value?.contains(related)) return;
  if (related) popup.close();
  form.blur();
}
</script>

<template>
  <div
    class="mar-ui-cascader"
    :class="$attrs.class"
    :style="$attrs.style"
    @keydown="keydown"
    @focusout="onFocusOut"
  >
    <div
      ref="anchor"
      class="mar-ui-cascader__field mar-ui-field-frame"
      :data-expanded="open"
      :data-disabled="form.disabled.value"
      :data-invalid="form.ariaInvalid($attrs['aria-invalid'])"
    >
      <input
        ref="input"
        v-bind="{ ...$attrs, class: undefined, style: undefined }"
        :id="form.id.value"
        class="mar-ui-field-frame__control"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="dialog"
        :aria-controls="popupId"
        :aria-expanded="open"
        :aria-invalid="form.ariaInvalid($attrs['aria-invalid'])"
        :aria-describedby="form.describedBy($attrs['aria-describedby'])"
        :value="search ?? selected?.label ?? ''"
        :placeholder="placeholder ?? locale.select"
        :disabled="form.disabled.value"
        :readonly="!filterable"
        @input="onInput"
        @click="show"
      />
      <button
        v-if="clearable && selected && !form.disabled.value"
        type="button"
        class="mar-ui-cascader__action"
        :aria-label="locale.clear"
        @pointerdown.prevent
        @click="select(undefined)"
      >
        <component :is="clearIcon" />
      </button>
      <span
        v-else
        class="mar-ui-cascader__action"
        aria-hidden="true"
        @pointerdown.prevent
        @click="
          focus();
          togglePopperVisible(!open);
        "
        ><MarIcon name="chevron-down"
      /></span>
    </div>
    <div
      :id="popupId"
      ref="surface"
      class="mar-ui-popup mar-ui-cascader__popup"
      popover="manual"
      role="dialog"
      :aria-label="($attrs['aria-label'] as string) || placeholder || locale.select"
    >
      <div v-if="open" class="mar-ui-popup__content">
        <div v-if="query && results.length" class="mar-ui-cascader__column">
          <button
            v-for="entry in results"
            :key="entry.option.value"
            data-option
            type="button"
            class="mar-ui-cascader__option"
            :aria-pressed="modelValue === entry.option.value"
            :disabled="entry.option.disabled"
            @click="select(entry.option.value)"
          >
            {{ entry.label }}
          </button>
        </div>
        <p v-else-if="query || !options.length" class="mar-ui-cascader__empty">
          {{ locale.noData }}
        </p>
        <div v-else class="mar-ui-cascader__columns">
          <div v-for="(column, index) in columns" :key="index" class="mar-ui-cascader__column">
            <div
              v-for="option in column"
              :key="option.value"
              class="mar-ui-cascader__row"
              :data-current="path[index] === option.value"
            >
              <button
                v-if="props.props?.checkStrictly && option.children?.length"
                type="button"
                class="mar-ui-cascader__choose"
                :disabled="option.disabled"
                :aria-label="option.label"
                :aria-pressed="modelValue === option.value"
                @click="select(option.value)"
              />
              <button
                data-option
                type="button"
                class="mar-ui-cascader__option"
                :aria-pressed="option.children?.length ? undefined : modelValue === option.value"
                :aria-expanded="option.children?.length ? path[index] === option.value : undefined"
                :disabled="option.disabled"
                @keydown.right="option.children?.length && expand(option, index, true)"
                @click="option.children?.length ? expand(option, index) : select(option.value)"
              >
                {{ option.label }}<MarIcon v-if="option.children?.length" name="chevron-right" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mar-ui-cascader {
  display: inline-block;
  inline-size: 14rem;
  min-inline-size: 0;
  max-inline-size: 100%;
}
.mar-ui-cascader__field {
  display: flex;
  align-items: center;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
}
input {
  flex: 1;
  inline-size: 0;
  min-inline-size: 0;
  padding-block: 0;
  padding-inline: 0.5rem 0.125rem;
  border: 0;
  background: transparent;
  color: var(--mar-ui-text-primary);
  font: inherit;
  font-size: var(--mar-ui-font-size-control);
  text-overflow: ellipsis;
}
input::placeholder {
  color: var(--mar-ui-text-secondary);
  font-weight: 400;
}
input:disabled {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
.mar-ui-cascader__action {
  display: grid;
  place-items: center;
  flex: 0 0 28px;
  border: 0;
  background: transparent;
  color: var(--mar-ui-text-secondary);
  padding: 0;
  cursor: pointer;
}
[data-disabled='true'] .mar-ui-cascader__action {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
.mar-ui-cascader__columns {
  display: flex;
  overflow: auto;
}
.mar-ui-cascader__column,
.mar-ui-cascader__empty {
  min-inline-size: min(10rem, 35vw);
}
.mar-ui-cascader__column {
  display: grid;
  align-content: start;
  max-block-size: 14rem;
  overflow: auto;
  font-size: var(--mar-ui-font-size-control);
}
.mar-ui-cascader__column + .mar-ui-cascader__column {
  border-inline-start: 1px solid var(--mar-ui-border-subtle);
}
.mar-ui-cascader__row {
  display: flex;
  align-items: center;
  padding-inline-start: 0.375rem;
}
.mar-ui-cascader__option {
  display: flex;
  flex: 1;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.375rem 0.625rem;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.mar-ui-cascader__column > .mar-ui-cascader__option:enabled:hover,
.mar-ui-cascader__row:has(.mar-ui-cascader__option:enabled):hover {
  background: var(--mar-ui-overlay-row-hover, var(--mar-ui-fill-row-hover));
}
.mar-ui-cascader__column > .mar-ui-cascader__option[aria-pressed='true'],
.mar-ui-cascader__row:is([data-current='true'], :has(> [aria-pressed='true'])) {
  background: var(--mar-ui-fill-selection);
}
.mar-ui-cascader__option:focus-visible,
.mar-ui-cascader__choose:focus-visible,
.mar-ui-cascader__action:focus-visible {
  outline-offset: -2px;
}
.mar-ui-cascader__option:disabled,
.mar-ui-cascader__choose:disabled {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
.mar-ui-cascader__choose {
  flex: none;
  inline-size: 14px;
  block-size: 14px;
  border: 1px solid var(--mar-ui-input-border);
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}
.mar-ui-cascader__choose[aria-pressed='true'] {
  border-color: var(--mar-ui-control-primary-bg);
  background: var(--mar-ui-control-primary-bg);
  box-shadow: inset 0 0 0 3px var(--mar-ui-overlay-surface);
}
.mar-ui-cascader__empty {
  display: grid;
  place-items: center;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  padding: 4px var(--mar-ui-compact-option-padding-inline);
  margin: 0;
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-control);
  line-height: 1.45;
  text-align: center;
}
</style>
