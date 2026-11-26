<script setup lang="ts">
import './view-toolbar-control.css';
import { computed, ref, shallowRef, useId, watch, watchEffect } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { readOverflowText } from '@myagentroam/mar-ui/tooltip';
import type { SessionCollaborationEdge } from '@myagentroam/protocol';
import type { NavigationSession } from '../../service/session-navigation-projection.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  boundCollaborationGraph,
  buildCollaborationGraph,
  collaborationNodeSize,
  focusCollaborationGraph,
  MAX_COLLABORATION_SCALE,
  MIN_COLLABORATION_SCALE,
  zoomCollaborationGraph,
  type GraphCamera
} from '../../util/collaboration-graph.js';

/** Renders the relationship canvas and owns its view transform, never session or board state. */
const props = defineProps<{
  anchor: string;
  selected: string | undefined;
  selectedEdge: SessionCollaborationEdge | undefined;
  sessions: readonly NavigationSession[];
  sharing: readonly SessionCollaborationEdge[];
  canOpenSession: boolean;
}>();
const emit = defineEmits<{
  select: [id: string];
  board: [edge: SessionCollaborationEdge];
  open: [sessionId: string, destination: 'main' | 'aside'];
}>();
const arrow = useId();
const help = useId();
const port = ref<HTMLElement>();
const size = shallowRef({ width: 0, height: 0 });
const graph = computed(() => buildCollaborationGraph(props.sessions, props.sharing));
const labels = computed(() => new Map(props.sessions.map(({ id, title }) => [id, title])));
const descriptions = computed(() => {
  const descriptions = new Map<string, string[]>();
  const add = (id: string, description: string) => {
    const items = descriptions.get(id) ?? [];
    items.push(description);
    descriptions.set(id, items);
  };
  for (const { from, to, kind } of graph.value.edges) {
    const source = labels.value.get(from)!;
    const target = labels.value.get(to)!;
    add(
      from,
      translate(kind === 'parent' ? 'collaboration.childRelation' : 'collaboration.sharesWith', {
        title: target
      })
    );
    add(
      to,
      translate(kind === 'parent' ? 'collaboration.parentRelation' : 'collaboration.followsBoard', {
        title: source
      })
    );
  }
  return descriptions;
});
const camera = shallowRef<GraphCamera>({ scale: 1, x: 0, y: 0 });
const canZoomOut = computed(() => camera.value.scale > MIN_COLLABORATION_SCALE);
const canZoomIn = computed(() => camera.value.scale < MAX_COLLABORATION_SCALE);
const initialized = ref(false);
const dragging = ref(false);
let manual = false;
let blockClick = false;
let gesture: { id: number; x: number; y: number; camera: GraphCamera } | undefined;

watchEffect((cleanup) => {
  const element = port.value;
  if (!element) return;
  const observer = new ResizeObserver(() => {
    size.value = { width: element.clientWidth, height: element.clientHeight };
  });
  observer.observe(element);
  cleanup(() => observer.disconnect());
});

watch(graph, ({ nodes, edges }) => {
  const viewport = port.value;
  const focused = viewport?.ownerDocument.activeElement;
  if (!viewport || !focused || !viewport.contains(focused)) return;
  let removed = false;
  const focusedNode = focused.closest<HTMLElement>('[data-network-node]');
  if (focusedNode) {
    removed = !nodes.has(focusedNode.dataset.networkNode!);
  } else if (focused instanceof SVGPathElement && focused.classList.contains('edge-hit-area')) {
    const { owner, follower } = focused.dataset;
    removed = !edges.some(
      ({ kind, from, to }) => kind === 'sharing' && from === owner && to === follower
    );
  }
  if (removed) {
    viewport.focus({ preventScroll: true });
  }
});

watch(
  () => props.canOpenSession,
  (canOpen) => {
    const viewport = port.value;
    const focused = viewport?.ownerDocument.activeElement;
    if (
      !canOpen &&
      viewport?.contains(focused ?? null) &&
      focused?.closest('.network-node-actions')
    ) {
      viewport.focus({ preventScroll: true });
    }
  }
);

watch([graph, size], ([next, viewport], [previous, oldViewport]) => {
  const current = next.nodes.get(props.anchor);
  if (!current || !viewport.width || !viewport.height) return;
  const old = previous.nodes.get(props.anchor);
  if (!initialized.value || !manual) {
    camera.value = focusCollaborationGraph(next, viewport, props.anchor);
    initialized.value = true;
  } else {
    camera.value = boundCollaborationGraph(next, viewport, {
      scale: camera.value.scale,
      x:
        camera.value.x +
        (viewport.width - oldViewport.width) / 2 +
        ((old?.x ?? current.x) - current.x) * camera.value.scale,
      y:
        camera.value.y +
        (viewport.height - oldViewport.height) / 2 +
        ((old?.y ?? current.y) - current.y) * camera.value.scale
    });
  }
});

function position(id?: string, keepScale = false) {
  manual = true;
  camera.value = focusCollaborationGraph(
    graph.value,
    size.value,
    id,
    keepScale ? camera.value.scale : undefined
  );
}

function zoom(factor: number, x = size.value.width / 2, y = size.value.height / 2) {
  manual = true;
  camera.value = zoomCollaborationGraph(graph.value, size.value, camera.value, { x, y }, factor);
}

function wheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey || !port.value) return;
  event.preventDefault();
  port.value.querySelector<HTMLButtonElement>('.network-node-more[aria-expanded="true"]')?.click();
  const rect = port.value.getBoundingClientRect();
  const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
  const delta = Math.max(-300, Math.min(300, event.deltaY * units));
  zoom(Math.exp(-delta / 400), event.clientX - rect.left, event.clientY - rect.top);
}

function down(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return;
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, camera: camera.value };
  blockClick = false;
}

function move(event: PointerEvent) {
  if (gesture?.id !== event.pointerId) return;
  if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
    end(event);
    return;
  }
  const dx = event.clientX - gesture.x;
  const dy = event.clientY - gesture.y;
  if (!dragging.value) {
    if (Math.hypot(dx, dy) < 6) return;
    // Touch pointers are already captured by the touched node or the canvas.
    if (event.pointerType === 'mouse') port.value?.setPointerCapture(event.pointerId);
    dragging.value = true;
    blockClick = true;
  }
  manual = true;
  camera.value = boundCollaborationGraph(graph.value, size.value, {
    ...gesture.camera,
    x: gesture.camera.x + dx,
    y: gesture.camera.y + dy
  });
}

function end(event: PointerEvent) {
  if (gesture?.id !== event.pointerId) return;
  gesture = undefined;
  dragging.value = false;
}

function nodeTooltip(id: string): string | undefined {
  return readOverflowText(
    port.value?.querySelector(`[data-node-title='${CSS.escape(id)}']`) ?? null
  );
}

function openNodeMenu(event: MouseEvent | KeyboardEvent) {
  if (
    event instanceof KeyboardEvent &&
    event.key !== 'ContextMenu' &&
    !(event.shiftKey && event.key === 'F10')
  )
    return;
  const node = (event.currentTarget as HTMLElement).closest('[data-network-node]');
  const more = node?.querySelector<HTMLButtonElement>('.network-node-more');
  if (!more || more.disabled) return;
  event.preventDefault();
  if (more.getAttribute('aria-expanded') !== 'true') more.click();
}

function stopDragClick(event: MouseEvent) {
  if (!blockClick || event.detail === 0) return;
  event.preventDefault();
  event.stopPropagation();
}

function keyboard(event: KeyboardEvent) {
  if (event.target !== port.value) return;
  if (event.key === '+' || event.key === '=') zoom(1.2);
  else if (event.key === '-') zoom(1 / 1.2);
  else if (event.key === 'Home') position(props.anchor, true);
  else {
    const x = event.key === 'ArrowLeft' ? 64 : event.key === 'ArrowRight' ? -64 : 0;
    const y = event.key === 'ArrowUp' ? 64 : event.key === 'ArrowDown' ? -64 : 0;
    if (!x && !y) return;
    manual = true;
    camera.value = boundCollaborationGraph(graph.value, size.value, {
      ...camera.value,
      x: camera.value.x + x,
      y: camera.value.y + y
    });
  }
  event.preventDefault();
}

function showFocused(id: string) {
  if (gesture) return;
  const point = graph.value.nodes.get(id);
  if (!point || !size.value.width) return;
  const x = camera.value.x + point.x * camera.value.scale;
  const y = camera.value.y + point.y * camera.value.scale;
  const insetX = (collaborationNodeSize.width * camera.value.scale) / 2 + 3;
  const insetY = (collaborationNodeSize.height * camera.value.scale) / 2 + 3;
  if (x < insetX || y < insetY || x > size.value.width - insetX || y > size.value.height - insetY)
    position(id, true);
}

function isSelectedEdge(owner: string, follower: string) {
  return (
    props.selectedEdge?.ownerSessionId === owner &&
    props.selectedEdge.followerSessionId === follower
  );
}

function selectEdge(ownerSessionId: string, followerSessionId: string) {
  emit('board', { ownerSessionId, followerSessionId });
}

function distanceToEdge(path: SVGPathElement, point: DOMPoint) {
  const length = path.getTotalLength();
  const step = length / 16;
  const distanceAt = (at: number) => {
    const p = path.getPointAtLength(at);
    return (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
  };
  let center = 0;
  let best = distanceAt(0);
  // Bracket the nearest part of the curve, then refine within that part.
  for (let i = 1; i <= 16; i++) {
    const candidate = distanceAt(i * step);
    if (candidate >= best) continue;
    center = i * step;
    best = candidate;
  }
  let low = Math.max(0, center - step);
  let high = Math.min(length, center + step);
  for (let i = 0; i < 12; i++) {
    const left = low + (high - low) / 3;
    const right = high - (high - low) / 3;
    if (distanceAt(left) < distanceAt(right)) high = right;
    else low = left;
  }
  return Math.min(best, distanceAt((low + high) / 2));
}

function activateEdge(event: MouseEvent, owner: string, follower: string) {
  const target = event.currentTarget as SVGPathElement;
  const transform = target.getScreenCTM();
  if (event.detail === 0 || !transform) {
    selectEdge(owner, follower);
    return;
  }
  // Wide touch strokes can overlap; choose the nearest centerline, not the last painted edge.
  const candidates = target.ownerDocument
    .elementsFromPoint(event.clientX, event.clientY)
    .filter(
      (element): element is SVGPathElement =>
        element instanceof SVGPathElement &&
        element.ownerSVGElement === target.ownerSVGElement &&
        element.classList.contains('edge-hit-area')
    );
  if (candidates.length < 2) {
    selectEdge(owner, follower);
    return;
  }
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
  let closest = target;
  let best = distanceToEdge(target, point);
  for (const candidate of candidates) {
    if (candidate === target) continue;
    const distance = distanceToEdge(candidate, point);
    if (distance >= best) continue;
    closest = candidate;
    best = distance;
  }
  if (closest !== target && target.ownerDocument.activeElement === target) {
    closest.focus({ preventScroll: true });
  }
  selectEdge(closest.dataset.owner!, closest.dataset.follower!);
}

function showFocusedEdge(event: FocusEvent) {
  const path = event.currentTarget as SVGPathElement;
  if (gesture || !path.matches(':focus-visible')) return;
  const point = path.getPointAtLength(path.getTotalLength() / 2);
  const { scale, x, y } = camera.value;
  const { width, height } = size.value;
  const screenX = x + point.x * scale;
  const screenY = y + point.y * scale;
  if (screenX >= 14 && screenX <= width - 14 && screenY >= 14 && screenY <= height - 14) return;
  manual = true;
  camera.value = boundCollaborationGraph(graph.value, size.value, {
    scale,
    x: width / 2 - point.x * scale,
    y: height / 2 - point.y * scale
  });
}
</script>

<template>
  <section class="network" :aria-label="translate('collaboration.relationships')">
    <div
      ref="port"
      class="network-viewport"
      :class="{ 'is-dragging': dragging }"
      tabindex="0"
      :aria-label="translate('collaboration.relationships')"
      :aria-describedby="help"
      @wheel="wheel"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="end"
      @pointercancel="end"
      @lostpointercapture.self="end"
      @click.capture="stopDragClick"
      @keydown="keyboard"
    >
      <span :id="help" class="network-hint">{{ translate('collaboration.canvasHint') }}</span>
      <div
        v-if="initialized"
        class="network-world"
        :style="{
          width: `${graph.width}px`,
          height: `${graph.height}px`,
          transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`
        }"
      >
        <svg class="network-edges" :width="graph.width" :height="graph.height">
          <defs>
            <marker :id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path class="network-arrow" d="M0 0L6 3.5 0 7z" />
            </marker>
          </defs>
          <g
            v-for="edge in graph.edges"
            :key="`${edge.kind}:${JSON.stringify([edge.from, edge.to])}`"
            :class="{
              'is-selected-edge': edge.kind === 'sharing' && isSelectedEdge(edge.from, edge.to)
            }"
          >
            <path
              :d="edge.path"
              aria-hidden="true"
              :class="[
                `edge-${edge.kind}`,
                { 'is-related': edge.from === selected || edge.to === selected }
              ]"
              :marker-end="edge.kind === 'parent' ? `url(#${arrow})` : undefined"
            />
            <path
              v-if="edge.kind === 'sharing'"
              :d="edge.path"
              class="edge-hit-area"
              role="button"
              tabindex="0"
              :data-owner="edge.from"
              :data-follower="edge.to"
              :aria-label="
                translate('collaboration.sharingRelation', {
                  owner: labels.get(edge.from)!,
                  follower: labels.get(edge.to)!
                })
              "
              :aria-pressed="isSelectedEdge(edge.from, edge.to)"
              @focus="showFocusedEdge"
              @click="activateEdge($event, edge.from, edge.to)"
              @keydown.enter.prevent="selectEdge(edge.from, edge.to)"
              @keydown.space.prevent
              @keyup.space.prevent="selectEdge(edge.from, edge.to)"
            />
          </g>
        </svg>
        <template v-for="session in sessions" :key="session.id">
          <div
            v-if="graph.nodes.has(session.id)"
            class="network-node-shell"
            :data-network-node="session.id"
            :style="{
              left: `${graph.nodes.get(session.id)!.x}px`,
              top: `${graph.nodes.get(session.id)!.y}px`,
              width: `${collaborationNodeSize.width}px`,
              height: `${collaborationNodeSize.height}px`
            }"
          >
            <button
              v-tooltip="() => nodeTooltip(session.id)"
              type="button"
              class="network-node"
              :class="{
                'is-current': session.id === anchor,
                'is-selected': session.id === selected
              }"
              :aria-pressed="session.id === selected"
              :aria-current="session.id === anchor ? 'true' : undefined"
              :aria-description="descriptions.get(session.id)?.join('; ')"
              @focus="showFocused(session.id)"
              @click="emit('select', session.id)"
              @contextmenu="openNodeMenu"
              @keydown="openNodeMenu"
            >
              <span class="network-node-icon">
                <MarIcon name="agent-session" :size="18" />
              </span>
              <span class="network-node-copy">
                <span class="network-node-title" :data-node-title="session.id">{{
                  session.title
                }}</span>
                <span v-if="session.id === anchor" class="network-node-badge">{{
                  translate('collaboration.current')
                }}</span>
              </span>
            </button>
            <MarDropdown
              class="network-node-actions"
              placement="bottom-end"
              :persistent="false"
              :disabled="!canOpenSession"
              @command="
                ($event === 'aside' || $event === 'main') && emit('open', session.id, $event)
              "
            >
              <MarButton
                v-tooltip="translate('sessionGroups.actions')"
                class="network-node-more mar-icon-action"
                icon="more"
                text
                :aria-label="translate('collaboration.sessionActions', { title: session.title })"
                @focus="showFocused(session.id)"
                @contextmenu="openNodeMenu"
                @keydown="openNodeMenu"
              />
              <template #dropdown>
                <MarDropdownMenu @pointerdown.stop @wheel.stop>
                  <MarDropdownItem icon="split" command="aside">
                    {{ translate('sessionGroups.openAside') }}
                  </MarDropdownItem>
                  <MarDropdownItem icon="external-link" command="main">
                    {{ translate('sessionGroups.openMain') }}
                  </MarDropdownItem>
                </MarDropdownMenu>
              </template>
            </MarDropdown>
          </div>
        </template>
      </div>
    </div>
    <footer class="network-toolbar">
      <div class="network-legend">
        <span><i aria-hidden="true" />{{ translate('collaboration.parentEdge') }}</span>
        <span
          ><i class="legend-sharing" aria-hidden="true" />{{
            translate('collaboration.sharingEdge')
          }}</span
        >
      </div>
      <div
        class="network-controls"
        role="group"
        :aria-label="translate('collaboration.viewControls')"
      >
        <div class="network-zoom" role="group" :aria-label="translate('collaboration.zoom')">
          <MarButton
            icon="subtract"
            text
            :aria-label="translate('collaboration.zoomOut')"
            v-tooltip="translate('collaboration.zoomOut')"
            :aria-disabled="!canZoomOut || undefined"
            @click="canZoomOut && zoom(1 / 1.2)"
          />
          <output>{{ Math.round(camera.scale * 100) }}%</output>
          <MarButton
            icon="plus"
            text
            :aria-label="translate('collaboration.zoomIn')"
            v-tooltip="translate('collaboration.zoomIn')"
            :aria-disabled="!canZoomIn || undefined"
            @click="canZoomIn && zoom(1.2)"
          />
        </div>
        <MarButton
          class="network-fit mar-view-toolbar-control"
          icon="fit"
          :aria-label="translate('collaboration.fit')"
          v-tooltip="translate('collaboration.fit')"
          @click="position()"
        />
        <MarButton icon="locate-current" @click="position(anchor, true)">{{
          translate('collaboration.locate')
        }}</MarButton>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.network {
  --network-sharing-stroke: color-mix(
    in srgb,
    var(--mar-color-accent) 66%,
    var(--mar-text-secondary)
  );
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.network-viewport {
  flex: 1;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: clip;
  touch-action: none;
  user-select: none;
  cursor: grab;
  background: var(--mar-bg-subtle);
}
.network-viewport.is-dragging,
.network-viewport.is-dragging :is(button, path) {
  cursor: grabbing;
}
.network-viewport:focus-visible {
  outline-offset: -2px;
}
.network-hint {
  position: absolute;
  width: 1px;
  height: 1px;
  clip-path: inset(50%);
  overflow: hidden;
  white-space: nowrap;
}
.network-world {
  position: absolute;
  inset: 0 auto auto 0;
  transform-origin: 0 0;
}
.network-edges {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
.network-edges :is(.edge-parent, .edge-sharing) {
  fill: none;
  stroke-width: 1.35;
}
.network-edges .edge-parent {
  stroke: var(--mar-border-strong);
}
.network-edges .edge-sharing {
  stroke: var(--network-sharing-stroke);
  stroke-dasharray: 4 5;
}
.network-edges .is-related {
  stroke-width: 1.65;
}
.network-edges .edge-parent.is-related {
  stroke: var(--mar-text-secondary);
}
.network-edges g:has(.edge-hit-area:focus-visible) .edge-sharing {
  stroke: var(--mar-text-primary);
  stroke-width: 2.5;
}
.network-edges .is-selected-edge .edge-sharing {
  stroke: var(--mar-color-accent);
  stroke-width: 2.5;
}
.edge-hit-area {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  vector-effect: non-scaling-stroke;
  pointer-events: stroke;
  cursor: pointer;
}
.edge-hit-area:focus-visible {
  outline: none;
}
@media (pointer: coarse) {
  .edge-hit-area {
    stroke-width: 28;
  }
}
.network-arrow {
  fill: var(--mar-border-strong);
}
.network-node-shell {
  position: absolute;
  transform: translate(-50%, -50%);
  --network-node-more-size: 1.875rem;
}
.network-node {
  box-sizing: border-box;
  inline-size: 100%;
  block-size: 100%;
  border-radius: var(--mar-radius-selection);
  border: 1px solid var(--mar-border-medium);
  background: var(--mar-bg-panel);
  color: var(--mar-text-primary);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  padding-inline-end: calc(var(--network-node-more-size) + 0.375rem);
  text-align: start;
  font-size: var(--mar-font-size-detail);
  font-weight: 400;
  cursor: pointer;
}
.network-node.is-current {
  border-color: var(--mar-border-strong);
}
.network-node.is-selected {
  border-color: var(--mar-border-strong);
  background: var(--mar-fill-selection);
}
.network-node:hover:not(.is-selected) {
  background: var(--mar-fill-row-hover);
}
.network-node-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  color: var(--mar-text-primary);
}
.network-node-copy {
  display: grid;
  min-width: 0;
}
.network-node-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.network-node-badge {
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-secondary);
}
.network-node-actions {
  position: absolute;
  inset-inline-end: 0.25rem;
  inset-block-start: 50%;
  transform: translateY(-50%);
}
.network-node-more {
  inline-size: var(--network-node-more-size);
  block-size: var(--network-node-more-size);
  padding: 0;
}
.network-toolbar,
.network-controls,
.network-legend,
.network-legend span {
  display: flex;
  align-items: center;
}
.network-toolbar {
  flex: none;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem;
  border-top: 1px solid var(--mar-border-subtle);
  padding: 0.5rem 0.625rem;
}
.network-controls {
  gap: 0.375rem;
  flex-wrap: wrap;
  touch-action: manipulation;
}
.network-zoom {
  display: inline-flex;
  flex: none;
  align-items: stretch;
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-control);
  background: var(--mar-bg-panel);
}
.network-zoom > .mar-ui-button,
.network-fit {
  flex: none;
  inline-size: var(--mar-compact-control-size);
  padding-inline: 0;
}
.network-zoom > .mar-ui-button {
  border: 0;
  border-radius: calc(var(--mar-radius-control) - 1px);
  min-block-size: calc(var(--mar-compact-control-size) - 2px);
}
.network-zoom > [aria-disabled='true'] {
  color: var(--mar-text-disabled);
  cursor: not-allowed;
}
.network-zoom > .mar-ui-button:first-child {
  border-start-end-radius: 0;
  border-end-end-radius: 0;
}
.network-zoom > .mar-ui-button:last-child {
  border-start-start-radius: 0;
  border-end-start-radius: 0;
}
.network-zoom output {
  display: grid;
  place-items: center;
  min-inline-size: calc(4ch + 1rem);
  padding-inline: 0.5rem;
  box-sizing: border-box;
  border-inline: 1px solid var(--mar-border-subtle);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
}
.network-controls > .mar-ui-button + .mar-ui-button {
  margin-inline-start: 0;
}
.network-legend {
  gap: 0.75rem;
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-secondary);
}
.network-legend span {
  gap: 0.3rem;
}
.network-legend i {
  position: relative;
  width: 1.25rem;
  border-top: 1px solid var(--mar-border-strong);
}
.network-legend i:not(.legend-sharing)::after {
  position: absolute;
  inset: -3px 0 auto auto;
  content: '';
  border: 2px solid transparent;
  border-inline-start: 4px solid var(--mar-border-strong);
  border-inline-end: 0;
}
.network-legend .legend-sharing {
  border-top-color: var(--network-sharing-stroke);
  border-top-style: dashed;
}
</style>
