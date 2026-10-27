import { h } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import HostedConversationEntryPage from '../../src/view/conversation/HostedConversationEntryPage.vue';
import HostedConversationComposer from '../../src/view/conversation/HostedConversationComposer.vue';
import type { HostedConversationSnapshot } from '@myagentroam/protocol';
import { ApiError } from '../../src/util/api-error.js';
import { createHostedConversationEntryService } from '../../src/service/hosted-conversation-entry-service.js';
import { createHostedConversationWorkspaceService } from '../../src/service/hosted-conversation-workspace-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');
themePreferenceService().setTheme(
  new URL(location.href).searchParams.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);

// Only HTTP responses are controlled by Playwright; the page and domain services are real.
const existing = new URL(location.href).searchParams.has('existing');
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error?.code ?? `REQUEST_FAILED_${response.status}`,
      value.error?.message ?? 'Hosted entry fixture request failed.'
    );
  if (existing && path.endsWith('/watch') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    if (body.mode === 'initial') {
      const snapshot = await request<HostedConversationSnapshot>(
        '/api/hosted-template-fixture/current'
      );
      queueMicrotask(() =>
        workspace.handleWatchEvent({
          type: 'watch.hosted-conversation.snapshot',
          workbenchConnectionId: 'fixture-connection',
          watchId: body.watchId,
          nodeGeneration: 'fixture-generation',
          nodeId: snapshot.conversation.nodeId,
          conversationId: snapshot.conversation.id,
          revision: 1,
          snapshotSequence: snapshot.snapshotSequence,
          expiresAt: Date.now() + 30_000,
          payload: snapshot
        })
      );
    }
  }
  return value as T;
}

const workspace = createHostedConversationWorkspaceService({
  request,
  workbenchConnectionId: () => (existing ? 'fixture-connection' : undefined),
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

if (existing) {
  const snapshot = await request<HostedConversationSnapshot>(
    '/api/hosted-template-fixture/current'
  );
  workspace.selectConversation(snapshot.conversation.nodeId, snapshot.conversation.id, snapshot);
  const watch = workspace.beginSelectedConversationWatch();
  if (new URL(location.href).searchParams.has('watch-pending')) void watch.catch(() => undefined);
  else await watch;
}

createTooltipApp({
  render: () =>
    existing
      ? h('main', { style: 'padding: 1rem; max-width: 54rem; margin: 6rem auto;' }, [
          h(HostedConversationComposer, {
            workspace,
            readonly: false,
            readonlyReason: '',
            connected: true,
            mobileViewport: matchMedia('(max-width: 767px)').matches
          })
        ])
      : h(HostedConversationEntryPage, {
          request,
          workspace,
          entry,
          mobileViewport: matchMedia('(max-width: 767px)').matches,
          connected: true
        })
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
