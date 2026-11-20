<script setup lang="ts">
import { computed, ref } from 'vue';
import { MarSwitch } from '@myagentroam/mar-ui/switch';

const draft = ref(false);
const changes = ref<boolean[]>([]);
const applied = ref(false);
const pending = ref<boolean>();
const loading = computed(() => pending.value !== undefined);

function finish(accept: boolean) {
  if (accept && pending.value !== undefined) applied.value = pending.value;
  pending.value = undefined;
}
</script>

<template>
  <main class="switch-fixture">
    <h1>Switch states</h1>
    <form>
      <div class="switch-row">
        <label for="draft">Draft setting</label>
        <MarSwitch id="draft" v-model="draft" name="draft" @change="changes.push($event)" />
      </div>
      <div class="switch-row">
        <label for="disabled">Unavailable setting</label>
        <MarSwitch id="disabled" :model-value="true" disabled />
      </div>
      <div class="switch-row">
        <label for="remote">Controlled setting</label>
        <MarSwitch
          id="remote"
          :model-value="applied"
          :loading="loading"
          @change="pending = $event"
        />
      </div>
      <output aria-label="Draft changes">{{ changes.join(',') }}</output>
      <button type="button" @click="finish(false)">Reject write</button>
      <button type="button" @click="finish(true)">Accept write</button>
    </form>
  </main>
</template>

<style scoped>
.switch-fixture {
  box-sizing: border-box;
  max-inline-size: 384px;
  margin: 12px;
  padding: 16px;
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-control);
  background: var(--mar-bg-panel);
}
.switch-fixture h1 {
  font-size: 1rem;
  margin-block: 0 8px;
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-block-size: 40px;
  border-bottom: 1px solid var(--mar-border-subtle);
}
.switch-fixture output {
  display: block;
  margin-block: 8px;
}
</style>
