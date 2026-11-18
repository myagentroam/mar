type IconAssociations = Readonly<Record<string, string>>;

export interface MarIconAssociations {
  readonly fileExtensions: IconAssociations;
  readonly fileNames: IconAssociations;
  readonly folderNames: IconAssociations;
  readonly fallback: { readonly file: string; readonly folder: string };
}

export function resolveMarIconId(
  mapping: MarIconAssociations,
  path: string,
  folder: boolean
): string;
