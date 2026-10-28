import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  localeFromLanguages,
  localePreferenceService,
  parseLocale,
  resolveInitialLocale,
  translate
} from '../../ee/web/src/service/locale-preference-service';
import { ApiError } from '@myagentroam/web-core/api-error';
import {
  absoluteMessageTime,
  absoluteSessionTime,
  errorMessage,
  hostedConversationTitle
} from '@myagentroam/web-core/workbench-presentation';

afterEach(() => vi.unstubAllGlobals());

describe('Web locale preference', () => {
  it('keeps native language names and documentation paths in the shared locale catalog', () => {
    expect(SUPPORTED_LOCALES).toEqual([
      expect.objectContaining({ value: 'zh-CN', nativeLabel: '简体中文', docsPrefix: '/docs' }),
      expect.objectContaining({ value: 'en-US', nativeLabel: 'English', docsPrefix: '/docs/en-US' })
    ]);
  });

  it('accepts only supported locale identifiers', () => {
    expect(parseLocale('zh-CN')).toBe('zh-CN');
    expect(parseLocale('en-US')).toBe('en-US');
    expect(parseLocale('en')).toBeUndefined();
    expect(parseLocale(null)).toBeUndefined();
  });

  it('maps every Chinese system locale to Simplified Chinese', () => {
    expect(localeFromLanguages(['zh-TW'])).toBe('zh-CN');
    expect(localeFromLanguages(['fr-FR', 'zh-HK'])).toBe('zh-CN');
  });

  it('respects the first supported language in browser preference order', () => {
    expect(localeFromLanguages(['en-US', 'zh-CN'])).toBe('en-US');
    expect(localeFromLanguages(['fr-FR', 'zh-HK', 'en-US'])).toBe('zh-CN');
  });

  it('falls back to English for non-Chinese and unknown languages', () => {
    expect(localeFromLanguages(['en-GB'])).toBe('en-US');
    expect(localeFromLanguages([])).toBe(DEFAULT_LOCALE);
  });

  it('prefers a persisted locale over system language detection', () => {
    expect(resolveInitialLocale({ stored: 'en-US', languages: ['zh-CN'] })).toBe('en-US');
    expect(resolveInitialLocale({ stored: 'invalid', languages: ['zh-CN'] })).toBe('zh-CN');
  });

  it('formats Workbench timestamps identically in both interface languages', () => {
    const timestamp = new Date(2026, 7, 24, 2, 30, 45).getTime();
    for (const locale of ['en-US', 'zh-CN'] as const) {
      localePreferenceService().setLocale(locale);
      expect(absoluteSessionTime(timestamp)).toBe('2026-08-24 02:30:45');
    }
  });

  it('localizes only the fixed default hosted-conversation title', () => {
    const defaultTitle = { title: 'New conversation', titleSource: 'DEFAULT' } as const;
    const automaticTitle = { title: 'Generated title', titleSource: 'AUTO' } as const;
    const customTitle = { title: '用户标题', titleSource: 'CUSTOM' } as const;

    localePreferenceService().setLocale('zh-CN');
    expect(hostedConversationTitle(defaultTitle)).toBe('新建对话');
    expect(hostedConversationTitle(automaticTitle)).toBe('Generated title');
    expect(hostedConversationTitle(customTitle)).toBe('用户标题');

    localePreferenceService().setLocale('en-US');
    expect(hostedConversationTitle(defaultTitle)).toBe('New conversation');
  });

  it('formats conversation message timestamps with a locale-neutral numeric date and time', () => {
    const timestamp = new Date(2026, 7, 24, 2, 30, 45).getTime();
    localePreferenceService().setLocale('en-US');
    expect(absoluteMessageTime(timestamp)).toBe('2026-08-24 02:30:45');
    localePreferenceService().setLocale('zh-CN');
    expect(absoluteMessageTime(timestamp)).toBe('2026-08-24 02:30:45');
  });

  it('resolves stable message keys with the active interface locale', () => {
    localePreferenceService().setLocale('en-US');
    expect(translate('generated.composerToolbar.send')).toBe('Send');
    localePreferenceService().setLocale('zh-CN');
    expect(translate('generated.composerToolbar.send')).toBe('发送');
  });

  it('uses the confirmed product terminology in both interface languages', () => {
    localePreferenceService().setLocale('zh-CN');
    expect(translate('navigation.nodes')).toBe('工作');
    expect(translate('personalInstructions.prompt')).toBe('个性化提示词');
    expect(translate('personalInstructions.marAgent')).toBe('MAR Agent');
    expect(translate('common.runner')).toBe('Agent');
    expect(translate('nodeMessages.implement')).toBe('执行计划');
    expect(translate('generated.conversationDomain.implement')).toBe('执行计划');
    expect(translate('generated.resourceSharingPage.unregisterWorkspace')).toBe('确认删除工作区');
    expect(translate('generated.workbenchWorkspaceTreeController.unregister')).toBe('移除工作区');
    expect(translate('generated.runnerUsageService.thisRunnerIsUnavailableSoUsageCannot')).toBe(
      '当前 Agent 不可用，无法查询用量。'
    );
    expect(translate('generated.nodeManagementPage.supportedAgents')).toBe('支持的 Agent');
    expect(translate('generated.workbenchPageController.theNodeIsDisabledOnlyTheCurrent')).toBe(
      '节点已禁用；当前内容仅供查看，无法继续同步。'
    );
    expect(translate('workbenchNotificationCenter.runStatus.SUCCEEDED')).toBe('已完成');

    localePreferenceService().setLocale('en-US');
    expect(translate('navigation.nodes')).toBe('Work');
    expect(translate('common.runner')).toBe('Agent');
    expect(translate('personalInstructions.prompt')).toBe('Personal instructions');
    expect(translate('personalInstructions.marAgent')).toBe('MAR Agent');
    expect(translate('generated.resourceSharingPage.unregisterWorkspace')).toBe('Delete Workspace');
    expect(translate('generated.runnerUsageService.thisRunnerIsUnavailableSoUsageCannot')).toBe(
      'This Agent is unavailable, so usage cannot be queried.'
    );
    expect(translate('auth.title')).toBe('Continue working with your Agent.');
    expect(translate('workbenchNotificationCenter.runStatus.SUCCEEDED')).toBe('Completed');
  });

  it('Shortcut descriptions use the same localized names as Inspector tabs', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      localePreferenceService().setLocale(locale);
      expect(translate('generated.settingsContent.switchTheInspectorToGitChanges')).toContain(
        translate('generated.workspaceInspector.gitChanges')
      );
      for (const key of [
        'generated.workspaceInspector.refreshGitChanges',
        'generated.workspaceInspector.refreshGitChanges2'
      ] as const)
        expect(translate(key).toLocaleLowerCase(locale)).toContain(
          translate('generated.workspaceInspector.gitChanges').toLocaleLowerCase(locale)
        );
      for (const key of [
        'generated.workspaceInspector.refreshGitHistory',
        'generated.workspaceInspector.refreshGitHistory2'
      ] as const)
        expect(translate(key).toLocaleLowerCase(locale)).toContain(
          translate('generated.workspaceInspector.gitHistory').toLocaleLowerCase(locale)
        );
    }
  });

  it('compiles literal at signs in composer and Git SSH messages', () => {
    for (const locale of ['en-US', 'zh-CN'] as const) {
      localePreferenceService().setLocale(locale);
      expect(
        translate('generated.workbenchSurface.typeForCommandsToReferenceWorkspaceFiles', {
          value0: 'Codex'
        })
      ).toContain('@');
      expect(translate('generated.skillSourceManagementPage.httpsGithubComOrgRepoOrGit')).toContain(
        'git@github.com'
      );
    }
  });

  it('localizes high-salience error codes and preserves readable English fallbacks', () => {
    localePreferenceService().setLocale('zh-CN');
    const diagnostic = errorMessage(
      new ApiError(
        'NODE_OFFLINE',
        'The Node is offline.',
        {},
        'The control connection closed before the operation completed.',
        'server-request-1',
        'node-request-1'
      )
    );
    expect(diagnostic).toContain('节点当前离线，请确认节点服务已启动。');
    expect(diagnostic).toContain('The control connection closed before the operation completed.');
    expect(diagnostic).toContain('NODE_OFFLINE');
    expect(diagnostic).toContain('server-request-1');
    expect(diagnostic).toContain('node-request-1');
    const fallback = errorMessage(
      new ApiError('LOW_SALIENCE_FAILURE', 'The background refresh failed.')
    );
    expect(fallback).toContain('The background refresh failed.');
    expect(fallback).toContain('LOW_SALIENCE_FAILURE');
  });
});
