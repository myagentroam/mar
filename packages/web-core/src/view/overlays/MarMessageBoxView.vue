<script setup lang="ts">
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { marUiLocaleKey } from '@myagentroam/mar-ui/locale';
import marEn from '@myagentroam/mar-ui/locale/en';
import marZhCn from '@myagentroam/mar-ui/locale/zh-cn';
import { computed, onBeforeUnmount, provide, ref, useId, useTemplateRef, type VNode } from 'vue';
import { createMobileLayerHistoryService } from '../../service/mobile-layer-history-service.js';
import { localePreferenceService } from '../../service/locale-preference-service.js';
import type {
  MarMessageBoxAction,
  MarMessageBoxOptions,
  MarMessageBoxVariant
} from '../../service/message-box-service.js';

/** Presents confirmation and prompt state. The MessageBox service owns the request promise. */
const props = defineProps<{
  readonly message: string | VNode;
  readonly title: string;
  readonly options: MarMessageBoxOptions;
  readonly variant: MarMessageBoxVariant;
}>();
const emit = defineEmits<{ finish: [action: MarMessageBoxAction, value?: string] }>();
const { locale } = localePreferenceService();
const locales = { 'en-US': marEn, 'zh-CN': marZhCn };
provide(
  marUiLocaleKey,
  computed(() => locales[locale.value])
);

const open = ref(true);
const closing = ref(false);
const value = ref(props.options.inputValue ?? '');
const error = ref('');
const id = useId();
const input = useTemplateRef<InstanceType<typeof MarInput>>('input');
const confirmAction = useTemplateRef<InstanceType<typeof MarButton>>('confirmAction');
const cancelAction = useTemplateRef<InstanceType<typeof MarButton>>('cancelAction');
const dialog = useTemplateRef<InstanceType<typeof MarDialog>>('dialog');
const history = createMobileLayerHistoryService({
  isOpen: () => open.value,
  close: () => dialog.value?.handleClose()
});
onBeforeUnmount(() => history.dispose());

function show() {
  history.start();
  if (props.variant === 'prompt') input.value?.focus({ preventScroll: true });
  else if (props.variant === 'confirm' && props.options.confirmButtonType === 'danger')
    cancelAction.value?.focus({ preventScroll: true });
  else confirmAction.value?.focus({ preventScroll: true });
}

function settle(action: MarMessageBoxAction) {
  if (!open.value) return;
  open.value = false;
  history.dispose();
  emit('finish', action, value.value);
}

function submit() {
  // A dialog can still receive form submissions while its exit animation runs.
  if (closing.value) return;
  if (props.variant === 'prompt') {
    const { inputPattern, inputValidator, inputErrorMessage } = props.options;
    if (inputPattern) inputPattern.lastIndex = 0;
    const result =
      inputPattern && !inputPattern.test(value.value) ? false : inputValidator?.(value.value);
    if (result === false || typeof result === 'string') {
      error.value =
        (typeof result === 'string' && result) ||
        inputErrorMessage ||
        locales[locale.value].invalidField;
      input.value?.focus({ preventScroll: true });
      return;
    }
  }
  settle('confirm');
}

const MessageBody = () => props.message;
</script>

<template>
  <MarDialog
    v-if="open"
    ref="dialog"
    :model-value="open"
    :title="title"
    :aria-describedby="`${id}-message`"
    :close-on-click-modal="variant !== 'alert'"
    :close-on-press-escape="variant !== 'alert'"
    append-to-body
    align-center
    class="mar-message-box"
    :class="options.customClass"
    width="min(420px, calc(100vw - 32px))"
    @focus="show"
    @close="closing = true"
    @update:model-value="settle('close')"
  >
    <div :id="`${id}-message`" class="mar-message-box__message" :data-tone="options.type">
      <component :is="options.icon" v-if="options.icon" class="mar-message-box__icon" />
      <MarIcon v-else-if="options.type" :name="options.type" class="mar-message-box__icon" />
      <div><MessageBody /></div>
    </div>
    <form v-if="variant === 'prompt'" :id="id" novalidate @submit.prevent="submit">
      <MarInput
        ref="input"
        v-model="value"
        :type="options.inputType ?? 'text'"
        :placeholder="options.inputPlaceholder"
        :aria-label="options.inputPlaceholder || title"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="error ? `${id}-error` : undefined"
        @input="error = ''"
      />
      <p v-if="error" :id="`${id}-error`" class="mar-message-box__error" role="alert">
        {{ error }}
      </p>
    </form>
    <template #footer>
      <MarButton v-if="variant !== 'alert'" ref="cancelAction" @click="settle('cancel')">
        {{ options.cancelButtonText ?? locales[locale].messageBox.cancel }}
      </MarButton>
      <MarButton
        ref="confirmAction"
        :type="options.confirmButtonType ?? 'primary'"
        :native-type="variant === 'prompt' ? 'submit' : 'button'"
        :form="variant === 'prompt' ? id : undefined"
        @click="variant !== 'prompt' && submit()"
      >
        {{ options.confirmButtonText ?? locales[locale].messageBox.confirm }}
      </MarButton>
    </template>
  </MarDialog>
</template>

<style scoped>
.mar-message-box__message {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  overflow-wrap: anywhere;
}
.mar-message-box__message + form {
  margin-block-start: 12px;
}
.mar-message-box__icon {
  flex: none;
  inline-size: 20px;
  block-size: 20px;
  color: var(--mar-ui-text-secondary);
}
[data-tone='warning'] > .mar-message-box__icon {
  color: var(--mar-ui-message-warning-color);
}
[data-tone='error'] > .mar-message-box__icon,
.mar-message-box__error {
  color: var(--mar-ui-message-error-color);
}
[data-tone='success'] > .mar-message-box__icon {
  color: var(--mar-ui-message-success-color);
}
.mar-message-box__error {
  margin-block: 6px 0;
}
</style>
