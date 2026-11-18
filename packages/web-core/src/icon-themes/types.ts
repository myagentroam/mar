export type IconThemeId = 'mar' | 'seti' | 'material';

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

export interface SpriteFileIcon {
  readonly kind: 'sprite';
  readonly href: string;
  readonly color: string;
  readonly cutColor: string;
}

export type FileIcon = GlyphFileIcon | SvgFileIcon | SpriteFileIcon;

export interface FileIconTheme {
  readonly id: IconThemeId;
  readonly labelKey: string;
  resolveFile(name: string, light: boolean): FileIcon;
  resolveFolder(light: boolean, name?: string): FileIcon;
}
