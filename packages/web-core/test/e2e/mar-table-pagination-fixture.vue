<script setup lang="ts">
import { ref } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarPagination } from '@myagentroam/mar-ui/pagination';
import { MarTable, MarTableColumn } from '@myagentroam/mar-ui/table';

const rows = ref([
  { id: 'a', name: 'Zulu', details: { value: 2 }, note: 'Brief' },
  {
    id: 'b',
    name: 'Alpha',
    details: { value: 10 },
    note: 'Long unbroken value: abcdefghijklmnopqrstuvwxyz0123456789'
  }
]);
const organizationTree = [
  {
    id: 'root',
    name: 'Parent',
    children: [
      { id: 'leaf', name: 'Child' },
      { id: 'match', name: 'Matching organization' }
    ]
  }
];
const trees = ref(organizationTree);
const treeProps = { children: 'children' };
const expanded = ref<string[]>([]);
const extra = ref(false);
const clicks = ref('');
const sorts = ref('');
const page = ref(1);
const requested = ref(1);
const total = ref(200);
const disabled = ref(false);
const pageChanges = ref<number[]>([]);

function updateExpanded(_row: unknown, entries: (typeof rows)['value'] | boolean): void {
  if (Array.isArray(entries)) expanded.value = entries.map((row) => row.id);
}

function recordSort({ prop, order }: { prop: string; order: string | null }): void {
  sorts.value = `${prop}:${order ?? 'none'}`;
}

function requestPage(value: number): void {
  requested.value = value;
  pageChanges.value.push(value);
}

function filterOrganizations(): void {
  const root = organizationTree[0]!;
  trees.value = [{ ...root, children: root.children.filter(({ id }) => id === 'match') }];
}
</script>

<template>
  <main>
    <button type="button" @click="extra = !extra">Toggle column</button>
    <button type="button" @click="rows[1]!.note = `Updated ${rows[1]!.note}`">Refresh note</button>
    <p id="note-context">Note context</p>
    <MarTable
      aria-label="Records"
      :data="rows"
      row-key="id"
      :expand-row-keys="expanded"
      @expand-change="updateExpanded"
      @sort-change="recordSort"
      @row-click="(row) => (clicks = row.name)"
    >
      <MarTableColumn type="expand">
        <template #default="{ row }">Details for {{ row.name }}</template>
      </MarTableColumn>
      <MarTableColumn label="Name" prop="name" sortable min-width="120" />
      <MarTableColumn v-if="extra" label="Extra" prop="details.value" min-width="90" />
      <MarTableColumn label="Remote" prop="details.value" sortable="custom" min-width="100" />
      <MarTableColumn label="Note" prop="note" width="120" show-overflow-tooltip>
        <template #default="{ row }">
          <a href="#note-context" aria-describedby="note-context" @click.prevent>{{ row.note }}</a>
        </template>
      </MarTableColumn>
      <MarTableColumn label="Action" width="100">
        <template #default="{ row, $index }">
          <MarButton @click.stop="clicks = `action:${row.name}`"> Act {{ $index }} </MarButton>
        </template>
      </MarTableColumn>
    </MarTable>
    <output aria-label="Click">{{ clicks }}</output>
    <output aria-label="Sort">{{ sorts }}</output>
    <output aria-label="Expanded rows">{{ expanded.join(',') }}</output>

    <button type="button" @click="filterOrganizations">Filter organizations</button>
    <MarTable
      aria-label="Organizations"
      :data="trees"
      row-key="id"
      default-expand-all
      :tree-props="treeProps"
    >
      <MarTableColumn label="Organization" prop="name" />
    </MarTable>
    <MarTable aria-label="Empty table" :data="[]" empty-text="Nothing here">
      <MarTableColumn label="Name" prop="name" />
    </MarTable>
    <MarTable aria-label="Narrow columns" class="narrow-columns" :data="rows">
      <MarTableColumn label="Configuration" prop="name" width="76" sortable />
      <MarTableColumn label="Synchronization" prop="note" width="86" />
      <MarTableColumn label="Action" width="100" />
    </MarTable>

    <MarPagination
      :current-page="page"
      :total="total"
      :page-size="10"
      :pager-count="5"
      :disabled="disabled"
      layout="total, prev, pager, next"
      background
      @current-change="requestPage"
    />
    <button type="button" @click="page = requested">Accept page</button>
    <button type="button" @click="disabled = !disabled">Toggle disabled</button>
    <button type="button" @click="total = 60">Use six pages</button>
    <button type="button" @click="total = 10">Shrink total</button>
    <output aria-label="Requests">{{ pageChanges.join(',') }}</output>
  </main>
</template>

<style scoped>
main {
  max-inline-size: 620px;
  padding: 12px;
}
.narrow-columns {
  max-inline-size: 262px;
}
</style>
