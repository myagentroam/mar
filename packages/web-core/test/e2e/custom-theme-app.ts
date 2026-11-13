import { createTooltipApp as createApp } from './tooltip-app.js';
import { defineAsyncComponent, h, ref } from 'vue';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import SettingsContent from '../../src/view/settings/SettingsContent.vue';
import FileTypeIcon from '../../src/view/workspace/FileTypeIcon.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import type { SettingsSection } from '../../src/model/settings.js';
import {
  createPwaApplicationService,
  PWA_APPLICATION_SERVICE_KEY
} from '../../src/service/pwa-application-service.js';

localePreferenceService().setLocale(
  new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
);
const ThemeControlsFixture = defineAsyncComponent(() => import('./theme-controls-fixture.vue'));
const section = ref<SettingsSection>('custom-themes');
const pwaApplication = createPwaApplicationService(undefined, {
  version: 'fixture',
  buildId: 'fixture'
});
const app = createApp({
  setup() {
    return () =>
      h('main', { style: 'height: 100vh; overflow: auto;' }, [
        h('nav', [
          new URLSearchParams(location.search).has('pwaUpdate')
            ? h(
                'button',
                {
                  onClick: async () => {
                    await pwaApplication.checkForUpdate();
                    await pwaApplication.applyUpdate();
                  }
                },
                'Apply PWA update'
              )
            : null,
          h(
            'button',
            {
              onClick: () => {
                section.value = 'custom-themes';
              }
            },
            i18n.global.t('customThemes.title')
          ),
          h(
            'button',
            {
              onClick: () => {
                section.value = 'appearance';
              }
            },
            i18n.global.t('settings.appearance')
          )
        ]),
        h(SettingsContent, {
          section: section.value,
          webVersion: 'fixture',
          sessions: [],
          newPassword: '',
          passwordValidationError: '',
          registrationToken: undefined,
          loading: false,
          changePassword: async () => true,
          formatSessionTime: String,
          request: async <T>() => ({}) as T,
          quickPrompts: [],
          quickPromptsLoading: false,
          quickPromptsFailed: false,
          refreshQuickPrompts: async () => undefined
        }),
        h('div', { 'data-testid': 'icon-theme-preview' }, [
          h(FileTypeIcon, { name: 'example.ts' })
        ]),
        !new URLSearchParams(location.search).has('appearance-only') && h(ThemeControlsFixture)
      ]);
  }
});
app.provide(PWA_APPLICATION_SERVICE_KEY, pwaApplication);
app.use(i18n).mount('#app');
