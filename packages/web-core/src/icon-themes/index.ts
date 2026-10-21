import { materialIconTheme } from './material/index.js';
import { setiIconTheme } from './seti/index.js';
import type { FileIconTheme, IconThemeId } from './types.js';

export type { FileIcon, FileIconTheme, IconThemeId } from './types.js';

export const iconThemes: readonly FileIconTheme[] = [setiIconTheme, materialIconTheme];

const ICON_THEMES: Readonly<Record<IconThemeId, FileIconTheme>> = Object.fromEntries(
  iconThemes.map((theme) => [theme.id, theme])
) as Readonly<Record<IconThemeId, FileIconTheme>>;

export function resolveIconTheme(id: IconThemeId): FileIconTheme {
  return ICON_THEMES[id];
}
