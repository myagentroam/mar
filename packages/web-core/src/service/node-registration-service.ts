import { computed, ref } from 'vue';
import type { MessageFeedback } from '../model/message-feedback.js';
import { translate } from './locale-preference-service.js';

export function createNodeRegistrationService<Context>(options: {
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly submit?: (
    request: <T>(path: string, init?: RequestInit) => Promise<T>,
    context?: Context
  ) => Promise<{ token: string }>;
  readonly notice: MessageFeedback;
  readonly errorMessage: (error: unknown) => string;
}) {
  const token = ref<string>();
  const pending = ref(false);
  async function create(context?: Context): Promise<void> {
    if (pending.value) return;
    pending.value = true;
    try {
      token.value = (
        await (options.submit === undefined
          ? options.request<{ token: string }>('/api/node-registration-tokens', { method: 'POST' })
          : options.submit(options.request, context))
      ).token;
    } catch (error) {
      options.notice(
        translate('generated.workbenchPageController.unableToCreateARegistrationToken', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      pending.value = false;
    }
  }
  return { token: computed(() => token.value), pending: computed(() => pending.value), create };
}

export interface WorkbenchSettingsView<NodeRegistrationContext> {
  quickPrompts: readonly {
    readonly id: string;
    readonly phrase: string;
    readonly prompt: string;
    readonly updatedAt: number;
  }[];
  quickPromptsLoading: boolean;
  quickPromptsFailed: boolean;
  refreshQuickPrompts: () => Promise<void>;
  createRegistrationToken: (context?: NodeRegistrationContext | undefined) => Promise<void>;
  registrationToken: string | undefined;
  registrationLoading: boolean;
}
