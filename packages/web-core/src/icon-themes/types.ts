export type IconThemeId = 'mar';

export interface FileIcon {
  readonly kind: 'sprite';
  readonly href: string;
  readonly color: string;
  readonly cutColor: string;
}

export interface FileIconTheme {
  readonly id: IconThemeId;
  readonly labelKey: string;
  resolveFile(name: string, light: boolean): FileIcon;
  resolveFolder(light: boolean, name?: string): FileIcon;
}
