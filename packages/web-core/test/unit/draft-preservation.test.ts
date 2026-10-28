import {
  createRenderer,
  nextTick,
  reactive,
  shallowRef,
  ssrContextKey,
  type Component,
  type Ref,
  type SetupContext
} from 'vue';
import { ElMessage, ElMessageBox, type MessageBoxData } from 'element-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceTextFilePage from '../../src/view/workspace/WorkspaceTextFilePage.vue';
import HostedConversationComposer from '../../src/view/conversation/HostedConversationComposer.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import { createWorkbenchSubmissionService } from '../../src/service/workbench-submission-service.js';
import { hostedConversationSubmissionContext } from '../../src/service/hosted-conversation-workspace-service.js';

const apps: { unmount(): void }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    documentElement: { lang: '' }
  });
  vi.spyOn(ElMessage, 'success').mockReturnValue({ close: vi.fn() });
  vi.spyOn(ElMessage, 'error').mockReturnValue({ close: vi.fn() });
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as MessageBoxData);
});

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

function mountBindings<T>(component: Component, props: object): T {
  const renderer = createRenderer<object, object>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null
  });
  let bindings!: T;
  const app = renderer.createApp({
    setup(_, context) {
      bindings = (component as unknown as { setup(props: object, context: SetupContext): T }).setup(
        props,
        context
      );
      return () => null;
    }
  });
  app.use(i18n);
  app.provide(ssrContextKey, {});
  app.mount({});
  apps.push(app);
  return bindings;
}

interface FileBindings {
  readonly editorContent: Ref<string>;
  readonly savedContent: Ref<string>;
  readonly revision: Ref<string>;
  readonly dirty: Ref<boolean>;
  save(): Promise<void>;
  canClose(): Promise<boolean>;
  captureDirtyDrafts(): readonly { path: string; content: string; expectedRevision: string }[];
}

function fileFixture() {
  const response = deferred<string>();
  const saveFile = vi.fn(() => response.promise);
  const props = reactive({
    file: {
      path: 'first.txt',
      content: 'original',
      revision: 'r1',
      encoding: 'utf-8',
      truncated: false
    },
    kind: 'text',
    writeEnabled: true,
    saveFile,
    downloading: false,
    editorIdentity: 'first-tab',
    tabIdentity: 'first-tab'
  });
  const page = mountBindings<FileBindings>(WorkspaceTextFilePage, props);
  return { response, saveFile, props, page };
}

describe('file save draft preservation', () => {
  it('marks only the submitted content as saved and keeps later edits recoverable', async () => {
    const { response, saveFile, page } = fileFixture();
    page.editorContent.value = 'submitted';
    const pending = page.save();
    expect(saveFile).toHaveBeenCalledWith('submitted', 'r1');
    page.editorContent.value = 'new unsaved edit';
    response.resolve('r2');
    await pending;
    expect(page.savedContent.value).toBe('submitted');
    expect(page.editorContent.value).toBe('new unsaved edit');
    expect(page.revision.value).toBe('r2');
    expect(page.dirty.value).toBe(true);
    expect(page.captureDirtyDrafts()).toEqual([
      expect.objectContaining({
        path: 'first.txt',
        content: 'new unsaved edit',
        expectedRevision: 'r2'
      })
    ]);
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel');
    expect(await page.canClose()).toBe(false);
    expect(ElMessageBox.confirm).toHaveBeenCalledOnce();
  });

  it('clears the dirty state when the submitted content is unchanged', async () => {
    const { response, page } = fileFixture();
    page.editorContent.value = 'submitted';
    const pending = page.save();
    response.resolve('r2');
    await pending;
    expect(page.savedContent.value).toBe('submitted');
    expect(page.dirty.value).toBe(false);
    expect(page.captureDirtyDrafts()).toEqual([]);
    expect(await page.canClose()).toBe(true);
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
  });

  it('preserves an undo to the old baseline when the save callback publishes file props', async () => {
    const { response, saveFile, props, page } = fileFixture();
    saveFile.mockImplementation(async () => {
      const revision = await response.promise;
      props.file = { ...props.file, content: 'submitted', revision };
      return revision;
    });
    page.editorContent.value = 'submitted';
    const pending = page.save();
    page.editorContent.value = 'original';
    response.resolve('r2');
    await pending;
    await nextTick();
    expect(page.editorContent.value).toBe('original');
    expect(page.savedContent.value).toBe('submitted');
    expect(page.revision.value).toBe('r2');
    expect(page.dirty.value).toBe(true);
  });

  it('preserves the draft and revision when saving fails', async () => {
    const { response, page } = fileFixture();
    page.editorContent.value = 'submitted';
    const pending = page.save();
    page.editorContent.value = 'new unsaved edit';
    response.reject(new Error('Save failed'));
    await pending;
    expect(page.savedContent.value).toBe('original');
    expect(page.editorContent.value).toBe('new unsaved edit');
    expect(page.revision.value).toBe('r1');
    expect(page.dirty.value).toBe(true);
    expect(ElMessage.error).toHaveBeenCalledOnce();
  });

  it('updates the saved file cache without marking another file as saved', async () => {
    const { response, props, page } = fileFixture();
    page.editorContent.value = 'submitted';
    const pending = page.save();
    page.editorContent.value = 'later first-file edit';
    props.file = { ...props.file, path: 'second.txt', content: 'second original', revision: 's1' };
    props.editorIdentity = 'second-tab';
    await nextTick();
    page.editorContent.value = 'second-file edit';
    response.resolve('r2');
    await pending;
    expect(page.savedContent.value).toBe('second original');
    expect(page.revision.value).toBe('s1');
    expect(page.dirty.value).toBe(true);
    props.file = { ...props.file, path: 'first.txt', content: 'submitted', revision: 'r2' };
    props.editorIdentity = 'first-tab';
    await nextTick();
    expect(page.editorContent.value).toBe('later first-file edit');
    expect(page.savedContent.value).toBe('submitted');
    expect(page.revision.value).toBe('r2');
    expect(page.dirty.value).toBe(true);
  });
});

function attachment(id: string, status: 'PENDING' | 'UPLOADING' | 'COMPLETED' = 'COMPLETED') {
  return {
    id,
    name: `${id}.png`,
    file: new File(['image'], `${id}.png`, { type: 'image/png' }),
    previewUrl: `blob:${id}`,
    clientRequestId: `upload-${id}`,
    controller: new AbortController(),
    fileId: `file-${id}`,
    receivedBytes: 5,
    status
  };
}

interface HostedBindings {
  readonly input: Ref<string>;
  readonly attachments: Ref<
    Array<Omit<ReturnType<typeof attachment>, 'fileId'> & { fileId?: string | undefined }>
  >;
  readonly composerReadonly: Ref<boolean>;
  send(deliveryIntent?: 'REPLACE_CURRENT'): Promise<void>;
  selectTemplate(id: string): Promise<void>;
  retryAttachment(id: string): void;
  refreshDraftTemplates(visible: boolean): Promise<void>;
}

function hostedFixture(mobileViewport = false) {
  const gate = createWorkbenchSubmissionService();
  const responses: ReturnType<typeof deferred<void>>[] = [];
  const sendMessage = vi.fn(
    async (_input: {
      prompt: string;
      attachmentIds: readonly string[];
      clientMessageId: string;
    }) => {
      const finish = gate.begin(hostedConversationSubmissionContext('node-1', 'conversation-1'));
      if (finish === undefined) throw new Error('Submission active');
      const response = deferred<void>();
      responses.push(response);
      try {
        await response.promise;
      } finally {
        finish();
      }
    }
  );
  const workspace = {
    templateChanging: shallowRef(false),
    watchReady: shallowRef(true),
    selectedWatchId: vi.fn(() => 'watch-1'),
    listTemplateOptions: vi.fn(async () => [
      { id: 'template-2', nodeId: 'node-1', name: 'Second template' }
    ]),
    switchTemplate: vi.fn(async () => undefined),
    snapshot: shallowRef({
      nodeAppVersion: '0.11.31',
      conversation: {
        id: 'conversation-1',
        nodeId: 'node-1',
        sessionId: 'session-1',
        modelId: 'model-1',
        templateName: 'Template',
        templateId: 'template-1',
        activeVersionId: 'version-1',
        status: 'ACTIVE',
        activity: { status: 'IDLE' }
      },
      run: null,
      models: []
    }),
    messageSubmitting: gate.pending,
    messageSubmissionContext: gate.context,
    sendMessage
  };
  const composer = mountBindings<HostedBindings>(HostedConversationComposer, {
    workspace,
    mobileViewport,
    readonly: false,
    readonlyReason: ''
  });
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return { composer, responses, sendMessage, revoke, workspace };
}

describe('hosted message draft preservation', () => {
  it('allows a mobile follow-up to use the existing replacement intent without queueing', async () => {
    const { composer, workspace, sendMessage, responses } = hostedFixture(true);
    workspace.snapshot.value = {
      ...workspace.snapshot.value,
      run: { id: 'run-a', status: 'RUNNING', startedAt: Date.now() } as never
    };
    await nextTick();
    expect(composer.composerReadonly.value).toBe(false);
    composer.input.value = 'Mobile follow-up';
    await nextTick();
    const pending = composer.send('REPLACE_CURRENT');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Mobile follow-up',
        deliveryIntent: 'REPLACE_CURRENT'
      })
    );
    responses[0]!.resolve();
    await pending;
    expect(composer.input.value).toBe('');
  });
  it('does not reuse an uncertain send identity after another client changes the template', async () => {
    const { composer, workspace, responses, sendMessage } = hostedFixture();
    composer.input.value = 'Unsent draft';
    await nextTick();
    const first = composer.send();
    responses[0]!.reject(new TypeError('Connection lost'));
    await first;
    workspace.snapshot.value = {
      ...workspace.snapshot.value,
      conversation: { ...workspace.snapshot.value.conversation, templateId: 'template-2' }
    };
    const second = composer.send();
    expect(sendMessage.mock.calls[1]![0].clientMessageId).not.toBe(
      sendMessage.mock.calls[0]![0].clientMessageId
    );
    responses[1]!.resolve();
    await second;
  });

  it('preserves text and completed attachments after a template switch', async () => {
    const { composer, workspace, revoke } = hostedFixture();
    composer.input.value = 'Unsent draft';
    composer.attachments.value = [attachment('first')];
    await composer.refreshDraftTemplates(true);
    await composer.selectTemplate('template-2');
    expect(workspace.switchTemplate).toHaveBeenCalledExactlyOnceWith('template-2', 'template-1');
    expect(composer.input.value).toBe('Unsent draft');
    expect(composer.attachments.value.map((item) => item.id)).toEqual(['first']);
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'watch-replaced', 'binding-replaced', 'unmounted'])(
    'does not apply a stale template confirmation: %s',
    async (reason) => {
      const { composer, workspace } = hostedFixture();
      const confirmation = deferred<MessageBoxData>();
      vi.mocked(ElMessageBox.confirm).mockReturnValueOnce(confirmation.promise);
      await composer.refreshDraftTemplates(true);
      const pending = composer.selectTemplate('template-2');
      expect(ElMessageBox.confirm).toHaveBeenCalledOnce();
      if (reason === 'watch-replaced') workspace.selectedWatchId.mockReturnValue('watch-2');
      if (reason === 'binding-replaced') {
        workspace.snapshot.value = {
          ...workspace.snapshot.value,
          conversation: { ...workspace.snapshot.value.conversation, activeVersionId: 'version-new' }
        };
      }
      if (reason === 'unmounted') apps.pop()!.unmount();
      if (reason === 'cancel') confirmation.reject(new Error('cancel'));
      else confirmation.resolve('confirm' as MessageBoxData);
      await pending;
      expect(workspace.switchTemplate).not.toHaveBeenCalled();
    }
  );

  it.each([0, 5_001])('clears an unchanged draft after success delayed by %i ms', async (delay) => {
    const { composer, responses, sendMessage, revoke } = hostedFixture();
    composer.input.value = 'submitted';
    composer.attachments.value = [attachment('first')];
    await nextTick();
    const pending = composer.send();
    expect(composer.composerReadonly.value).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'submitted', attachmentIds: ['file-first'] })
    );
    await vi.advanceTimersByTimeAsync(delay);
    responses[0]!.resolve();
    await pending;
    expect(composer.input.value).toBe('');
    expect(composer.attachments.value).toEqual([]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:first');
  });

  it('preserves text and attachments edited after a send times out', async () => {
    const { composer, responses, revoke } = hostedFixture();
    composer.input.value = 'submitted';
    composer.attachments.value = [attachment('first')];
    await nextTick();
    const pending = composer.send();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(composer.composerReadonly.value).toBe(false);
    composer.input.value = 'new unsent message';
    await nextTick();
    responses[0]!.resolve();
    await pending;
    expect(composer.input.value).toBe('new unsent message');
    expect(composer.attachments.value.map((item) => item.id)).toEqual(['first']);
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(['UPLOADING', 'COMPLETED'] as const)(
    'preserves a newly added %s attachment when the old send succeeds',
    async (status) => {
      const { composer, responses, revoke } = hostedFixture();
      composer.input.value = 'submitted';
      await nextTick();
      const pending = composer.send();
      await vi.advanceTimersByTimeAsync(5_001);
      composer.attachments.value = [attachment('new', status)];
      responses[0]!.resolve();
      await pending;
      expect(composer.input.value).toBe('submitted');
      expect(composer.attachments.value.map((item) => item.id)).toEqual(['new']);
      expect(revoke).not.toHaveBeenCalled();
    }
  );

  it('keeps a newer send retry identity when an older send fails explicitly', async () => {
    const { composer, responses, sendMessage } = hostedFixture();
    composer.input.value = 'first';
    await nextTick();
    const first = composer.send();
    await vi.advanceTimersByTimeAsync(5_001);
    composer.input.value = 'second';
    await nextTick();
    const second = composer.send();
    responses[0]!.reject(new Error('REJECTED'));
    await first;
    expect(composer.input.value).toBe('second');
    await vi.advanceTimersByTimeAsync(5_001);
    const retry = composer.send();
    expect(sendMessage.mock.calls[2]![0].clientMessageId).toBe(
      sendMessage.mock.calls[1]![0].clientMessageId
    );
    responses[1]!.resolve();
    responses[2]!.resolve();
    await Promise.all([second, retry]);
    expect(composer.input.value).toBe('');
  });

  it('keeps a failed draft but starts a new intent after an explicit rejection', async () => {
    const { composer, responses, sendMessage, revoke } = hostedFixture();
    composer.input.value = 'submitted';
    composer.attachments.value = [attachment('first')];
    await nextTick();
    const pending = composer.send();
    responses[0]!.reject(new Error('REJECTED'));
    await pending;
    expect(composer.input.value).toBe('submitted');
    expect(composer.attachments.value.map((item) => item.id)).toEqual(['first']);
    expect(revoke).not.toHaveBeenCalled();
    const retry = composer.send();
    expect(sendMessage.mock.calls[1]![0].clientMessageId).not.toBe(
      sendMessage.mock.calls[0]![0].clientMessageId
    );
    responses[1]!.resolve();
    await retry;
  });
});
