<script setup lang="ts">
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ readonly src: string }>();
const emit = defineEmits<{ rendered: []; error: [] }>();

const container = ref<HTMLElement>();
const pageCount = ref(0);
const canvases = new Map<number, HTMLCanvasElement>();
let document: PDFDocumentProxy | undefined;
let loadingTask: PDFDocumentLoadingTask | undefined;
let renderTask: RenderTask | undefined;
let activeRender: Promise<boolean> | undefined;
let renderQueued = false;
let generation = 0;
let resizeObserver: ResizeObserver | undefined;
let renderedWidth = 0;

function bindCanvas(page: number, element: unknown): void {
  if (element instanceof HTMLCanvasElement) canvases.set(page, element);
  else canvases.delete(page);
}

async function load(): Promise<void> {
  const currentGeneration = ++generation;
  renderQueued = false;
  cancelRendering();
  const previousRender = activeRender;
  const previousTask = loadingTask;
  loadingTask = undefined;
  await Promise.all([
    previousTask?.destroy().catch(() => undefined),
    previousRender?.catch(() => false)
  ]);
  document = undefined;
  pageCount.value = 0;
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = workerSource;
    const currentTask = pdfjs.getDocument({ url: props.src, withCredentials: true });
    loadingTask = currentTask;
    const loaded = await currentTask.promise;
    if (currentGeneration !== generation) {
      await currentTask.destroy();
      return;
    }
    document = loaded;
    pageCount.value = loaded.numPages;
    await nextTick();
    const rendered = await queueRender(currentGeneration);
    if (currentGeneration === generation && rendered) emit('rendered');
  } catch {
    if (currentGeneration === generation) emit('error');
  }
}

function queueRender(currentGeneration = generation): Promise<boolean> {
  if (currentGeneration !== generation) return Promise.resolve(false);
  renderQueued = true;
  if (activeRender === undefined) {
    const queuedRender = drainRenderQueue(currentGeneration);
    activeRender = queuedRender;
    void queuedRender.finally(() => {
      if (activeRender === queuedRender) activeRender = undefined;
      if (renderQueued && currentGeneration === generation) void queueRender(currentGeneration);
    });
  }
  return activeRender;
}

async function drainRenderQueue(currentGeneration: number): Promise<boolean> {
  let rendered = false;
  while (currentGeneration === generation && renderQueued) {
    renderQueued = false;
    rendered = await render(currentGeneration);
  }
  return rendered;
}

async function render(currentGeneration: number): Promise<boolean> {
  if (document === undefined || container.value === undefined) return false;
  const availableWidth = Math.max(240, container.value.clientWidth - 32);
  renderedWidth = availableWidth;
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (currentGeneration !== generation) return false;
      const page = await document.getPage(pageNumber);
      if (currentGeneration !== generation) return false;
      const canvas = canvases.get(pageNumber);
      if (canvas === undefined) continue;
      const initialViewport = page.getViewport({ scale: 1 });
      const cssScale = Math.min(availableWidth / initialViewport.width, 2);
      const viewport = page.getViewport({ scale: cssScale * outputScale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.ceil(viewport.width / outputScale)}px`;
      canvas.style.height = `${Math.ceil(viewport.height / outputScale)}px`;
      const task = page.render({ canvas, viewport });
      renderTask = task;
      try {
        await task.promise;
      } finally {
        if (renderTask === task) renderTask = undefined;
      }
    }
    return true;
  } catch (error) {
    if (currentGeneration === generation && !isRenderingCancelled(error)) emit('error');
    renderQueued = false;
    return false;
  }
}

function cancelRendering(): void {
  renderTask?.cancel();
}

function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

watch(() => props.src, load);

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (
      container.value !== undefined &&
      Math.max(240, container.value.clientWidth - 32) !== renderedWidth
    )
      void queueRender();
  });
  if (container.value !== undefined) resizeObserver.observe(container.value);
  void load();
});

onBeforeUnmount(() => {
  generation += 1;
  resizeObserver?.disconnect();
  cancelRendering();
  void loadingTask?.destroy().catch(() => undefined);
});
</script>

<template>
  <div ref="container" class="pdf-file-preview">
    <canvas
      v-for="page in pageCount"
      :key="page"
      :ref="(element) => bindCanvas(page, element)"
      class="pdf-file-preview-page"
    />
  </div>
</template>

<style scoped>
.pdf-file-preview {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 16px;
  overflow: auto;
  background: var(--mar-fill-subtle);
}

.pdf-file-preview-page {
  display: block;
  max-width: 100%;
  background: white;
  box-shadow: 0 1px 4px var(--mar-shadow-soft);
}
</style>
