<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarCheckbox } from '@myagentroam/mar-ui/checkbox';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarTabs } from '@myagentroam/mar-ui/tabs';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import {
  BROWSER_TAB_LIMIT,
  isBrowserWorkspacePreview,
  type BrowserCapability,
  type BrowserPageInput
} from '@myagentroam/protocol';
import type { AsideWorkspace } from '../../service/workbench-aside-service.js';
import type {
  BrowserDestination,
  WorkbenchBrowserService
} from '../../service/workbench-browser-service.js';
import { browserAddress, isBrowserLoopback } from '../../service/browser-link-routing.js';
import BrowserDownloadsDialog from './BrowserDownloadsDialog.vue';
import { browserError } from '../../service/browser-presentation.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { translate as t } from '../../service/locale-preference-service.js';

const props = defineProps<{
  scope: AsideWorkspace;
  capability: BrowserCapability;
  browser: WorkbenchBrowserService;
  connected: boolean;
  requested?: BrowserDestination | undefined;
  restoreId?: string | undefined;
}>();
const emit = defineEmits<{
  settings: [browserId: string | undefined];
  data: [kind: 'cache' | 'history', browserId: string];
  consumed: [];
  restored: [];
}>();
const canvas = ref<HTMLCanvasElement>();
const tabPrefix = useId();
const keyboard = ref<HTMLTextAreaElement>();
const keyboardFocused = ref(false);
const draft = ref('');
const edited = ref(false);
const invalid = ref(false);
const preserve = ref(false);
const answer = ref('');
const clipboardStatus = ref<'copied' | 'copyFailed'>();
const downloadsOpen = ref(false);
const { snapshot, status, frame, path, error, uploadStatus } = props.browser;
const active = computed(() =>
  snapshot.value?.tabs.find((tab) => tab.id === snapshot.value?.activeId)
);
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
      const label = tab.title || (tab.url === 'about:blank' ? '' : tab.url) || t('browser.blank');
      return { name: tab.id, label, closeLabel: t('browser.closeTab', { tab: label }) };
    }) ?? []
);
const hasCommands = computed(() => !!snapshot.value && status.value !== 'failed');
const pageUnavailable = computed(
  () => status.value === 'ready' && error.value === 'BROWSER_NAVIGATION_FAILED'
);
const stateTitle = computed(() =>
  pageUnavailable.value ? t('browser.pageUnavailable') : t('browser.browserUnavailable')
);
const reconnectId = computed(() =>
  error.value !== 'BROWSER_SESSION_ENDED' ? props.browser.browserId() : undefined
);
const canRecover = computed(
  () =>
    error.value !== 'BROWSER_H264_DECODER_UNAVAILABLE' && error.value !== 'BROWSER_NOT_AUTHORIZED'
);
const problem = computed(() =>
  invalid.value ? t('browser.invalid') : error.value ? browserError(error.value) : undefined
);
let desired: BrowserDestination | undefined;
const submitted = ref<{ target: string; previous: string | undefined; tab: string | undefined }>();
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
        props.restoreId ? { action: 'resume', browserId: props.restoreId } : { action: 'lookup' }
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
    if (status.value === 'idle' && !initial && props.connected) {
      show({ action: 'open', preserveLogin: preserve.value });
    } else if (status.value === 'ready' && snapshot.value) {
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

watch(active, (tab, previous) => {
  if (tab?.id !== previous?.id) {
    edited.value = invalid.value = false;
    submitted.value = undefined;
  }
  if (
    submitted.value &&
    tab &&
    !tab.loading &&
    tab.id === submitted.value.tab &&
    !error.value &&
    (tab.url === submitted.value.target || tab.url !== submitted.value.previous)
  ) {
    edited.value = false;
    submitted.value = undefined;
  }
  if (!edited.value) draft.value = !tab || tab.url === 'about:blank' ? '' : tab.url;
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
    when: () => keyboardFocused.value,
    execute: () => {
      keyboard.value?.blur();
      return 'HANDLED';
    }
  });
});
onBeforeUnmount(() => {
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
    return;
  }
  navigateTo(address);
}
function navigateTo(address: string): void {
  if (!snapshot.value) return;
  if (props.browser.send({ type: 'navigate', viewVersion: snapshot.value.viewVersion, address })) {
    draft.value = address;
    edited.value = true;
    invalid.value = false;
    submitted.value = { target: address, previous: active.value?.url, tab: active.value?.id };
  }
}
function travel(action: 'back' | 'forward' | 'reload' | 'stop'): void {
  if (!snapshot.value) return;
  if (action === 'reload' && pageUnavailable.value && submitted.value)
    return navigateTo(submitted.value.target);
  edited.value = invalid.value = false;
  submitted.value = undefined;
  props.browser.send({ type: 'navigation', viewVersion: snapshot.value.viewVersion, action });
}
function command(value: string | number | object): void {
  if (value === 'copy') void copy();
  const id = props.browser.browserId();
  if (value === 'settings') return emit('settings', id);
  if (!id) return;
  if (value === 'downloads') downloadsOpen.value = true;
  if (value === 'cache' || value === 'history') emit('data', value, id);
  if (value === 'close') void props.browser.closeBrowser();
}
function recover(): void {
  if (pageUnavailable.value) travel('reload');
  else if (reconnectId.value) show({ action: 'resume', browserId: reconnectId.value });
  else show({ action: 'open', preserveLogin: preserve.value });
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

function point(event: PointerEvent) {
  if (!frame.value || !canvas.value) return;
  const box = canvas.value.getBoundingClientRect();
  const { width, height, viewVersion } = frame.value;
  const scale = Math.min(box.width / width, box.height / height);
  if (scale <= 0) return;
  const x = (event.clientX - box.left - (box.width - width * scale) / 2) / scale;
  const y = (event.clientY - box.top - (box.height - height * scale) / 2) / scale;
  if (
    (x < 0 || x >= width || y < 0 || y >= height) &&
    !canvas.value.hasPointerCapture(event.pointerId)
  )
    return;
  return {
    viewVersion,
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y))
  };
}
const input = (action: BrowserPageInput) => props.browser.send({ type: 'input', action });
type ButtonPress = Omit<Extract<BrowserPageInput, { type: 'button' }>, 'type' | 'edge'>;
const pressedPointers = new Map<number, ButtonPress>();
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
  if (!gesture.scrolling) input({ type: 'move', ...gesture.position });
  gesture.scrolling = true;
  gesture.clientX = event.clientX;
  gesture.clientY = event.clientY;
  const box = canvas.value.getBoundingClientRect();
  const scale = Math.min(box.width / frame.value.width, box.height / frame.value.height);
  if (scale > 0 && (dx || dy)) input({ type: 'wheel', viewVersion, x: dx / scale, y: dy / scale });
}

function cancelPointer(id: number): void {
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
  const position = point(event);
  if (edge === 'up') {
    releasePointer(event.pointerId, position);
    return;
  }
  if (!position) return;
  if (edge === 'move') {
    input({ type: 'move', ...position });
    return;
  }
  const button = (['left', 'middle', 'right'] as const)[event.button];
  if (!button || pressedPointers.has(event.pointerId)) return;
  keyboard.value?.focus({ preventScroll: true });
  if (input({ type: 'button', edge, button, ...position })) {
    pressedPointers.set(event.pointerId, { button, ...position });
    canvas.value?.setPointerCapture(event.pointerId);
  }
}
function wheel(event: WheelEvent): void {
  if (!frame.value) return;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.value.height : 1;
  input({
    type: 'wheel',
    viewVersion: frame.value.viewVersion,
    x: event.deltaX * unit,
    y: event.deltaY * unit
  });
}
const keys = new Set<string>();
async function copy(): Promise<void> {
  clipboardStatus.value = undefined;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
      throw new Error('Clipboard unavailable');
    await navigator.clipboard.write([
      new ClipboardItem({
        // Start within the user gesture. Only the remote bytes arrive asynchronously.
        'text/plain': props.browser.copySelection().then((value) => {
          if (!value) throw new Error('No selection');
          return new Blob([value], { type: 'text/plain' });
        })
      })
    ]);
    clipboardStatus.value = 'copied';
  } catch {
    clipboardStatus.value = 'copyFailed';
  }
}

function key(event: KeyboardEvent, edge: 'up' | 'down'): void {
  if (!frame.value || event.isComposing || event.key === 'Process' || event.key === 'Unidentified')
    return;
  if (event.key === 'Escape' || event.key === 'Tab') return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (event.key.toLowerCase() === 'v') return;
    if (event.key.toLowerCase() === 'c') {
      event.preventDefault();
      if (edge === 'down' && !event.repeat) void copy();
      return;
    }
  }
  if (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !keys.has(event.key)
  )
    return;
  event.preventDefault();
  if (edge === 'down') keys.add(event.key);
  else keys.delete(event.key);
  input({ type: 'key', edge, viewVersion: frame.value.viewVersion, key: event.key });
}
function releaseKeys(): void {
  const viewVersion = frame.value?.viewVersion;
  if (viewVersion !== undefined)
    for (const key of keys) input({ type: 'key', edge: 'up', viewVersion, key });
  keys.clear();
}
function releaseControls(): void {
  touch = undefined;
  for (const id of pressedPointers.keys()) releasePointer(id);
  releaseKeys();
}
watch(
  () => snapshot.value?.viewVersion,
  () => {
    // Node releases held input when the active view changes; never send old input to its replacement.
    pressedPointers.clear();
    touch = undefined;
    keys.clear();
  }
);
function text(event: Event): void {
  if ((event as InputEvent).isComposing) return;
  const target = event.target as HTMLTextAreaElement;
  insertText(target.value);
  target.value = '';
}
function insertText(value: string): void {
  const viewVersion = frame.value?.viewVersion;
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
        :id-prefix="tabPrefix"
        :tabs="tabs"
        :label="t('browser.title')"
        :model-value="snapshot.activeId"
        @tab-activate="(id) => browser.send({ type: 'tab.select', tabId: String(id) })"
        @tab-close="(id) => browser.send({ type: 'tab.close', tabId: String(id) })"
      />
      <MarButton
        class="node-browser-icon"
        icon="plus"
        :aria-label="t('browser.tab')"
        v-tooltip="t('browser.tab')"
        :disabled="!hasCommands || tabs.length >= BROWSER_TAB_LIMIT"
        @click="browser.send({ type: 'tab.open' })"
      />
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
          :icon="active?.loading ? 'stop' : 'refresh'"
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
            <MarDropdownItem
              command="copy"
              icon="copy"
              :disabled="status !== 'ready' || pageUnavailable"
              >{{ t('browser.copySelection') }}</MarDropdownItem
            >
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
      <MarButton
        v-if="status === 'ready' && !pageUnavailable"
        class="node-browser-keyboard"
        @pointerdown.prevent
        @click="keyboardFocused ? keyboard?.blur() : keyboard?.focus({ preventScroll: true })"
        >{{ t(keyboardFocused ? 'browser.hideKeyboard' : 'browser.showKeyboard') }}</MarButton
      >
    </form>
    <p v-if="invalid" :id="`${tabPrefix}-address-error`" class="node-browser-notice" role="alert">
      <MarIcon name="warning" aria-hidden="true" />{{ t('browser.invalid') }}
    </p>
    <p
      v-else-if="problem && status === 'ready' && !pageUnavailable && !chooser"
      class="node-browser-notice"
      role="alert"
    >
      <MarIcon name="warning" aria-hidden="true" />{{ problem }}
    </p>
    <p v-if="clipboardStatus" class="node-browser-text" role="status">
      {{ t(`browser.${clipboardStatus}`) }}
    </p>
    <div class="node-browser-body">
      <canvas
        ref="canvas"
        v-show="status === 'ready' && !pageUnavailable"
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
        v-if="status === 'ready' && !pageUnavailable"
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
        @input="text"
        @paste.prevent="insertText($event.clipboardData?.getData('text/plain') ?? '')"
      />
      <div v-if="status === 'connecting'" class="node-browser-loading" role="status">
        <MarBusyIndicator />{{ t('browser.connecting') }}
      </div>
      <div v-else-if="status === 'failed' || pageUnavailable" class="node-browser-placeholder">
        <div class="node-browser-error" role="alert">
          <MarIcon
            :name="pageUnavailable ? 'document' : 'connection'"
            :size="32"
            aria-hidden="true"
          />
          <h2>{{ stateTitle }}</h2>
          <p v-if="pageUnavailable && submitted" class="node-browser-error-address">
            {{ submitted.target }}
          </p>
          <p>{{ error ? browserError(error) : t('browser.failed') }}</p>
        </div>
        <MarButton
          v-if="canRecover"
          type="primary"
          :icon="pageUnavailable ? 'refresh' : 'retry'"
          :disabled="!connected"
          @click="recover"
          >{{
            t(
              pageUnavailable
                ? 'browser.tryPageAgain'
                : reconnectId
                  ? 'browser.retry'
                  : 'browser.open'
            )
          }}</MarButton
        >
      </div>
      <div v-else-if="status === 'idle'" class="node-browser-placeholder">
        <MarCheckbox v-model="preserve">{{ t('browser.preserve') }}</MarCheckbox>
        <MarButton
          type="primary"
          icon="web"
          :disabled="!connected"
          @click="show({ action: 'open', preserveLogin: preserve })"
          >{{ t('browser.open') }}</MarButton
        >
      </div>
    </div>
    <p v-if="path" class="node-browser-text" role="status">
      {{ t(path === 'ice' ? 'browser.ice' : 'browser.relay') }}
    </p>
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
.node-browser-toolbar {
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
}
.node-browser-body canvas {
  inline-size: 100%;
  block-size: 100%;
  min-block-size: 0;
  object-fit: contain;
  touch-action: none;
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
.node-browser-error .node-browser-error-address {
  color: var(--mar-ui-text-primary);
}
.node-browser-notice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem;
  border-block-end: 1px solid var(--mar-ui-border);
  color: var(--mar-ui-text-secondary);
}
.node-browser-text {
  margin: 0.25rem 0.5rem;
  color: var(--mar-ui-text-secondary);
}
@media (max-width: 420px) {
  .node-browser-toolbar {
    display: grid;
    grid-template-columns: 1fr auto auto;
  }
  .node-browser-address {
    grid-column: 1 / -1;
    grid-row: 1;
  }
}
</style>
