import type { FileIcon, FileIconTheme } from '../types.js';
import illustrationsUrl from './illustrations.svg?no-inline';
import mapping from './mapping.json';
import { resolveMarIconId } from './resolve-icon-id.mjs';

interface MarIconPalette {
  readonly artwork: Readonly<Record<string, { readonly accent: string; readonly symbol?: string }>>;
  readonly colors: Readonly<Record<string, { readonly light: string; readonly dark: string }>>;
}

const { artwork, colors }: MarIconPalette = mapping;

function icon(id: string, light: boolean): FileIcon {
  // Asset integrity is covered by the registry test; inputs only select bundled identifiers.
  const { accent, symbol = id } = artwork[id]!;
  const palette = colors[accent]!;
  return {
    kind: 'sprite',
    href: `${illustrationsUrl}#mar-file-${symbol}`,
    color: light ? palette.light : palette.dark,
    cutColor: light ? mapping.cutColors.light : mapping.cutColors.dark
  };
}

export const marIconTheme = {
  id: 'mar',
  labelKey: 'settings.iconThemeMar',
  resolveFile: (name, light) => icon(resolveMarIconId(mapping, name, false), light),
  resolveFolder: (light, name = '') => icon(resolveMarIconId(mapping, name, true), light)
} satisfies FileIconTheme;
