import { describe, expect, it } from 'vitest';
import { parseMarkdownPreviewPreference } from '../../src/service/markdown-preview-preference-service.js';
import {
  isExternalMarkdownImageUrl,
  resolveMarkdownWorkspacePath
} from '../../src/util/markdown-preview.js';

describe('Markdown preview', () => {
  it('Default to a disabled watermark and tolerate malformed browser preferences', () => {
    expect(parseMarkdownPreviewPreference(null)).toEqual({
      watermarkEnabled: false,
      watermarkText: ''
    });
    expect(parseMarkdownPreviewPreference('{')).toEqual({
      watermarkEnabled: false,
      watermarkText: ''
    });
    expect(
      parseMarkdownPreviewPreference('{"watermarkEnabled":true,"watermarkText":"Internal"}')
    ).toEqual({ watermarkEnabled: true, watermarkText: 'Internal' });
    expect(parseMarkdownPreviewPreference('{"theme":"dark"}')).toEqual({
      watermarkEnabled: false,
      watermarkText: ''
    });
  });

  it('Resolve only relative paths within the current Workspace', () => {
    expect(resolveMarkdownWorkspacePath('docs/guide/readme.md', '../logo.svg')).toBe(
      'docs/logo.svg'
    );
    expect(resolveMarkdownWorkspacePath('readme.md', '../secret.md')).toBeUndefined();
    expect(resolveMarkdownWorkspacePath('readme.md', 'https://example.test')).toBeUndefined();
    expect(resolveMarkdownWorkspacePath('readme.md', '/etc/passwd')).toBeUndefined();
    expect(isExternalMarkdownImageUrl('https://example.test/image.png')).toBe(true);
    expect(isExternalMarkdownImageUrl('data:image/png;base64,abc')).toBe(false);
  });
});
