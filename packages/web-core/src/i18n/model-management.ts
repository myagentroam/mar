export { modelManagementEnUS } from './model-management.en-US.js';
export { modelManagementZhCN } from './model-management.zh-CN.js';

export const codexUsageLargeTokenFormat = {
  'en-US': { divisor: 1_000_000, minimumFractionDigits: 0 },
  'zh-CN': { divisor: 100_000_000, minimumFractionDigits: 1 }
} as const;
