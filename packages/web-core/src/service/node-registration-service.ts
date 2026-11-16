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
  let operation: object | undefined;
  async function create(context?: Context): Promise<void> {
    if (pending.value) return;
    pending.value = true;
    const owner = {};
    operation = owner;
    try {
      const result = (
        await (options.submit === undefined
          ? options.request<{ token: string }>('/api/node-registration-tokens', { method: 'POST' })
          : options.submit(options.request, context))
      ).token;
      if (operation === owner) token.value = result;
    } catch (error) {
      if (operation !== owner) return;
      options.notice(
        translate('generated.workbenchPageController.unableToCreateARegistrationToken', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      if (operation === owner) pending.value = false;
    }
  }
  return {
    token: computed(() => token.value),
    pending: computed(() => pending.value),
    create,
    clear: () => {
      operation = undefined;
      token.value = undefined;
      pending.value = false;
    }
  };
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
