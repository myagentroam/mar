<script setup lang="ts">
import { provide, ref } from 'vue';
import { MarAlert } from '@myagentroam/mar-ui/alert';
import { MarCascader } from '@myagentroam/mar-ui/cascader';
import { MarCheckbox, MarCheckboxGroup } from '@myagentroam/mar-ui/checkbox';
import { MarDatePicker } from '@myagentroam/mar-ui/date-picker';
import { MarDescriptions, MarDescriptionsItem } from '@myagentroam/mar-ui/descriptions';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { MarForm, MarFormItem } from '@myagentroam/mar-ui/form';
import { MarInputNumber } from '@myagentroam/mar-ui/input-number';
import { marUiLocaleKey } from '@myagentroam/mar-ui/locale';
import en from '@myagentroam/mar-ui/locale/en';
import zhCn from '@myagentroam/mar-ui/locale/zh-cn';
import { MarRadioButton, MarRadioGroup } from '@myagentroam/mar-ui/radio';
import { MarSegmented } from '@myagentroam/mar-ui/segmented';
import { MarTabs, MarTabPane } from '@myagentroam/mar-ui/tabs';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarTimePicker } from '@myagentroam/mar-ui/time-picker';
import { MarTimeSelect } from '@myagentroam/mar-ui/time-select';

const locale = ref(en);
provide(marUiLocaleKey, locale);
const selected = ref<string[]>([]);
const radio = ref('a');
const quantity = ref<number | undefined>(2);
const quantityChanges = ref<string[]>([]);
const tab = ref('first');
const segment = ref('day');
const owner = ref<number>();
const controls = ref({
  time: '08:00' as string | null,
  minutes: undefined as string | undefined,
  range: null as [Date, Date] | null
});
const changes = ref(0);
const timeChanges = ref(0);
const expiration = ref<Date | null>(null);
const showCommandMenu = new URLSearchParams(location.search).has('command-menu');
const organizations = [
  {
    value: 1,
    label: 'Platform',
    children: [
      { value: 2, label: 'Release' },
      { value: 3, label: 'Operations', children: [{ value: 4, label: 'Support' }] }
    ]
  }
];
</script>

<template>
  <article>
    <h1>MAR controls</h1>
    <div
      v-if="showCommandMenu"
      style="position: fixed; inset-block-start: 16px; inset-inline-end: 8px"
    >
      <MarDropdown trigger="click">
        <button>Commands</button>
        <template #dropdown>
          <MarDropdownMenu>
            <MarDropdownItem command="copy">Copy</MarDropdownItem>
            <MarDropdownItem command="rename">Rename</MarDropdownItem>
          </MarDropdownMenu>
        </template>
      </MarDropdown>
    </div>
    <section aria-label="Display controls">
      <MarTag type="success" effect="plain">Available</MarTag>
      <MarAlert
        title="Review needed"
        description="Changes are saved as a draft."
        type="warning"
        show-icon
        :closable="false"
      />
      <MarDescriptions :column="2" border>
        <MarDescriptionsItem label="Workspace">Test fixture</MarDescriptionsItem>
        <MarDescriptionsItem label="Long value"
          >SomePathWithoutSpaces/Segment/AnotherSegment</MarDescriptionsItem
        >
      </MarDescriptions>
    </section>
    <section aria-label="Interaction controls">
      <MarCheckboxGroup v-model="selected" aria-label="Permissions"
        ><MarCheckbox value="read">Read</MarCheckbox
        ><MarCheckbox value="write" disabled>Write</MarCheckbox></MarCheckboxGroup
      >
      <MarRadioGroup v-model="radio" aria-label="Metric"
        ><MarRadioButton value="a">Tokens</MarRadioButton
        ><MarRadioButton value="b">Requests</MarRadioButton></MarRadioGroup
      >
      <MarInputNumber
        v-model="quantity"
        :min="1"
        :max="3"
        aria-label="Quantity"
        @change="(value, previous) => quantityChanges.push(`${previous}->${value}`)"
        ><template #decrease-icon
          ><span aria-hidden="true" data-test-icon>−</span></template
        ></MarInputNumber
      >
      <output aria-label="Quantity value">{{ String(quantity) }}</output>
      <output aria-label="Quantity changes">{{ quantityChanges.join(',') }}</output>
      <MarTabs v-model="tab"
        ><MarTabPane name="first" label="Overview">Overview panel</MarTabPane
        ><MarTabPane name="second" label="Details">Details panel</MarTabPane></MarTabs
      >
      <output aria-label="Permissions value">{{ selected.join(',') }}</output>
      <MarSegmented
        v-model="segment"
        label="Period"
        :options="[
          { value: 'day', label: 'Day' },
          { value: 'week', label: 'Week' }
        ]"
      />
      <output aria-label="Metric value">{{ radio }}</output>
    </section>
    <section aria-label="Complex fields">
      <MarForm :model="controls">
        <MarFormItem label="Owner"
          ><MarCascader
            v-model="owner"
            :options="organizations"
            :props="{ checkStrictly: true, emitPath: false }"
            filterable
            clearable
        /></MarFormItem>
        <MarFormItem label="Range"
          ><MarDatePicker
            v-model="controls.range"
            type="datetimerange"
            single-panel
            @change="changes++"
        /></MarFormItem>
        <MarFormItem label="Time" prop="time"
          ><MarTimePicker
            v-model="controls.time"
            format="HH:mm"
            value-format="HH:mm"
            @change="timeChanges++"
        /></MarFormItem>
        <MarFormItem label="Minutes" prop="minutes"
          ><MarTimeSelect
            v-model="controls.minutes"
            start="00:05"
            end="00:15"
            step="00:05"
            prefix-icon="clock"
        /></MarFormItem>
      </MarForm>
      <output aria-label="Owner value">{{ owner }}</output>
      <output aria-label="Range changes">{{ changes }}</output>
      <output aria-label="Range value">{{
        controls.range?.map((date) => date.getHours()).join(',')
      }}</output>
      <output aria-label="Time value">{{ String(controls.time) }}</output>
      <output aria-label="Time changes">{{ timeChanges }}</output>
      <output aria-label="Minute value">{{ String(controls.minutes) }}</output>
      <button type="button" @click="locale = zhCn">Chinese controls</button>
    </section>
    <section aria-label="Expiration field">
      <MarDatePicker v-model="expiration" type="datetime" aria-label="Expires at" clearable />
      <output aria-label="Expiration value">{{
        expiration ? expiration.toISOString() : ''
      }}</output>
    </section>
  </article>
</template>

<style scoped>
article {
  max-width: 46rem;
  margin: 1rem auto;
  padding: 0 1rem;
  color: var(--mar-text-primary);
}
section {
  grid-template-columns: minmax(0, 1fr);
  display: grid;
  justify-items: start;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}
.mar-ui-form {
  width: 100%;
  min-width: 0;
}
</style>
