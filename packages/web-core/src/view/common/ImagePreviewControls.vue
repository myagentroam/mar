<script lang="ts">
import type { ImagePreviewPoint } from '../../util/image-preview-geometry.js';

export interface ImagePreviewControlState {
  readonly canZoomOut: boolean;
  readonly canZoomIn: boolean;
  readonly canPan: boolean;
  readonly zoomBy: (factor: number) => void;
  readonly fit: () => void;
  readonly canPanToward: (direction: ImagePreviewPoint) => boolean;
  readonly panByViewportStep: (direction: ImagePreviewPoint) => void;
}
</script>

<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { marIcon } from '@myagentroam/mar-ui/icons';
import { translate } from '../../service/locale-preference-service.js';

defineProps<{ controls: ImagePreviewControlState; placement?: 'top' | 'bottom' }>();

const directions = [
  { key: 'up', icon: 'chevron-up', x: 0, y: 1 },
  { key: 'down', icon: 'chevron-down', x: 0, y: -1 },
  { key: 'left', icon: 'chevron-left', x: 1, y: 0 },
  { key: 'right', icon: 'chevron-right', x: -1, y: 0 }
] as const;
</script>

<template>
  <div
    class="mar-image-preview-controls"
    role="group"
    :aria-label="translate('imageViewport.actions')"
  >
    <MarButton
      class="image-preview-control"
      v-tooltip="translate('imageViewport.zoomOut')"
      :aria-label="translate('imageViewport.zoomOut')"
      :icon="marIcon('zoom-out')"
      :disabled="!controls.canZoomOut"
      circle
      @click="controls.zoomBy(1 / 1.5)"
    />
    <MarButton
      class="image-preview-control"
      v-tooltip="translate('imageViewport.fit')"
      :aria-label="translate('imageViewport.fit')"
      :icon="marIcon('fit')"
      :disabled="!controls.canZoomOut"
      circle
      @click="controls.fit()"
    />
    <MarButton
      class="image-preview-control"
      v-tooltip="translate('imageViewport.zoomIn')"
      :aria-label="translate('imageViewport.zoomIn')"
      :icon="marIcon('zoom-in')"
      :disabled="!controls.canZoomIn"
      circle
      @click="controls.zoomBy(1.5)"
    />
    <MarDropdown :placement="placement ?? 'top'" :disabled="!controls.canPan">
      <MarButton
        class="image-preview-control"
        v-tooltip="translate('imageViewport.pan.label')"
        :aria-label="translate('imageViewport.pan.label')"
        :icon="marIcon('pan')"
        circle
      />
      <template #dropdown>
        <MarDropdownMenu :aria-label="translate('imageViewport.pan.label')">
          <MarDropdownItem
            v-for="direction in directions"
            :key="direction.key"
            :icon="direction.icon"
            :disabled="!controls.canPanToward(direction)"
            @click="controls.panByViewportStep(direction)"
          >
            {{ translate(`imageViewport.pan.${direction.key}`) }}
          </MarDropdownItem>
        </MarDropdownMenu>
      </template>
    </MarDropdown>
  </div>
</template>

<style scoped>
.mar-image-preview-controls {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--image-action-gap, 0.375rem);
}

.mar-image-preview-controls > .image-preview-control {
  margin-inline-start: 0;
}
</style>
