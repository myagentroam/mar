<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch, watchEffect } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import marAgentIcon from '../../assets/logo-icon.png';
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
  selected: string;
  sessions: readonly NavigationSession[];
  sharing: readonly SessionCollaborationEdge[];
}>();
const emit = defineEmits<{ select: [id: string]; board: [id: string] }>();
const arrow = useId();
const help = useId();
const port = ref<HTMLElement>();
const size = shallowRef({ width: 0, height: 0 });
const graph = computed(() => buildCollaborationGraph(props.sessions, props.anchor, props.sharing));
const descriptions = computed(() => {
  const labels = new Map(props.sessions.map(({ id, title }) => [id, title]));
  const descriptions = new Map<string, string[]>();
  const add = (id: string, description: string) => {
    const items = descriptions.get(id) ?? [];
    items.push(description);
    descriptions.set(id, items);
  };
  for (const { from, to, kind } of graph.value.edges) {
    const source = labels.get(from)!;
    const target = labels.get(to)!;
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
        <svg class="network-edges" :width="graph.width" :height="graph.height" aria-hidden="true">
          <defs>
            <marker :id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path class="network-arrow" d="M0 0L6 3.5 0 7z" />
            </marker>
          </defs>
          <g
            v-for="edge in graph.edges"
            :key="`${edge.kind}:${JSON.stringify([edge.from, edge.to])}`"
          >
            <path
              :d="edge.path"
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
              @click="emit('board', edge.from)"
            />
          </g>
        </svg>
        <template v-for="session in sessions" :key="session.id">
          <button
            v-if="graph.nodes.has(session.id)"
            type="button"
            class="network-node"
            :class="{ 'is-current': session.id === anchor, 'is-selected': session.id === selected }"
            :style="{
              left: `${graph.nodes.get(session.id)!.x}px`,
              top: `${graph.nodes.get(session.id)!.y}px`,
              width: `${collaborationNodeSize.width}px`,
              height: `${collaborationNodeSize.height}px`
            }"
            :aria-pressed="session.id === selected"
            :aria-current="session.id === anchor ? 'true' : undefined"
            :aria-description="descriptions.get(session.id)?.join('; ')"
            @focus="showFocused(session.id)"
            @click="emit('select', session.id)"
          >
            <span class="network-node-icon">
              <img :src="marAgentIcon" alt="" width="18" height="18" draggable="false" />
            </span>
            <span class="network-node-copy">
              <span class="network-node-title">{{ session.title }}</span>
              <span v-if="session.id === anchor" class="network-node-badge">{{
                translate('collaboration.current')
              }}</span>
            </span>
          </button>
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
      <div class="network-controls" :aria-label="translate('collaboration.viewControls')">
        <MarButton
          :aria-label="translate('collaboration.zoomOut')"
          :disabled="camera.scale <= MIN_COLLABORATION_SCALE"
          @click="zoom(1 / 1.2)"
        >
          <MarIcon name="subtract" />
        </MarButton>
        <output>{{ Math.round(camera.scale * 100) }}%</output>
        <MarButton
          :aria-label="translate('collaboration.zoomIn')"
          :disabled="camera.scale >= MAX_COLLABORATION_SCALE"
          @click="zoom(1.2)"
        >
          <MarIcon name="plus" />
        </MarButton>
        <MarButton
          class="network-fit"
          icon="fullscreen"
          :aria-label="translate('collaboration.fit')"
          v-tooltip="translate('collaboration.fit')"
          @click="position()"
          >{{ translate('collaboration.fit') }}</MarButton
        >
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
.network-edges g:hover .edge-sharing {
  stroke: var(--mar-text-primary);
}
.edge-hit-area {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  pointer-events: stroke;
  cursor: pointer;
}
.network-arrow {
  fill: var(--mar-border-strong);
}
.network-node {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: var(--mar-radius-selection);
  border: 1px solid var(--mar-border-medium);
  background: var(--mar-bg-panel);
  color: var(--mar-text-primary);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  text-align: start;
  font-size: var(--mar-font-size-body);
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
  border-radius: var(--mar-radius-control);
  background: color-mix(in srgb, var(--mar-text-primary) 9%, var(--mar-bg-panel));
}
.network-node-icon img {
  display: block;
  object-fit: contain;
}
.network-node-copy {
  display: grid;
  min-width: 0;
}
.network-node-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.network-node-badge {
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-secondary);
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
  gap: 0.25rem;
  flex-wrap: wrap;
  touch-action: manipulation;
}
.network-controls output {
  font-size: var(--mar-font-size-meta);
  text-align: center;
  min-width: 2.5em;
  font-variant-numeric: tabular-nums;
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
@media (max-width: 430px) {
  .network-fit :deep(.mar-ui-button__label) {
    display: none;
  }
  .network-fit {
    gap: 0;
  }
}
</style>
