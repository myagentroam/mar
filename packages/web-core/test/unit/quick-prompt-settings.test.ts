import { createRenderer, h, nextTick, ssrContextKey, type Component, type VNode } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElMessage } from 'element-plus';
import QuickPromptSettings from '../../src/view/settings/QuickPromptSettings.vue';
import type { QuickPrompt } from '../../src/model/workbench.js';
import { i18n } from '../../src/service/LocalePreferenceService.js';

vi.mock('element-plus', () => ({ ElMessage: { error: vi.fn(), success: vi.fn() } }));

const apps: { unmount(): void }[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const first: QuickPrompt = { id: 'first/id', phrase: 'first', prompt: 'First body', updatedAt: 1 };
const second: QuickPrompt = { id: 'second', phrase: 'second', prompt: 'Second body', updatedAt: 2 };

interface Editor {
  form: { validate(): Promise<boolean> };
  dialogOpen: boolean;
  saving: boolean;
  editing: QuickPrompt | undefined;
  draft: { phrase: string; prompt: string };
  openCreate(): void;
  openEdit(prompt: QuickPrompt): void;
  close(): void;
  save(): Promise<void>;
}

function mount() {
  const request = vi.fn().mockResolvedValue({});
  const refresh = vi.fn().mockResolvedValue(undefined);
  const validate = vi.fn().mockResolvedValue(true);
  const renderer = createRenderer<object, object>({
    patchProp() {},
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    parentNode: () => null,
    nextSibling: () => null
  });
  let editor!: Editor;
  // Mount the real SFC lifecycle; Chromium covers its template and Element Plus controls.
  const app = renderer.createApp({
    render: () =>
      h({ ...QuickPromptSettings, render: () => null } as Component, {
        prompts: [first, second],
        loading: false,
        failed: false,
        request,
        refresh,
        onVnodeMounted: (vnode: VNode) => {
          editor = (vnode.component as unknown as { setupState: Editor }).setupState;
        }
      })
  });
  app.use(i18n);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount({});
  apps.push(app);
  return { app, editor, request, refresh, validate };
}

async function open(view: ReturnType<typeof mount>, prompt?: QuickPrompt) {
  if (prompt) view.editor.openEdit(prompt);
  else view.editor.openCreate();
  await nextTick();
  view.editor.form = { validate: view.validate };
}

async function startSave(view: ReturnType<typeof mount>) {
  const saving = view.editor.save();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { saving };
}

function expectSecond(view: ReturnType<typeof mount>, saving: boolean) {
  expect(view.editor.dialogOpen).toBe(true);
  expect(view.editor.editing?.id).toBe(second.id);
  expect(view.editor.draft).toEqual({ phrase: 'second', prompt: 'Second body' });
  expect(view.editor.saving).toBe(saving);
}

describe('Quick prompt editor save ownership', () => {
  it('creates and edits with validation, refreshes the list, and closes on success', async () => {
    const view = mount();
    await open(view);
    view.editor.draft = { phrase: 'created', prompt: 'Created body' };
    await view.editor.save();
    expect(view.validate).toHaveBeenCalledOnce();
    expect(view.request).toHaveBeenLastCalledWith('/api/quick-prompts', {
      method: 'POST',
      body: JSON.stringify({ phrase: 'created', prompt: 'Created body' })
    });
    expect(view.editor.dialogOpen).toBe(false);
    await open(view, first);
    view.editor.draft.prompt = 'Edited body';
    await view.editor.save();
    expect(view.request).toHaveBeenLastCalledWith('/api/quick-prompts/first%2Fid', {
      method: 'PATCH',
      body: JSON.stringify({ phrase: 'first', prompt: 'Edited body' })
    });
    expect(view.refresh).toHaveBeenCalledTimes(3);
    expect(ElMessage.success).toHaveBeenCalledTimes(2);
    expect(view.editor.dialogOpen).toBe(false);
    expect(view.editor.saving).toBe(false);
  });

  it('preserves the current draft and identity on failure and permits retry', async () => {
    const view = mount();
    await open(view, first);
    view.editor.draft.prompt = 'Retained draft';
    view.request.mockRejectedValueOnce(new Error('Save unavailable'));
    await view.editor.save();
    expect(view.editor.dialogOpen).toBe(true);
    expect(view.editor.editing?.id).toBe(first.id);
    expect(view.editor.draft.prompt).toBe('Retained draft');
    expect(view.editor.saving).toBe(false);
    expect(view.refresh).toHaveBeenCalledOnce();
    expect(ElMessage.error).toHaveBeenCalledOnce();
    await view.editor.save();
    expect(view.editor.dialogOpen).toBe(false);
  });

  it('does not submit invalid forms or send a second request while saving', async () => {
    const view = mount();
    await open(view, first);
    view.validate.mockRejectedValueOnce(new Error('Invalid'));
    await view.editor.save();
    expect(view.request).not.toHaveBeenCalled();
    const pending = deferred<void>();
    view.request.mockReturnValueOnce(pending.promise);
    const { saving } = await startSave(view);
    await view.editor.save();
    expect(view.request).toHaveBeenCalledOnce();
    pending.resolve();
    await saving;
  });

  it.each(['success', 'failure'] as const)(
    'ignores a late %s and finally without clearing the new save busy state',
    async (outcome) => {
      const view = mount();
      const oldRequest = deferred<void>();
      const newRequest = deferred<void>();
      view.request.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
      await open(view, first);
      const old = await startSave(view);
      view.editor.close();
      await nextTick();
      await open(view, second);
      expectSecond(view, false);
      const current = await startSave(view);
      expect(view.request).toHaveBeenLastCalledWith('/api/quick-prompts/second', {
        method: 'PATCH',
        body: JSON.stringify({ phrase: 'second', prompt: 'Second body' })
      });
      expectSecond(view, true);
      if (outcome === 'success') oldRequest.resolve();
      else oldRequest.reject(new Error('Old save failed'));
      await old.saving;
      expectSecond(view, true);
      expect(view.refresh).toHaveBeenCalledOnce();
      expect(ElMessage.success).not.toHaveBeenCalled();
      expect(ElMessage.error).not.toHaveBeenCalled();
      newRequest.resolve();
      await current.saving;
      expect(view.editor.dialogOpen).toBe(false);
      expect(ElMessage.success).toHaveBeenCalledOnce();
    }
  );

  it.each(['success', 'failure'] as const)(
    'ignores late refresh %s after another editor opens',
    async (outcome) => {
      const view = mount();
      const refresh = deferred<void>();
      view.refresh.mockReturnValueOnce(refresh.promise);
      await open(view, first);
      const old = await startSave(view);
      expect(view.refresh).toHaveBeenCalledTimes(2);
      view.editor.close();
      await nextTick();
      await open(view, second);
      if (outcome === 'success') refresh.resolve();
      else refresh.reject(new Error('Old refresh failed'));
      await old.saving;
      expectSecond(view, false);
      expect(ElMessage.success).not.toHaveBeenCalled();
      expect(ElMessage.error).not.toHaveBeenCalled();
      await view.editor.save();
      expect(view.request).toHaveBeenLastCalledWith('/api/quick-prompts/second', expect.anything());
    }
  );

  it('does not submit a new draft when old validation finishes after reopening', async () => {
    const view = mount();
    await open(view, first);
    const validation = deferred<boolean>();
    view.validate.mockReturnValueOnce(validation.promise);
    const old = await startSave(view);
    view.editor.close();
    await nextTick();
    await open(view, second);
    validation.resolve(true);
    await old.saving;
    expect(view.request).not.toHaveBeenCalled();
    expectSecond(view, false);
  });
});
