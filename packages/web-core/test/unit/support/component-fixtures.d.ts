declare module '*.vue?unit-render' {
  import type { Component } from 'vue';
  const component: Component;
  export default component;
}
