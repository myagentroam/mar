import { describe, expect, it } from 'vitest';
import { resolveSetiFileIcon, resolveSetiFolderIcon } from '../../src/icon-themes/seti/index.js';

describe('Seti file icon resolver', () => {
  it('uses exact file names before extensions', () => {
    expect(resolveSetiFileIcon('README.md')).not.toEqual(resolveSetiFileIcon('notes.md'));
  });

  it('uses the longest compound extension', () => {
    expect(resolveSetiFileIcon('button.spec.ts')).not.toEqual(resolveSetiFileIcon('button.ts'));
  });

  it.each([
    ['component.ts', 'component.unknown'],
    ['Main.java', 'Main.unknown'],
    ['script.py', 'script.unknown'],
    ['styles.css', 'styles.unknown'],
    ['index.html', 'index.unknown'],
    ['query.sql', 'query.unknown'],
    ['README-other.md', 'README-other.unknown']
  ])('uses Seti language icons for %s', (fileName, fallbackName) => {
    expect(resolveSetiFileIcon(fileName)).not.toEqual(resolveSetiFileIcon(fallbackName));
  });

  it('recognizes language-specific extensionless files', () => {
    expect(resolveSetiFileIcon('Dockerfile')).not.toEqual(resolveSetiFileIcon('unknown'));
    expect(resolveSetiFileIcon('Makefile')).not.toEqual(resolveSetiFileIcon('unknown'));
  });

  it('matches names case-insensitively and supplies light variants', () => {
    expect(resolveSetiFileIcon('VITE.CONFIG.TS')).toEqual(resolveSetiFileIcon('vite.config.ts'));
    expect(resolveSetiFileIcon('image.png', true).color).not.toBe(
      resolveSetiFileIcon('image.png').color
    );
  });

  it('falls back to the default file glyph', () => {
    const icon = resolveSetiFileIcon('file.unknown-extension');
    expect([...icon.character]).toHaveLength(1);
    expect(icon.character).not.toContain('\\');
  });

  it('decodes CSS escaped Seti characters into a single font glyph', () => {
    const icon = resolveSetiFileIcon('README.md');
    expect([...icon.character]).toHaveLength(1);
    expect(icon.character.codePointAt(0)).toBeGreaterThanOrEqual(0xe000);
  });

  it('uses the Seti folder glyph with theme-specific color', () => {
    expect(resolveSetiFolderIcon()).toEqual({
      kind: 'glyph',
      character: '\uE032',
      color: '#519aba'
    });
    expect(resolveSetiFolderIcon(true)).toEqual({
      kind: 'glyph',
      character: '\uE032',
      color: '#498ba7'
    });
  });
});
