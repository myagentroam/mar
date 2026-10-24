import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import ModelPage from '../../src/view/settings/MarAgentModelManagementPage.vue';
import ImagePage from '../../src/view/settings/ImageGenerationManagement.vue';
import ChatGPTManageUsageButton from '../../src/view/common/ChatGPTManageUsageButton.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import { commonMessages } from '../../src/i18n/messages.js';
import { codexUsageTokenCountLabel } from '../../src/util/workbench-presentation.js';

afterEach(() => vi.unstubAllGlobals());
describe('Shared model, credential and image management', () => {
  it('provides a safe bilingual usage link in ChatGPT credential details independently of writes', async () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      i18n.global.locale.value = locale;
      const app = createSSRApp({ render: () => h(ChatGPTManageUsageButton) });
      app.use(i18n).use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 941, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html).toContain('class="el-button"');
      expect(html).not.toContain('el-button--primary');
      expect(html).toContain('href="https://chatgpt.com/settings/usage"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain(locale === 'zh-CN' ? '管理用量' : 'Manage usage');
    }
  });

  it('lists both OAuth types together and labels legacy credentials in both locales', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      expect(commonMessages[locale].marAgentModels.codexLegacyCredential).toBe('Codex (legacy)');
      expect(commonMessages[locale].marAgentModels.protocolCodex).toBe('Codex (legacy)');
      expect(commonMessages[locale].marAgentModels.chatgptCredential).toBe('ChatGPT');
    }
    expect(commonMessages['zh-CN'].marAgentModels.codexCredentialsTab).toBe('OAuth 凭据');
    expect(commonMessages['en-US'].marAgentModels.codexCredentialsTab).toBe('OAuth credentials');
  });
  it('uses provider-neutral OAuth wording and credential-specific name labels in both locales', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const messages = commonMessages[locale].marAgentModels;
      for (const key of [
        'codexEditCredentialTitle',
        'codexReloginTitle',
        'codexCredential',
        'codexCredentialId',
        'credentialSelect',
        'credentialRequired',
        'codexTestSucceeded',
        'codexTestFailed',
        'codexRemoved',
        'codexRemoveFailed',
        'codexConfirmRemove',
        'codexLoadFailed',
        'codexCatalogTitle',
        'codexCatalogLoadFailed',
        'codexImportSucceeded',
        'codexImportFailed',
        'codexImportResultTitle',
        'codexErrorNameConflict',
        'codexErrorReauthRequired',
        'codexErrorRefreshTransient',
        'codexErrorCheckFailed',
        'codexErrorCatalogChanged',
        'codexErrorCatalogLoadFailed',
        'codexErrorAttemptNotFound'
      ] as const) {
        expect(messages[key], `${locale}: ${key}`).not.toContain('Codex');
      }
      expect(messages.codexEditCredentialTitle).toBe(
        locale === 'zh-CN' ? '编辑 OAuth 凭据' : 'Edit OAuth credential'
      );
      expect(messages.credentialName).toBe(locale === 'zh-CN' ? '凭据名称' : 'Credential name');
      expect(messages.credentialNameRequired).toBe(
        locale === 'zh-CN' ? '请输入凭据名称。' : 'Enter a credential name.'
      );
      expect(messages.codexDeviceLoginTitle).toContain('Codex');
      expect(messages.codexUsageTitle).toContain('Codex');
      expect(messages.imageGenerationCredential).toContain('Codex');
    }
  });
  it('keeps Grok credentials, models and subscription usage provider-specific', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const messages = commonMessages[locale].marAgentModels;
      expect(messages.grokSubscriptionCredential).toBe(
        locale === 'zh-CN' ? 'X订阅' : 'X subscription'
      );
      expect(messages.grokProtocol).toBe(messages.grokSubscriptionCredential);
      expect(messages.grokExperimentalHint).toBeTruthy();
      expect(messages.grokProxyHint).toBeTruthy();
      expect(messages.grokUsageTitle).toBe(
        locale === 'zh-CN' ? 'X订阅额度' : 'X subscription usage'
      );
      expect(messages.grokLoginTitle).toBe(
        locale === 'zh-CN' ? 'X订阅登录' : 'X subscription sign-in'
      );
      expect(messages.grokUsagePrepaidBalance).toBeTruthy();
      expect(messages.grokUsageRemainingPercentage).toBeTruthy();
      expect(messages.grokErrorLoginConflict).toBe(
        locale === 'zh-CN'
          ? '登录期间凭据或账户发生变化，请重新发起登录。'
          : 'The credential or account changed during sign-in. Start sign-in again.'
      );
      expect(messages.grokErrorEntitlementRequired).toBeTruthy();
      expect(messages.grokErrorRequestFailed).toBeTruthy();
    }
  });
  it('provides localized model transport diagnostic labels', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const messages = commonMessages[locale].marAgentModels;
      for (const key of [
        'modelTestResultTitle',
        'modelTestSuccess',
        'modelTestFailure',
        'modelTestCode',
        'modelTestHttpStatus',
        'modelTestMessage',
        'modelTestServerRequestId',
        'modelTestUpstreamRequestId',
        'modelTestContentType',
        'modelTestRetryAfter',
        'modelTestResponseBody',
        'modelTestResponseBodyTruncated'
      ] as const) {
        expect(messages[key]).toBeTruthy();
      }
    }
  });

  it('keeps enterprise ownership and grants outside complete public pages', () => {
    for (const name of ['MarAgentModelManagementPage', 'ImageGenerationManagement']) {
      const source = readFileSync(
        new URL(`../../src/view/settings/${name}.vue`, import.meta.url),
        'utf8'
      );
      expect(source).not.toMatch(
        /@\/|ORGANIZATION|ENTERPRISE|ownerOrganizationId|\/api\/organizations|\/api\/resource-grants|props\.role|props\.edition/u
      );
    }
  });
  it('omits retired high-density model option labels from locales', () => {
    expect(commonMessages['zh-CN'].marAgentModels).not.toHaveProperty('highDensityCompaction');
    expect(commonMessages['en-US'].marAgentModels).not.toHaveProperty('highDensityCompaction');
  });
  it('formats large Codex usage directly in millions for English and preserves Chinese units', () => {
    expect(commonMessages['zh-CN'].marAgentModels.codexUsageCurrentDayTokens).toBe('上一日用量');
    expect(commonMessages['en-US'].marAgentModels.codexUsageCurrentDayTokens).toBe(
      'Previous day usage'
    );
    expect(commonMessages['zh-CN'].marAgentModels.codexUsageStatsAsOf).toBe(
      '{value}（{timezone}）'
    );
    expect(commonMessages['en-US'].marAgentModels.codexUsageStatsAsOf).toBe('{value} ({timezone})');
    const previousLocale = i18n.global.locale.value;
    try {
      i18n.global.locale.value = 'en-US';
      expect(codexUsageTokenCountLabel(48_150_000_000)).toBe('48150M');
      expect(codexUsageTokenCountLabel(760_000_000)).toBe('760M');
      expect(codexUsageTokenCountLabel(4_710_000_000)).toBe('4710M');
      expect(codexUsageTokenCountLabel(99_000_000)).toBe('99.0M');
      expect(codexUsageTokenCountLabel(null)).toBe('—');

      i18n.global.locale.value = 'zh-CN';
      expect(codexUsageTokenCountLabel(48_150_000_000)).toBe('481.5亿');
      expect(codexUsageTokenCountLabel(760_000_000)).toBe('7.6亿');
      expect(codexUsageTokenCountLabel(4_710_000_000)).toBe('47.1亿');
    } finally {
      i18n.global.locale.value = previousLocale;
    }
  });
  it('omits obsolete Responses encoding labels from both locales', () => {
    for (const language of ['en-US', 'zh-CN'] as const) {
      for (const key of ['encoding', 'encodingStandard', 'encodingLite', 'encodingRequired']) {
        expect(commonMessages[language].marAgentModels).not.toHaveProperty(key);
      }
    }
  });

  it('keeps model labels, free-form ID, and creation defaults', () => {
    expect(commonMessages['zh-CN'].marAgentModels.name).toBe('模型名称');
    expect(commonMessages['zh-CN'].marAgentModels.model).toBe('模型 ID');
    expect(commonMessages['en-US'].marAgentModels.name).toBe('Model name');
    expect(commonMessages['en-US'].marAgentModels.model).toBe('Model ID');
    expect(commonMessages['zh-CN'].marAgentModels.enabled).toBe('启用');
    expect(commonMessages['en-US'].marAgentModels.enabled).toBe('Enabled');
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'renders standalone public pages with complete %s messages',
    async (locale) => {
      vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
      i18n.global.locale.value = locale;
      for (const [name, component] of [
        ['MarAgentModelManagementPage', ModelPage],
        ['ImageGenerationManagement', ImagePage]
      ] as const) {
        const source = readFileSync(
          new URL(`../../src/view/settings/${name}.vue`, import.meta.url),
          'utf8'
        );
        for (const match of source.matchAll(
          /['"]((?:marAgentModels|common)\.[A-Za-z0-9]+)['"]/gu
        )) {
          let value: unknown = commonMessages[locale];
          for (const part of match[1]!.split('.'))
            value = (value as Record<string, unknown>)?.[part];
          expect(value, `${name}: ${match[1]}`).toBeTypeOf('string');
        }
        const request = vi.fn(async <T>() => ({}) as T);
        const app = createSSRApp({
          render: () => h(component, { request, writable: true, nodes: [] })
        });
        app.use(i18n).use(ElementPlus);
        app.directive('tooltip', { getSSRProps: () => ({}) });
        app.provide(ID_INJECTION_KEY, { prefix: 941, current: 0 });
        app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
        const html = await renderToString(app);
        expect(html).toContain('el-');
        expect(html).not.toMatch(/enterprise|organization|全企业|组织/iu);
        expect(request).not.toHaveBeenCalled();
      }
    }
  );
});
