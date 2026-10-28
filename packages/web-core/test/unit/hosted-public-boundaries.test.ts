import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { computed } from 'vue';
import type { ConversationTemplateSummary } from '@myagentroam/protocol';
import { listAvailableConversationTemplates } from '../../src/service/hosted-conversation-entry-service.js';
import {
  hostedConversationsEnUS,
  hostedConversationsZhCN
} from '../../src/i18n/hosted-conversations.js';
import { commonMessages } from '../../src/i18n/messages.js';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import { hostedConversationTitle } from '../../src/util/hosted-conversation-presentation.js';

const template: ConversationTemplateSummary = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'Code Review',
  description: 'Review changes in an isolated conversation.',
  status: 'ACTIVE',
  currentVersionId: 'version-1',
  available: true,
  createdAt: 1,
  updatedAt: 1
};

const hostedConversationMessageKeys =
  'switchTemplate templateSwitchTitle templateSwitchConfirmation templateOptionsFailed noSameNodeTemplates eyebrow title summary chooseTemplate chooseTemplateLabel chooseTemplateHint singleTemplatePreselected noTemplates noTemplateSelected temporaryTitle templatePlaceholder templateRequired explicitConfirmation create start created createFailed loadFailed createdTitle createdHint nodeOffline capacityUnavailable sandboxUnavailable nodeUnavailable historyTitle closeHistory hostNode offline searchHistory noLoadedHistoryMatches filterLoadedOnly noHistory historyTemplateNode refreshHistory loadMore noConversationSelected selectConversationHint loadingConversation filesTitle closeFiles filesAvailableAfterCreate noFiles filesDropHint filesDropNow filesUploaded fileUploadFailed fileDelete fileDeleteNamed fileDeleteTitle fileDeleteConfirmation fileDeleted fileNotFound fileConflict fileCategoryUPLOAD fileCategoryOUTPUT expandFileDirectory collapseFileDirectory statusACTIVE moreActions editTitle titlePrompt titlePlaceholder titleRequired titleTooLong titleUpdated pin unpin pinned unpinned pinnedLabel unreadLabel deleteNamed deleteTitle deleteConfirmation delete cancel deleted nodeOfflineReadonly watchUnavailableReadonly readonly watchExpired watchFailed messagePlaceholder sending running addAttachment confirmDroppedAttachmentsTitle confirmDroppedAttachments confirmUpload attachmentLimit folderAttachmentUnsupported attachmentTooLarge attachmentInvalidName attachmentConflict quotaExceeded storageFull fileProjectionFailed uploadProgress uploaded uploadAfterCreate firstMessagePaused firstMessageDisposed firstMessageWatchRequired retryAttachment retryAttachmentNamed removeAttachment model modelUnavailable loadedTemplateNamed send stop stopWithEsc runActive replaceCurrentHint replaceCurrentUnsupported rollbackTitle rollbackConfirmation rollback rollbackTargetInvalid upgradeFailed operationFailed copied copyFailed notFound stateInvalid responseInvalid filePreview previewTruncated previewUnavailable download mobilePanels mobileHistory mobileConversation mobileFiles'.split(
    ' '
  );

const originalLocale = localePreferenceService().locale.value;

afterEach(() => localePreferenceService().setLocale(originalLocale));

describe('Public Hosted Conversation Boundaries', () => {
  it('Read only strictly public summaries from the public template directory', async () => {
    const requests: Array<{ path: string; init: RequestInit | undefined }> = [];

    const result = await listAvailableConversationTemplates(
      async (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        return { templates: [template] } as never;
      }
    );

    expect(result).toEqual([template]);
    expect(requests).toEqual([{ path: '/api/conversation-templates', init: undefined }]);
  });

  it('Reject unknown top-level fields in the template directory response', async () => {
    await expect(
      listAvailableConversationTemplates(
        async () =>
          ({
            templates: [template],
            nextCursor: 'private-server-state'
          }) as never
      )
    ).rejects.toThrow('CONVERSATION_TEMPLATE_RESPONSE_INVALID');
  });

  it('Reject a template response whose templates field is not an array', async () => {
    await expect(
      listAvailableConversationTemplates(async () => ({ templates: template }) as never)
    ).rejects.toThrow('CONVERSATION_TEMPLATE_RESPONSE_INVALID');
  });

  it('Reject template summaries that expose draft fields', async () => {
    await expect(
      listAvailableConversationTemplates(
        async () =>
          ({
            templates: [{ ...template, draftRevision: 7 }]
          }) as never
      )
    ).rejects.toThrow('CONVERSATION_TEMPLATE_RESPONSE_INVALID');
  });

  it('Preserve template-directory request errors unchanged', async () => {
    const requestError = new Error('REQUEST_FAILED_503');

    await expect(
      listAvailableConversationTemplates(async () => {
        throw requestError;
      })
    ).rejects.toBe(requestError);
  });

  it('Isolate directory requests and results for different callers', async () => {
    const firstTemplate = { ...template, id: 'template-first' };
    const secondTemplate = { ...template, id: 'template-second', nodeId: 'node-second' };
    const firstRequests: string[] = [];
    const secondRequests: string[] = [];

    const [first, second] = await Promise.all([
      listAvailableConversationTemplates(async (path: string) => {
        firstRequests.push(path);
        return { templates: [firstTemplate] } as never;
      }),
      listAvailableConversationTemplates(async (path: string) => {
        secondRequests.push(path);
        return { templates: [secondTemplate] } as never;
      })
    ]);

    expect(first).toEqual([firstTemplate]);
    expect(second).toEqual([secondTemplate]);
    expect(firstRequests).toEqual(['/api/conversation-templates']);
    expect(secondRequests).toEqual(['/api/conversation-templates']);
  });

  it('keeps HostedConversation file flows outside the Workspace direct-transfer client', () => {
    const serviceSource = readFileSync(
      new URL('../../src/service/hosted-conversation-workspace-service.ts', import.meta.url),
      'utf8'
    );
    const pageSource = readFileSync(
      new URL('../../src/view/conversation/HostedConversationWorkspacePage.vue', import.meta.url),
      'utf8'
    );

    for (const source of [serviceSource, pageSource]) {
      expect(source).not.toContain('WorkspaceDirectTransfer');
      expect(source).not.toContain('direct.prepare');
      expect(source).not.toContain('direct-metadata');
    }
  });

  it('Keep bilingual public message keys, placeholders, and composition fields aligned', () => {
    expect(hostedConversationsEnUS.hostedConversations.replaceCurrentHint).toBe(
      'While working, press Ctrl+Enter to steer with this message.'
    );
    expect(hostedConversationsZhCN.hostedConversations.replaceCurrentHint).toBe(
      '任务进行中，按 Ctrl+Enter 可插入消息。'
    );
    expect(hostedConversationsEnUS.hostedConversations.replaceCurrentUnsupported).toBe(
      'This host does not support steering an in-progress task.'
    );
    expect(Object.keys(hostedConversationsEnUS.hostedConversations)).toEqual(
      hostedConversationMessageKeys
    );
    expect(Object.keys(hostedConversationsZhCN.hostedConversations)).toEqual(
      hostedConversationMessageKeys
    );
    expect(commonMessages['en-US'].common).toMatchObject({ cancel: 'Cancel', save: 'Save' });
    expect(commonMessages['zh-CN'].common).toMatchObject({
      cancel: commonMessages['zh-CN'].common.cancel,
      save: commonMessages['zh-CN'].common.save
    });
    expect(commonMessages['en-US'].workbench.sending).toBe('Sending...');
    expect(commonMessages['en-US'].presentation.lastActivity).toBe('Last activity: {value}');

    const english = messageLeaves(hostedConversationsEnUS);
    const chinese = messageLeaves(hostedConversationsZhCN);
    expect([...english.keys()].sort()).toEqual([...chinese.keys()].sort());
    for (const [path, englishMessage] of english) {
      const chineseMessage = chinese.get(path);
      expect(chineseMessage, path).toBeTypeOf('string');
      expect(placeholders(englishMessage)).toEqual(placeholders(chineseMessage!));
    }
    for (const [locale, leaves] of [
      ['en-US', english],
      ['zh-CN', chinese]
    ] as const) {
      for (const [path, value] of leaves) {
        expect(
          path
            .split('.')
            .reduce<unknown>(
              (part, key) => (part as Record<string, unknown>)[key],
              commonMessages[locale]
            ),
          path
        ).toBe(value);
      }
    }
  });

  it('Localize the default title reactively while keeping custom titles unchanged', () => {
    const defaultTitle = { title: 'New conversation', titleSource: 'DEFAULT' } as const;
    const customTitle = { title: 'Release review', titleSource: 'CUSTOM' } as const;
    const displayedTitle = computed(() => hostedConversationTitle(defaultTitle));

    localePreferenceService().setLocale('en-US');
    expect(displayedTitle.value).toBe('New conversation');
    expect(hostedConversationTitle(customTitle)).toBe('Release review');

    localePreferenceService().setLocale('zh-CN');
    expect(displayedTitle.value).toBe(hostedConversationsZhCN.hostedConversations.temporaryTitle);
    expect(hostedConversationTitle(customTitle)).toBe('Release review');
  });
});

function messageLeaves(value: Record<string, unknown>, prefix = ''): ReadonlyMap<string, string> {
  const leaves = new Map<string, string>();
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (typeof child === 'string') {
      leaves.set(path, child);
      continue;
    }
    if (typeof child !== 'object' || child === null || Array.isArray(child))
      throw new Error(`Invalid locale message at ${path}`);
    for (const [nestedPath, message] of messageLeaves(child as Record<string, unknown>, path))
      leaves.set(nestedPath, message);
  }
  return leaves;
}

function placeholders(message: string): readonly string[] {
  return [...message.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!).sort();
}
