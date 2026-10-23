<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { translate } from '../../service/LocalePreferenceService.js';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createScopedHttpService } from '../../service/ScopedHttpService.js';
import { createTerminalService } from '../../service/TerminalService.js';
import type { createTerminalDirectClient } from '../../service/TerminalDirectClient.js';

const props = defineProps<{
  readonly terminalId: string;
  readonly nodeId: string;
  readonly direct: Pick<ReturnType<typeof createTerminalDirectClient>, 'attach'> | undefined;
  readonly workspaceId: string | undefined;
  readonly csrfToken: string;
  readonly renewCsrfToken: () => Promise<string>;
  readonly windowsConPty: boolean;
  readonly windowsBuildNumber: number | undefined;
  readonly active: boolean;
  readonly visible: boolean;
}>();
const emit = defineEmits<{
  exited: [terminalId: string];
  notice: [message: string];
}>();

const host = ref<HTMLElement>();
const reconnectStatus = ref<string>();
const contextMenu = ref<{ x: number; y: number; selection: string }>();
let xterm: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let resizeAnimationFrame: number | undefined;
let focusRequested = false;
let resizeSyncPending = false;
const http = createScopedHttpService({
  csrfToken: () => props.csrfToken,
  renewCsrfToken: props.renewCsrfToken
});
let reconnectRelay: (() => void) | undefined;
const terminalService = createTerminalService({
  terminalId: props.terminalId,
  nodeId: props.nodeId,
  ...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId }),
  ...(props.direct === undefined ? {} : { direct: props.direct }),
  http,
  onAttached: () => scheduleResize(true),
  onOutput: (data) => xterm?.write(data),
  onExited: () => emit('exited', props.terminalId),
  onTerminalUnavailable: () => emit('exited', props.terminalId),
  onErrorFrame: (code) => {
    if (code === 'TERMINAL_FRAME_REJECTED') reconnectRelay?.();
    else xterm?.writeln(`\r\n[MyAgentRoam] ${code}`);
  },
  onReconnectStatus: (message) => (reconnectStatus.value = message),
  onNotice: (notice) => emit('notice', notice)
});
reconnectRelay = terminalService.reconnect;
function send(frame: object): void {
  terminalService.send(frame);
}
function resize(): void {
  const terminal = xterm;
  const addon = fitAddon;
  if (!props.active || !props.visible || terminal === undefined || addon === undefined) return;
  const previous = { cols: terminal.cols, rows: terminal.rows };
  addon.fit();
  const next = { cols: terminal.cols, rows: terminal.rows };
  if (!resizeSyncPending && previous.cols === next.cols && previous.rows === next.rows) return;
  send({ type: 'resize', terminalId: props.terminalId, ...next });
  resizeSyncPending = false;
}
function scheduleResize(forceSync = false): void {
  if (forceSync) resizeSyncPending = true;
  if (resizeAnimationFrame !== undefined) return;
  resizeAnimationFrame = window.requestAnimationFrame(() => {
    resizeAnimationFrame = undefined;
    resize();
  });
}
function focus(): void {
  focusRequested = true;
  void nextTick(() => {
    if (xterm === undefined || !props.active || !props.visible) return;
    xterm.focus();
    focusRequested = false;
  });
}
function closeContextMenu(): void {
  contextMenu.value = undefined;
  window.removeEventListener('pointerdown', closeContextMenuOnPointerDown);
  window.removeEventListener('keydown', closeContextMenuOnEscape, true);
}
function closeContextMenuOnPointerDown(event: PointerEvent): void {
  if (event.target instanceof Element && event.target.closest('.terminal-context-menu')) return;
  closeContextMenu();
}
function closeContextMenuOnEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeContextMenu();
  xterm?.focus();
}
function preventTerminalRightMouseDown(event: MouseEvent): void {
  if (event.button === 2) event.stopPropagation();
}
function openContextMenu(event: MouseEvent): void {
  const pointerType = (event as PointerEvent).pointerType;
  if (event.button !== 2 || (pointerType !== undefined && pointerType !== 'mouse')) return;
  event.preventDefault();
  event.stopPropagation();
  if (xterm === undefined) return;
  closeContextMenu();
  contextMenu.value = {
    x: Math.max(6, Math.min(event.clientX, window.innerWidth - 168 - 6)),
    y: Math.max(6, Math.min(event.clientY, window.innerHeight - 132 - 6)),
    selection: xterm.getSelection()
  };
  window.addEventListener('pointerdown', closeContextMenuOnPointerDown);
  window.addEventListener('keydown', closeContextMenuOnEscape, true);
}
async function copySelection(): Promise<void> {
  const selection = contextMenu.value?.selection;
  closeContextMenu();
  xterm?.focus();
  if (!selection) return;
  try {
    await navigator.clipboard.writeText(selection);
  } catch {
    emit(
      'notice',
      translate('generated.terminalTabView.terminalCopyFailedCheckBrowserClipboardPermissions')
    );
  }
}
async function pasteFromClipboard(): Promise<void> {
  closeContextMenu();
  const terminal = xterm;
  if (terminal === undefined) return;
  terminal.focus();
  try {
    const text = await navigator.clipboard.readText();
    if (xterm === terminal && text !== '') terminal.paste(text);
  } catch {
    emit(
      'notice',
      translate('generated.terminalTabView.terminalPasteFailedCheckClipboardPermissions')
    );
  }
}
function clearTerminal(): void {
  closeContextMenu();
  xterm?.clear();
  xterm?.focus();
}
function terminalFontSize(): number {
  const configured = Number(
    getComputedStyle(document.documentElement).getPropertyValue('--mar-terminal-font-size').trim()
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 12;
}
function terminalThemeColor(property: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(property).trim() || fallback;
}
onMounted(() => {
  if (host.value === undefined) return;
  xterm = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    macOptionClickForcesSelection: true,
    fontFamily: 'SFMono-Regular, Consolas, monospace',
    fontSize: terminalFontSize(),
    cols: 100,
    rows: 18,
    ...(props.windowsConPty
      ? {
          windowsPty: {
            backend: 'conpty' as const,
            ...(props.windowsBuildNumber === undefined
              ? {}
              : { buildNumber: props.windowsBuildNumber })
          }
        }
      : {}),
    theme: {
      background: terminalThemeColor('--mar-terminal-background', '#0e1116'),
      foreground: terminalThemeColor('--mar-terminal-foreground', '#e8eef8'),
      cursor: terminalThemeColor('--mar-terminal-cursor', '#37c8ff')
    }
  });
  xterm.loadAddon(new Unicode11Addon());
  xterm.unicode.activeVersion = '11';
  xterm.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!event.ctrlKey && !event.metaKey) return;
      window.open(uri, '_blank', 'noopener,noreferrer');
    })
  );
  fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.open(host.value);
  if (focusRequested && props.active && props.visible) {
    xterm.focus();
    focusRequested = false;
  }
  xterm.onData((data) => send({ type: 'input', terminalId: props.terminalId, data }));
  host.value.addEventListener('mousedown', preventTerminalRightMouseDown, true);
  host.value.addEventListener('contextmenu', openContextMenu, true);
  resizeObserver = new ResizeObserver(() => scheduleResize());
  resizeObserver.observe(host.value);
  resize();
  scheduleResize();
  void terminalService.attach();
});
watch(
  () => [props.active, props.visible] as const,
  ([active, visible]) => {
    if (!active || !visible) closeContextMenu();
    if (active && visible)
      void nextTick().then(() => {
        scheduleResize();
        if (focusRequested) focus();
      });
  }
);
defineExpose({ focus });
onBeforeUnmount(() => {
  closeContextMenu();
  terminalService.dispose();
  resizeObserver?.disconnect();
  if (resizeAnimationFrame !== undefined) window.cancelAnimationFrame(resizeAnimationFrame);
  if (host.value !== undefined) {
    host.value.removeEventListener('mousedown', preventTerminalRightMouseDown, true);
    host.value.removeEventListener('contextmenu', openContextMenu, true);
  }
  const terminal = xterm;
  xterm = undefined;
  fitAddon = undefined;
  terminal?.dispose();
});
</script>

<template>
  <div v-show="active" class="admin-terminal-body">
    <div
      ref="host"
      class="xterm-host"
      :aria-label="translate('generated.terminalTabView.terminalOutput')"
      tabindex="0"
    />
    <div v-if="reconnectStatus" class="admin-terminal-status" role="status">
      {{ reconnectStatus }}
    </div>
    <Teleport to="body">
      <div
        v-if="contextMenu !== undefined"
        class="terminal-context-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      >
        <ul class="el-dropdown-menu" role="menu">
          <li
            class="el-dropdown-menu__item"
            :class="{ 'is-disabled': !contextMenu.selection }"
            role="menuitem"
            :aria-disabled="!contextMenu.selection"
            @click="contextMenu.selection && copySelection()"
          >
            <MarIcon name="copy" />
            {{ translate('generated.terminalTabView.copy') }}
          </li>
          <li class="el-dropdown-menu__item" role="menuitem" @click="pasteFromClipboard">
            <MarIcon name="paste" />
            {{ translate('generated.terminalTabView.paste') }}
          </li>
          <li
            class="el-dropdown-menu__item el-dropdown-menu__item--divided"
            role="menuitem"
            @click="clearTerminal"
          >
            <MarIcon name="clear" />
            {{ translate('generated.terminalTabView.clear') }}
          </li>
        </ul>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.admin-terminal-body {
  box-sizing: border-box;
  block-size: 229px;
  border-top: 1px solid var(--mar-border-subtle);
  overflow: hidden;
  background: var(--mar-terminal-background);
  padding: 4px;
  position: relative;
}

.admin-terminal-status {
  position: absolute;
  inset-inline-start: 50%;
  inset-block-start: 12px;
  z-index: 2;
  transform: translateX(-50%);
  border: 1px solid var(--mar-overlay-border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--mar-terminal-surface) 90%, transparent);
  color: var(--mar-terminal-foreground);
  padding: 5px 10px;
  font-size: var(--mar-font-size-meta);
  pointer-events: none;
}

.xterm-host {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--mar-terminal-background);
}

.xterm-host:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 2px;
}

.terminal-context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 168px;
  filter: drop-shadow(0 8px 24px rgb(0 0 0 / 30%));
}

:global(.terminal-context-menu .el-dropdown-menu) {
  min-width: 168px;
}
</style>
