<script setup lang="ts">
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';
import WorkspaceLabelsFixture from './workspace-labels-fixture.vue';
import ChatGPTManageUsageButton from '../../src/view/settings/ChatGPTManageUsageButton.vue';
import QuickPromptSettings from '../../src/view/settings/QuickPromptSettings.vue';
import { onMounted, provide, ref, useTemplateRef } from 'vue';
import { MarCascader } from '@myagentroam/mar-ui/cascader';
import { MarDatePicker } from '@myagentroam/mar-ui/date-picker';
import { MarForm, MarFormItem } from '@myagentroam/mar-ui/form';
import { MarInputNumber } from '@myagentroam/mar-ui/input-number';
import { MarLink } from '@myagentroam/mar-ui/link';
import { MarTimePicker } from '@myagentroam/mar-ui/time-picker';
import { MarTimeSelect } from '@myagentroam/mar-ui/time-select';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarSelect, MarOption } from '@myagentroam/mar-ui/select';
import { marIcon } from '@myagentroam/mar-ui/icons';
import en from '@myagentroam/mar-ui/locale/en';
import zhCn from '@myagentroam/mar-ui/locale/zh-cn';
import { marUiLocaleKey } from '@myagentroam/mar-ui/locale';
import AgentMarkdown from '../../src/view/conversation/AgentMarkdown.vue';
import { MarLoadingPanel } from '@myagentroam/mar-ui/loading-panel';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import { showMessage } from '../../src/service/message-feedback-service.js';
import { MarMessageBox } from '../../src/service/message-box-service.js';
const value = ref('');
const selection = ref('one');
const selections = ref(['one', 'unavailable']);
const menuAction = ref('');
const sampleLoading = ref(true);
const buttonLoading = ref(false);
const buttonDisabled = ref(false);
const buttonSubmissions = ref(0);
const linkVisits = ref(0);
const marInput = ref('');
const marInputDisabled = ref(false);
const marLocale = ref(en);
provide(marUiLocaleKey, marLocale);
function useChineseControls(): void {
  marLocale.value = zhCn;
  localePreferenceService().setLocale('zh-CN');
}
const marChoice = ref(false);
const longChoice = ref(36);
const showMarCommands = ref(true);
const marCommand = ref('');
const invalidForm = useTemplateRef('invalid-form');
onMounted(() => void invalidForm.value?.validate().catch(() => undefined));
async function refreshPrompts(): Promise<void> {}
async function requestPrompt<T>(): Promise<T> {
  throw new Error('This visual fixture does not persist prompts');
}
const message =
  'Body text with **emphasis** and `inline code`.\n\n### Section heading\n\n| Item | Value |\n| --- | --- |\n| Example | Readable content |';
const linkMessage = [
  '[Windows protocol](E:/project/docs/design/BLE_PROTOCOL.md#L7)',
  'README.md:10',
  '[Relative file](docs/guide.md#L3)',
  '[Temporary file](sandbox:/tmp/note.txt)',
  '[External website](https://example.com/help)',
  '[Unsafe](javascript:alert(1))'
].join('\n\n');
const openedMarkdownFiles = ref<
  {
    path: string;
    line: number | undefined;
    column: number | undefined;
    external: boolean;
  }[]
>([]);

function recordMarkdownFile(
  path: string,
  line: number | undefined,
  column: number | undefined,
  external: boolean
): void {
  openedMarkdownFiles.value.push({ path, line, column, external });
}

const dialogOpen = ref(false);

async function openConfirmation(): Promise<void> {
  await MarMessageBox.confirm('Confirm this fixture action.', 'Action confirmation').catch(
    () => undefined
  );
}

const longFeedback = Array.from(
  { length: 36 },
  (_, index) => `Line ${index + 1}: long feedback remains readable and can be dismissed.`
).join('\n');

function showRepeatedFeedback(): void {
  showMessage('Repeated feedback event', 'info');
  showMessage('Repeated feedback event', 'info');
}

function saveFeedbackDialog(): void {
  dialogOpen.value = false;
  showMessage('Dialog settings saved', 'success');
}
</script>
<template>
  <WorkspaceLabelsFixture />
  <section class="mar-control-visual-sample" aria-label="MAR field and menu states">
    <label for="mar-input-sample">MAR sample</label>
    <MarInput
      id="mar-input-sample"
      v-model="marInput"
      :prefix-icon="marIcon('search')"
      :suffix-icon="marIcon('lock')"
      autocomplete="off"
      :disabled="marInputDisabled"
    />
    <label class="mar-sample-checkbox"
      ><input v-model="marInputDisabled" type="checkbox" /> Disable sample inputs</label
    >
    <MarSelect v-model="marChoice" aria-label="MAR choice">
      <MarOption :value="false" label="First choice" />
      <MarOption :value="'disabled'" label="Unavailable choice" disabled />
      <MarOption :value="true" label="Second choice" />
    </MarSelect>
    <output aria-label="Selected value">{{ marChoice }}</output>
    <MarDropdown v-if="showMarCommands" trigger="click" @command="marCommand = $event">
      <MarButton id="mar-command-trigger" text icon="more" aria-label="MAR commands" />
      <template #dropdown>
        <MarDropdownMenu>
          <MarDropdownItem command="apply">Apply command</MarDropdownItem>
          <MarDropdownItem command="unavailable" disabled>Unavailable command</MarDropdownItem>
          <MarDropdownItem command="reset" divided icon="undo">Reset command</MarDropdownItem>
        </MarDropdownMenu>
      </template>
    </MarDropdown>
    <MarButton @click="showMarCommands = false">Remove MAR menu</MarButton>
    <output aria-label="Last command">{{ marCommand }}</output>
  </section>
  <section class="mar-control-visual-sample" aria-label="MAR localized controls">
    <MarSelect aria-label="Empty choice" />
    <MarButton @click="useChineseControls">Switch controls to Chinese</MarButton>
  </section>
  <section class="mar-control-visual-sample" aria-label="MAR scrolling choices">
    <label id="long-choice-label" for="long-choice">Long choice</label>
    <MarSelect id="long-choice" v-model="longChoice" aria-labelledby="long-choice-label">
      <MarOption v-for="number in 36" :key="number" :value="number" :label="`Choice ${number}`" />
    </MarSelect>
    <output aria-label="Confirmed choice">{{ longChoice }}</output>
  </section>
  <section class="mar-control-visual-sample" aria-label="MAR scrolling commands">
    <MarDropdown trigger="click">
      <MarButton>Long command menu</MarButton>
      <template #dropdown>
        <MarDropdownMenu>
          <MarDropdownItem v-for="number in 36" :key="number" :command="number">
            Command {{ number }}
          </MarDropdownItem>
        </MarDropdownMenu>
      </template>
    </MarDropdown>
  </section>
  <section class="mar-control-visual-sample" aria-label="MAR button states">
    <form
      @submit.prevent="
        buttonSubmissions += 1;
        buttonLoading = true;
      "
    >
      <label>Action input <input /></label>
      <MarButton
        type="primary"
        native-type="submit"
        :icon="marIcon('check')"
        :loading="buttonLoading"
        :disabled="buttonDisabled"
      >
        Submit action
      </MarButton>
      <MarButton :loading="buttonLoading">Text action</MarButton>
      <MarButton aria-label="Idle text reference">Text action</MarButton>
      <MarButton :icon="marIcon('refresh')" aria-label="Refresh action" :loading="buttonLoading" />
      <MarButton @click="buttonLoading = false">Finish action</MarButton>
      <label class="mar-sample-checkbox"
        ><input v-model="buttonDisabled" type="checkbox" /> Disable submit action</label
      >
      <output aria-label="Submission count">{{ buttonSubmissions }}</output>
    </form>
    <MarButton
      tag="a"
      :disabled="buttonDisabled"
      href="#button-link-target"
      @click="linkVisits += 1"
    >
      Open destination
    </MarButton>
    <output id="button-link-target" aria-label="Link activation count">{{ linkVisits }}</output>
  </section>
  <section aria-label="Real management actions">
    <QuickPromptSettings
      :prompts="[
        { id: 'visual-prompt', phrase: 'review', prompt: 'Review this change', updatedAt: 0 }
      ]"
      :loading="false"
      :failed="false"
      :refresh="refreshPrompts"
      :request="requestPrompt"
    />
  </section>
  <section aria-label="Real theme controls">
    <MarInput v-model="value" aria-label="Sample input" />
    <MarSelect v-model="value" aria-label="Sample select">
      <MarOption label="One" value="one" />
    </MarSelect>
    <MarButton>Sample default</MarButton>
    <MarButton disabled>Sample disabled default</MarButton>
    <MarButton type="primary">Sample primary</MarButton>
    <MarButton type="warning">Sample filled warning</MarButton>
    <MarButton type="danger">Sample filled danger</MarButton>
    <MarButton type="primary" disabled>Sample disabled primary</MarButton>
    <MarButton type="primary" link>Sample link</MarButton>
    <MarButton type="primary" link disabled>Sample disabled link</MarButton>
    <MarButton link>Sample neutral action</MarButton>
    <MarButton link disabled>Sample disabled neutral action</MarButton>
    <MarButton link type="danger">Sample dangerous action</MarButton>
    <div v-for="type in ['warning', 'danger'] as const" :key="type">
      <MarButton :type="type" link :icon="marIcon('delete')">Sample {{ type }} action</MarButton>
      <MarButton :type="type" link disabled :icon="marIcon('delete')"
        >Sample disabled {{ type }} action</MarButton
      >
    </div>
    <ChatGPTManageUsageButton />
    <MarLink type="primary" href="#button-link-target">Sample anchor</MarLink>
    <MarTable :data="[{ name: 'First' }, { name: 'Second' }]">
      <MarTableColumn prop="name" label="Name" />
    </MarTable>
  </section>
  <section aria-label="Select state samples">
    <MarSelect v-model="selection" aria-label="Neutral select">
      <MarOption label="One" value="one" />
      <MarOption label="Two" value="two" />
      <MarOption label="Unavailable" value="unavailable" disabled />
    </MarSelect>
    <MarSelect v-model="selections" aria-label="Multiple select" multiple>
      <MarOption label="One" value="one" />
      <MarOption label="Two" value="two" />
      <MarOption label="Unavailable" value="unavailable" disabled />
    </MarSelect>
    <MarSelect v-model="selection" aria-label="Disabled select" disabled>
      <MarOption label="One" value="one" />
    </MarSelect>
  </section>
  <section aria-label="Standard field boundaries">
    <MarInput aria-label="Text field" model-value="Value" />
    <MarInput type="textarea" aria-label="Textarea field" model-value="Value" />
    <MarInputNumber aria-label="Number field" :model-value="2" />
    <MarSelect v-model="selection" aria-label="Select field">
      <MarOption label="One" value="one" />
    </MarSelect>
    <MarCascader placeholder="Cascader field" :options="[{ value: 'one', label: 'One' }]" />
    <MarDatePicker placeholder="Single date field" type="date" />
    <MarDatePicker type="datetimerange" start-placeholder="Start date" end-placeholder="End date" />
    <MarTimeSelect aria-label="Time select field" />
    <MarTimePicker placeholder="Single time field" />
    <MarInput aria-label="Disabled text field" disabled model-value="Value" />
    <MarSelect :model-value="selection" aria-label="Disabled field" disabled>
      <MarOption label="One" value="one" />
    </MarSelect>
    <MarDatePicker
      type="datetimerange"
      start-placeholder="Disabled start date"
      end-placeholder="Disabled end date"
      disabled
    />
    <MarForm
      ref="invalid-form"
      :model="{}"
      :rules="{
        select: { required: true, message: 'Select a value' },
        range: { required: true, message: 'Select a date range' }
      }"
    >
      <MarFormItem prop="select">
        <MarSelect aria-label="Invalid field">
          <MarOption label="One" value="one" />
        </MarSelect>
      </MarFormItem>
      <MarFormItem prop="range">
        <MarDatePicker
          type="datetimerange"
          start-placeholder="Invalid start date"
          end-placeholder="Invalid end date"
        />
      </MarFormItem>
    </MarForm>
  </section>
  <section aria-label="Dropdown state samples">
    <MarDropdown trigger="click" @command="menuAction = $event">
      <button type="button" class="mar-icon-action">Sample menu</button>
      <template #dropdown>
        <MarDropdownMenu>
          <MarDropdownItem command="rename" icon="edit">Rename</MarDropdownItem>
          <MarDropdownItem command="copy" icon="copy">Copy</MarDropdownItem>
          <MarDropdownItem command="unavailable" disabled>Unavailable</MarDropdownItem>
          <MarDropdownItem command="delete" icon="delete" divided>Delete</MarDropdownItem>
        </MarDropdownMenu>
      </template>
    </MarDropdown>
    <output aria-label="Selected menu action">{{ menuAction }}</output>
  </section>
  <section class="conversation-typography-fixture" aria-label="Real conversation typography">
    <AgentMarkdown :content="message" />
    <p class="conversation-metadata">Run duration 11s</p>
  </section>
  <section aria-label="Conversation file links">
    <AgentMarkdown
      :content="linkMessage"
      workspace-root="E:/project"
      @open-file="recordMarkdownFile"
    />
    <output aria-label="Opened Markdown files">{{ JSON.stringify(openedMarkdownFiles) }}</output>
  </section>
  <section aria-label="Message feedback controls">
    <button
      type="button"
      data-testid="show-info-feedback"
      @click="showMessage('Theme-aware info feedback', 'info')"
    >
      Show info feedback
    </button>
    <button
      type="button"
      data-testid="show-success-feedback"
      @click="showMessage('Theme-aware success feedback', 'success')"
    >
      Show success feedback
    </button>
    <button
      type="button"
      data-testid="show-warning-feedback"
      @click="showMessage('Theme-aware warning feedback', 'warning')"
    >
      Show warning feedback
    </button>
    <button
      type="button"
      data-testid="show-error-feedback"
      @click="showMessage('Theme-aware error feedback', 'error')"
    >
      Show error feedback
    </button>
    <button
      type="button"
      data-testid="show-long-feedback"
      @click="showMessage(longFeedback, 'error')"
    >
      Show long feedback
    </button>
    <button
      type="button"
      data-testid="show-plain-text-feedback"
      @click="showMessage('Plain text <img data-feedback-payload=unsafe src=x>', 'warning')"
    >
      Show plain-text feedback
    </button>
    <button type="button" data-testid="show-repeated-feedback" @click="showRepeatedFeedback">
      Show repeated feedback
    </button>
    <button type="button" data-testid="open-feedback-dialog" @click="dialogOpen = true">
      Open feedback dialog
    </button>
    <button type="button" data-testid="open-close-confirmation" @click="openConfirmation">
      Open confirmation
    </button>
    <MarDialog v-if="dialogOpen" v-model="dialogOpen" title="Message feedback dialog">
      <p>Dialog content</p>
      <button
        type="button"
        data-testid="show-dialog-feedback"
        @click="showMessage(longFeedback, 'error')"
      >
        Show dialog feedback
      </button>
      <button type="button" data-testid="save-feedback-dialog" @click="saveFeedbackDialog">
        Save and close
      </button>
    </MarDialog>
  </section>
  <section aria-label="Loading directive sample">
    <button type="button" @click="sampleLoading = !sampleLoading">Toggle sample loading</button>
    <MarLoadingPanel :loading="sampleLoading" variant="region">Content</MarLoadingPanel>
  </section>
</template>

<style scoped>
.mar-control-visual-sample {
  display: grid;
  gap: 0.375rem;
  inline-size: min(100%, 30rem);
  padding: 0.75rem;
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-control);
  background: var(--mar-bg-panel);
}

.mar-control-visual-sample form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
}

.mar-control-visual-sample .mar-sample-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}

.mar-control-visual-sample > .mar-ui-button {
  justify-self: start;
}

.conversation-typography-fixture {
  margin-top: 1rem;
  background: var(--mar-conversation-canvas);
  padding: 1rem;
}

.conversation-metadata {
  color: var(--mar-text-secondary);
}
</style>
