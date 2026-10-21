<script setup lang="ts">
import { ref } from 'vue';
const value = ref('');
</script>
<template>
  <section aria-label="Real theme controls">
    <el-input v-model="value" aria-label="Sample input" />
    <el-select v-model="value" aria-label="Sample select">
      <el-option label="One" value="one" />
    </el-select>
    <el-button>Sample default</el-button>
    <el-button type="primary">Sample primary</el-button>
    <el-button type="primary" disabled>Sample disabled primary</el-button>
    <el-button type="primary" link>Sample link</el-button>
    <el-button type="primary" link disabled>Sample disabled link</el-button>
    <el-link type="primary">Sample anchor</el-link>
    <el-table :data="[{ name: 'First' }, { name: 'Second' }]">
      <el-table-column prop="name" label="Name" />
    </el-table>
  </section>
</template>
