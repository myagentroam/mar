import { resolve } from 'node:path';
import { thirdPartyNoticesPlugin } from './scripts/third-party-notices.js';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [
    vue(),
    thirdPartyNoticesPlugin({ outputDirectory: resolve(import.meta.dirname, 'dist') })
  ],
  build: {
    sourcemap: false,
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'web-core' },
    rollupOptions: { external: ['vue', 'vue-i18n', 'element-plus', '@myagentroam/protocol'] }
  }
});
