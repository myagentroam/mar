<script setup lang="ts">
import { getCurrentInstance, onBeforeUnmount, ref } from 'vue';
import WorkspaceFileTree from '../../src/view/workspace/WorkspaceFileTree.vue';
import AgentMarkdown from '../../src/view/common/AgentMarkdown.vue';
import type { WorkspaceFileTreeNode } from '../../src/service/workspace-file-tree-service.js';
import { createRunnerInteractionService } from '../../src/service/runner-interaction-service.js';
import { createMobileSurfaceFocusService } from '../../src/service/mobile-surface-focus-service.js';

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
const dialogOpen = ref(false);
const editing = ref(true);
const selection = ref('one');
const menuActions = ref(0);
const mobileSidebarOpen = ref(false);
const mobileSidebar = ref<HTMLElement>();
const mobileFocus = createMobileSurfaceFocusService({
  isOpen: () => mobileSidebarOpen.value,
  regions: () => [mobileSidebar.value],
  close: () => (mobileSidebarOpen.value = false)
});
onBeforeUnmount(mobileFocus.dispose);
const runStops = ref(0);
const runInput = ref('');
const runner = createRunnerInteractionService({
  input: runInput,
  draftSessionOpen: ref(false),
  selectedSession: ref(undefined),
  profile: ref(undefined)
});
function onRunKeydown(event: KeyboardEvent): void {
  runner.onKeydown(event, {
    mobile: false,
    canInterrupt: true,
    stop: () => runStops.value++,
    send: () => undefined
  });
}
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
    <button data-testid="open-escape-dialog" @click="dialogOpen = true">Open Escape dialog</button>
    <output data-testid="menu-actions">{{ menuActions }}</output>
    <textarea v-model="runInput" aria-label="Running composer" @keydown="onRunKeydown" />
    <button v-tooltip="'Run action details'">Run action hint</button>
    <output data-testid="run-stops">{{ runStops }}</output>
    <button data-testid="open-mobile-sidebar" @click="mobileSidebarOpen = true">
      Open mobile sidebar
    </button>
    <aside v-if="mobileSidebarOpen" ref="mobileSidebar" aria-label="Mobile sidebar" tabindex="-1">
      <el-dropdown trigger="click" @command="menuActions++">
        <button>Mobile sidebar menu</button>
        <template #dropdown>
          <div v-tooltip="'Mobile menu action details'">
            <el-dropdown-menu>
              <el-dropdown-item command="action">Mobile menu action</el-dropdown-item>
            </el-dropdown-menu>
          </div>
        </template>
      </el-dropdown>
    </aside>
    <el-dialog v-if="dialogOpen" v-model="dialogOpen" title="Escape ownership">
      <input
        v-if="editing"
        v-tooltip="'Cancel editing with Escape'"
        aria-label="Inline edit"
        @keydown.esc="editing = false"
      />
      <output v-else data-testid="edit-cancelled">Edit cancelled</output>
      <div v-tooltip="'Select details'">
        <el-select v-model="selection" aria-label="Escape select" filterable>
          <el-option label="One" value="one" />
          <el-option label="Two" value="two" />
        </el-select>
      </div>
      <el-dropdown trigger="click" @command="menuActions++">
        <button>Escape menu</button>
        <template #dropdown>
          <div v-tooltip="'Menu action details'">
            <el-dropdown-menu>
              <el-dropdown-item command="action">Menu action</el-dropdown-item>
            </el-dropdown-menu>
          </div>
        </template>
      </el-dropdown>
    </el-dialog>
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
    <AgentMarkdown v-if="mounted" :content="'```text\n' + label + '\n```'" />
  </main>
</template>
