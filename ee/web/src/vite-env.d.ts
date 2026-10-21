/// <reference types="vite/client" />

declare const __MAR_WEB_VERSION__: string;
declare const __MAR_WEB_BUILD_HASH__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
