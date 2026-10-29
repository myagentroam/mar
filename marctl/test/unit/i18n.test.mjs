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

test('describes steer neutrally and makes deferred queue consumption explicit in both languages', () => {
  const english = createTranslator({ LANG: 'en_US.UTF-8' })('commandHelp.agents');
  const chinese = createTranslator({ LANG: 'zh_CN.UTF-8' })('commandHelp.agents');
  assert.match(english, /Prefer --steer for timely communication or course correction/);
  assert.match(english, /consumed after\s+current work and earlier queued inputs finish/u);
  assert.match(english, /not consumed until that Goal exits/u);
  assert.doesNotMatch(english, /--steer replaces/u);
  assert.match(chinese, /即时沟通或纠偏优先使用 --steer/u);
  assert.match(chinese, /当前工作及前面的队列项结束后才消费/u);
  assert.match(chinese, /必须等到该 Goal 退出才消费/u);
});
