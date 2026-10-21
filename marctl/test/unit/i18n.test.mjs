import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslator, localeFromEnv } from '../../src/i18n/index.mjs';

test('selects zh-CN from LC_ALL before LANG', () => {
  assert.equal(localeFromEnv({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }), 'zh-CN');
  assert.equal(localeFromEnv({ LC_ALL: '', LANG: 'zh-TW' }), 'zh-CN');
  assert.equal(localeFromEnv({ LANG: 'C.UTF-8' }), 'en-US');
});

test('localizes help and terminal setup errors without exposing credentials', () => {
  const translate = createTranslator({ LANG: 'zh_CN.UTF-8' });
  assert.match(translate('help'), /用法/);
  assert.match(translate('errors.terminalAttachTimeout'), /超时/);
  assert.equal(translate('errors.userContextUnavailable').includes('secret'), false);
});
