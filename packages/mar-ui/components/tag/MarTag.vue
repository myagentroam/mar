<script setup lang="ts">
import type { TagProps } from './tag-types.js';

withDefaults(defineProps<TagProps>(), { type: 'primary', effect: 'light' });
</script>

<template>
  <span class="mar-ui-tag" :data-type="type" :data-effect="effect"><slot /></span>
</template>

<style scoped>
.mar-ui-tag {
  --tag-fg: var(--mar-ui-control-link-text);
  --tag-tint: var(--mar-ui-color-brand);
  --tag-fill: color-mix(in srgb, var(--tag-tint) 10%, transparent);
  display: inline-flex;
  box-sizing: border-box;
  max-inline-size: 100%;
  flex: none;
  align-items: center;
  min-block-size: 20px;
  padding-inline: 0.375rem;
  border: 1px solid
    var(--mar-ui-tag-border-color, color-mix(in srgb, var(--tag-tint) 20%, var(--mar-ui-bg-panel)));
  border-radius: var(--mar-ui-radius-control);
  background: var(--tag-fill);
  color: var(--mar-ui-tag-text-color, var(--tag-fg));
  font-size: var(--mar-ui-font-size-meta);
  line-height: 1.3;
  vertical-align: middle;
  white-space: nowrap;
}
[data-type='info'] {
  --tag-fg: var(--mar-ui-text-secondary);
  --tag-tint: var(--tag-fg);
  --tag-fill: var(--mar-ui-fill-subtle);
}
[data-type='success'] {
  --tag-fg: var(--mar-ui-color-success-text);
  --tag-tint: var(--tag-fg);
  --tag-fill: var(--mar-ui-color-success-bg);
}
[data-type='warning'] {
  --tag-fg: var(--mar-ui-color-warning-text);
  --tag-tint: var(--tag-fg);
  --tag-fill: var(--mar-ui-color-warning-bg);
}
[data-type='danger'] {
  --tag-fg: var(--mar-ui-color-danger-text);
  --tag-tint: var(--tag-fg);
  --tag-fill: var(--mar-ui-color-danger-bg);
}
[data-effect='plain'] {
  background: var(--mar-ui-bg-panel);
}
</style>
