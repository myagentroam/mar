<script setup lang="ts">
import { vMarLoading } from '@myagentroam/mar-ui/loading';
import { showMessage } from '../../src/service/message-feedback-service.js';
import SharedTooltipHost from '../../src/view/overlays/SharedTooltipHost.vue';
import { ref } from 'vue';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarMessageBox } from '../../src/service/message-box-service.js';

const open = ref(false);
const loading = ref(false);
const child = ref(false);
const third = ref(false);
const showThirdOpener = ref(true);
const focusDraft = ref(false);
const locked = ref(false);
const forbidBackdrop = ref(false);
const forbidEscape = ref(false);
const closed = ref(0);
const dirty = ref('');
const messageResult = ref('None');
let finish: ((cancel?: boolean) => void) | undefined;

function guard(done: (cancel?: boolean) => void) {
  if (!locked.value) return done();
  finish = done;
  child.value = true;
}

function answer(cancel: boolean) {
  child.value = false;
  finish?.(cancel);
  finish = undefined;
}

function opened() {
  dirty.value = '';
  open.value = true;
}

async function prompt() {
  try {
    const result = await MarMessageBox.prompt('Choose a label.', 'Rename record', {
      inputValue: 'Initial',
      inputPlaceholder: 'Record name',
      inputValidator: (value) => value.trim().length > 0 || 'A name is required',
      confirmButtonText: 'Save name',
      cancelButtonText: 'Cancel editing'
    });
    messageResult.value = result.value;
  } catch (error) {
    messageResult.value = String(error);
  }
}
</script>

<template>
  <SharedTooltipHost />
  <div id="confirmation-host"></div>
  <button type="button" @click="opened">Open editor</button>
  <button type="button" @click="prompt">Open prompt</button>
  <button type="button" @click="MarMessageBox.alert('Operation completed.', 'Result')">
    Open alert
  </button>
  <button type="button" @click="showMessage('Background saved', 'success')">
    Background command
  </button>
  <button type="button" @click="showMessage('Usage authentication failed.', 'error')">
    Complete failed usage request
  </button>
  <label><input v-model="locked" type="checkbox" /> Guard close</label>
  <label><input v-model="focusDraft" type="checkbox" /> Autofocus draft</label>
  <label><input v-model="forbidBackdrop" type="checkbox" /> Disable backdrop</label>
  <label><input v-model="forbidEscape" type="checkbox" /> Disable Escape</label>
  <span role="status">Closed {{ closed }}</span>
  <label><input v-model="loading" type="checkbox" /> Load region</label>
  <section v-mar-loading:region="loading" aria-label="Record results">Retained record</section>
  <output aria-label="Prompt result">{{ messageResult }}</output>
  <MarDialog
    v-if="open"
    v-model="open"
    title="Edit record"
    width="min(520px, calc(100vw - 32px))"
    append-to-body
    :close-on-press-escape="!forbidEscape"
    :close-on-click-modal="!forbidBackdrop"
    :before-close="guard"
    @closed="closed += 1"
  >
    <MarInput v-model="dirty" aria-label="Draft" :autofocus="focusDraft" />
    <button type="button" v-tooltip="'Help for this field'">Field help</button>
    <button type="button" @click="showMessage('<b>Draft saved</b>', 'success')">Save draft</button>
    <p v-for="i in 40" :key="i">Content line {{ i }}</p>
    <template #footer>
      <button type="button" @click="prompt">Rename inside editor</button>
      <button type="button" @click="open = false">Owner close</button>
    </template>
    <Teleport to="#confirmation-host">
      <!-- Keep the later-opened confirmation before its parent in DOM order. -->
      <MarDialog v-if="child" v-model="child" title="Discard changes?">
        <button type="button" @click="answer(true)">Keep draft</button>
        <button type="button" @click="answer(false)">Discard draft</button>
        <button v-if="showThirdOpener" type="button" @click="third = true">
          Open more options
        </button>
        <MarDialog v-if="third" v-model="third" append-to-body title="More options">
          <button
            type="button"
            @click="
              showThirdOpener = false;
              third = false;
            "
          >
            Remove opener and close
          </button>
        </MarDialog>
      </MarDialog>
    </Teleport>
  </MarDialog>
</template>
