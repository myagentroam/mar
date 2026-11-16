import { defineComponent, h, onBeforeUnmount, ref } from 'vue';
import { createTooltipApp } from './tooltip-app.js';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';
import {
  createSessionDraftService,
  type DraftTarget,
  type DraftPane
} from '../../src/service/session-draft-service.js';
import { createWorkbenchSubmissionOwner } from '../../src/service/workbench-submission-service.js';
import { createWorkspaceSessionPaneState } from '../../src/service/workspace-session-pane-state.js';
import ComposerAttachments from '../../src/view/composer/ComposerAttachments.vue';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');
createTooltipApp(
  defineComponent({
    setup() {
      const initial: DraftTarget = {
        kind: 'session',
        nodeId: 'n',
        workspaceId: 'w',
        sessionId: 'a'
      };
      const targets = { main: ref<DraftTarget>(initial), aside: ref<DraftTarget>(initial) };
      const uploads = ref(0);
      const pending = new Map<string, () => void>();
      const attachments = createComposerAttachmentService({
        context: () => targets.main.value,
        notice: (message) => {
          throw new Error(message);
        },
        request: async <T>(path: string): Promise<T> => {
          if (path.endsWith('/cancel')) return undefined as T;
          throw new Error(`Unexpected server upload: ${path}`);
        },
        csrfToken: ref('fixture'),
        renewCsrfToken: async () => 'fixture',
        onUnauthenticated: () => {
          throw new Error('Unexpected authentication failure');
        },
        direct: {
          generation: () => 'fixture',
          upload: ({ descriptor }) => {
            if (descriptor.direction !== 'UPLOAD' || descriptor.composerAttachment === undefined)
              throw new Error('Expected a Composer attachment upload');
            const attachmentId = descriptor.composerAttachment.id;
            uploads.value++;
            return new Promise<void>((resolve) => pending.set(attachmentId, resolve));
          }
        }
      });
      const drafts = createSessionDraftService({ target: targets.main });
      const submissions = createWorkbenchSubmissionOwner();
      const makePane = (pane: DraftPane) =>
        createWorkspaceSessionPaneState({
          pane,
          draftTarget: targets[pane],
          drafts,
          attachments,
          submissions,
          onConversationOverflow: () => {}
        });
      const panes = { main: makePane('main'), aside: makePane('aside') };
      const accepts = new Map<DraftPane, () => void>();
      const select = (pane: DraftPane, sessionId?: string) => {
        const { nodeId, workspaceId } = targets[pane].value;
        targets[pane].value =
          sessionId === undefined
            ? { kind: 'workspace', nodeId, workspaceId }
            : { kind: 'session', nodeId, workspaceId, sessionId };
      };
      onBeforeUnmount(() => attachments.clearAll());
      return () =>
        h('main', [
          h('output', { 'aria-label': 'Upload count' }, String(uploads.value)),
          h(
            'button',
            {
              onClick: () => {
                for (const target of Object.values(targets))
                  target.value = {
                    ...target.value,
                    workspaceId: target.value.workspaceId === 'w' ? 'other' : 'w'
                  };
              }
            },
            'Switch workspace'
          ),
          h(
            'button',
            {
              onClick: () => {
                for (const finish of pending.values()) finish();
                pending.clear();
              }
            },
            'Finish uploads'
          ),
          ...(['main', 'aside'] as const).map((position) => {
            const pane = panes[position];
            return h('section', { 'aria-label': position }, [
              h('textarea', {
                'aria-label': 'Question',
                value: pane.draft.input.value,
                onInput: (event: Event) => {
                  pane.draft.input.value = (event.target as HTMLTextAreaElement).value;
                }
              }),
              h('input', {
                type: 'file',
                'aria-label': 'Attachments',
                onChange: (event: Event) => {
                  pane.attachments.add((event.target as HTMLInputElement).files ?? []);
                }
              }),
              h(ComposerAttachments, {
                attachments: pane.attachments.attachments.value,
                onRemoveAttachment: pane.attachments.remove,
                onPreview: attachments.openPreview
              }),
              h('button', { onClick: () => select(position, 'a') }, 'Session A'),
              h('button', { onClick: () => select(position, 'b') }, 'Session B'),
              position === 'main' &&
                h('button', { onClick: () => select(position) }, 'New session'),
              position === 'main' &&
                h(
                  'button',
                  {
                    onClick: () => {
                      pane.captureDraft()?.createdSession({
                        id: 'created',
                        workspaceId: targets[position].value.workspaceId
                      });
                      select(position, 'created');
                    }
                  },
                  'Session created'
                ),
              h(
                'button',
                {
                  onClick: () => {
                    const submitted = [...pane.attachments.attachments.value];
                    const release = attachments.retainForSubmission(submitted);
                    accepts.set(position, () => {
                      attachments.consume(submitted);
                      release();
                    });
                  }
                },
                'Capture attachment batch'
              ),
              h(
                'button',
                {
                  onClick: () => {
                    accepts.get(position)?.();
                    accepts.delete(position);
                  }
                },
                'Accept attachment batch'
              )
            ]);
          })
        ]);
    }
  })
).mount('#app');
