import enUS from './en-US.mjs';
import zhCN from './zh-CN.mjs';

export function localeFromEnv(env = process.env) {
  const value = String(env.LC_ALL || env.LANG || '').toLowerCase();
  return value.startsWith('zh_') || value.startsWith('zh-') || value === 'zh' ? 'zh-CN' : 'en-US';
}

export function createTranslator(env = process.env) {
  const locale = localeFromEnv(env);
  const resource = locale === 'zh-CN' ? zhCN : enUS;
  const translate = (key, params = {}) => {
    const value = key.split('.').reduce((current, part) => current?.[part], resource);
    if (typeof value === 'function') return value(params);
    if (typeof value !== 'string') return key;
    return value.replace(/\{(\w+)\}/gu, (_match, name) => String(params[name] ?? ''));
  };
  translate.locale = locale;
  return translate;
}
