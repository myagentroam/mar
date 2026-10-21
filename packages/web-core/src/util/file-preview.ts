import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import typescript from 'highlight.js/lib/languages/typescript';

hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('typescript', typescript);

export type FilePreviewKind =
  | 'text'
  | 'image'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'video'
  | 'audio'
  | 'unsupported';

export interface InlineTextSearchSegment {
  readonly text: string;
  readonly matchIndex?: number;
}

export interface InlineTextSearchResult {
  readonly lines: readonly (readonly InlineTextSearchSegment[])[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface WorkspaceFileTarget {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

const MAX_INLINE_TEXT_SEARCH_MATCHES = 5_000;
export const TEXT_FILE_PREVIEW_LIMIT_BYTES = 512 * 1024;
export const FILE_TYPE_PROBE_LIMIT_BYTES = 4 * 1024;

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp'
]);
const VIDEO_EXTENSIONS = new Set(['m4v', 'mov', 'mp4', 'ogv', 'webm']);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'wav', 'webm']);

const CODE_LANGUAGES: Readonly<Record<string, string>> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cxx: 'cpp',
  diff: 'diff',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'xml',
  htm: 'xml',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  markdown: 'markdown',
  mjs: 'javascript',
  cjs: 'javascript',
  php: 'php',
  pl: 'perl',
  ps1: 'powershell',
  py: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'xml',
  wasm: 'wasm',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml'
};
const TEXT_EXTENSIONS = new Set([
  ...Object.keys(CODE_LANGUAGES),
  'conf',
  'csv',
  'env',
  'log',
  'properties',
  'text',
  'toml',
  'txt'
]);

export function workspaceFileTarget(
  value: string,
  workspaceRoot: string | undefined,
  currentOrigin: string
): WorkspaceFileTarget | undefined {
  const sandboxReference = /^sandbox:/iu.test(value);
  const rootFileLocation =
    /^[^/\\:]+:\d+(?::\d+)?$/u.test(value) &&
    !/^(?:https?|file|javascript|data|mailto|blob|ftp|wss?):/iu.test(value);
  let source = value;
  if (sandboxReference) {
    source = value.slice(value.indexOf(':') + 1);
  } else if (
    !rootFileLocation &&
    !/^[a-z]:[\\/]/iu.test(value) &&
    /^[a-z][a-z\d+.-]*:/iu.test(value)
  ) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (url.origin !== currentOrigin || url.search.length > 0) return undefined;
    source = url.pathname + url.hash;
  }
  source = source.replace(/#L(\d+)$/u, ':$1');
  if (source.includes('?') || source.includes('#')) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    return undefined;
  }
  const location = decoded.match(/:(\d+)(?::(\d+))?$/u);
  const line = location === null ? undefined : Number(location[1]);
  const column = location?.[2] === undefined ? undefined : Number(location[2]);
  if (
    (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) ||
    (column !== undefined && (!Number.isSafeInteger(column) || column < 1))
  )
    return undefined;
  const normalized = decoded
    .replace(/:(?:\d+)(?::\d+)?$/u, '')
    .replaceAll('\\', '/')
    .replace(/^\/([a-z]:\/)/iu, '$1');
  const normalizedRoot = workspaceRoot?.replaceAll('\\', '/');
  const root = normalizedRoot === '/' ? '/' : normalizedRoot?.replace(/\/+$/u, '');
  const isAbsolute = normalized.startsWith('/') || /^[a-z]:\//iu.test(normalized);
  if (sandboxReference && !isAbsolute) return undefined;
  let path = normalized;
  if (isAbsolute) {
    if (root !== undefined && root.length > 0 && root !== '/') {
      const windowsPath = /^[a-z]:\//iu.test(root);
      const comparablePath = windowsPath ? normalized.toLocaleLowerCase() : normalized;
      const comparableRoot = windowsPath ? root.toLocaleLowerCase() : root;
      if (comparablePath.startsWith(`${comparableRoot}/`)) path = normalized.slice(root.length + 1);
    }
  } else {
    if (decoded.includes('\\')) return undefined;
    path = path.replace(/^(\.\/)+/u, '');
  }
  if (
    path.length === 0 ||
    /^[\\/]{2,}[?.](?:[\\/]|$)/u.test(decoded) ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('\0') ||
    (!isAbsolute &&
      path
        .split('/')
        .some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
  )
    return undefined;
  return line === undefined
    ? { path }
    : { path, line, ...(column === undefined ? {} : { column }) };
}

export function codeHighlightLanguage(path: string): string {
  const filename = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  if (filename === 'dockerfile' || filename.startsWith('dockerfile.')) return 'dockerfile';
  if (filename === 'makefile' || filename.startsWith('makefile.')) return 'makefile';
  if (filename === '.gitignore' || filename === '.gitattributes') return 'bash';
  if (filename === '.editorconfig' || filename === '.npmrc' || filename.startsWith('.env'))
    return 'ini';
  return CODE_LANGUAGES[fileExtension(filename)] ?? 'plaintext';
}

export function canUseCodeEditor(file: {
  readonly content: string;
  readonly size?: number;
  readonly truncated: boolean;
}): boolean {
  return (
    !file.truncated &&
    (file.size ?? new TextEncoder().encode(file.content).byteLength) <=
      TEXT_FILE_PREVIEW_LIMIT_BYTES
  );
}

export function highlightCodeLines(source: string, path: string): readonly string[] {
  const language = codeHighlightLanguage(path);
  const highlighted = hljs.highlight(source, {
    language: hljs.getLanguage(language) === undefined ? 'plaintext' : language,
    ignoreIllegals: true
  }).value;
  return splitHighlightedLines(highlighted);
}

export function inlineTextSearch(lines: readonly string[], query: string): InlineTextSearchResult {
  if (query.length === 0)
    return { lines: lines.map((text) => [{ text }]), total: 0, truncated: false };
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  let total = 0;
  let truncated = false;
  const resultLines = lines.map((line) => {
    if (total >= MAX_INLINE_TEXT_SEARCH_MATCHES) {
      expression.lastIndex = 0;
      if (expression.test(line)) truncated = true;
      expression.lastIndex = 0;
      return [{ text: line }];
    }
    const segments: InlineTextSearchSegment[] = [];
    let offset = 0;
    for (const match of line.matchAll(expression)) {
      if (total >= MAX_INLINE_TEXT_SEARCH_MATCHES) {
        truncated = true;
        break;
      }
      const index = match.index;
      if (index > offset) segments.push({ text: line.slice(offset, index) });
      segments.push({ text: match[0], matchIndex: total++ });
      offset = index + match[0].length;
    }
    if (offset < line.length || segments.length === 0) segments.push({ text: line.slice(offset) });
    return segments;
  });
  return {
    lines: resultLines,
    total,
    truncated
  };
}

export function isInlineFindShortcut(event: {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}): boolean {
  return (
    event.key.toLocaleLowerCase() === 'f' &&
    (event.ctrlKey === true || event.metaKey === true) &&
    event.altKey !== true &&
    event.shiftKey !== true
  );
}

function splitHighlightedLines(value: string): readonly string[] {
  const lines: string[] = [];
  const openSpans: string[] = [];
  let line = '';
  for (const part of value.split(/(<span class="[^"]+">|<\/span>|\n)/)) {
    if (part === '') continue;
    if (part === '\n') {
      lines.push(`${line}${'</span>'.repeat(openSpans.length)}`);
      line = openSpans.join('');
    } else if (part.startsWith('<span class="')) {
      openSpans.push(part);
      line += part;
    } else if (part === '</span>') {
      openSpans.pop();
      line += part;
    } else line += part;
  }
  lines.push(`${line}${'</span>'.repeat(openSpans.length)}`);
  return lines;
}

export function binaryFilePreviewKind(path: string): Exclude<FilePreviewKind, 'text'> {
  const extension = fileExtension(path);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'docx') return 'document';
  if (extension === 'xlsx') return 'spreadsheet';
  if (extension === 'pptx') return 'presentation';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return 'unsupported';
}

export function filePreviewKind(path: string, encoding: 'utf-8' | 'base64'): FilePreviewKind {
  return encoding === 'utf-8' ? 'text' : binaryFilePreviewKind(path);
}

export function isMarkdownFile(path: string): boolean {
  return ['md', 'markdown'].includes(fileExtension(path));
}

export function isHtmlFile(path: string): boolean {
  return ['html', 'htm'].includes(fileExtension(path));
}

export function isTextFilePreview(path: string, mimeType: string): boolean {
  const normalizedMimeType = mimeType.trim().toLocaleLowerCase();
  if (
    normalizedMimeType.startsWith('text/') ||
    [
      'application/graphql',
      'application/javascript',
      'application/json',
      'application/sql',
      'application/toml',
      'application/typescript',
      'application/xml',
      'application/yaml'
    ].includes(normalizedMimeType)
  )
    return true;
  const filename = path.replaceAll('\\', '/').split('/').at(-1)?.toLocaleLowerCase() ?? '';
  return (
    filename === 'dockerfile' ||
    filename === 'makefile' ||
    filename === '.editorconfig' ||
    filename === '.gitattributes' ||
    filename === '.gitignore' ||
    filename === '.npmrc' ||
    filename.startsWith('.env') ||
    TEXT_EXTENSIONS.has(fileExtension(filename))
  );
}

export function usesRawFilePreview(path: string): boolean {
  return binaryFilePreviewKind(path) !== 'unsupported';
}

export function usesHttpRangeFilePreview(path: string): boolean {
  const kind = binaryFilePreviewKind(path);
  return kind === 'audio' || kind === 'video';
}

/** Unknown suffixes require a bounded content probe, not a download-only verdict. */
export function shouldReadTextFilePreview(path: string, mimeType = ''): boolean {
  return isTextFilePreview(path, mimeType) || !usesRawFilePreview(path);
}

export function decodeFilePreviewText(
  bytes: Uint8Array,
  eof = true,
  decoder = new TextDecoder('utf-8', { fatal: true })
): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return decoder.decode(bytes, { stream: !eof });
  } catch {
    return undefined;
  }
}

export function isLegacyOfficeFile(path: string): boolean {
  return ['doc', 'ppt', 'xls'].includes(fileExtension(path));
}

export function filePreviewMimeType(path: string): string {
  const extension = fileExtension(path);
  return (
    {
      avif: 'image/avif',
      aac: 'audio/aac',
      bmp: 'image/bmp',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      flac: 'audio/flac',
      gif: 'image/gif',
      ico: 'image/x-icon',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      m4a: 'audio/mp4',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      m4v: 'video/x-m4v',
      mov: 'video/quicktime',
      oga: 'audio/ogg',
      ogg: 'audio/ogg',
      ogv: 'video/ogg',
      pdf: 'application/pdf',
      png: 'image/png',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      svg: 'image/svg+xml',
      wav: 'audio/wav',
      webm: 'video/webm',
      webp: 'image/webp',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }[extension] ?? 'application/octet-stream'
  );
}

function fileExtension(path: string): string {
  return path.split('.').at(-1)?.toLowerCase() ?? '';
}
