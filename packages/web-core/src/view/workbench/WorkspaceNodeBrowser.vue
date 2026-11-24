<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarTabs } from '@myagentroam/mar-ui/tabs';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import {
  BROWSER_TAB_LIMIT,
  isBrowserWorkspacePreview,
  type BrowserPageInput
} from '@myagentroam/protocol';
import { BrowserInputScheduler } from '../../service/browser-input-scheduler.js';
import { BrowserTextInput } from '../../service/browser-text-input.js';
import type { AsideWorkspace } from '../../service/workbench-aside-service.js';
import type {
  BrowserDestination,
  WorkbenchBrowserCapability,
  WorkbenchBrowserService
} from '../../service/workbench-browser-service.js';
import { browserAddress, isBrowserLoopback } from '../../service/browser-link-routing.js';
import BrowserDownloadsDialog from './BrowserDownloadsDialog.vue';
import BrowserPerformanceIndicator from './BrowserPerformanceIndicator.vue';
import BrowserTabLabel from './BrowserTabLabel.vue';
import { browserError } from '../../service/browser-presentation.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { translate as t } from '../../service/locale-preference-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

const props = defineProps<{
  scope: AsideWorkspace;
  capability: WorkbenchBrowserCapability;
  browser: WorkbenchBrowserService;
  connected: boolean;
  directDescription?: string | undefined;
  requested?: BrowserDestination | undefined;
  restoreId?: string | undefined;
}>();
const emit = defineEmits<{
  settings: [browserId: string | undefined];
  data: [kind: 'cache' | 'history', browserId: string];
  consumed: [];
  restored: [];
  closed: [scope: AsideWorkspace];
}>();
const canvas = ref<HTMLCanvasElement>();
const tabPrefix = useId();
const keyboard = ref<HTMLTextAreaElement>();
const keyboardFocused = ref(false);
const body = ref<HTMLElement>();
const lifetime = new AbortController();
const draft = ref('');
const edited = ref(false);
const invalid = ref(false);
const answer = ref('');
const downloadsOpen = ref(false);
const { snapshot, status, frame, path, streamSample, error, uploadStatus } = props.browser;
const connection = computed(() => {
  if (path.value === 'ice') return props.directDescription ?? t('workspaceTabs.directAvailable');
  if (path.value === 'relay') return t('browser.relay');
  return status.value === 'connecting' ? t('browser.connecting') : '—';
});
const active = computed(() =>
  snapshot.value?.tabs.find((tab) => tab.id === snapshot.value?.activeId)
);
const blank = computed(() => active.value?.url === 'about:blank');
const dialog = computed(() => snapshot.value?.dialog);
const chooser = computed(() => snapshot.value?.fileChooser);
const fileInputId = useId();
function chooseFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!chooser.value || files.length === 0) return;
  void props.browser.upload(chooser.value.id, files);
}

function cancelFiles(): void {
  if (chooser.value) void props.browser.upload(chooser.value.id);
}
const external = computed(() => {
  const url = active.value?.url;
  return url?.match(/^https?:\/\//iu) && !isBrowserWorkspacePreview(url) ? url : undefined;
});
const tabs = computed(
  () =>
    snapshot.value?.tabs.map((tab) => {
      const label = tab.url === 'about:blank' ? t('browser.blank') : tab.title || tab.url;
      return {
        name: tab.id,
        label,
        closeLabel: t('browser.closeTab', { tab: label })
      };
    }) ?? []
);
const hasCommands = computed(() => !!snapshot.value && status.value !== 'failed');
const reconnectId = computed(() =>
  error.value !== 'BROWSER_SESSION_ENDED' ? props.browser.browserId() : undefined
);
const canRecover = computed(
  () =>
    error.value !== 'BROWSER_H264_DECODER_UNAVAILABLE' && error.value !== 'BROWSER_NOT_AUTHORIZED'
);
const problem = computed(() =>
  error.value && error.value !== 'BROWSER_NAVIGATION_FAILED' ? browserError(error.value) : undefined
);
watch(error, () => {
  if (status.value === 'ready' && !chooser.value && problem.value) feedback(problem.value, 'error');
});
let desired: BrowserDestination | undefined;
let initial = true;

function show(action: Parameters<WorkbenchBrowserService['show']>[3]): void {
  if (canvas.value && props.connected)
    void props.browser.show(props.scope, props.capability, canvas.value, action);
}

watch(
  [canvas, () => props.connected],
  ([element, connected], [, previous]) => {
    if (!element || !connected) return;
    if (initial) {
      initial = false;
      show(
        props.restoreId
          ? { action: 'resume', browserId: props.restoreId }
          : { action: 'open', preserveLogin: true }
      );
      if (props.restoreId) emit('restored');
    } else if (!previous) {
      const browserId = props.browser.browserId();
      if (browserId) show({ action: 'resume', browserId });
    }
  },
  { flush: 'post' }
);

watch(
  () => props.requested,
  (request) => {
    if (request) desired = request;
  },
  { immediate: true }
);
watch(
  [status, () => props.requested],
  () => {
    if (!desired) return;
    if (status.value === 'ready' && snapshot.value) {
      props.browser.send(
        'url' in desired
          ? { type: 'tab.open', address: desired.url }
          : { type: 'tab.openHtml', path: desired.htmlPath }
      );
      desired = undefined;
      emit('consumed');
    } else if (status.value === 'failed') {
      desired = undefined;
      emit('consumed');
    }
  },
  { flush: 'post' }
);

function showCurrentAddress(): void {
  edited.value = invalid.value = false;
  const url = active.value?.url;
  draft.value = !url || url === 'about:blank' ? '' : url;
}
watch(active, (tab, previous) => {
  if (tab?.id !== previous?.id || !edited.value) showCurrentAddress();
});
watch(dialog, (next, previous) => {
  if (next?.id !== previous?.id) answer.value = next?.defaultValue ?? '';
});
let unregisterInputEscape: (() => void) | undefined;
onMounted(() => {
  // Exit focused page input before the enclosing mobile surface handles Escape.
  unregisterInputEscape = consoleKeyboardShortcutService.register({
    command: 'browser.exitPageInput',
    scope: 'workspace',
    priority: 30,
    owner: () => keyboard.value,
    keys: [{ key: 'Escape' }],
    when: () => keyboardFocused.value && !textInput.active,
    execute: () => {
      keyboard.value?.blur();
      return 'HANDLED';
    }
  });
});
onBeforeUnmount(() => {
  lifetime.abort();
  unregisterInputEscape?.();
  releaseControls();
  props.browser.hide();
});

function edit(value: string): void {
  draft.value = value;
  edited.value = true;
  invalid.value = false;
}
function navigate(): void {
  if (!snapshot.value || !hasCommands.value) return;
  const address = browserAddress(draft.value);
  if (!address) {
    invalid.value = true;
    feedback(t('browser.invalid'), 'warning');
    return;
  }
  navigateTo(address);
}
function navigateTo(address: string): void {
  if (!snapshot.value) return;
  if (props.browser.send({ type: 'navigate', viewVersion: snapshot.value.viewVersion, address }))
    showCurrentAddress();
}
function travel(action: 'back' | 'forward' | 'reload' | 'stop'): void {
  if (!snapshot.value) return;
  showCurrentAddress();
  props.browser.send({ type: 'navigation', viewVersion: snapshot.value.viewVersion, action });
}
function command(value: string | number | object): void {
  const id = props.browser.browserId();
  if (value === 'settings') return emit('settings', id);
  if (!id) return;
  if (value === 'downloads') downloadsOpen.value = true;
  if (value === 'cache' || value === 'history') emit('data', value, id);
  if (value === 'close') {
    const scope = props.scope;
    void props.browser.closeBrowser().then((closed) => {
      if (closed && !lifetime.signal.aborted) emit('closed', scope);
    });
  }
}
function recover(): void {
  if (reconnectId.value) show({ action: 'resume', browserId: reconnectId.value });
  else show({ action: 'open', preserveLogin: true });
}
function respond(accept: boolean): void {
  if (!dialog.value) return;
  props.browser.send({
    type: 'dialog.respond',
    id: dialog.value.id,
    accept,
    ...(accept && dialog.value.type === 'prompt' ? { text: answer.value } : {})
  });
}

function paintedPage() {
  if (!frame.value || !canvas.value) return;
  const element = canvas.value;
  const box = element.getBoundingClientRect();
  const scale = Math.min(box.width / element.width, box.height / element.height);
  if (scale <= 0) return;
  // Match the canvas's object-fit: contain, then convert to remote CSS pixels.
  const width = element.width * scale;
  const height = element.height * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    scaleX: width / frame.value.width,
    scaleY: height / frame.value.height
  };
}

function point(event: Pick<PointerEvent, 'clientX' | 'clientY'>, captured = false) {
  const painted = paintedPage();
  if (!painted || !frame.value || !canvas.value) return;
  const { width, height, viewVersion } = frame.value;
  const x = (event.clientX - painted.left) / painted.scaleX;
  const y = (event.clientY - painted.top) / painted.scaleY;
  if (!captured && (x < 0 || x >= width || y < 0 || y >= height)) return;
  return {
    viewVersion,
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y))
  };
}
const inputScheduler = new BrowserInputScheduler((action) =>
  props.browser.send({ type: 'input', action })
);
const input = (action: BrowserPageInput) => inputScheduler.send(action);
const textInput = new BrowserTextInput(insertText);
type ButtonPress = Omit<Extract<BrowserPageInput, { type: 'button' }>, 'type' | 'edge'>;
const pressedPointers = new Map<number, ButtonPress>();
let nativeTouch: { id: number; position: NonNullable<ReturnType<typeof point>> } | undefined;
let touch:
  | {
      id: number;
      position: NonNullable<ReturnType<typeof point>>;
      clientX: number;
      clientY: number;
      scrolling: boolean;
    }
  | undefined;

function touchPointer(event: PointerEvent, edge: 'up' | 'down' | 'move'): void {
  if (props.capability.nativeTouch) {
    // Touch pointers can already have implicit capture on pointerdown, even outside the picture.
    const position = point(event, nativeTouch?.id === event.pointerId);
    if (edge === 'down') {
      if (!position || nativeTouch || !event.isPrimary) return;
      event.preventDefault();
      if (input({ type: 'touch', phase: 'start', ...position })) {
        nativeTouch = { id: event.pointerId, position };
        canvas.value?.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (nativeTouch?.id !== event.pointerId) return;
    if (
      position?.viewVersion === nativeTouch.position.viewVersion &&
      (position.x !== nativeTouch.position.x || position.y !== nativeTouch.position.y)
    ) {
      input({ type: 'touch', phase: 'move', ...position });
      nativeTouch.position = position;
    }
    if (edge === 'up') {
      input({ type: 'touch', phase: 'end', ...nativeTouch.position });
      nativeTouch = undefined;
    }
    return;
  }
  if (edge === 'down') {
    const position = point(event);
    if (!position || touch || !event.isPrimary) return;
    event.preventDefault();
    touch = {
      id: event.pointerId,
      position,
      clientX: event.clientX,
      clientY: event.clientY,
      scrolling: false
    };
    canvas.value?.setPointerCapture(event.pointerId);
    return;
  }
  const gesture = touch;
  if (!gesture || gesture.id !== event.pointerId) return;
  if (edge === 'up') touch = undefined;
  const { viewVersion } = gesture.position;
  if (frame.value?.viewVersion !== viewVersion || !canvas.value) return;
  const dx = gesture.clientX - event.clientX;
  const dy = gesture.clientY - event.clientY;
  const moved = Math.hypot(dx, dy) >= 8;
  if (edge === 'up' && !gesture.scrolling && !moved) {
    const press = { type: 'button', button: 'left', ...gesture.position } as const;
    if (input({ ...press, edge: 'down' })) input({ ...press, edge: 'up' });
    return;
  }
  if (!gesture.scrolling && !moved) return;
  gesture.scrolling = true;
  gesture.clientX = event.clientX;
  gesture.clientY = event.clientY;
  const painted = paintedPage();
  if (painted && (dx || dy))
    inputScheduler.wheel(gesture.position, dx / painted.scaleX, dy / painted.scaleY);
  if (edge === 'up') inputScheduler.finish(viewVersion);
}

function cancelPointer(id: number): void {
  if (nativeTouch?.id === id) {
    input({ type: 'touch', phase: 'cancel', ...nativeTouch.position });
    nativeTouch = undefined;
  }
  if (touch?.id === id) touch = undefined;
  releasePointer(id);
}
function releasePointer(id: number, position?: ReturnType<typeof point>): void {
  const pressed = pressedPointers.get(id);
  if (!pressed) return;
  pressedPointers.delete(id);
  input({
    ...pressed,
    ...(position?.viewVersion === pressed.viewVersion ? position : {}),
    type: 'button',
    edge: 'up'
  });
}
function pointer(event: PointerEvent, edge: 'up' | 'down' | 'move'): void {
  if (event.pointerType === 'touch') return touchPointer(event, edge);
  const position = point(event, pressedPointers.has(event.pointerId));
  if (edge === 'up') {
    releasePointer(event.pointerId, position);
    return;
  }
  if (!position) return;
  if (edge === 'move') {
    const pressed = pressedPointers.get(event.pointerId);
    if (pressed?.viewVersion === position.viewVersion)
      pressedPointers.set(event.pointerId, { ...pressed, ...position });
    input({ type: 'move', ...position });
    return;
  }
  const button = (['left', 'middle', 'right'] as const)[event.button];
  if (!button || pressedPointers.has(event.pointerId)) return;
  // The canvas's default pointer focus would blur the text sink and release the drag.
  event.preventDefault();
  keyboard.value?.focus({ preventScroll: true });
  if (input({ type: 'button', edge, button, ...position })) {
    pressedPointers.set(event.pointerId, { button, ...position });
    canvas.value?.setPointerCapture(event.pointerId);
  }
}
function wheel(event: WheelEvent): void {
  const target = point(event);
  if (!target || !frame.value) return;
  const mode = event.deltaMode;
  const size = frame.value;
  inputScheduler.wheel(
    target,
    event.deltaX * (mode === 1 ? 16 : mode === 2 ? size.width : 1),
    event.deltaY * (mode === 1 ? 16 : mode === 2 ? size.height : 1)
  );
}
// Pair releases by physical key: modifiers can change the reported key before keyup.
const pressedKeys = new Map<string, string>();
function feedback(message: string, type: 'info' | 'warning' | 'error'): void {
  if (body.value)
    showMessage(message, type, undefined, { owner: body.value, signal: lifetime.signal });
}

async function copy(): Promise<void> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
      throw new Error('Clipboard unavailable');
    const viewVersion = frame.value?.viewVersion;
    // Read the selection after any final drag sample, not one animation frame behind it.
    if (viewVersion !== undefined) inputScheduler.finish(viewVersion);
    await navigator.clipboard.write([
      new ClipboardItem({
        // Start within the user gesture. Only the remote bytes arrive asynchronously.
        'text/plain': props.browser.copySelection().then((value) => {
          if (!value) throw new Error('No selection');
          return new Blob([value], { type: 'text/plain' });
        })
      })
    ]);
    feedback(t('browser.copied'), 'info');
  } catch {
    feedback(t('browser.copyFailed'), 'error');
  }
}

function key(event: KeyboardEvent, edge: 'up' | 'down'): void {
  const viewVersion = frame.value?.viewVersion;
  if (viewVersion === undefined) return;
  const identity = event.code || event.key;
  const pressedKey = pressedKeys.get(identity);
  if (edge === 'up') {
    if (pressedKey === undefined) return;
    event.preventDefault();
    pressedKeys.delete(identity);
    input({ type: 'key', edge, viewVersion, key: pressedKey });
    return;
  }
  if (
    textInput.active ||
    event.isComposing ||
    (event.key === 'Enter' && event.keyCode === 229) ||
    event.key === 'Process' ||
    event.key === 'Unidentified'
  )
    return;
  if (pressedKey !== undefined) {
    event.preventDefault();
    input({ type: 'key', edge, viewVersion, key: pressedKey });
    return;
  }
  if (event.key === 'Escape' || event.key === 'Tab') return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (event.key.toLowerCase() === 'v') return;
    if (event.key.toLowerCase() === 'c') {
      event.preventDefault();
      if (!event.repeat) void copy();
      return;
    }
  }
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
  event.preventDefault();
  if (input({ type: 'key', edge, viewVersion, key: event.key }))
    pressedKeys.set(identity, event.key);
}
function releaseKeys(): void {
  const viewVersion = frame.value?.viewVersion;
  if (viewVersion !== undefined)
    for (const key of pressedKeys.values()) input({ type: 'key', edge: 'up', viewVersion, key });
  pressedKeys.clear();
}
function releaseControls(): void {
  if (nativeTouch) cancelPointer(nativeTouch.id);
  touch = undefined;
  for (const id of pressedPointers.keys()) releasePointer(id);
  releaseKeys();
  resetTransientInput();
}
watch(
  () => snapshot.value?.viewVersion,
  () => {
    // Node releases held input when the active view changes; never send old input to its replacement.
    pressedPointers.clear();
    touch = undefined;
    nativeTouch = undefined;
    pressedKeys.clear();
  }
);
function resetTransientInput(): void {
  inputScheduler.reset();
  textInput.reset();
  if (keyboard.value) keyboard.value.value = '';
}
watch(
  [() => snapshot.value?.viewVersion, () => frame.value?.viewVersion, status],
  () => {
    if (status.value !== 'ready') return resetTransientInput();
    inputScheduler.reset();
    textInput.invalidate();
  },
  { flush: 'sync' }
);

function text(event: InputEvent): void {
  const target = event.target as HTMLTextAreaElement;
  if (textInput.read(event, target.value, frame.value?.viewVersion)) target.value = '';
}
function endComposition(event: CompositionEvent): void {
  textInput.end(event.data, frame.value?.viewVersion);
  const target = event.target as HTMLTextAreaElement;
  target.value = '';
}
function softKey(event: InputEvent): void {
  if (event.isComposing || textInput.active) return;
  const viewVersion = frame.value?.viewVersion;
  const key =
    event.inputType === 'deleteContentBackward'
      ? 'Backspace'
      : event.inputType === 'deleteContentForward'
        ? 'Delete'
        : event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph'
          ? 'Enter'
          : undefined;
  if (viewVersion === undefined || key === undefined || !event.cancelable) return;
  event.preventDefault();
  if (input({ type: 'key', edge: 'down', viewVersion, key }))
    input({ type: 'key', edge: 'up', viewVersion, key });
}
function insertText(value: string, viewVersion = frame.value?.viewVersion): void {
  if (viewVersion === undefined) return;
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 4096, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
    if (!input({ type: 'text', viewVersion, text: value.slice(start, end) })) return;
    start = end;
  }
}
</script>

<template>
  <section class="node-browser" :aria-label="t('browser.title')">
    <div class="node-browser-tabs" v-if="snapshot">
      <MarTabs
        mode="strip"
        appearance="workbench"
        item-class="browser-web-tab"
        tab-class="browser-web-tab-trigger"
        close-class="browser-web-tab-close"
        :id-prefix="tabPrefix"
        :tabs="tabs"
        :label="t('browser.title')"
        :model-value="snapshot.activeId"
        @tab-activate="(id) => browser.send({ type: 'tab.select', tabId: String(id) })"
        @tab-close="(id) => browser.send({ type: 'tab.close', tabId: String(id) })"
      >
        <template #label="{ tab }">
          <BrowserTabLabel
            :label="tab.label"
            :loading="snapshot.tabs.find(({ id }) => id === tab.name)?.loading ?? false"
            :icon="browser.tabIcons.value.get(String(tab.name))?.png"
          />
        </template>
        <template #action>
          <MarButton
            text
            circle
            icon="plus"
            :aria-label="t('browser.tab')"
            v-tooltip="t('browser.tab')"
            :disabled="!hasCommands || tabs.length >= BROWSER_TAB_LIMIT"
            @click="browser.send({ type: 'tab.open' })"
          />
        </template>
      </MarTabs>
    </div>
    <form class="node-browser-toolbar" @submit.prevent="navigate">
      <div class="node-browser-nav" role="group" :aria-label="t('browser.navigationControls')">
        <MarButton
          class="node-browser-icon"
          icon="chevron-left"
          :aria-label="t('browser.back')"
          v-tooltip="t('browser.back')"
          :disabled="!hasCommands || !active?.canGoBack"
          @click="travel('back')"
        />
        <MarButton
          class="node-browser-icon"
          icon="chevron-right"
          :aria-label="t('browser.forward')"
          v-tooltip="t('browser.forward')"
          :disabled="!hasCommands || !active?.canGoForward"
          @click="travel('forward')"
        />
        <MarButton
          class="node-browser-icon"
          :icon="active?.loading ? 'close' : 'refresh'"
          :aria-label="t(active?.loading ? 'browser.stop' : 'browser.reload')"
          v-tooltip="t(active?.loading ? 'browser.stop' : 'browser.reload')"
          :disabled="!hasCommands || !active"
          @click="travel(active?.loading ? 'stop' : 'reload')"
        />
      </div>
      <MarInput
        class="node-browser-address"
        :model-value="draft"
        :aria-label="t('browser.address')"
        :placeholder="t('browser.address')"
        :aria-invalid="invalid || undefined"
        :aria-describedby="invalid ? `${tabPrefix}-address-error` : undefined"
        :disabled="!hasCommands || !active"
        @update:model-value="(value) => edit(String(value))"
      >
        <template v-if="active?.loading" #prefix>
          <span role="status" :aria-label="t('browser.loadingPage')">
            <MarBusyIndicator />
          </span>
        </template>
      </MarInput>
      <MarButton
        tag="a"
        class="node-browser-icon"
        icon="external-link"
        :href="external ?? ''"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="
          t(external && isBrowserLoopback(external) ? 'browser.externalLocal' : 'browser.external')
        "
        v-tooltip="
          t(external && isBrowserLoopback(external) ? 'browser.externalLocal' : 'browser.external')
        "
        :disabled="!hasCommands || !external"
      />
      <MarDropdown trigger="click" placement="bottom-end" @command="command">
        <MarButton
          class="node-browser-icon"
          icon="more"
          :aria-label="t('browser.menu')"
          v-tooltip="t('browser.menu')"
        />
        <template #dropdown>
          <MarDropdownMenu :aria-label="t('browser.menu')">
            <MarDropdownItem command="downloads" icon="download" :disabled="status !== 'ready'">{{
              t('browser.downloads')
            }}</MarDropdownItem>
            <MarDropdownItem command="history" icon="clock" :disabled="!browser.browserId()">{{
              t('browser.history')
            }}</MarDropdownItem>
            <MarDropdownItem command="cache" icon="clear" :disabled="!browser.browserId()">{{
              t('browser.cache')
            }}</MarDropdownItem>
            <MarDropdownItem command="settings" icon="settings" divided>{{
              t('browser.settings')
            }}</MarDropdownItem>
            <MarDropdownItem command="close" icon="power" :disabled="!browser.browserId()">{{
              t('browser.close')
            }}</MarDropdownItem>
          </MarDropdownMenu>
        </template>
      </MarDropdown>
    </form>
    <span v-if="invalid" :id="`${tabPrefix}-address-error`" hidden>{{ t('browser.invalid') }}</span>
    <div ref="body" class="node-browser-body">
      <canvas
        ref="canvas"
        v-show="status === 'ready'"
        :class="{ 'node-browser-blank-canvas': blank }"
        :aria-hidden="blank || undefined"
        :aria-label="t('browser.viewport')"
        @pointerdown="pointer($event, 'down')"
        @pointerup="pointer($event, 'up')"
        @pointermove="pointer($event, 'move')"
        @pointercancel="cancelPointer($event.pointerId)"
        @lostpointercapture="cancelPointer($event.pointerId)"
        @wheel.prevent="wheel"
        @contextmenu.prevent
      />
      <textarea
        v-if="status === 'ready' && !blank"
        ref="keyboard"
        data-node-browser-input
        class="node-browser-input"
        :aria-label="t('browser.viewport')"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        @keydown="key($event, 'down')"
        @keyup="key($event, 'up')"
        @focus="keyboardFocused = true"
        @blur="
          keyboardFocused = false;
          releaseControls();
        "
        @compositionstart="textInput.start(frame?.viewVersion)"
        @compositionend="endComposition"
        @beforeinput="softKey"
        @input="text"
        @paste.prevent="insertText($event.clipboardData?.getData('text/plain') ?? '')"
      />
      <div
        v-if="status === 'connecting' || (status === 'idle' && connected)"
        class="node-browser-loading"
        role="status"
      >
        <MarBusyIndicator />{{ t('browser.connecting') }}
      </div>
      <div v-else-if="status === 'failed'" class="node-browser-placeholder">
        <div class="node-browser-error" role="alert">
          <MarIcon name="connection" :size="32" aria-hidden="true" />
          <h2>{{ t('browser.browserUnavailable') }}</h2>
          <p>{{ error ? browserError(error) : t('browser.failed') }}</p>
        </div>
        <MarButton
          v-if="canRecover"
          type="primary"
          icon="retry"
          :disabled="!connected"
          @click="recover"
          >{{ t('browser.retry') }}</MarButton
        >
      </div>
      <div v-else-if="status === 'idle'" class="node-browser-placeholder">
        <p role="status">{{ t('browser.disconnected') }}</p>
      </div>
      <form v-else-if="blank" class="node-browser-blank" @submit.prevent="navigate">
        <MarInput
          :model-value="draft"
          prefix-icon="web"
          :aria-label="t('browser.blankAddress')"
          :placeholder="t('browser.blankAddress')"
          :aria-invalid="invalid || undefined"
          :aria-describedby="invalid ? `${tabPrefix}-address-error` : undefined"
          @update:model-value="(value) => edit(String(value))"
        />
      </form>
      <div
        v-if="status === 'ready'"
        class="node-browser-actions"
        role="group"
        :aria-label="t('browser.pageActions')"
      >
        <MarButton
          v-if="!blank"
          class="node-browser-keyboard"
          circle
          icon="keyboard"
          :aria-label="t(keyboardFocused ? 'browser.hideKeyboard' : 'browser.showKeyboard')"
          v-tooltip="t(keyboardFocused ? 'browser.hideKeyboard' : 'browser.showKeyboard')"
          @pointerdown.prevent
          @click="keyboardFocused ? keyboard?.blur() : keyboard?.focus({ preventScroll: true })"
        />
        <MarButton
          v-if="!blank"
          circle
          icon="copy"
          :aria-label="t('browser.copySelection')"
          v-tooltip="t('browser.copySelection')"
          @click="copy"
        />
        <BrowserPerformanceIndicator
          :connection="connection"
          :frame="frame"
          :sample="streamSample"
        />
      </div>
    </div>
    <BrowserDownloadsDialog
      v-if="downloadsOpen"
      :browser="browser"
      @close="downloadsOpen = false"
    />
    <MarDialog
      v-if="chooser"
      :key="chooser.id"
      :model-value="true"
      :title="t('browser.uploadTitle')"
      @update:model-value="(open) => !open && cancelFiles()"
    >
      <label :for="fileInputId">{{ t('browser.uploadChoose') }}</label>
      <input
        :id="fileInputId"
        type="file"
        :multiple="chooser.multiple"
        :disabled="uploadStatus !== undefined"
        @change="chooseFiles"
      />
      <p v-if="uploadStatus" role="status">
        {{ t(uploadStatus === 'canceling' ? 'browser.cancelingUpload' : 'browser.uploading') }}
      </p>
      <p v-else-if="problem" role="alert">{{ problem }}</p>
      <template #footer>
        <MarButton
          :disabled="uploadStatus === 'finishing' || uploadStatus === 'canceling'"
          @click="cancelFiles"
          >{{ t('browser.cancel') }}</MarButton
        >
      </template>
    </MarDialog>
    <MarDialog
      v-if="dialog"
      :model-value="true"
      :title="t('browser.dialog')"
      @update:model-value="(open) => !open && respond(false)"
    >
      <p>{{ dialog.message }}</p>
      <MarInput
        v-if="dialog.type === 'prompt'"
        v-model="answer"
        :aria-label="t('browser.dialog')"
      />
      <template #footer>
        <MarButton v-if="dialog.type !== 'alert'" @click="respond(false)">{{
          t('browser.cancel')
        }}</MarButton>
        <MarButton type="primary" @click="respond(true)">{{ t('browser.accept') }}</MarButton>
      </template>
    </MarDialog>
  </section>
</template>

<style scoped>
.node-browser {
  --browser-tab-surface: color-mix(in srgb, var(--mar-ui-bg-panel) 75%, var(--mar-ui-fill-row-hover));
  display: flex;
  flex-direction: column;
  block-size: 100%;
  min-block-size: 0;
}
.node-browser-tabs,
.node-browser-toolbar,
.node-browser-nav {
  display: flex;
  align-items: center;
  min-inline-size: 0;
}
.node-browser-tabs > :first-child,
.node-browser-address {
  flex: 1;
  min-inline-size: 0;
}
.node-browser-tabs {
  --browser-tab-corner: 8px;
  container-type: inline-size;
  background: var(--mar-ui-bg-subtle);
  border-block-end: 1px solid var(--mar-ui-border-default);
}
.node-browser-tabs :deep(.mar-tab-strip) {
  padding-inline: var(--browser-tab-corner);
}
.node-browser-tabs :deep(.browser-web-tab) {
  position: relative;
  inline-size: clamp(7rem, 36cqi, 13rem);
  margin-inline-start: 0;
  border: 0;
  border-radius: 10px 10px 0 0;
  background: transparent;
}
.node-browser-tabs :deep(.browser-web-tab-trigger) {
  justify-content: start;
}
.node-browser-tabs :deep(.browser-web-tab-close) {
  border-radius: 50%;
}
.node-browser-tabs :deep(.browser-web-tab-close:hover:enabled) {
  background: var(--mar-ui-action-hover-overlay);
}
.node-browser-tabs :deep(.browser-web-tab:not(.is-active) + .browser-web-tab:not(.is-active)::before) {
  content: '';
  position: absolute;
  inset: 25% auto 25% 0;
  border-inline-start: 1px solid var(--mar-ui-border-default);
  pointer-events: none;
}
.node-browser-tabs :deep(.browser-web-tab.is-active) {
  z-index: 1;
  background: var(--browser-tab-surface);
}
.node-browser-tabs :deep(.browser-web-tab.is-active::before),
.node-browser-tabs :deep(.browser-web-tab.is-active::after) {
  content: '';
  position: absolute;
  inset-block-end: 0;
  inline-size: var(--browser-tab-corner);
  block-size: var(--browser-tab-corner);
  pointer-events: none;
}
.node-browser-tabs :deep(.browser-web-tab.is-active::before) {
  right: 100%;
  background: radial-gradient(circle at 0 0, transparent 68%, var(--browser-tab-surface) 72%);
}
.node-browser-tabs :deep(.browser-web-tab.is-active::after) {
  left: 100%;
  background: radial-gradient(circle at 100% 0, transparent 68%, var(--browser-tab-surface) 72%);
}
@media (forced-colors: active) {
  .node-browser-tabs :deep(.browser-web-tab.is-active) {
    outline: 1px solid Highlight;
    outline-offset: -1px;
  }
}
.node-browser-toolbar {
  background: var(--browser-tab-surface);
  gap: 0.25rem;
  padding: 0.25rem;
  border-block-end: 1px solid var(--mar-ui-border);
}
.node-browser-icon {
  padding-inline: 0;
  inline-size: var(--mar-ui-compact-control-size, 24px);
  flex: none;
}
.node-browser-nav > :not(:first-child) {
  margin-inline-start: -1px;
  border-start-start-radius: 0;
  border-end-start-radius: 0;
}
.node-browser-nav > :not(:last-child) {
  border-start-end-radius: 0;
  border-end-end-radius: 0;
}
.node-browser-nav > :is(:hover, :focus-visible) {
  z-index: 1;
}
.node-browser-nav {
  isolation: isolate;
  flex: none;
}
.node-browser-nav > :focus-visible {
  position: relative;
}
.node-browser-body {
  position: relative;
  flex: 1;
  min-block-size: 0;
  display: grid;
  place-items: center;
  background: var(--mar-ui-bg-panel);
}
.node-browser-body canvas {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  min-block-size: 0;
  object-fit: contain;
  touch-action: none;
}
.node-browser-blank-canvas {
  visibility: hidden;
}
.node-browser-blank {
  inline-size: min(28rem, calc(100% - 2rem));
}
.node-browser-blank :deep(.mar-ui-field-frame) {
  min-block-size: 2.75rem;
  border-radius: 999px;
  padding-inline: 0.875rem;
}
.node-browser-keyboard {
  display: none;
}
@media (any-pointer: coarse) {
  .node-browser-keyboard {
    display: inline-flex;
  }
}
.node-browser-input {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  opacity: 0;
}
.node-browser-body:focus-within {
  outline: 1px solid var(--mar-ui-primary);
  outline-offset: -1px;
}
.node-browser-placeholder {
  display: grid;
  justify-items: start;
  padding: 1rem;
  gap: 0.75rem;
  max-inline-size: 26rem;
}
.node-browser-loading {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--mar-ui-text-secondary);
}
.node-browser-error {
  display: grid;
  gap: 0.5rem;
  min-inline-size: 0;
}
.node-browser-error > svg {
  color: var(--mar-ui-text-secondary);
}
.node-browser-error h2 {
  margin: 0;
  font-size: 1.25rem;
}
.node-browser-error p {
  margin: 0;
  color: var(--mar-ui-text-secondary);
  overflow-wrap: anywhere;
}
.node-browser-actions {
  position: absolute;
  inset-inline-end: max(0.5rem, env(safe-area-inset-right));
  inset-block-end: max(0.5rem, env(safe-area-inset-bottom));
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--mar-ui-border);
  border-radius: var(--mar-radius-surface);
  background: color-mix(in srgb, var(--mar-ui-bg-panel) 96%, transparent);
  box-shadow: var(--mar-ui-overlay-shadow);
}
@media (any-pointer: coarse) {
  .node-browser-actions :deep(.mar-ui-button) {
    inline-size: 36px;
    block-size: 36px;
  }
}
</style>
