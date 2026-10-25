import { h } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import HostedConversationEntryPage from '../../src/view/conversation/HostedConversationEntryPage.vue';
import { createHostedConversationEntryService } from '../../src/service/hosted-conversation-entry-service.js';
import { createHostedConversationWorkspaceService } from '../../src/service/hosted-conversation-workspace-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');

// Only HTTP responses are controlled by Playwright; the page and domain services are real.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error('Hosted entry fixture request failed');
  return response.json() as Promise<T>;
}

const workspace = createHostedConversationWorkspaceService({
  request,
  workbenchConnectionId: () => undefined,
  heartbeatMs: 30000,
  requestTimeoutMs: 5000,
  confirmationTimeoutMs: 5000
});
const entry = createHostedConversationEntryService(request, {
  submission: {
    workspace,
    select: async (snapshot) => {
      workspace.selectConversation(
        snapshot.conversation.nodeId,
        snapshot.conversation.id,
        snapshot
      );
      await workspace.beginSelectedConversationWatch();
    }
  }
});

createTooltipApp({
  render: () =>
    h(HostedConversationEntryPage, {
      request,
      workspace,
      entry,
      mobileViewport: false,
      connected: true
    })
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
