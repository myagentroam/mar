import { createApp, type Component } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import App from './App.vue';
import { tooltipPlugin } from './directive/tooltip.js';
import { i18n } from './service/locale-preference-service.js';
import {
  createPwaApplicationService,
  PWA_APPLICATION_SERVICE_KEY
} from './service/pwa-application-service.js';
import {
  MANAGEMENT_COMPOSITION_KEY,
  type ManagementComposition
} from './service/management-composition.js';
import './styles.css';

export interface ConsoleComposition {
  readonly documentationAvailable?: boolean;
  readonly webBuild?: { readonly version: string; readonly buildId: string };
  readonly workbench: Component;
  readonly filePreview: Component;
  readonly management: ManagementComposition;
}

export function bootstrapConsole(composition: ConsoleComposition) {
  const { management, webBuild, ...pages } = composition;
  const app = createApp(App, pages);
  const pwa = createPwaApplicationService(
    'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    webBuild
  );
  app.provide(MANAGEMENT_COMPOSITION_KEY, management);
  app.provide(PWA_APPLICATION_SERVICE_KEY, pwa);
  app.use(i18n);
  app.use(ElementPlus);
  app.use(tooltipPlugin);
  app.mount('#app');

  const startPwa = () => void pwa.start();
  if (document.readyState === 'complete') startPwa();
  else window.addEventListener('load', startPwa, { once: true });
  app.onUnmount(() => {
    window.removeEventListener('load', startPwa);
    pwa.dispose();
  });
  return app;
}
