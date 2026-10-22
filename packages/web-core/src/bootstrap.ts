import { createApp, type Component } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import App from './App.vue';
import { i18n } from './service/LocalePreferenceService.js';
import {
  MANAGEMENT_COMPOSITION_KEY,
  type ManagementComposition
} from './service/ManagementComposition.js';
import './styles.css';

export interface ConsoleComposition {
  readonly documentationAvailable?: boolean;
  readonly workbench: Component;
  readonly filePreview: Component;
  readonly management: ManagementComposition;
}

export function bootstrapConsole(composition: ConsoleComposition) {
  const { management, ...pages } = composition;
  const app = createApp(App, pages);
  app.provide(MANAGEMENT_COMPOSITION_KEY, management);
  app.use(i18n);
  app.use(ElementPlus);
  app.mount('#app');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => {
        // Installation is a progressive enhancement; registration failures must not block Console.
      });
    });
  }
  return app;
}
