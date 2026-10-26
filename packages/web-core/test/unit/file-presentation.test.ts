import { describe, expect, it } from 'vitest';
import {
  currentChangesBranch,
  fileSizeLabel,
  workspaceAbsolutePath
} from '../../src/util/file-presentation.js';

describe('shared file presentation', () => {
  it.each([
    ['/home/example/project', 'src/main.ts', '/home/example/project/src/main.ts'],
    ['/home/example/project/', 'src', '/home/example/project/src'],
    ['/Users/example/My Project', 'docs/说明.md', '/Users/example/My Project/docs/说明.md'],
    ['/home/example/project', '.', '/home/example/project'],
    ['/', 'notes.txt', '/notes.txt'],
    ['/', '.', '/'],
    ['C:\\Projects\\App', 'src/main.ts', 'C:\\Projects\\App\\src\\main.ts'],
    ['C:\\Projects\\App\\', 'src/main.ts', 'C:\\Projects\\App\\src\\main.ts'],
    ['C:\\', 'notes.txt', 'C:\\notes.txt'],
    ['C:\\', '.', 'C:\\'],
    ['D:/Projects/App/', 'src/main.ts', 'D:/Projects/App/src/main.ts'],
    ['\\\\server\\share\\Project\\', 'src/main.ts', '\\\\server\\share\\Project\\src\\main.ts'],
    ['\\\\server\\share\\Project', '.', '\\\\server\\share\\Project'],
    ['/home/example/My Project', 'docs/notes.txt', '/home/example/My Project/docs/notes.txt'],
    ['/home/example/project', 'docs/file\\name.txt', '/home/example/project/docs/file\\name.txt'],
    ['/home/example/project\\', 'notes.txt', '/home/example/project\\/notes.txt']
  ])('builds the absolute path from %s and %s', (root, path, expected) => {
    expect(workspaceAbsolutePath(root, path)).toBe(expected);
  });

  it('Displays the uploaded file size in binary units and preserves up to two decimal places', () => {
    expect(fileSizeLabel(0)).toBe('0 B');
    expect(fileSizeLabel(1_023)).toBe('1023 B');
    expect(fileSizeLabel(709_830)).toBe('693.19 KB');
    expect(fileSizeLabel(1_048_576)).toBe('1 MB');
    expect(fileSizeLabel(1_073_741_824)).toBe('1 GB');
  });

  it('preserves the authoritative branch and distinguishes missing metadata from detached HEAD', () => {
    expect(currentChangesBranch({ branch: 'feature/workspace' })).toBe('feature/workspace');
    expect(currentChangesBranch({ branch: null })).toBeNull();
    expect(currentChangesBranch({ branch: '' })).toBeNull();
    expect(currentChangesBranch({})).toBeUndefined();
  });

  it('does not interpret unrelated values as branch metadata', () => {
    for (const value of [undefined, null, 'main', 5, []]) {
      expect(currentChangesBranch(value)).toBeUndefined();
    }
    expect(currentChangesBranch({ branch: false })).toBeNull();
    expect(currentChangesBranch({ branch: ['main'] })).toBeNull();
  });
});
