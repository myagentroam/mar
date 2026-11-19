import { marIconTheme } from './mar/index.js';
import type { FileIconTheme, IconThemeId } from './types.js';

export type { FileIcon, FileIconTheme, IconThemeId } from './types.js';

export const DEFAULT_ICON_THEME_ID: IconThemeId = 'mar';

const ICON_THEMES: Readonly<Record<IconThemeId, FileIconTheme>> = {
  mar: marIconTheme
};

export const iconThemes: readonly FileIconTheme[] = Object.values(ICON_THEMES);

export function isIconThemeId(value: string): value is IconThemeId {
  return Object.hasOwn(ICON_THEMES, value);
}

export function resolveIconTheme(id: IconThemeId): FileIconTheme {
  return ICON_THEMES[id];
}
