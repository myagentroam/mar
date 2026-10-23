<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';
import { createFilePreviewWindowInteractionService } from '../../service/FilePreviewWindowInteractionService.js';
import { type FilePreviewKind } from '../../util/file-preview.js';
import { fileSizeLabel } from '../../util/file-presentation.js';
import FilePreviewLoading from './FilePreviewLoading.vue';
import PdfFilePreview from './PdfFilePreview.vue';
import WorkspaceFilePageFrame from './WorkspaceFilePageFrame.vue';

const VueOfficeDocx = defineAsyncComponent(async () => {
  await import('@vue-office/docx/lib/index.css');
  return (await import('@vue-office/docx')).default;
});
const VueOfficeExcel = defineAsyncComponent(async () => {
  await import('@vue-office/excel/lib/index.css');
  return (await import('@vue-office/excel')).default;
});
const VueOfficePptx = defineAsyncComponent(async () => (await import('@vue-office/pptx')).default);

interface FileContent {
  readonly path: string;
  readonly size?: number;
  readonly encoding: 'utf-8' | 'base64';
  readonly content: string;
  readonly truncated: boolean;
  readonly revision?: string;
}

const props = withDefaults(
  defineProps<{
    readonly file: FileContent;
    readonly contentUrl: string | undefined;
    readonly kind: FilePreviewKind;
    readonly loading?: boolean;
    readonly fullscreen?: boolean;
    readonly downloading: boolean;
    readonly active?: boolean;
  }>(),
  { active: true }
);

const emit = defineEmits<{
  close: [];
  download: [];
}>();

const root = ref<{ readonly root: HTMLElement | undefined }>();
const rendererError = ref(false);
const rendererLoading = ref(false);
const hasRenderableContent = computed(
  () => props.contentUrl !== undefined && props.kind !== 'unsupported'
);

watch(
  () => [props.contentUrl, props.kind],
  () => {
    rendererError.value = false;
    rendererLoading.value = ['pdf', 'document', 'spreadsheet', 'presentation'].includes(props.kind);
  },
  { immediate: true }
);

function rendererFailed(): void {
  rendererError.value = true;
  rendererLoading.value = false;
}

function focus(): void {
  root.value?.root?.focus();
}

function closeFullscreenPreview(): boolean {
  emit('close');
  return true;
}
const windowInteraction = createFilePreviewWindowInteractionService({
  isOpen: () => props.fullscreen === true && props.active !== false,
  closeWindow: closeFullscreenPreview,
  closeTab: closeFullscreenPreview
});

onMounted(() => {
  if (props.active !== false) focus();
  if (props.fullscreen) windowInteraction.mount();
});
onBeforeUnmount(() => windowInteraction.dispose());

defineExpose({
  focus,
  openFind: () => false,
  selectAll: () => false,
  toggleEdit: () => 'UNAVAILABLE' as const,
  canClose: async () => true
});
</script>

<template>
  <WorkspaceFilePageFrame
    ref="root"
    :file-name="file.path.split('/').at(-1) ?? file.path"
    :path="file.path"
    :loading="loading"
    :fullscreen="fullscreen"
    mobile-actions-layout="compact"
    tabindex="-1"
    role="dialog"
    :aria-modal="active !== false || undefined"
    :aria-hidden="active === false || undefined"
    :inert="active === false"
    :aria-label="translate('generated.filePreviewDialog.filePreview', { value0: file.path })"
  >
    <template #status>
      <span class="file-preview-eyebrow">
        <span v-if="file.size !== undefined">{{ fileSizeLabel(file.size) }}</span>
      </span>
    </template>
    <template #secondary-actions>
      <el-button
        v-tooltip="translate('generated.filePreviewDialog.downloadFile')"
        :loading="downloading"
        :aria-label="translate('generated.filePreviewDialog.downloadFile')"
        circle
        size="small"
        @click="emit('download')"
        :loading-icon="marIcon('loading-action')"
      >
        <MarIcon name="download" />
      </el-button>
      <el-button
        v-tooltip="translate('generated.filePreviewDialog.closePreview')"
        v-if="fullscreen"
        :aria-label="translate('generated.filePreviewDialog.closePreview')"
        circle
        size="small"
        type="primary"
        @click="emit('close')"
      >
        <MarIcon name="close" />
      </el-button>
    </template>
    <template #mobile-actions>
      <el-button
        v-tooltip="translate('generated.filePreviewDialog.downloadFile2')"
        :loading="downloading"
        :aria-label="translate('generated.filePreviewDialog.downloadFile2')"
        circle
        size="small"
        @click="emit('download')"
        :loading-icon="marIcon('loading-action')"
      >
        <MarIcon name="download" />
      </el-button>
      <el-button
        v-tooltip="translate('generated.filePreviewDialog.closePreview2')"
        v-if="fullscreen"
        :aria-label="translate('generated.filePreviewDialog.closePreview2')"
        circle
        size="small"
        type="primary"
        @click="emit('close')"
      >
        <MarIcon name="close" />
      </el-button>
    </template>
    <main class="file-preview-content">
      <template v-if="!loading">
        <img
          v-if="kind === 'image' && contentUrl"
          class="file-binary-preview"
          :src="contentUrl"
          :alt="file.path"
        />
        <video
          v-else-if="kind === 'video' && contentUrl"
          class="file-binary-preview"
          :src="contentUrl"
          controls
          preload="metadata"
        />
        <audio
          v-else-if="kind === 'audio' && contentUrl"
          class="file-audio-preview"
          :src="contentUrl"
          controls
          preload="metadata"
        />
        <div v-else-if="kind === 'pdf' && contentUrl" class="file-pdf-preview">
          <p v-if="rendererError" class="empty">
            {{ translate('generated.filePreviewDialog.previewFailedDownloadInstead') }}
          </p>
          <template v-else>
            <PdfFilePreview
              :src="contentUrl"
              @rendered="rendererLoading = false"
              @error="rendererFailed"
            />
            <FilePreviewLoading v-if="rendererLoading" overlay />
          </template>
        </div>
        <div
          v-else-if="
            hasRenderableContent && ['document', 'spreadsheet', 'presentation'].includes(kind)
          "
          class="file-office-preview"
          :class="{
            'is-spreadsheet': kind === 'spreadsheet',
            'is-presentation': kind === 'presentation'
          }"
        >
          <p v-if="rendererError" class="empty">
            {{ translate('generated.filePreviewDialog.previewFailedDownloadInstead') }}
          </p>
          <template v-else>
            <VueOfficeDocx
              v-if="kind === 'document'"
              class="file-document-renderer"
              :src="contentUrl"
              @rendered="rendererLoading = false"
              @error="rendererFailed"
            />
            <VueOfficeExcel
              v-else-if="kind === 'spreadsheet'"
              class="file-spreadsheet-renderer"
              :src="contentUrl"
              @rendered="rendererLoading = false"
              @error="rendererFailed"
            />
            <VueOfficePptx
              v-else
              class="file-presentation-renderer"
              :src="contentUrl"
              @rendered="rendererLoading = false"
              @error="rendererFailed"
            />
            <FilePreviewLoading v-if="rendererLoading" overlay />
          </template>
        </div>
        <p v-else class="empty">
          {{ translate('generated.filePreviewDialog.thisFileTypeCannotBePreviewedIn') }}
        </p>
      </template>
    </main>
  </WorkspaceFilePageFrame>
</template>

<style scoped>
.file-preview-content {
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: auto;
}

.file-binary-preview {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.file-audio-preview {
  width: min(36rem, 100%);
}

.file-pdf-preview,
.file-office-preview {
  position: relative;
  isolation: isolate;
  width: 100%;
  height: 100%;
}

.file-office-preview {
  container-type: size;
  overflow: hidden;
}

.file-office-preview.is-spreadsheet {
  overflow: auto;
}

.file-office-preview.is-presentation {
  container-type: size;
  overflow: hidden;
}

.file-document-renderer,
.file-spreadsheet-renderer,
.file-presentation-renderer {
  width: 100%;
  height: 100%;
}

.file-presentation-renderer {
  width: min(100%, calc(100cqh * 16 / 9));
  height: 100%;
  margin: 0 auto;
}
</style>
