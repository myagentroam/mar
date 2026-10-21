import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

const LEGACY_EXTENSION_ALIASES: Readonly<Record<string, string>> = {
  conf: 'Properties files',
  jsonc: 'JSON',
  zsh: 'Shell'
};

export function codeEditorLanguage(path: string): LanguageDescription | undefined {
  const filename = path.replaceAll('\\', '/').split('/').at(-1) ?? path;
  const language =
    LanguageDescription.matchFilename(languages, filename) ??
    LanguageDescription.matchFilename(languages, filename.toLowerCase());
  if (language !== null) return language;

  if (/^dockerfile(?:\..+)?$/iu.test(filename))
    return LanguageDescription.matchLanguageName(languages, 'Dockerfile', false) ?? undefined;

  const extension = /\.([^.]+)$/u.exec(filename.toLowerCase())?.[1];
  const alias = extension === undefined ? undefined : LEGACY_EXTENSION_ALIASES[extension];
  return alias === undefined
    ? undefined
    : (LanguageDescription.matchLanguageName(languages, alias, false) ?? undefined);
}
