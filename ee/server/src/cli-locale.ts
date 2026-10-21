import { cliMessagesEnUS } from './cli-messages.en-US.js';
import { cliMessagesZhCN } from './cli-messages.zh-CN.js';

export type CliLocale = 'zh-CN' | 'en-US';
export type CliMessageKey = keyof typeof cliMessagesEnUS;

export function resolveCliLocale(environment: NodeJS.ProcessEnv = process.env): CliLocale {
  const explicit = environment['MAR_LOCALE'];
  if (explicit === 'zh-CN' || explicit === 'en-US') return explicit;
  const systemLocale =
    environment['LC_ALL'] ?? environment['LC_MESSAGES'] ?? environment['LANG'] ?? '';
  return systemLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function cliText(
  key: CliMessageKey,
  parameters: Readonly<Record<string, string | number>> = {}
): string {
  const messages = resolveCliLocale() === 'zh-CN' ? cliMessagesZhCN : cliMessagesEnUS;
  let text: string = messages[key];
  for (const [name, value] of Object.entries(parameters))
    text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
