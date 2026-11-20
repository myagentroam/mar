import { createApp, h } from 'vue';
import PersonalInstructionsSettings from '../../src/view/settings/PersonalInstructionsSettings.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');

// Only the request boundary is controlled; the component and form validation are real.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error('Instruction fixture write unavailable');
  return response.json() as Promise<T>;
}

createApp({ render: () => h(PersonalInstructionsSettings, { request }) })
  .use(i18n)
  .mount('#app');
