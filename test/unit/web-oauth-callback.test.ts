import { describe, expect, it } from 'vitest';
import { oauthErrorMessage } from '../../ee/web/src/util/oauth-callback.js';
import { localePreferenceService } from '../../ee/web/src/service/LocalePreferenceService.js';

describe('Web OAuth callback messages', () => {
  it('Known error codes map to specific messages and unknown codes retain a generic fallback', () => {
    localePreferenceService().setLocale('zh-CN');
    expect(oauthErrorMessage('OAUTH_IDENTITY_ALREADY_BOUND', 'fallback')).toContain(
      '已绑定到其他账号'
    );
    expect(oauthErrorMessage('OAUTH_CALLBACK_INVALID', 'fallback')).toContain('授权未完成');
    expect(oauthErrorMessage('UNRECOGNIZED_OAUTH_ERROR', 'fallback')).toBe('fallback');
    expect(oauthErrorMessage(null, 'fallback')).toBe('fallback');
  });

  it('uses English known-error messages when English is active', () => {
    localePreferenceService().setLocale('en-US');
    expect(oauthErrorMessage('OAUTH_IDENTITY_ALREADY_BOUND', 'fallback')).toContain(
      'bound to another account'
    );
    expect(oauthErrorMessage('OAUTH_CALLBACK_INVALID', 'fallback')).toContain('was not completed');
  });
});
