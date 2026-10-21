export type IconThemeId = 'seti' | 'material';

export interface GlyphFileIcon {
  readonly kind: 'glyph';
  readonly character: string;
  readonly color?: string;
}

export interface SvgFileIcon {
  readonly kind: 'svg';
  readonly markup: string;
  readonly color: string;
}

export type FileIcon = GlyphFileIcon | SvgFileIcon;

export interface FileIconTheme {
  readonly id: IconThemeId;
  readonly labelKey: string;
  resolveFile(name: string, light: boolean): FileIcon;
  resolveFolder(light: boolean, name?: string): FileIcon;
}
