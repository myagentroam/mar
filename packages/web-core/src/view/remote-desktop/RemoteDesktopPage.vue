<script setup lang="ts">
import RFB from '@novnc/novnc';
import { publicErrorMessage } from '@myagentroam/protocol';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import {
  createStandaloneRemoteDesktopService,
  type StandaloneDesktopDiscovery
} from '../../service/standalone-remote-desktop-service.js';
import { remoteDesktopViewport } from '../../service/remote-desktop-viewport.js';
import { remoteDesktopEncodings } from '../../service/remote-desktop-encodings.js';
import { createRemoteDesktopStatistics } from '../../service/remote-desktop-statistics.js';
import { ApiError } from '../../util/api-error.js';
import { errorMessage } from '../../util/error-presentation.js';
import MarIcon from '../common/MarIcon.vue';

const props = defineProps<{ readonly nodeId: string }>();
type Mode = 'VIEW' | 'CONTROL';
type Attachment = Awaited<
  ReturnType<ReturnType<typeof createStandaloneRemoteDesktopService>['select']>
>;
const discovery = shallowRef<StandaloneDesktopDiscovery>();
const mode = ref<Mode>('VIEW');
const quality = ref(6);
const screenId = ref<string>();
const displayOptions = computed(
  () =>
    discovery.value?.description.selectableDisplays ?? discovery.value?.description.displays ?? []
);
const state = ref<'connecting' | 'ready' | 'hidden' | 'error'>('connecting');
const errorCode = ref<string>();
const remoteError = shallowRef<ApiError>();
const pasteError = ref(false);
const softKeyboardOpen = ref(false);
const softText = ref('');
const textFailed = ref(false);
const stage = ref<HTMLElement>();
const target = ref<HTMLElement>();
const renderKey = ref(0);
const statistics = shallowRef<ReturnType<typeof createRemoteDesktopStatistics>>();
const metrics = computed(() => statistics.value?.value.value);
const stageSize = ref({ width: 1, height: 1 });
const viewport = computed(() =>
  discovery.value
    ? remoteDesktopViewport(
        discovery.value.description,
        screenId.value || undefined,
        stageSize.value
      )
    : undefined
);
const errorText = computed(() => {
  const code = errorCode.value ?? 'DESKTOP_UNAVAILABLE';
  const summary =
    code === 'UNAUTHENTICATED'
      ? translate('remoteDesktop.signIn')
      : code === 'NODE_ACCESS_DENIED' || code === 'DESKTOP_NOT_AUTHORIZED'
        ? translate('remoteDesktop.notAuthorized')
        : code === 'DESKTOP_CONTROL_UNAVAILABLE'
          ? translate('remoteDesktop.unknownCleanup')
          : undefined;
  return errorMessage(remoteError.value ?? new ApiError(code, publicErrorMessage(code)), summary);
});
let service: ReturnType<typeof createStandaloneRemoteDesktopService> | undefined;
let attachment: Attachment | undefined;
let rfb: RFB | undefined;
let opening: AbortController | undefined;
let observer: ResizeObserver | undefined;
let generation = 0;
let inputRevision = 0;
let disposed = false;
let connectionClosed = false;

function codeOf(error: unknown): string {
  if (typeof error === 'string') return error;
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'DESKTOP_UNAVAILABLE';
}
function apiErrorOf(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = codeOf(error);
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : publicErrorMessage(code);
  return new ApiError(code, message);
}
function detachDisplay(): void {
  ++inputRevision;
  statistics.value?.close();
  statistics.value = undefined;
  softText.value = '';
  softKeyboardOpen.value = false;
  textFailed.value = false;
  const previous = rfb;
  rfb = undefined;
  if (previous) {
    previous.viewOnly = true;
    previous.disconnect();
  }
}
function failed(error: unknown, token: number): void {
  if (disposed || token !== generation) return;
  remoteError.value = apiErrorOf(error);
  errorCode.value = remoteError.value.code;
  state.value = 'error';
  detachDisplay();
}

async function connect(): Promise<void> {
  if (!service || !discovery.value || disposed || document.hidden) return;
  const authorizationMode = discovery.value.capability.supportsControl ? 'CONTROL' : 'VIEW';
  const token = ++generation;
  opening?.abort();
  const controller = new AbortController();
  opening = controller;
  mode.value = 'VIEW';
  pasteError.value = false;
  errorCode.value = undefined;
  remoteError.value = undefined;
  state.value = 'connecting';
  // The owner fences the previous attachment synchronously before opening the replacement.
  const pending = service.select({
    discovery: discovery.value,
    mode: authorizationMode,
    signal: controller.signal,
    onDisconnected: (code) => failed(code, token)
  });
  attachment = undefined;
  detachDisplay();
  try {
    const next = await pending;
    if (disposed || token !== generation || controller.signal.aborted) {
      await next.close();
      return;
    }
    attachment = next;
    renderKey.value++;
    await nextTick();
    if (!target.value || token !== generation || controller.signal.aborted) {
      await next.close();
      return;
    }
    const client = new RFB(target.value, next.channel, {
      manualClipboard: true,
      requestDrivenUpdates: true,
      allowedEncodings: remoteDesktopEncodings(authorizationMode)
    });
    rfb = client;
    statistics.value = createRemoteDesktopStatistics({
      frames: client,
      channel: next.channel,
      path: next.path,
      controlRoundTripMs: () => next.controlRoundTripMs
    });
    client.viewOnly = true;
    client.scaleViewport = true;
    client.qualityLevel = quality.value;
    client.addEventListener(
      'firstframe',
      () => {
        if (disposed || token !== generation || rfb !== client) return;
        next.ready();
        if (disposed || token !== generation || rfb !== client) return;
        state.value = 'ready';
      },
      { once: true }
    );
    client.addEventListener(
      'disconnect',
      () => {
        if (disposed || token !== generation || rfb !== client) return;
        void next.close();
        failed('DESKTOP_UNAVAILABLE', token);
      },
      { once: true }
    );
  } catch (error) {
    if (token === generation && !disposed) failed(error, token);
  } finally {
    if (opening === controller) opening = undefined;
  }
}

async function discoverAndConnect(displayId?: string): Promise<void> {
  if (!service || disposed || document.hidden) return;
  if (connectionClosed || errorCode.value === 'DESKTOP_CONTROL_UNAVAILABLE') {
    location.reload();
    return;
  }
  const token = ++generation;
  opening?.abort();
  const controller = new AbortController();
  opening = controller;
  mode.value = 'VIEW';
  state.value = 'connecting';
  errorCode.value = undefined;
  remoteError.value = undefined;
  detachDisplay();
  try {
    const snapshot = await service.discover(controller.signal, displayId);
    if (disposed || token !== generation || controller.signal.aborted) return;
    discovery.value = snapshot;
    screenId.value = snapshot.description.displays.find((display) => display.primary)?.displayId;
    await connect();
  } catch (error) {
    if (token === generation && !disposed) failed(error, token);
  } finally {
    if (opening === controller) opening = undefined;
  }
}

function changeScreen(displayId: string): void {
  if (discovery.value?.description.selectableDisplays) void discoverAndConnect(displayId);
}

function displayName(name: string): string {
  const device = /^\\\\\.\\DISPLAY(\d+)$/iu.exec(name);
  return device ? translate('remoteDesktop.displayName', { number: device[1]! }) : name;
}

function dataRate(bytes: number | undefined): string {
  if (bytes === undefined) return '-';
  if (bytes < 1024) return `${Math.round(bytes)} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB/s`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB/s`;
}

function setInputMode(nextMode: Mode): void {
  if (
    disposed ||
    !rfb ||
    state.value !== 'ready' ||
    document.hidden ||
    nextMode === mode.value ||
    (nextMode === 'CONTROL' && !discovery.value?.capability.supportsControl)
  )
    return;
  ++inputRevision;
  mode.value = nextMode;
  rfb.viewOnly = nextMode === 'VIEW';
  pasteError.value = false;
  softKeyboardOpen.value = false;
  softText.value = '';
  textFailed.value = false;
}
function stopActivity(): void {
  if (disposed) return;
  ++generation;
  opening?.abort();
  opening = undefined;
  const previous = attachment;
  attachment = undefined;
  mode.value = 'VIEW';
  state.value = 'hidden';
  const closing = previous?.close();
  detachDisplay();
  if (closing)
    void closing.then((settled) => {
      if (!settled && !disposed && state.value === 'hidden') {
        errorCode.value = 'DESKTOP_CONTROL_UNAVAILABLE';
        remoteError.value = new ApiError(
          'DESKTOP_CONTROL_UNAVAILABLE',
          publicErrorMessage('DESKTOP_CONTROL_UNAVAILABLE')
        );
        state.value = 'error';
      }
    });
}
function releaseControl(): void {
  setInputMode('VIEW');
}
function changeQuality(): void {
  if (rfb) rfb.qualityLevel = quality.value;
}
function visibilityChanged(): void {
  if (document.hidden) stopActivity();
}
async function paste(): Promise<void> {
  const token = inputRevision;
  const client = rfb;
  if (!client || mode.value !== 'CONTROL' || state.value !== 'ready') return;
  try {
    const text = await navigator.clipboard.readText();
    if (
      token !== inputRevision ||
      rfb !== client ||
      mode.value !== 'CONTROL' ||
      document.hidden ||
      !document.hasFocus()
    )
      return;
    client.clipboardPasteFrom(text);
    pasteError.value = false;
  } catch {
    if (token === inputRevision && rfb === client) pasteError.value = true;
  }
}
function sendSoftText(): void {
  if (mode.value !== 'CONTROL' || state.value !== 'ready' || document.hidden || !rfb) return;
  if (rfb.sendText(softText.value)) {
    softText.value = '';
    textFailed.value = false;
  } else textFailed.value = true;
}
function sendSoftKey(keysym: number, code: string): void {
  if (mode.value === 'CONTROL' && state.value === 'ready' && !document.hidden)
    rfb?.sendKey(keysym, code);
}
function resizeStage(): void {
  if (!stage.value) return;
  stageSize.value = {
    width: Math.max(1, stage.value.clientWidth),
    height: Math.max(1, stage.value.clientHeight)
  };
}
onMounted(() => {
  observer = new ResizeObserver(resizeStage);
  if (stage.value) observer.observe(stage.value);
  resizeStage();
  window.addEventListener('blur', releaseControl);
  document.addEventListener('visibilitychange', visibilityChanged);
  service = createStandaloneRemoteDesktopService({
    nodeId: props.nodeId,
    onDisconnected: (code) => {
      connectionClosed = true;
      failed(code, generation);
    }
  });
  if (document.hidden) state.value = 'hidden';
  else void discoverAndConnect();
});
onBeforeUnmount(() => {
  disposed = true;
  ++generation;
  opening?.abort();
  observer?.disconnect();
  window.removeEventListener('blur', releaseControl);
  document.removeEventListener('visibilitychange', visibilityChanged);
  detachDisplay();
  void service?.close();
});
</script>

<template>
  <main class="remote-desktop-page">
    <header class="remote-desktop-toolbar">
      <div class="remote-desktop-title">
        <strong>{{ translate('remoteDesktop.title') }}</strong
        ><span
          v-if="discovery?.nodeName"
          v-tooltip="discovery.nodeName"
          data-testid="desktop-node-name"
          >{{ discovery.nodeName }}</span
        >
      </div>
      <div class="remote-desktop-actions">
        <el-select
          v-model="quality"
          :aria-label="translate('remoteDesktop.quality')"
          class="remote-screen-select"
          data-testid="desktop-quality"
          @change="changeQuality"
        >
          <el-option :value="3" :label="translate('remoteDesktop.qualityLow')" />
          <el-option :value="6" :label="translate('remoteDesktop.qualityMedium')" />
          <el-option :value="9" :label="translate('remoteDesktop.qualityHigh')" />
        </el-select>
        <el-select
          v-if="discovery"
          v-model="screenId"
          :aria-label="translate('remoteDesktop.screens')"
          class="remote-screen-select"
          data-testid="desktop-screen"
          :disabled="
            state === 'connecting' ||
            state === 'hidden' ||
            errorCode === 'DESKTOP_CONTROL_UNAVAILABLE'
          "
          @change="changeScreen"
        >
          <el-option
            v-for="display in displayOptions"
            :key="display.displayId"
            :value="display.displayId"
            :label="
              display.primary
                ? translate('remoteDesktop.primary', { name: displayName(display.name) })
                : displayName(display.name)
            "
          />
        </el-select>
        <el-button
          v-if="mode === 'CONTROL'"
          data-testid="desktop-view"
          @click="setInputMode('VIEW')"
          >{{ translate('remoteDesktop.viewing') }}</el-button
        >
        <el-button
          v-else
          data-testid="desktop-control"
          :disabled="!discovery?.capability.supportsControl || state !== 'ready'"
          @click="setInputMode('CONTROL')"
          >{{ translate('remoteDesktop.controlling') }}</el-button
        >
        <el-button
          v-if="mode === 'CONTROL'"
          :disabled="state !== 'ready'"
          :aria-expanded="softKeyboardOpen"
          data-testid="desktop-keyboard"
          @click="softKeyboardOpen = !softKeyboardOpen"
          >{{ translate('remoteDesktop.keyboard') }}</el-button
        >
        <el-button
          :disabled="
            mode !== 'CONTROL' || state !== 'ready' || !discovery?.capability.supportsUnicodePaste
          "
          data-testid="desktop-paste"
          @click="paste"
          >{{ translate('remoteDesktop.paste') }}</el-button
        >
      </div>
    </header>
    <div v-if="softKeyboardOpen && mode === 'CONTROL'" class="remote-desktop-keyboard">
      <el-input
        v-model="softText"
        :aria-label="translate('remoteDesktop.keyboardInput')"
        :placeholder="translate('remoteDesktop.keyboardInput')"
        maxlength="256"
        data-testid="desktop-soft-text"
      />
      <el-button data-testid="desktop-send-text" :disabled="!softText" @click="sendSoftText">{{
        translate('remoteDesktop.sendText')
      }}</el-button>
      <el-button data-testid="desktop-enter" @click="sendSoftKey(0xff0d, 'Enter')">{{
        translate('remoteDesktop.enter')
      }}</el-button>
      <el-button data-testid="desktop-backspace" @click="sendSoftKey(0xff08, 'Backspace')">{{
        translate('remoteDesktop.backspace')
      }}</el-button>
      <span v-if="textFailed" role="alert">{{ translate('remoteDesktop.textFailed') }}</span>
    </div>
    <div ref="stage" class="remote-desktop-stage">
      <div
        v-if="viewport"
        data-testid="desktop-frame"
        class="remote-desktop-frame"
        :style="{ width: `${viewport.width}px`, height: `${viewport.height}px` }"
      >
        <div
          :key="renderKey"
          ref="target"
          class="remote-desktop-target"
          :class="{ 'is-interactive': mode === 'CONTROL' && state === 'ready' }"
          :style="{
            width: `${viewport.framebufferWidth}px`,
            height: `${viewport.framebufferHeight}px`,
            left: `${viewport.left}px`,
            top: `${viewport.top}px`
          }"
        />
      </div>
      <div
        v-if="state === 'ready' && mode === 'VIEW' && discovery?.capability.supportsControl"
        class="remote-desktop-control-prompt"
      >
        <el-button data-testid="desktop-control-prompt" @click="setInputMode('CONTROL')">{{
          translate('remoteDesktop.controlling')
        }}</el-button>
      </div>
      <div v-if="state !== 'ready'" class="remote-desktop-overlay" role="status">
        <p class="remote-desktop-status-line">
          <MarIcon v-if="state === 'connecting'" name="loading-action" />
          <span :class="{ 'remote-desktop-error-text': state === 'error' }">{{
            state === 'connecting'
              ? translate('remoteDesktop.connecting')
              : state === 'hidden'
                ? translate('remoteDesktop.hidden')
                : errorText
          }}</span>
        </p>
        <el-button v-if="state === 'hidden' || state === 'error'" @click="discoverAndConnect()">{{
          translate('remoteDesktop.retry')
        }}</el-button>
        <el-button v-if="errorCode === 'UNAUTHENTICATED'" tag="a" href="/console">{{
          translate('remoteDesktop.openWorkbench')
        }}</el-button>
      </div>
    </div>
    <footer
      v-if="state === 'ready' && metrics"
      v-tooltip="translate('remoteDesktop.statisticsHint')"
      class="remote-desktop-statistics"
      :aria-label="translate('remoteDesktop.statistics')"
      data-testid="desktop-statistics"
    >
      <span
        >{{ translate('remoteDesktop.connection') }}:
        {{
          translate(metrics.path === 'direct' ? 'remoteDesktop.direct' : 'remoteDesktop.relay')
        }}</span
      >
      <span
        >{{ translate('remoteDesktop.latency') }}:
        {{
          metrics.controlRoundTripMs === undefined
            ? '-'
            : `${Math.round(metrics.controlRoundTripMs)} ms`
        }}</span
      >
      <span
        >{{ translate('remoteDesktop.frameRate') }}:
        {{ metrics.framesPerSecond?.toFixed(1) ?? '-' }} FPS</span
      >
      <span
        >{{ translate('remoteDesktop.receiving') }}:
        {{ dataRate(metrics.receivedBytesPerSecond) }}</span
      >
      <span
        >{{ translate('remoteDesktop.sending') }}: {{ dataRate(metrics.sentBytesPerSecond) }}</span
      >
    </footer>
    <p v-if="pasteError" class="remote-desktop-message" role="alert">
      {{ translate('remoteDesktop.pasteFailed') }}
    </p>
  </main>
</template>

<style scoped>
.remote-desktop-page {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  background: var(--el-bg-color-page);
  color: var(--el-text-color-primary);
}
.remote-desktop-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}
.remote-desktop-statistics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  flex-shrink: 0;
  padding: 6px 16px;
  border-top: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.remote-desktop-statistics span {
  white-space: nowrap;
}
.remote-desktop-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.remote-desktop-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-secondary);
}
.remote-desktop-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.remote-desktop-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.remote-desktop-keyboard {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  flex-wrap: wrap;
}
.remote-desktop-keyboard :deep(.el-input) {
  flex: 1 1 12rem;
}
.remote-desktop-keyboard :deep(.el-button + .el-button) {
  margin-left: 0;
}
.remote-screen-select {
  width: 200px;
}
.remote-desktop-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #17191d;
}
.remote-desktop-frame {
  position: relative;
  overflow: hidden;
  flex: none;
}
.remote-desktop-target {
  position: absolute;
  pointer-events: none;
}
.remote-desktop-target.is-interactive {
  pointer-events: auto;
}
.remote-desktop-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 0;
  max-width: 100%;
  overflow: auto;
}
.remote-desktop-error-text {
  min-width: 0;
  max-width: 100%;
  align-self: flex-start;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  user-select: text;
  text-align: left;
}
.remote-desktop-control-prompt {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.remote-desktop-control-prompt :deep(.el-button) {
  pointer-events: auto;
}
.remote-desktop-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background: var(--el-overlay-color-lighter);
  color: #fff;
}
.remote-desktop-message {
  margin: 8px 16px;
  color: var(--el-color-danger);
}
@media (max-width: 600px) {
  .remote-desktop-toolbar {
    padding: 8px;
  }
  .remote-desktop-title {
    width: 100%;
  }
  .remote-screen-select {
    width: 160px;
  }
}
</style>
