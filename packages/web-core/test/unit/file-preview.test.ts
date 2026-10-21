import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  readFilePreview,
  readFilePreviewObject
} from '../../src/service/FilePreviewReadService.js';
import {
  binaryFilePreviewKind,
  canUseCodeEditor,
  codeHighlightLanguage,
  decodeFilePreviewText,
  filePreviewKind,
  filePreviewMimeType,
  highlightCodeLines,
  inlineTextSearch,
  isInlineFindShortcut,
  isLegacyOfficeFile,
  isMarkdownFile,
  isTextFilePreview,
  shouldReadTextFilePreview,
  usesHttpRangeFilePreview,
  workspaceFileTarget,
  usesRawFilePreview
} from '../../src/util/file-preview.js';

describe('Web unified file preview classification', () => {
  it.each(['clip.mp4', 'sound.mp3', 'image.png', 'manual.pdf'])(
    'selects the shared preview transport before starting complete reads for %s',
    async (path) => {
      const read = vi.fn(async () => ({ url: 'blob:complete-preview' }));
      const result = await readFilePreviewObject(path, read);
      expect(read).toHaveBeenCalledTimes(usesHttpRangeFilePreview(path) ? 0 : 1);
      expect(result).toEqual(
        usesHttpRangeFilePreview(path) ? undefined : { url: 'blob:complete-preview' }
      );
    }
  );

  it.each(['demo.MP4', 'movie.webm', 'recording.mov', 'music.mp3', 'sound.wav', 'music.flac'])(
    'keeps %s on HTTP Range rather than complete-file object URLs',
    (path) => expect(usesHttpRangeFilePreview(path)).toBe(true)
  );

  it.each(['photo.png', 'manual.pdf', 'report.docx', 'table.xlsx', 'deck.pptx', 'notes.txt'])(
    'preserves complete-file preview support for %s',
    (path) => expect(usesHttpRangeFilePreview(path)).toBe(false)
  );

  it.each(['utf-8', 'base64'] as const)(
    'reads only a 4 KiB probe for complete %s content',
    async (encoding) => {
      const probe = { encoding, size: 20, content: 'probe', nextOffset: null };
      const read = vi.fn(async () => probe);
      expect(await readFilePreview(read)).toBe(probe);
      expect(read).toHaveBeenCalledExactlyOnceWith(4096);
    }
  );

  it('stops after a 4 KiB probe for a large binary file', async () => {
    const probe = { encoding: 'base64' as const, size: 900_000, content: '', nextOffset: 4096 };
    const read = vi.fn(async () => probe);
    expect(await readFilePreview(read)).toBe(probe);
    expect(read).toHaveBeenCalledExactlyOnceWith(4096);
  });

  it('loads a larger text preview only after a successful probe without splicing ranges', async () => {
    const probe = {
      encoding: 'utf-8' as const,
      size: 900_000,
      content: 'probe',
      nextOffset: 4096,
      revision: 'same'
    };
    const preview = { ...probe, content: 'full preview', nextOffset: 512 * 1024 };
    const read = vi.fn().mockResolvedValueOnce(probe).mockResolvedValueOnce(preview);
    expect(await readFilePreview(read)).toBe(preview);
    expect(read.mock.calls).toEqual([[4096], [512 * 1024]]);
  });

  it.each(['size', 'revision'] as const)(
    'rejects a changed %s between probe and preview',
    async (field) => {
      const probe = {
        encoding: 'utf-8' as const,
        size: 8000,
        content: 'probe',
        nextOffset: 4096,
        revision: 'before'
      };
      const preview = field === 'size' ? { ...probe, size: 9000 } : { ...probe, revision: 'after' };
      const read = vi.fn().mockResolvedValueOnce(probe).mockResolvedValueOnce(preview);
      await expect(readFilePreview(read)).rejects.toThrow('FILE_PREVIEW_REVISION_CHANGED');
    }
  );

  it('does not start a text-body read after the preview was replaced', async () => {
    const probe = { encoding: 'utf-8' as const, size: 8000, content: 'probe', nextOffset: 4096 };
    const read = vi.fn(async () => probe);
    expect(await readFilePreview(read, () => false)).toBe(probe);
    expect(read).toHaveBeenCalledExactlyOnceWith(4096);
  });

  it('preserves read failures without retrying a larger request', async () => {
    const read = vi.fn(async () => {
      throw new Error('READ_FAILED');
    });
    await expect(readFilePreview(read)).rejects.toThrow('READ_FAILED');
    expect(read).toHaveBeenCalledExactlyOnceWith(4096);
  });

  it('limits PPTX render width to fit the available preview height', async () => {
    const dialog = await readFile(
      resolve(process.cwd(), 'src/view/workspace/WorkspaceFormatFilePage.vue'),
      'utf8'
    );

    expect(dialog).toContain("'is-presentation': kind === 'presentation'");
    expect(dialog).toContain('class="file-presentation-renderer"');
    expect(dialog).toMatch(
      /\.file-office-preview\.is-presentation\s*\{[^}]*container-type:\s*size;[^}]*overflow:\s*hidden;/su
    );
    expect(dialog).toMatch(
      /\.file-presentation-renderer\s*\{[^}]*width:\s*min\(100%, calc\(100cqh \* 16 \/ 9\)\);[^}]*height:\s*100%;[^}]*margin:\s*0 auto;/su
    );
  });

  it('chooses a unified preview adapter for modern Office, PDF, media, and image files', () => {
    expect(binaryFilePreviewKind('brief.docx')).toBe('document');
    expect(binaryFilePreviewKind('sheet.xlsx')).toBe('spreadsheet');
    expect(binaryFilePreviewKind('deck.pptx')).toBe('presentation');
    expect(binaryFilePreviewKind('manual.pdf')).toBe('pdf');
    expect(binaryFilePreviewKind('demo.mp4')).toBe('video');
    expect(binaryFilePreviewKind('sample.mp3')).toBe('audio');
    expect(binaryFilePreviewKind('logo.png')).toBe('image');
  });

  it('Recognizes code language by filename and extension without guessing unknown text', () => {
    expect(codeHighlightLanguage('src/App.vue')).toBe('xml');
    expect(codeHighlightLanguage('src/main.tsx')).toBe('typescript');
    expect(codeHighlightLanguage('Dockerfile')).toBe('dockerfile');
    expect(codeHighlightLanguage('Makefile')).toBe('makefile');
    expect(codeHighlightLanguage('.env.local')).toBe('ini');
    expect(codeHighlightLanguage('logs/server.log')).toBe('plaintext');
  });

  it('Safely highlights code and creates independently renderable lines for cross-line syntax', () => {
    const lines = highlightCodeLines('const value = "<unsafe>";\n/* first\nsecond */', 'main.ts');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('hljs-keyword');
    expect(lines[0]).toContain('&lt;unsafe&gt;');
    expect(lines[1]).toContain('hljs-comment');
    expect(lines[2]).toContain('hljs-comment');
  });

  it('Preserves Vue embedded-language tags across lines', () => {
    const lines = highlightCodeLines(
      '<script setup lang="ts">\nconst value = 1;\n</script>',
      'App.vue'
    );

    expect(lines[1]).toContain('language-javascript');
    for (const line of lines) {
      expect(line.match(/<span\b/g)?.length ?? 0).toBe(line.match(/<\/span>/g)?.length ?? 0);
    }
  });

  it('Escapes plain text without producing misleading syntax colors', () => {
    expect(highlightCodeLines('<plain> & text', 'notes.txt')).toEqual(['&lt;plain&gt; &amp; text']);
  });

  it('keeps large or truncated text out of the CodeMirror editor', () => {
    expect(
      canUseCodeEditor({
        content: 'short text',
        size: 512 * 1024,
        truncated: false
      })
    ).toBe(true);
    expect(
      canUseCodeEditor({
        content: 'partial text',
        size: 512 * 1024 + 1,
        truncated: false
      })
    ).toBe(false);
    expect(
      canUseCodeEditor({
        content: 'partial text',
        truncated: true
      })
    ).toBe(false);
  });

  it('Prefers text previews and provides only a download fallback for legacy Office files', () => {
    expect(filePreviewKind('README.md', 'utf-8')).toBe('text');
    expect(isMarkdownFile('README.md')).toBe(true);
    expect(isMarkdownFile('guide.markdown')).toBe(true);
    expect(isMarkdownFile('guide.mdx')).toBe(false);
    expect(isLegacyOfficeFile('legacy.doc')).toBe(true);
    expect(binaryFilePreviewKind('legacy.doc')).toBe('unsupported');
    expect(usesRawFilePreview('legacy.doc')).toBe(false);
    expect(usesRawFilePreview('archive.zip')).toBe(false);
  });

  it('Recognizes text previews from MIME types, common filenames, and extensions', () => {
    expect(isTextFilePreview('output/result.bin', 'text/plain')).toBe(true);
    expect(isTextFilePreview('output/result.json', 'application/octet-stream')).toBe(true);
    expect(isTextFilePreview('output/.env.local', 'application/octet-stream')).toBe(true);
    expect(isTextFilePreview('output/archive.zip', 'application/octet-stream')).toBe(false);
  });

  it('probes unknown extensions without treating binary preview formats as text', () => {
    for (const path of ['script.mts', 'script.cts', 'notes.custom', 'LICENSE', 'archive.zip']) {
      expect(shouldReadTextFilePreview(path)).toBe(true);
      expect(filePreviewKind(path, 'utf-8')).toBe('text');
    }
    expect(shouldReadTextFilePreview('image.png')).toBe(false);
    expect(shouldReadTextFilePreview('report.pdf')).toBe(false);
    expect(shouldReadTextFilePreview('image.png', 'text/plain')).toBe(true);
    expect(filePreviewKind('script.mts', 'base64')).toBe('unsupported');
  });

  it('detects text from UTF-8 bytes and rejects NUL or invalid encoding', () => {
    expect(decodeFilePreviewText(new TextEncoder().encode('const value = "中文";'))).toBe(
      'const value = "中文";'
    );
    expect(decodeFilePreviewText(new Uint8Array())).toBe('');
    expect(decodeFilePreviewText(new Uint8Array([65, 0, 66]))).toBeUndefined();
    expect(decodeFilePreviewText(new Uint8Array([0xff]))).toBeUndefined();
    expect(decodeFilePreviewText(new Uint8Array([0xe4, 0xb8]))).toBeUndefined();
  });

  it('preserves UTF-8 characters across ranges and omits unfinished preview tails', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    expect(decodeFilePreviewText(new Uint8Array([65, 0xe4, 0xb8]), false, decoder)).toBe('A');
    expect(decodeFilePreviewText(new Uint8Array([0xad, 66]), true, decoder)).toBe('中B');
    expect(decodeFilePreviewText(new Uint8Array([65, 0xe4, 0xb8]), false)).toBe('A');
  });

  it('Preserves browser-recognized MIME types for blob previews from older Nodes', () => {
    expect(filePreviewMimeType('assets/icon.ico')).toBe('image/x-icon');
    expect(filePreviewMimeType('reports/result.pdf')).toBe('application/pdf');
    expect(filePreviewMimeType('media/demo.ogg')).toBe('audio/ogg');
    expect(filePreviewMimeType('unknown.bin')).toBe('application/octet-stream');
  });

  it('Finds literal matches inline, ignores case, and keeps stable match indexes', () => {
    const result = inlineTextSearch(['const Answer = 1;', 'answer.* answer'], 'answer.*');

    expect(result.total).toBe(1);
    expect(result.lines[1]).toEqual([{ text: 'answer.*', matchIndex: 0 }, { text: ' answer' }]);
    expect(inlineTextSearch(['Answer answer'], 'answer').total).toBe(2);
  });

  it('Recognizes Ctrl or Command+F without Shift or Alt as preview search', () => {
    expect(isInlineFindShortcut({ key: 'f', ctrlKey: true })).toBe(true);
    expect(isInlineFindShortcut({ key: 'F', metaKey: true })).toBe(true);
    expect(isInlineFindShortcut({ key: 'f', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isInlineFindShortcut({ key: 'f' })).toBe(false);
  });

  it('Converts sandbox image paths to local file targets and supports Windows temporary directories', () => {
    expect(
      workspaceFileTarget(
        'C:/Users/runner/AppData/Local/Temp/capture.png',
        'C:/workspace',
        'https://console.example'
      )
    ).toEqual({ path: 'C:/Users/runner/AppData/Local/Temp/capture.png' });
    expect(
      workspaceFileTarget(
        'C:\\Windows\\Temp\\note.txt:12',
        'C:/workspace',
        'https://console.example'
      )
    ).toEqual({ path: 'C:/Windows/Temp/note.txt', line: 12 });
    expect(
      workspaceFileTarget(
        'sandbox:/tmp/thing-model-cache-tip%20copy.png',
        '/workspace',
        'https://console.example'
      )
    ).toEqual({ path: '/tmp/thing-model-cache-tip copy.png' });
    expect(
      workspaceFileTarget(
        'sandbox:/C:/Users/runner/AppData/Local/Temp/capture.png',
        'C:/workspace',
        'https://console.example'
      )
    ).toEqual({ path: 'C:/Users/runner/AppData/Local/Temp/capture.png' });
    expect(
      workspaceFileTarget(
        'sandbox:C:\\Users\\runner\\AppData\\Local\\Temp\\capture.png',
        'C:/workspace',
        'https://console.example'
      )
    ).toEqual({ path: 'C:/Users/runner/AppData/Local/Temp/capture.png' });
    expect(
      workspaceFileTarget('sandbox:relative/capture.png', '/workspace', 'https://console.example')
    ).toBeUndefined();
    expect(
      workspaceFileTarget(
        'sandbox:\\\\.\\C:\\Users\\runner\\AppData\\Local\\Temp\\capture.png',
        'C:/workspace',
        'https://console.example'
      )
    ).toBeUndefined();
  });

  it('Parses relative file locations with a one-based line and optional column', () => {
    expect(workspaceFileTarget('foo.ts:12', '/workspace', 'https://console.example')).toEqual({
      path: 'foo.ts',
      line: 12
    });
    expect(workspaceFileTarget('README.md:12:3', '/workspace', 'https://console.example')).toEqual({
      path: 'README.md',
      line: 12,
      column: 3
    });
    expect(workspaceFileTarget('Makefile:12', '/workspace', 'https://console.example')).toEqual({
      path: 'Makefile',
      line: 12
    });
    expect(
      workspaceFileTarget('javascript:12', '/workspace', 'https://console.example')
    ).toBeUndefined();
    expect(workspaceFileTarget('file:12', '/workspace', 'https://console.example')).toBeUndefined();
    expect(
      workspaceFileTarget('foo.ts:9007199254740992', '/workspace', 'https://console.example')
    ).toBeUndefined();
    expect(
      workspaceFileTarget('src/view/App.vue:123:45', '/workspace', 'https://console.example')
    ).toEqual({ path: 'src/view/App.vue', line: 123, column: 45 });
    expect(
      workspaceFileTarget('src/view/App.vue:123', '/workspace', 'https://console.example')
    ).toEqual({ path: 'src/view/App.vue', line: 123 });
    expect(
      workspaceFileTarget('src/view/App.vue:0', '/workspace', 'https://console.example')
    ).toBeUndefined();
    expect(
      workspaceFileTarget('src/view/App.vue:123:0', '/workspace', 'https://console.example')
    ).toBeUndefined();
  });

  it('Resolves hash line anchors through the same Windows and POSIX file target rules', () => {
    const origin = 'https://console.example';
    const path = 'docs/design/SDK.md';
    for (const root of ['E:/project', '/home/runner/project']) {
      for (const href of [
        `${path}#L25`,
        `${root}/${path}#L25`,
        `sandbox:${root}/${path}#L25`,
        `${origin}/${root.replace(/^\//u, '')}/${path}#L25`
      ])
        expect(workspaceFileTarget(href, root, origin)).toEqual({ path, line: 25 });
    }
    expect(
      workspaceFileTarget(String.raw`E:\project\docs\note.md#L25`, String.raw`E:\project`, origin)
    ).toEqual({ path: 'docs/note.md', line: 25 });
  });

  it('Does not turn external URLs, ordinary fragments or invalid hash lines into file locations', () => {
    for (const href of [
      'https://other.example/docs/note.md#L25',
      'https://console.example/docs/note.md?download=1#L25',
      'docs/note.md#overview',
      '#L25',
      'docs/note.md#L0',
      'docs/note.md#L-1',
      'docs/note.md#L9007199254740992',
      'docs/note.md#L25#L26',
      'docs/note.md%23L25'
    ])
      expect(workspaceFileTarget(href, 'E:/project', 'https://console.example')).toBeUndefined();
  });

  it('Limits frequent matches to avoid unbounded highlight nodes in long files', () => {
    const result = inlineTextSearch(['a'.repeat(5_001)], 'a');

    expect(result.total).toBe(5_000);
    expect(result.truncated).toBe(true);
  });
});
