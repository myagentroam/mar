import { ref } from 'vue';

export interface MailTemplate {
  readonly id: string;
  readonly kind: 'TEST' | 'NOTIFICATION';
  readonly locale: 'zh-CN' | 'en-US';
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly revision: number;
  readonly isDefault: boolean;
}

export function createMailTemplateManagementService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
) {
  const templates = ref<readonly MailTemplate[]>([]);
  const loading = ref(false);
  const busy = ref(false);
  async function load(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    try {
      templates.value = await request<readonly MailTemplate[]>('/api/mail/templates');
    } finally {
      loading.value = false;
    }
  }
  async function preview(
    template: MailTemplate,
    message: string
  ): Promise<{
    readonly subject: string;
    readonly text: string;
    readonly html: string;
  }> {
    return request('/api/mail/templates/preview', {
      method: 'POST',
      body: JSON.stringify({ templateId: template.id, message })
    });
  }
  async function test(email: string, templateId: string): Promise<void> {
    busy.value = true;
    try {
      await request('/api/mail/test', {
        method: 'POST',
        body: JSON.stringify({ email, templateId })
      });
    } finally {
      busy.value = false;
    }
  }
  return { templates, loading, busy, load, preview, test };
}
