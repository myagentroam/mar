import { createTooltipApp as createApp } from './tooltip-app.js';
import { h, ref } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import SettingsContent from '../../src/view/settings/SettingsContent.vue';
import ThemeControlsFixture from './theme-controls-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import type { SettingsSection } from '../../src/model/settings.js';

localePreferenceService().setLocale(
  new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
);
const section = ref<SettingsSection>('custom-themes');
const app = createApp({
  setup() {
    return () =>
      h('main', { style: 'height: 100vh; overflow: auto;' }, [
        h('nav', [
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
        h(ThemeControlsFixture)
      ]);
  }
});
app.use(i18n).use(ElementPlus).mount('#app');
