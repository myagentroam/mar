import { enUS } from './messages.en-US.js';
import { zhCN } from './messages.zh-CN.js';

export const messages = {
  'zh-CN': zhCN,
  'en-US': enUS
} as const;

export type MessageSchema = typeof enUS;
