<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarTabs } from '@myagentroam/mar-ui/tabs';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import {
  BROWSER_TAB_LIMIT,
  browserProfileDescriptionSchema,
  isBrowserWorkspacePreview,
  type BrowserHistoryResult,
  type BrowserFindOperation,
  type BrowserFindResult,
  type BrowserProfileTarget,
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
import BrowserAddressInput from './BrowserAddressInput.vue';
import BrowserFindBar from './BrowserFindBar.vue';
import BrowserDownloadsDialog from './BrowserDownloadsDialog.vue';
import BrowserContextMenu from './BrowserContextMenu.vue';
import BrowserPerformanceIndicator from './BrowserPerformanceIndicator.vue';
import BrowserTabLabel from './BrowserTabLabel.vue';
import WorkspaceFloatingActions from '../common/WorkspaceFloatingActions.vue';
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
const browserSurface = ref<HTMLElement>();
const tabPrefix = useId();
const keyboard = ref<HTMLTextAreaElement>();
const keyboardFocused = ref(false);
const pageKeyboard = ref(false);
let keyboardOrigin: HTMLElement | undefined;
const body = ref<HTMLElement>();
const lifetime = new AbortController();
const draft = ref('');
const edited = ref(false);
const invalid = ref(false);
const answer = ref('');
const downloadsOpen = ref(false);
const {
  snapshot,
  status,
  frame,
  path,
  streamSample,
  pictureMode,
  pictureQuality,
  error,
  uploadStatus
} = props.browser;
const closingTabs = new Set<string>();
function closePageTab(id: string): void {
  if (!closingTabs.has(id) && props.browser.send({ type: 'tab.close', tabId: id }))
    closingTabs.add(id);
}
watch(
  snapshot,
  (value) => {
    if (!value) return closingTabs.clear();
    let closed = false;
    for (const id of closingTabs) {
      if (value.tabs.some((tab) => tab.id === id)) continue;
      closingTabs.delete(id);
      closed = true;
    }
    if (closed && value.tabs.length === 0) emit('closed', props.scope);
  },
  { flush: 'sync' }
);
watch(error, (value) => {
  if (value) closingTabs.clear();
});
const downloadBrowserId = computed(() => props.browser.browserId());
const activeDownloads = computed(() =>
  status.value === 'ready' ? (snapshot.value?.activeDownloadCount ?? 0) : 0
);
const downloadStatusId = `${tabPrefix}-download-status`;
watch(downloadBrowserId, () => (downloadsOpen.value = false));
watch(
  [downloadBrowserId, () => snapshot.value?.startedDownloadCount],
  ([id, count], [previousId, previousCount]) => {
    if (
      id &&
      id === previousId &&
      count !== undefined &&
      previousCount !== undefined &&
      count > previousCount
    )
      feedback(t('browser.downloadStarted'), 'info');
  }
);
const connection = computed(() => {
  if (path.value === 'ice') return props.directDescription ?? t('workspaceTabs.directAvailable');
  if (path.value === 'relay') return t('browser.relay');
  return status.value === 'connecting' ? t('browser.connecting') : '—';
});
const active = computed(() =>
  snapshot.value?.tabs.find((tab) => tab.id === snapshot.value?.activeId)
);
const historyBrowserId = computed(() =>
  props.connected && status.value === 'ready' ? props.browser.browserId() : undefined
);
const historyContext = computed(() =>
  historyBrowserId.value && active.value && snapshot.value
    ? JSON.stringify([historyBrowserId.value, active.value.id, snapshot.value.viewVersion])
    : undefined
);
let historyTarget:
  Promise<{ target: BrowserProfileTarget; historySuggestions: boolean } | undefined> | undefined;
watch(historyBrowserId, () => (historyTarget = undefined), { flush: 'sync' });

async function lookupAddressHistory(text: string): Promise<BrowserHistoryResult['items']> {
  const id = historyBrowserId.value;
  const context = historyContext.value;
  if (!id || !context) return [];
  const lookup = (historyTarget ??= props.browser
    .profile(props.scope, { action: 'describe' })
    .then((result) => {
      const description = browserProfileDescriptionSchema.safeParse(result);
      if (!description.success) return;
      const { profile: target, historySuggestions } = description.data;
      if (target?.kind === 'live' && target.id === id)
        return { target, historySuggestions: historySuggestions === true };
    }));
  try {
    const description = await lookup;
    if (!description || lookup !== historyTarget || context !== historyContext.value) {
      if (!description && historyTarget === lookup) historyTarget = undefined;
      return [];
    }
    const result = (await props.browser.profile(props.scope, {
      action: 'history',
      target: description.target,
      input: {
        text,
        startTime: 0,
        ...(description.historySuggestions ? { suggestions: true } : {})
      }
    })) as BrowserHistoryResult;
    return result.items;
  } catch (error) {
    if (historyTarget === lookup) historyTarget = undefined;
    throw error;
  }
}
const findBar = ref<InstanceType<typeof BrowserFindBar>>();
const findOpen = ref(false);
const findQuery = ref('');
const findResult = shallowRef<BrowserFindResult>();
const findPending = ref(false);
const findFailed = ref(false);
const canFind = computed(() =>
  Boolean(
    props.capability.find &&
    status.value === 'ready' &&
    !blank.value &&
    active.value &&
    snapshot.value?.viewVersion === frame.value?.viewVersion &&
    frame.value
  )
);
let findVersion: number | undefined;
let findTimer: ReturnType<typeof setTimeout> | undefined;
let findIntent = 0;
let findOrigin: HTMLElement | undefined;
let findRequest: Promise<BrowserFindResult | undefined> | undefined;

async function requestFind(
  version: number,
  intent: number,
  operation: BrowserFindOperation
): Promise<void> {
  // Keep at most one expensive scan outstanding. Only the newest edit may follow it.
  await findRequest;
  if (intent !== findIntent) return;
  const request = props.browser.findInPage(version, operation);
  findRequest = request;
  const result = await request;
  if (findRequest === request) findRequest = undefined;
  if (intent !== findIntent || operation.action === 'clear') return;
  findResult.value = result;
  findFailed.value = !result;
  findPending.value = false;
}

function editFind(value: string): void {
  findQuery.value = value;
  findResult.value = undefined;
  findFailed.value = false;
  const version = findVersion;
  const intent = ++findIntent;
  clearTimeout(findTimer);
  findPending.value = !!value.trim();
  if (version === undefined) return;
  if (!value.trim()) {
    void requestFind(version, intent, { action: 'clear' });
    return;
  }
  findTimer = setTimeout(
    () => void requestFind(version, intent, { action: 'start', query: value }),
    130
  );
}

function stepFind(action: 'previous' | 'next'): void {
  const version = findVersion;
  if (version === undefined || findPending.value || !findResult.value?.total) return;
  const intent = ++findIntent;
  findPending.value = true;
  void requestFind(version, intent, { action });
}

function openFind(): void {
  if (!canFind.value) return;
  if (!findOpen.value) {
    const focused = document.activeElement;
    findOrigin =
      focused instanceof HTMLElement && browserSurface.value?.contains(focused)
        ? focused
        : undefined;
    findVersion = frame.value?.viewVersion;
    findOpen.value = true;
    if (findQuery.value.trim()) editFind(findQuery.value);
  }
  void nextTick(() => findBar.value?.focus());
}

function closeFind(restore: boolean): void {
  if (!findOpen.value) return;
  clearTimeout(findTimer);
  const intent = ++findIntent;
  if (findVersion !== undefined) void requestFind(findVersion, intent, { action: 'clear' });
  findOpen.value = findPending.value = findFailed.value = false;
  findResult.value = undefined;
  findVersion = undefined;
  if (restore)
    (findOrigin?.isConnected ? findOrigin : browserSurface.value)?.focus({ preventScroll: true });
  findOrigin = undefined;
}
const blank = computed(() => active.value?.url === 'about:blank');
const dialog = computed(() => snapshot.value?.dialog);
const chooser = computed(() => snapshot.value?.fileChooser);
const fileInputId = useId();
watch([() => snapshot.value?.viewVersion, canFind], () => {
  if (!canFind.value || findVersion !== snapshot.value?.viewVersion) closeFind(false);
});
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
      const label =
        tab.url === 'about:blank'
          ? t('browser.blank')
          : tab.title || tab.url || t('browser.untitledTab');
      return {
        name: tab.id,
        label,
        closeLabel: t('browser.closeTab', { tab: label })
      };
    }) ?? []
);
const hasCommands = computed(() => !!snapshot.value && status.value !== 'failed');
let recentAddresses: string[] = [];
let restoreAddresses: string[] | undefined;
const reconnectFrom = shallowRef<{ id: string; addresses: string[] }>();
const blankForRestore = computed(
  () =>
    snapshot.value?.tabs.length === 1 &&
    blank.value &&
    !active.value?.loading &&
    !active.value?.canGoBack &&
    !active.value?.canGoForward
);
const replacementRestore = computed(() => {
  const previous = reconnectFrom.value;
  const id = props.browser.browserId();
  return previous &&
    id &&
    id !== previous.id &&
    status.value === 'ready' &&
    snapshot.value?.tabControls &&
    blankForRestore.value
    ? previous.addresses
    : undefined;
});
watch(
  snapshot,
  (value) => {
    if (!value) return;
    const ordered = [
      ...value.tabs.filter(({ id }) => id !== value.activeId),
      ...value.tabs.filter(({ id }) => id === value.activeId)
    ];
    recentAddresses = ordered.flatMap(({ url }) => {
      const parsed = URL.parse(url);
      return parsed &&
        /^https?:$/u.test(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        !isBrowserWorkspacePreview(url)
        ? [parsed.href]
        : [];
    });
  },
  { flush: 'sync' }
);
watch([status, snapshot], () => {
  if (status.value === 'failed') restoreAddresses = undefined;
  if (
    status.value === 'ready' &&
    snapshot.value?.tabs.length &&
    (!blankForRestore.value || props.browser.browserId() === reconnectFrom.value?.id)
  )
    reconnectFrom.value = undefined;
  if (!restoreAddresses || status.value !== 'ready' || !snapshot.value?.tabControls) return;
  const addresses = restoreAddresses;
  restoreAddresses = undefined;
  props.browser.send({ type: 'tab.restore', addresses });
});
const canRestoreTabs = computed(
  () =>
    props.capability.tabControls &&
    error.value === 'BROWSER_SESSION_ENDED' &&
    recentAddresses.length > 0
);
const canRecover = computed(
  () => error.value !== 'BROWSER_VNC_UNAVAILABLE' && error.value !== 'BROWSER_NOT_AUTHORIZED'
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
  if (canvas.value && body.value && props.connected)
    void props.browser.show(props.scope, props.capability, canvas.value, action, body.value);
}

watch(
  [canvas, () => props.connected],
  ([element, connected]) => {
    if (!initial || !element || !connected) return;
    initial = false;
    show(
      props.restoreId
        ? { action: 'resume', browserId: props.restoreId }
        : { action: 'open', preserveLogin: true }
    );
    if (props.restoreId) emit('restored');
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
  [status, () => !!snapshot.value, () => props.requested],
  () => {
    if (!desired) return;
    if (status.value === 'ready' && snapshot.value) {
      if (
        !props.browser.send(
          'url' in desired
            ? { type: 'tab.open', address: desired.url }
            : { type: 'tab.openHtml', path: desired.htmlPath }
        )
      )
        return;
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
let unregisterFind: (() => void) | undefined;
let unregisterFindEscape: (() => void) | undefined;
onMounted(() => {
  unregisterFind = consoleKeyboardShortcutService.register({
    command: 'browser.find',
    scope: 'workspace',
    priority: 45,
    owner: () => browserSurface.value,
    keys: [
      { key: 'f', ctrl: true },
      { key: 'f', meta: true }
    ],
    when: () => canFind.value,
    execute: () => {
      openFind();
      return 'HANDLED';
    }
  });
  unregisterFindEscape = consoleKeyboardShortcutService.register({
    command: 'browser.closeFind',
    scope: 'workspace',
    priority: 45,
    owner: () => browserSurface.value,
    keys: [{ key: 'Escape' }],
    when: () => findOpen.value && !contextMenu.value,
    execute: () => {
      closeFind(true);
      return 'HANDLED';
    }
  });
  document.addEventListener('pointerdown', newPointerIntent, {
    capture: true,
    signal: lifetime.signal
  });
  document.addEventListener('focusin', newFocusIntent, { capture: true, signal: lifetime.signal });
  // Exit focused page input before the enclosing mobile surface handles Escape.
  unregisterInputEscape = consoleKeyboardShortcutService.register({
    command: 'browser.exitPageInput',
    scope: 'workspace',
    priority: 30,
    owner: () => keyboard.value,
    keys: [{ key: 'Escape' }],
    when: (event) => keyboardFocused.value && !textInput.active && !event.isComposing,
    execute: () => {
      ++contextIntent;
      exitPageKeyboard();
      return 'HANDLED';
    }
  });
});
onBeforeUnmount(() => {
  closeFind(false);
  unregisterFind?.();
  unregisterFindEscape?.();
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
  if (!snapshot.value || !hasCommands.value) return;
  if (props.browser.send({ type: 'navigate', viewVersion: snapshot.value.viewVersion, address }))
    showCurrentAddress();
}
function travel(action: 'back' | 'forward' | 'reload' | 'stop'): void {
  if (!snapshot.value) return;
  showCurrentAddress();
  props.browser.send({ type: 'navigation', viewVersion: snapshot.value.viewVersion, action });
}
function zoomUnavailable(direction: 'in' | 'out' | 'reset'): boolean {
  const zoom = snapshot.value?.tabControls?.zoom;
  return (
    !hasCommands.value ||
    blank.value ||
    zoom === undefined ||
    (direction === 'in' ? zoom >= 200 : direction === 'out' ? zoom <= 50 : zoom === 100)
  );
}
function zoomPage(direction: 'in' | 'out' | 'reset'): void {
  const viewVersion = snapshot.value?.viewVersion;
  if (viewVersion !== undefined && !zoomUnavailable(direction))
    props.browser.send({ type: 'page.zoom', viewVersion, direction });
}
function command(value: string | number | object): void {
  if (value === 'find') {
    // The command menu restores its trigger immediately after emitting the command.
    void nextTick(openFind);
    return;
  }
  const id = props.browser.browserId();
  if (value === 'settings') return emit('settings', id);
  if (!id) return;
  if (value === 'reopen') props.browser.send({ type: 'tab.reopen' });
  if (value === 'cache' || value === 'history') emit('data', value, id);
  if (value === 'close') {
    const scope = props.scope;
    void props.browser.closeBrowser().then((closed) => {
      if (closed && !lifetime.signal.aborted) emit('closed', scope);
    });
  }
}

function recover(): void {
  const id = props.browser.browserId();
  if (id && props.capability.tabControls && recentAddresses.length)
    reconnectFrom.value = { id, addresses: recentAddresses };
  show({ action: 'open', preserveLogin: true });
}
function restoreRecentTabs(): void {
  if (replacementRestore.value) {
    if (props.browser.send({ type: 'tab.restore', addresses: replacementRestore.value }))
      reconnectFrom.value = undefined;
    return;
  }
  if (!canRestoreTabs.value) return;
  reconnectFrom.value = undefined;
  restoreAddresses = [...recentAddresses];
  show({ action: 'open', preserveLogin: true });
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
const buttonMask = { left: 1, right: 2, middle: 4 } as const;
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
    if (pressed?.viewVersion === position.viewVersion) {
      // A chorded button can be released in pointermove while another stays down.
      if (!(event.buttons & buttonMask[pressed.button])) {
        releasePointer(event.pointerId, position);
        return;
      }
      pressedPointers.set(event.pointerId, { ...pressed, ...position });
    }
    input({ type: 'move', ...position });
    return;
  }
  const button = (['left', 'middle', 'right'] as const)[event.button];
  if (!button || pressedPointers.has(event.pointerId)) return;
  if (button === 'right' && props.capability.contextMenu) {
    event.preventDefault();
    // Use the pointer edge as the sole mouse trigger, regardless of when the
    // host browser emits its separate contextmenu event.
    void openContext(
      new DOMRect(event.clientX, event.clientY),
      event.shiftKey ? undefined : position
    );
    return;
  }
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

async function copy(link?: string): Promise<void> {
  try {
    if (link) {
      await navigator.clipboard.writeText(link);
      feedback(t('browser.copied'), 'info');
      return;
    }
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
    feedback(t(link ? 'browser.contextCopyLinkFailed' : 'browser.copyFailed'), 'error');
  }
}

const contextMenu = shallowRef<{
  intent: number;
  anchor: DOMRect;
  keyboard: boolean;
  options: NonNullable<Awaited<ReturnType<WorkbenchBrowserService['queryContextMenu']>>>;
}>();
let contextIntent = 0;
function inContextMenu(target: EventTarget | null): boolean {
  return !!(
    contextMenu.value &&
    target instanceof Element &&
    target.closest('.browser-context-menu')
  );
}
function newPointerIntent(event: PointerEvent): void {
  // The shared dropdown owns dismissal; an item click must not invalidate its own command.
  if (inContextMenu(event.target)) return;
  ++contextIntent;
}
function newFocusIntent(event: FocusEvent): void {
  // Menu navigation and the dropdown's focus restoration are part of this action.
  if (event.target === keyboard.value || inContextMenu(event.target)) return;
  ++contextIntent;
}

async function openContext(
  anchor: DOMRect,
  target?: ReturnType<typeof point>,
  keyboardTriggered = false
): Promise<void> {
  if (!props.capability.contextMenu || blank.value || status.value !== 'ready') return;
  const viewVersion = frame.value?.viewVersion;
  if (viewVersion === undefined || pressedPointers.size || nativeTouch || touch) return;
  const intent = ++contextIntent;
  contextMenu.value = undefined;
  const sink = keyboard.value;
  sink?.focus({ preventScroll: true });
  inputScheduler.finish(viewVersion);
  const options = await props.browser.queryContextMenu(
    viewVersion,
    target && { x: target.x, y: target.y }
  );
  if (options && currentContext(intent, viewVersion) && document.activeElement === sink)
    contextMenu.value = { intent, anchor, options, keyboard: keyboardTriggered };
}

function currentContext(intent: number, viewVersion: number): boolean {
  return (
    !lifetime.signal.aborted &&
    intent === contextIntent &&
    status.value === 'ready' &&
    frame.value?.viewVersion === viewVersion
  );
}

async function contextCommand(
  command: 'copy' | 'paste' | 'copyLink' | 'openLink' | 'back' | 'forward' | 'reload'
): Promise<void> {
  const menu = contextMenu.value;
  if (!menu || !currentContext(menu.intent, menu.options.viewVersion)) return;
  const { link, viewVersion, id } = menu.options;
  if (command === 'copy') return copy();
  if (command === 'copyLink') {
    if (link) return copy(link);
    return;
  }
  if (command === 'openLink') {
    if (link) props.browser.send({ type: 'tab.open', address: link });
    return;
  }
  if (command !== 'paste') return travel(command);
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !currentContext(menu.intent, viewVersion)) return;
    if (text.length > 4096 || !props.browser.send({ type: 'context.paste', id, viewVersion, text }))
      throw new Error('Cannot paste');
  } catch {
    if (currentContext(menu.intent, viewVersion))
      feedback(t('browser.contextPasteFailed'), 'warning');
  }
}

async function pasteFromDevice(): Promise<void> {
  const viewVersion = frame.value?.viewVersion;
  if (
    viewVersion === undefined ||
    snapshot.value?.viewVersion !== viewVersion ||
    blank.value ||
    status.value !== 'ready'
  )
    return;
  const intent = ++contextIntent;
  const current = () =>
    currentContext(intent, viewVersion) && snapshot.value?.viewVersion === viewVersion;
  try {
    const text = await navigator.clipboard.readText();
    if (text && current()) insertText(text, viewVersion);
  } catch {
    if (current()) feedback(t('browser.pasteFailed'), 'warning');
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
  if (!['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'].includes(event.key)) ++contextIntent;
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
  if (
    event.key === 'Escape' ||
    (event.key === 'Tab' && (!pageKeyboard.value || event.ctrlKey || event.metaKey || event.altKey))
  )
    return;
  if (
    props.capability.contextMenu &&
    (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
  ) {
    event.preventDefault();
    const painted = paintedPage();
    if (painted && !event.repeat)
      void openContext(new DOMRect(painted.left + 12, painted.top + 12), undefined, true);
    return;
  }
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
function exitPageKeyboard(): void {
  const origin = keyboardOrigin;
  pageKeyboard.value = false;
  if (keyboardFocused.value) {
    (origin?.isConnected ? origin : browserSurface.value)?.focus({ preventScroll: true });
    keyboard.value?.blur();
  }
}

function togglePageKeyboard(event: MouseEvent): void {
  if (pageKeyboard.value) return exitPageKeyboard();
  if (!frame.value || !keyboard.value) return;
  if (event.currentTarget instanceof HTMLElement) keyboardOrigin = event.currentTarget;
  keyboard.value.focus({ preventScroll: true });
  pageKeyboard.value = document.activeElement === keyboard.value;
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
watch([() => active.value?.id, status], () => {
  if (pageKeyboard.value) exitPageKeyboard();
});
function resetTransientInput(): void {
  inputScheduler.reset();
  textInput.reset();
  if (keyboard.value) keyboard.value.value = '';
}
watch(
  // Watch scalar values: passing the shallow status ref directly makes Vue
  // invoke this on every rendered frame even if the generation has not changed.
  [() => snapshot.value?.viewVersion, () => frame.value?.viewVersion, () => status.value],
  () => {
    ++contextIntent;
    contextMenu.value = undefined;
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
function startComposition(): void {
  ++contextIntent;
  textInput.start(frame.value?.viewVersion);
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
  ++contextIntent;
  event.preventDefault();
  if (input({ type: 'key', edge: 'down', viewVersion, key }))
    input({ type: 'key', edge: 'up', viewVersion, key });
}
function insertText(value: string, viewVersion = frame.value?.viewVersion): void {
  if (!value || viewVersion === undefined) return;
  ++contextIntent;
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 4096, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
    if (!input({ type: 'text', viewVersion, text: value.slice(start, end) })) return;
    start = end;
  }
}
</script>

<template>
  <section ref="browserSurface" class="node-browser" :aria-label="t('browser.title')" tabindex="-1">
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
        @tab-close="(id) => closePageTab(String(id))"
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
      <BrowserAddressInput
        class="node-browser-address"
        :model-value="draft"
        :label="t('browser.address')"
        :invalid="invalid"
        :error-id="`${tabPrefix}-address-error`"
        :history-context="historyContext"
        :lookup="lookupAddressHistory"
        :disabled="!hasCommands || !active"
        @edit="edit"
        @navigate="navigateTo"
      >
        <template v-if="active?.loading" #prefix>
          <span
            class="node-browser-address-loading"
            role="status"
            :aria-label="t('browser.loadingPage')"
          >
            <MarBusyIndicator />
          </span>
        </template>
      </BrowserAddressInput>
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
      <div class="node-browser-download">
        <MarButton
          class="node-browser-icon"
          icon="download"
          :aria-label="t('browser.downloads')"
          :aria-describedby="activeDownloads ? downloadStatusId : undefined"
          aria-haspopup="dialog"
          v-tooltip="t('browser.downloads')"
          :disabled="status !== 'ready'"
          @click="downloadsOpen = true"
        />
        <span :id="downloadStatusId" class="node-browser-download-status">{{
          activeDownloads ? t('browser.downloadActive', { count: activeDownloads }) : ''
        }}</span>
        <span v-if="activeDownloads" class="node-browser-download-badge" aria-hidden="true">
          {{ activeDownloads > 99 ? '99+' : activeDownloads }}
        </span>
      </div>
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
              v-if="capability.find"
              command="find"
              icon="search"
              :disabled="!canFind"
              >{{ t('browser.find') }}</MarDropdownItem
            >
            <MarDropdownItem command="history" icon="clock" :disabled="!browser.browserId()">{{
              t('browser.history')
            }}</MarDropdownItem>
            <template v-if="snapshot?.tabControls">
              <MarDropdownItem
                command="reopen"
                icon="retry"
                :disabled="!snapshot.tabControls.reopen"
              >
                {{ t('browser.reopenTab') }}
              </MarDropdownItem>
              <div class="node-browser-zoom" role="group" :aria-label="t('browser.zoom')">
                <span class="node-browser-zoom-label" aria-hidden="true">
                  <MarIcon name="search" />
                  {{ t('browser.zoom') }}
                </span>
                <div class="node-browser-zoom-controls" role="presentation">
                  <MarButton
                    class="node-browser-icon"
                    text
                    icon="subtract"
                    role="menuitem"
                    tabindex="-1"
                    :aria-label="t('browser.zoomOut')"
                    :aria-disabled="zoomUnavailable('out') || undefined"
                    @click="zoomPage('out')"
                  />
                  <MarButton
                    class="node-browser-zoom-value"
                    text
                    role="menuitem"
                    tabindex="-1"
                    :aria-label="t('browser.zoomReset', { percent: snapshot.tabControls.zoom })"
                    :aria-disabled="zoomUnavailable('reset') || undefined"
                    @click="zoomPage('reset')"
                  >
                    {{ snapshot.tabControls.zoom }}%
                  </MarButton>
                  <MarButton
                    class="node-browser-icon"
                    text
                    icon="plus"
                    role="menuitem"
                    tabindex="-1"
                    :aria-label="t('browser.zoomIn')"
                    :aria-disabled="zoomUnavailable('in') || undefined"
                    @click="zoomPage('in')"
                  />
                </div>
              </div>
            </template>
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
      <BrowserFindBar
        v-if="findOpen"
        ref="findBar"
        :query="findQuery"
        :result="findResult"
        :pending="findPending"
        :failed="findFailed"
        @edit="editFind"
        @step="stepFind"
        @close="closeFind(true)"
      />
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
      <p class="node-browser-activity" role="status">
        <span v-if="status === 'ready' && snapshot?.agentActive">{{ t('browser.useActive') }}</span>
      </p>
      <BrowserContextMenu
        v-if="contextMenu"
        :key="contextMenu.intent"
        :options="contextMenu.options"
        :anchor="contextMenu.anchor"
        :keyboard="contextMenu.keyboard"
        :can-go-back="!!active?.canGoBack"
        :can-go-forward="!!active?.canGoForward"
        :can-open-tab="tabs.length < BROWSER_TAB_LIMIT"
        @command="contextCommand"
        @close="contextMenu = undefined"
      />
      <textarea
        v-if="status === 'ready' && !blank"
        ref="keyboard"
        data-node-browser-input
        class="node-browser-input"
        tabindex="-1"
        :aria-label="t('browser.viewport')"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        @keydown="key($event, 'down')"
        @keyup="key($event, 'up')"
        @focus="keyboardFocused = true"
        @blur="
          keyboardFocused = false;
          pageKeyboard = false;
          keyboardOrigin = undefined;
          releaseControls();
        "
        @compositionstart="startComposition"
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
          <MarIcon name="connection-off" :size="32" aria-hidden="true" />
          <h2>{{ t('browser.browserUnavailable') }}</h2>
          <p>{{ error ? browserError(error) : t('browser.failed') }}</p>
          <p v-if="canRestoreTabs">{{ t('browser.restoreTabsHint') }}</p>
        </div>
        <MarButton
          v-if="canRecover"
          type="primary"
          icon="retry"
          :disabled="!connected"
          @click="recover"
          >{{
            t(error === 'BROWSER_SESSION_ENDED' ? 'browser.newBrowser' : 'browser.retry')
          }}</MarButton
        >
        <MarButton v-if="canRestoreTabs" :disabled="!connected" @click="restoreRecentTabs">
          {{ t('browser.restoreTabs') }}
        </MarButton>
      </div>
      <div v-else-if="status === 'idle'" class="node-browser-placeholder">
        <p role="status">{{ t('browser.disconnected') }}</p>
      </div>
      <form v-else-if="blank" class="node-browser-blank" @submit.prevent="navigate">
        <BrowserAddressInput
          :model-value="draft"
          blank
          :label="t('browser.blankAddress')"
          :invalid="invalid"
          :error-id="`${tabPrefix}-address-error`"
          :history-context="historyContext"
          :lookup="lookupAddressHistory"
          @edit="edit"
          @navigate="navigateTo"
        />
        <MarButton
          v-if="replacementRestore"
          class="node-browser-blank-restore"
          v-tooltip="t('browser.restoreTabsHint')"
          @click="restoreRecentTabs"
          >{{ t('browser.restoreTabs') }}</MarButton
        >
      </form>
      <WorkspaceFloatingActions
        v-slot="{ expanded }"
        v-if="status === 'ready'"
        :label="t('browser.pageActions')"
        :collapse-label="t('browser.collapsePageActions')"
        :expand-label="t('browser.expandPageActions')"
        contained
        compact-on-desktop
      >
        <MarButton
          v-if="!blank"
          circle
          icon="keyboard"
          :aria-label="t('browser.pageKeyboard')"
          :aria-pressed="pageKeyboard"
          v-tooltip="t('browser.pageKeyboardHint')"
          @pointerdown.prevent
          @click="togglePageKeyboard"
        />
        <MarButton
          v-if="!blank"
          circle
          icon="copy"
          :aria-label="t('browser.copySelection')"
          v-tooltip="t('browser.copySelection')"
          @click="copy()"
        />
        <MarButton
          v-if="!blank"
          circle
          icon="paste"
          :aria-label="t('browser.pasteText')"
          v-tooltip="t('browser.pasteText')"
          @pointerdown.prevent
          @click="pasteFromDevice"
        />
        <BrowserPerformanceIndicator
          :connection="connection"
          :disabled="!expanded"
          :frame="frame"
          :sample="streamSample"
          :mode="pictureMode"
          :quality="pictureQuality"
          @quality="browser.selectPictureMode($event)"
        />
      </WorkspaceFloatingActions>
    </div>
    <BrowserDownloadsDialog
      v-if="downloadsOpen"
      :key="downloadBrowserId ?? ''"
      :browser="browser"
      :save-workspace="capability.downloadWorkspace === true"
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
.node-browser-activity {
  position: absolute;
  inset-inline-start: 0.75rem;
  inset-block-end: 0.75rem;
  z-index: 1;
  margin: 0;
  pointer-events: none;
}
.node-browser-activity span {
  display: block;
  padding: 0.25rem 0.5rem;
  color: var(--mar-text-secondary);
  background: var(--mar-ui-bg-panel);
  border: 1px solid var(--mar-ui-border-default);
  border-radius: var(--mar-ui-radius-control);
  font-size: var(--mar-ui-font-size-meta);
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
  inline-size: clamp(6rem, 28cqi, 13rem);
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
  margin-inline-end: 2px;
}
.node-browser-tabs :deep(.browser-web-tab-close:hover:enabled) {
  background: var(--mar-ui-action-hover-overlay);
}
.node-browser-tabs
  :deep(.browser-web-tab:not(.is-active) + .browser-web-tab:not(.is-active)::before) {
  content: '';
  position: absolute;
  inset: 25% auto 25% 0;
  border-inline-start: 1px solid var(--mar-ui-border-default);
  pointer-events: none;
}
.node-browser-tabs :deep(.browser-web-tab.is-active) {
  z-index: 1;
  background: var(--mar-ui-fill-selection);
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
  background: radial-gradient(circle at 0 0, transparent 68%, var(--mar-ui-fill-selection) 72%);
}
.node-browser-tabs :deep(.browser-web-tab.is-active::after) {
  left: 100%;
  background: radial-gradient(circle at 100% 0, transparent 68%, var(--mar-ui-fill-selection) 72%);
}
@media (forced-colors: active) {
  .node-browser-tabs :deep(.browser-web-tab.is-active) {
    outline: 1px solid Highlight;
    outline-offset: -1px;
  }
}
.node-browser-toolbar {
  background: color-mix(in srgb, var(--mar-ui-bg-panel) 75%, var(--mar-ui-fill-row-hover));
  gap: 0.25rem;
  padding: 0.25rem;
  border-block-end: 1px solid var(--mar-ui-border);
}
.node-browser-address-loading {
  display: grid;
  place-items: center;
}
.node-browser-icon {
  padding-inline: 0;
  inline-size: var(--mar-ui-compact-control-size, 24px);
  flex: none;
}
.node-browser-zoom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.125rem 0.75rem;
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-control);
}
.node-browser-zoom-label {
  display: flex;
  align-items: center;
  gap: 5px;
}
.node-browser-zoom-controls {
  display: inline-flex;
  flex: none;
  border: 1px solid var(--mar-ui-border-default);
  border-radius: var(--mar-ui-radius-control);
}
.node-browser-zoom-controls > .mar-ui-button {
  --mar-ui-button-hover-border: var(--mar-ui-border-subtle);
  border: 0;
  border-radius: 0;
  outline-offset: -2px;
}
.node-browser-zoom-controls > .mar-ui-button + .mar-ui-button {
  margin-inline-start: 0;
  border-inline-start: 1px solid var(--mar-ui-border-subtle);
}
.node-browser-zoom-controls > .mar-ui-button:first-child {
  border-start-start-radius: inherit;
  border-end-start-radius: inherit;
}
.node-browser-zoom-controls > .mar-ui-button:last-child {
  border-start-end-radius: inherit;
  border-end-end-radius: inherit;
}
.node-browser-zoom-value {
  min-inline-size: 6ch;
  padding-inline: 0.25rem;
  font-variant-numeric: tabular-nums;
}
.node-browser-zoom-value[aria-disabled='true'] {
  color: var(--mar-ui-text-secondary);
  cursor: default;
}
.node-browser-download {
  position: relative;
  flex: none;
  display: flex;
}
.node-browser-download-status {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.node-browser-download-badge {
  position: absolute;
  z-index: 1;
  inset-block-start: -4px;
  inset-inline-end: -4px;
  min-inline-size: 0.875rem;
  padding-inline: 0.15em;
  box-sizing: border-box;
  border: 1px solid var(--mar-ui-bg-panel);
  border-radius: 999px;
  background: var(--mar-ui-control-primary-bg);
  color: var(--mar-ui-control-primary-fg);
  font-size: var(--mar-ui-font-size-meta);
  font-weight: 600;
  line-height: 1.05;
  text-align: center;
  pointer-events: none;
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
.node-browser-blank-restore {
  display: flex;
  margin-block-start: 0.75rem;
  margin-inline: auto;
}
.node-browser-blank :deep(.mar-ui-field-frame) {
  min-block-size: 2.75rem;
  border-radius: 999px;
  font-size: max(1rem, var(--mar-ui-font-size-input));
}
.node-browser-blank :deep(.mar-ui-input__body) {
  gap: 0.625em;
  padding-inline: 1.125em;
}
.node-browser-blank :deep(.mar-ui-input__icon) {
  font-size: 1.25em;
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
</style>
