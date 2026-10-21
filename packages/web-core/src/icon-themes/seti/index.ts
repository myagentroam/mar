import themeData from './assets/vs-seti-icon-theme.json' with { type: 'json' };
import type { FileIcon, FileIconTheme } from '../types.js';

interface IconDefinition {
  readonly fontCharacter?: string;
  readonly fontColor?: string;
}

interface SetiTheme {
  readonly iconDefinitions: Readonly<Record<string, IconDefinition>>;
  readonly file?: string;
  readonly fileNames?: Readonly<Record<string, string>>;
  readonly fileExtensions?: Readonly<Record<string, string>>;
  readonly languageIds?: Readonly<Record<string, string>>;
  readonly light?: {
    readonly file?: string;
    readonly fileNames?: Readonly<Record<string, string>>;
    readonly fileExtensions?: Readonly<Record<string, string>>;
    readonly languageIds?: Readonly<Record<string, string>>;
  };
}

export type SetiFileIcon = Extract<FileIcon, { readonly kind: 'glyph' }>;

export function resolveSetiFolderIcon(light = false): SetiFileIcon {
  return { kind: 'glyph', character: '\uE032', color: light ? '#498ba7' : '#519aba' };
}

const theme = themeData as SetiTheme;

const LANGUAGE_BY_FILE_NAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  rakefile: 'ruby',
  gemfile: 'ruby'
};

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bat: 'bat',
  cmd: 'bat',
  clj: 'clojure',
  cljs: 'clojure',
  coffee: 'coffeescript',
  json: 'json',
  jsonc: 'jsonc',
  jsonl: 'jsonl',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cu: 'cuda-cpp',
  cs: 'csharp',
  css: 'css',
  dart: 'dart',
  dockerfile: 'dockerfile',
  env: 'dotenv',
  gitignore: 'ignore',
  dockerignore: 'ignore',
  properties: 'properties',
  fs: 'fsharp',
  fsx: 'fsharp',
  go: 'go',
  groovy: 'groovy',
  hbs: 'handlebars',
  handlebars: 'handlebars',
  html: 'html',
  htm: 'html',
  java: 'java',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'javascriptreact',
  jl: 'julia',
  tex: 'latex',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  markdown: 'markdown',
  m: 'objective-c',
  mm: 'objective-cpp',
  pl: 'perl',
  pm: 'perl',
  php: 'php',
  ps1: 'powershell',
  pug: 'jade',
  py: 'python',
  pyw: 'python',
  r: 'r',
  razor: 'razor',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sass: 'sass',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  tsx: 'typescriptreact',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  ex: 'elixir',
  exs: 'elixir',
  elm: 'elm',
  gradle: 'gradle',
  haml: 'haml',
  hs: 'haskell',
  hx: 'haxe',
  jinja: 'jinja',
  jinja2: 'jinja',
  kt: 'kotlin',
  kts: 'kotlin',
  ml: 'ocaml',
  mli: 'ocaml',
  res: 'rescript',
  styl: 'stylus',
  tf: 'terraform',
  tfvars: 'terraform',
  vala: 'vala',
  vue: 'vue'
};

function decodeFontCharacter(value: string): string | undefined {
  const match = /^\\([\da-f]{1,6})$/iu.exec(value);
  if (match === null) return value.length === 1 ? value : undefined;
  const codePoint = Number.parseInt(match[1] ?? '', 16);
  return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : undefined;
}

function extensionCandidates(name: string): readonly string[] {
  const parts = name.split('.');
  if (parts.length < 2) return [];
  return parts.slice(1).map((_, index) => parts.slice(index + 1).join('.'));
}

function resolveDefinitionId(name: string, light: boolean): string | undefined {
  const normalized = name.toLocaleLowerCase();
  const variant = light ? theme.light : undefined;
  const fileName = variant?.fileNames?.[normalized] ?? theme.fileNames?.[normalized];
  if (fileName !== undefined) return fileName;
  const extensions = extensionCandidates(normalized);
  for (const extension of extensions) {
    const definition = variant?.fileExtensions?.[extension] ?? theme.fileExtensions?.[extension];
    if (definition !== undefined) return definition;
  }
  const languageId =
    LANGUAGE_BY_FILE_NAME[normalized] ??
    extensions.map((extension) => LANGUAGE_BY_EXTENSION[extension]).find(Boolean);
  if (languageId !== undefined) {
    const definition = variant?.languageIds?.[languageId] ?? theme.languageIds?.[languageId];
    if (definition !== undefined) return definition;
  }
  return variant?.file ?? theme.file;
}

export function resolveSetiFileIcon(name: string, light = false): SetiFileIcon {
  const fallback: SetiFileIcon = {
    kind: 'glyph',
    character: '\uE023',
    color: light ? '#6d8086' : '#8b949e'
  };
  const definitionId = resolveDefinitionId(name, light);
  if (definitionId === undefined) return fallback;
  const definition = theme.iconDefinitions[definitionId];
  if (definition?.fontCharacter === undefined) return fallback;
  const character = decodeFontCharacter(definition.fontCharacter);
  if (character === undefined) return fallback;
  return {
    kind: 'glyph',
    character,
    ...(definition.fontColor === undefined ? {} : { color: definition.fontColor })
  };
}

export const setiIconTheme: FileIconTheme = {
  id: 'seti',
  labelKey: 'settings.iconThemeSeti',
  resolveFile: resolveSetiFileIcon,
  resolveFolder: resolveSetiFolderIcon
};
