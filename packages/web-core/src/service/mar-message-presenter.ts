import { getActiveMarDialog } from '@myagentroam/mar-ui/dialog';
import { MarMessage } from '@myagentroam/mar-ui/message';
import { marUiLocaleKey } from '@myagentroam/mar-ui/locale';
import marEn from '@myagentroam/mar-ui/locale/en';
import marZhCn from '@myagentroam/mar-ui/locale/zh-cn';
import { computed, h, provide, render, shallowReactive } from 'vue';
import type { MessageType } from '../model/message-feedback.js';
import { localePreferenceService } from './locale-preference-service.js';
import './mar-message-presenter.css';

interface Feedback {
  readonly id: number;
  readonly type: MessageType;
  readonly message: string;
}

export type MessageSurface = Readonly<{ owner: HTMLElement; signal: AbortSignal }>;

const surfaces = new Map<HTMLElement, { add(feedback: Feedback): void; dispose(): void }>();
let sequence = 0;

/** Owns transient rendering in the document, a dialog, or a caller-owned local surface. */
function mount(owner: HTMLElement, signal?: AbortSignal) {
  const entries = shallowReactive<Feedback[]>([]);
  const container = owner.ownerDocument.createElement('div');
  container.className = 'mar-feedback-stack';
  if (signal) container.classList.add('mar-feedback-stack--local');
  const observer =
    signal || owner === owner.ownerDocument.body
      ? undefined
      : new MutationObserver(() => {
          if (!owner.isConnected || !owner.matches('dialog[open]')) dispose();
        });
  observer?.observe(owner.ownerDocument.body, { subtree: true, childList: true });
  observer?.observe(owner, { attributes: true, attributeFilter: ['open'] });
  signal?.addEventListener('abort', dispose, { once: true });
  owner.append(container);

  function dispose() {
    if (!surfaces.delete(owner)) return;
    signal?.removeEventListener('abort', dispose);
    observer?.disconnect();
    render(null, container);
    container.remove();
  }

  function remove(id: number) {
    const index = entries.findIndex((feedback) => feedback.id === id);
    if (index >= 0) entries.splice(index, 1);
    if (!entries.length) dispose();
  }

  const Surface = {
    setup() {
      const { locale } = localePreferenceService();
      provide(
        marUiLocaleKey,
        computed(() => (locale.value === 'zh-CN' ? marZhCn : marEn))
      );
      return () =>
        entries.map(({ id, type, message }) =>
          h(MarMessage, {
            key: id,
            type,
            message,
            duration: type === 'warning' || type === 'error' ? 6_000 : 3_000,
            onClose: () => remove(id)
          })
        );
    }
  };
  const surface = { add: (item: Feedback) => entries.push(item), dispose };
  surfaces.set(owner, surface);
  render(h(Surface), container);
  return surface;
}

export function presentMessage(message: string, type: MessageType, surface?: MessageSurface): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (surface && (surface.signal.aborted || !surface.owner.isConnected)) return;
  // Body-level feedback cannot paint above, or receive input through, a native modal.
  const owner = surface?.owner ?? getActiveMarDialog(document) ?? document.body;
  (surfaces.get(owner) ?? mount(owner, surface?.signal)).add({ id: ++sequence, type, message });
}

export function dismissMessages(): void {
  for (const surface of surfaces.values()) surface.dispose();
}
