import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import {
  serializeComposerTag,
  composerVisibleText,
  parseComposerTags
} from '@myagentroam/protocol';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { composerMessagePresentation } from '../../src/util/composer-message.js';
import {
  conversationItemLabel,
  conversationItemText
} from '../../src/util/conversation-presentation.js';
import { displayConversationItem } from '../../src/util/conversation-domain.js';
import { createComposerQueueService } from '../../src/service/composer-queue-service.js';
import { createSessionDraftService } from '../../src/service/session-draft-service.js';
import { createComposerReferenceService } from '../../src/service/composer-reference-service.js';
import { serializeComposerMessage } from '../../src/service/composer-skill-token-service.js';
import MessageAttachmentFiles from '../../src/view/composer/MessageAttachmentFiles.vue';

const references = serializeComposerTag('mar_references', {
  references: [{ type: 'file', path: 'src/main.ts', label: 'main.ts' }]
});
const skills = serializeComposerTag('mar_skills', {
  action: 'use',
  instruction: 'Use the selected skills for this task.',
  skills: [{ name: 'review', source: 'WORKSPACE', path: '.agents/skills/review/SKILL.md' }]
});
const files = [{ name: '截图.png', mime: 'image/png', path: '.mar/temp-files/input/截图.png' }];
const attachments = serializeComposerTag('mar_attachments', { files });
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('document', {
    documentElement: {
      lang: '',
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() }
    }
  });
});
afterEach(() => {
  localePreferenceService().setLocale('en-US');
  vi.unstubAllGlobals();
});

describe('Composer product tag presentation', () => {
  it('hides mixed session references and preserves their metadata when a queue body is edited', () => {
    const selected = [
      { type: 'file' as const, path: 'src/main.ts', label: 'main.ts' },
      { type: 'session' as const, sessionId: 'session-42', label: 'Alpha & <review>' }
    ];
    const raw = serializeComposerMessage([], 'Compare this work', selected);
    expect(parseComposerTags(raw).find((part) => part.kind === 'mar_references')).toMatchObject({
      payload: { references: selected }
    });
    expect(composerVisibleText(raw)).toBe('Compare this work');
    expect(composerMessagePresentation({ text: raw }).text).toBe('Compare this work');
    expect(conversationItemText('user_message', { text: raw })).toBe('Compare this work');
    const queue = createComposerQueueService();
    queue.startEditing({ queueItemId: 'mixed-references', content: raw });
    expect(queue.editingContent.value).toBe('Compare this work');
    const edited = queue.serializeEditedContent('Updated request');
    expect(composerVisibleText(edited)).toBe('Updated request');
    expect(parseComposerTags(edited).find((part) => part.kind === 'mar_references')).toMatchObject({
      payload: { references: selected }
    });
  });

  it('retains legacy session mention text alongside file references', () => {
    const body = 'Compare <mar-session: Alpha session> with this file';
    const raw = `${body}\n${references}`;
    expect(composerVisibleText(raw)).toContain(body);
    expect(parseComposerTags(raw).map((part) => part.kind)).toEqual(['text', 'mar_references']);
    expect(composerMessagePresentation({ text: raw }).text).toBe(body);
    expect(conversationItemText('user_message', { text: raw })).toBe(body);
    const queue = createComposerQueueService();
    queue.startEditing({ queueItemId: 'session-reference', content: raw });
    expect(queue.editingContent.value).toBe(body);
    expect(queue.serializeEditedContent(body)).toContain(body);
  });

  it('hides attachment instructions in history and queue editing while retaining mixed files', () => {
    const instruction = 'Images are included. Use view_image only to revisit them.';
    const mixedFiles = [
      ...files,
      { name: 'notes.txt', mime: 'text/plain', path: '.mar/temp-files/input/notes.txt' }
    ];
    const raw = `Review these\n${serializeComposerTag('mar_attachments', {
      files: mixedFiles,
      instruction
    })}`;
    expect(composerMessagePresentation({ text: raw })).toMatchObject({
      text: 'Review these',
      files: mixedFiles
    });
    expect(conversationItemText('user_message', { text: raw })).toBe('Review these');
    const queue = createComposerQueueService();
    queue.startEditing({ queueItemId: 'mixed-attachments', content: raw });
    expect(queue.editingContent.value).toBe('Review these');
    const edited = queue.serializeEditedContent('Updated input');
    expect(composerMessagePresentation({ text: edited })).toMatchObject({
      text: 'Updated input',
      files: mixedFiles
    });
    expect(parseComposerTags(edited).find((part) => part.kind === 'mar_attachments')).toMatchObject(
      {
        payload: { instruction }
      }
    );
  });

  it('shows steering body, source snapshot, and resources consistently in history and queue editing', () => {
    const body = '补充 <message>literal</message> & context';
    const tag = serializeComposerTag('mar_steer', { message: body });
    const origin = { sessionId: 'session-42', name: 'Reviewer at send time' };
    const originTag = serializeComposerTag('mar_session_origin', origin);
    const text = [tag, originTag, attachments, references, skills].join('\n');
    expect(composerMessagePresentation({ text })).toMatchObject({
      text: body,
      files,
      sessionOrigin: origin
    });
    expect(conversationItemText('user_message', { text })).toBe(body);
    const queue = createComposerQueueService();
    queue.startEditing({ queueItemId: 'steer', content: text });
    expect(queue.editingContent.value).toBe(body);
    const edited = queue.serializeEditedContent('Updated context');
    expect(edited).not.toContain('<mar_steer>');
    expect(composerMessagePresentation({ text: edited })).toMatchObject({
      text: 'Updated context',
      files,
      sessionOrigin: origin
    });
    expect(parseComposerTags(edited).map((part) => part.kind)).toContain('mar_references');
    const unfinished = queue.serializeEditedContent('```xml\nUnclosed example');
    expect(composerMessagePresentation({ text: unfinished }).sessionOrigin).toEqual(origin);
    queue.finishEditing();
    queue.startEditing({ queueItemId: 'plain', content: 'Plain input' });
    expect(queue.serializeEditedContent('New input')).toBe('New input');
  });
  it('uses the shared source title while preserving channel attribution outside the body and queue editor', () => {
    localePreferenceService().setLocale('en-US');
    const channel = {
      source: 'WEB_SHARE' as const,
      channelId: 'link',
      senderId: 'visitor',
      name: '访客'
    };
    const payload = { text: serializeComposerTag('mar_channel', channel) + '\nHello' };
    expect(composerMessagePresentation(payload)).toMatchObject({ text: 'Hello', channel });
    expect(conversationItemLabel('user_message', payload)).toBe('From 访客');
    expect(
      displayConversationItem({
        id: 'shared-source',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: serializeComposerTag('mar_channel', channel) }
      })
    ).toBe(true);
    const queue = createComposerQueueService();
    queue.startEditing({ queueItemId: 'shared', content: payload.text });
    expect(queue.editingContent.value).toBe('Hello');
    expect(
      composerMessagePresentation({
        text: queue.serializeEditedContent('```xml\nUnclosed example')
      }).channel
    ).toEqual(channel);
    expect(conversationItemText('user_message', payload)).toBe('Hello');
    expect(
      composerMessagePresentation({
        text: serializeComposerTag('mar_channel', channel) + attachments
      }).files
    ).toEqual(files);
  });
  it('hides session-origin tags while retaining normal and steering message text and attachments', () => {
    const origin = { sessionId: 'session-42', name: 'Reviewer' };
    const tag = serializeComposerTag('mar_session_origin', origin);
    const normal = composerMessagePresentation({ text: `Review this\n${tag}\n${attachments}` });
    expect(normal).toMatchObject({ text: 'Review this', files, sessionOrigin: origin });

    const steerTag = serializeComposerTag('mar_steer', { message: 'Focus on the resume path.' });
    const steered = composerMessagePresentation({ text: `${steerTag}\n${tag}\n${attachments}` });
    expect(steered).toMatchObject({
      text: 'Focus on the resume path.',
      files,
      sessionOrigin: origin
    });
    expect(steered.text).not.toContain('mar_session_origin');
    expect(composerMessagePresentation({ text: 'No source marker.' })).not.toHaveProperty(
      'sessionOrigin'
    );
    expect(
      displayConversationItem({
        id: 'source-only',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: serializeComposerTag('mar_session_origin', {}) }
      })
    ).toBe(true);
  });
  it('localizes Session and terminal marctl source titles without changing unmarked messages', () => {
    const sessionPayload = {
      text: serializeComposerTag('mar_session_origin', {
        sessionId: 'session-42',
        name: 'Reviewer'
      })
    };
    const marctlPayload = { text: serializeComposerTag('mar_session_origin', {}) };
    for (const locale of ['en-US', 'zh-CN'] as const) {
      localePreferenceService().setLocale(locale);
      expect(conversationItemLabel('user_message', sessionPayload)).toBe(
        locale === 'en-US' ? 'From Reviewer' : '来自 Reviewer'
      );
      expect(conversationItemLabel('user_message', marctlPayload)).toBe(
        locale === 'en-US' ? 'From marctl' : '来自 marctl'
      );
      expect(conversationItemLabel('user_message', { text: 'Ordinary input' })).toBe(
        locale === 'en-US' ? 'You' : '你'
      );
    }
  });
  it('labels automatic restart inputs separately from user messages in both languages', () => {
    const payload = { text: serializeComposerTag('mar_restart', {}) };
    expect(composerMessagePresentation(payload)).toMatchObject({ restarted: true, text: '' });
    for (const [locale, label, text] of [
      [
        'en-US',
        'System restart continuation',
        'Continuing unfinished work after a system restart.'
      ],
      ['zh-CN', '系统重启续作', '因系统重启，检查现场并继续未完成工作。']
    ] as const) {
      localePreferenceService().setLocale(locale);
      expect(conversationItemLabel('user_message', payload)).toBe(label);
      expect(conversationItemText('user_message', payload)).toBe(text);
    }
  });
  it('uses resource identity instead of the Runner filesystem path for attachment previews', () => {
    const resource = 'mar-attachment://00000000-0000-4000-8000-000000000001/image.png';
    const presentation = composerMessagePresentation({
      text: serializeComposerTag('mar_attachments', {
        files: [
          {
            name: 'image.png',
            mime: 'image/png',
            path: '../../node-data/temp-files/image.png',
            workspacePath: resource
          }
        ]
      })
    });
    expect(presentation.files).toEqual([{ name: 'image.png', mime: 'image/png', path: resource }]);
  });
  it('hides selection inputs but keeps uploaded file metadata and user text', () => {
    const payload = { text: ['检查这份代码', skills, references, attachments].join('\n') };
    expect(conversationItemText('user_message', payload)).toBe('检查这份代码');
    expect(composerMessagePresentation(payload).files).toEqual(files);
    expect(
      displayConversationItem({ id: 'user', kind: 'user_message', status: 'COMPLETED', payload })
    ).toBe(true);
    expect(
      displayConversationItem({
        id: 'hidden',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: references }
      })
    ).toBe(false);
    expect(
      displayConversationItem({
        id: 'file',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: attachments }
      })
    ).toBe(true);
  });

  it('interprets complete user-written tags and preserves unknown or damaged text', () => {
    expect(composerVisibleText(`正文\n${references}`)).toBe('正文');
    const invalid = '<mar_references>{not-json}</mar_references>';
    expect(conversationItemText('user_message', { text: invalid })).toBe(invalid);
    expect(conversationItemText('user_message', { text: '<other>content</other>' })).toBe(
      '<other>content</other>'
    );
  });
  it('does not hide a legal nested tag inside an unknown or damaged outer candidate', () => {
    const channel = serializeComposerTag('mar_channel', {
      source: 'WEB_SHARE',
      channelId: 'link',
      senderId: 'visitor',
      name: 'Alice'
    });
    for (const name of ['mar_unknown', 'mar_unknown2', 'mar_']) {
      const unknown = '<' + name + '>' + references + attachments + channel + '</' + name + '>';
      expect(conversationItemText('user_message', { text: unknown })).toBe(unknown);
      const presentation = composerMessagePresentation({ text: unknown });
      expect(presentation.files).toHaveLength(0);
      expect(presentation.channel).toBeUndefined();
    }
    const damaged =
      '<mar_steer><instruction>Supplemental context.</instruction>' + references + '</mar_steer>';

    expect(conversationItemText('user_message', { text: damaged })).toBe(damaged);
  });
  it('keeps complete product tags visible when they appear in a fenced code example', () => {
    const fence = String.fromCharCode(96).repeat(3);
    const example = fence + 'xml\n' + references + '\n' + fence;

    expect(conversationItemText('user_message', { text: example })).toBe(example);
  });
  it('decodes Steer body text once and does not recursively interpret its contents', () => {
    const body = '&lt; stays escaped, while ' + references + ' stays literal.';
    const text = serializeComposerTag('mar_steer', { message: body });

    expect(composerMessagePresentation({ text }).text).toBe(body);
  });
  it('keeps Goal and scheduled labels visible together without duplicating scheduled provenance', () => {
    localePreferenceService().setLocale('zh-CN');
    const text =
      serializeComposerTag('mar_schedule', { objective: 'Scheduled objective' }) +
      serializeComposerTag('mar_goal_continue', {});
    expect(conversationItemLabel('user_message', { text, source: 'SCHEDULED' })).toBe(
      '定时任务 · 目标继续'
    );
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes Goal and file controls without translating names (%s)',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const payload = { text: serializeComposerTag('mar_goal_start', { objective: '原始目标' }) };
      expect(conversationItemLabel('user_message', payload)).toBe(
        locale === 'zh-CN' ? '目标开始' : 'Goal started'
      );
      expect(
        conversationItemLabel('user_message', {
          text: serializeComposerTag('mar_goal_continue', {})
        })
      ).toBe(locale === 'zh-CN' ? '目标继续' : 'Goal continued');
      expect(conversationItemText('user_message', payload)).toBe('原始目标');
      const documentFiles = [{ name: '说明.txt', mime: 'text/plain', path: '.mar/input/note.txt' }];
      const app = createSSRApp({
        render: () => h(MessageAttachmentFiles, { files: [...files, ...documentFiles] })
      });
      app.use(i18n);
      app.directive('tooltip', { getSSRProps: () => ({}) });
      const html = await renderToString(app);
      expect(html).toContain('说明.txt');
      expect(html).not.toContain('截图.png');
      expect(html).toContain(locale === 'zh-CN' ? '图片附件' : 'Image attachment');
      expect(html).toContain(locale === 'zh-CN' ? '预览文件' : 'Preview file');
      expect(html).not.toContain('data:image');
    }
  );

  it('retains hidden resource inputs when a queued message body is edited', () => {
    const state = createComposerQueueService();
    state.startEditing({
      queueItemId: 'item',
      content: `Old body\n${skills}\n${references}\n${attachments}`
    });
    expect(state.editingContent.value).toBe('Old body');
    expect(composerVisibleText(state.serializeEditedContent('New body'))).toBe('New body');
    expect(
      parseComposerTags(state.serializeEditedContent('')).filter((p) => p.kind !== 'text')
    ).toHaveLength(3);
    state.finishEditing();
    expect(state.serializeEditedContent('Plain')).toBe('Plain');
  });

  it('persists reference-only drafts per Workspace and restores metadata safely', () => {
    const values = new Map<string, string>();
    const target = ref({ nodeId: 'node', workspaceId: 'workspace' });
    const draft = createSessionDraftService({
      workspaceTarget: target as never,
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key)
      }
    });
    const selected = [
      { type: 'file' as const, path: 'src/main.ts', label: 'main.ts' },
      { type: 'session' as const, sessionId: 'session-42', label: 'Alpha & <review>' }
    ];
    draft.references.value = selected;
    draft.persist();
    draft.references.value = [];
    draft.restore();
    expect(draft.references.value).toEqual(selected);
    target.value = { nodeId: 'node', workspaceId: 'other' };
    draft.restore();
    expect(draft.references.value).toEqual([]);
  });

  it('deduplicates and removes Composer reference tokens without inserting paths into the body', () => {
    const input = ref('Review @main');
    const state = createComposerReferenceService(input, {
      nodeId: ref('node'),
      workspaceId: ref('workspace'),
      ready: () => true,
      request: async () => ({})
    } as never);
    const edit = (start: number, end: number, text: string) => {
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      return true;
    };
    state.update(input.value.length);
    state.entries.value = [{ path: 'src/main.ts', name: 'main.ts', kind: 'FILE' }];
    state.selectCandidate(state.candidates.value[0]!, edit);
    expect(input.value).toBe('Review ');
    expect(state.selected.value).toHaveLength(1);
    input.value = '@main';
    state.update(5);
    state.entries.value = [{ path: 'src/main.ts', name: 'main.ts', kind: 'FILE' }];
    state.selectCandidate(state.candidates.value[0]!, edit);
    expect(state.selected.value).toHaveLength(1);
    state.remove('file:src/main.ts');
    expect(state.selected.value).toEqual([]);
  });
});
