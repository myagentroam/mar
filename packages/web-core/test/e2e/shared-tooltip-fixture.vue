<script setup lang="ts">
import { getCurrentInstance, ref } from 'vue';
import WorkspaceFileTree from '../../src/view/workspace/WorkspaceFileTree.vue';
import type { WorkspaceFileTreeNode } from '../../src/service/workspace-file-tree-service.js';

const root: WorkspaceFileTreeNode = {
  path: '.',
  name: 'Fixture workspace',
  kind: 'DIRECTORY',
  size: null,
  children: [],
  expanded: true,
  loaded: true,
  loading: false,
  nextCursor: null,
  placeholder: false
};

const count = ref(1000);
const label = ref('Original');
const shown = ref(true);
const mounted = ref(true);
const disabled = ref(false);
const live = ref(0);
const created = ref(0);
getCurrentInstance()!.appContext.app.mixin({
  created() {
    if (this.$options.name === 'ElTooltip') {
      live.value++;
      created.value++;
    }
  },
  unmounted() {
    if (this.$options.name === 'ElTooltip') live.value--;
  }
});
</script>

<template>
  <main style="padding: 24px">
    <section style="height: 80px">
      <WorkspaceFileTree
        :root="root"
        filter=""
        :selected-path="undefined"
        :disabled="false"
        :mutations-enabled="false"
        :mobile-viewport="false"
      />
    </section>
    <output data-testid="tooltip-live">{{ live }}</output>
    <output data-testid="tooltip-created">{{ created }}</output>
    <p id="existing-description">Existing description</p>
    <button data-testid="rename" @click="label = 'Updated'">Rename</button>
    <button data-testid="disable" @click="disabled = !disabled">Toggle disabled hint</button>
    <button data-testid="hide" @click="shown = !shown">Toggle visibility</button>
    <button data-testid="remove" @click="mounted = !mounted">Toggle mounted list</button>
    <button data-testid="grow" @click="count = 2000">Grow list</button>
    <div
      v-if="mounted"
      v-show="shown"
      data-testid="tooltip-list"
      style="height: 240px; overflow: auto; width: 320px; margin-top: 20px"
    >
      <button
        v-for="index in count"
        :key="index"
        v-tooltip="{ content: `${label} ${index}`, disabled, touch: index === 1 }"
        :data-row="index"
        aria-describedby="existing-description"
        aria-haspopup="menu"
        aria-expanded="false"
        style="display: block; width: 200px; height: 32px"
      >
        <span>Item {{ index }}</span>
      </button>
    </div>
  </main>
</template>
