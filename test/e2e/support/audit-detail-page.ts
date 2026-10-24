import { createApp, h, nextTick, ref } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import AuditManagementPage from '../../../ee/web/src/view/settings/AuditManagementPage.vue';
import { i18n } from '../../../ee/web/src/service/locale-preference-service.js';

const events = ['audit-A', 'audit-B'].map((id) => ({
  id,
  eventType: 'conversation_input_recorded',
  occurredAt: 1_700_000_000_000,
  result: 'SUCCESS',
  errorCode: null,
  actorUserId: 1,
  actorUsername: id,
  authenticationMethod: 'PASSWORD',
  requestId: null,
  inputMode: 'SEND',
  hasConversationPayload: true
}));
const pending: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void }[] =
  [];
const mounted = ref(true);

declare global {
  interface Window {
    auditDetailFixture: {
      count: () => number;
      settle: (index: number, success: boolean) => Promise<void>;
      unmount: () => Promise<void>;
    };
  }
}

// Only the request boundary is replaced; the page, dialogs, loading and feedback are real.
window.auditDetailFixture = {
  count: () => pending.length,
  async settle(index, success) {
    const gate = pending[index]!;
    if (success) {
      gate.resolve({
        ...events.find((event) => event.id === gate.id),
        conversationPayload: {
          conversationTitle: gate.id,
          userMessage: `Payload ${gate.id} request ${index}`
        }
      });
    } else gate.reject(new Error(`Failure ${gate.id} request ${index}`));
    await nextTick();
    await nextTick();
  },
  async unmount() {
    mounted.value = false;
    await nextTick();
  }
};
const request = async <T>(path: string): Promise<T> => {
  if (path.includes('?')) return { events, total: events.length, page: 1 } as T;
  return new Promise<T>((resolve, reject) => {
    pending.push({
      id: decodeURIComponent(path.split('/').at(-1)!),
      resolve: (value) => resolve(value as T),
      reject
    });
  });
};

i18n.global.locale.value = 'en-US';
createApp({ render: () => (mounted.value ? h(AuditManagementPage, { request }) : null) })
  .use(ElementPlus)
  .use(i18n)
  .mount('#app');
