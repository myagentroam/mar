import { describe, expect, it } from 'vitest';
import { createFileDiff } from '../../src/tools/file-change-diff.js';

describe('immutable file change diff', () => {
  it('shows additions, deletions and empty path effects', () => {
    expect(createFileDiff('new.txt', undefined, Buffer.from('one\ntwo\n'))).toMatchObject({
      additions: 2,
      deletions: 0
    });
    expect(createFileDiff('old.txt', Buffer.from('one\n'), undefined)).toMatchObject({
      additions: 0,
      deletions: 1
    });
    expect(createFileDiff('empty', undefined, Buffer.alloc(0))).toEqual({
      text: '--- /dev/null\n+++ "b/empty"\n',
      additions: 0,
      deletions: 0
    });
  });
  it('compares actual content including newline differences', () => {
    const diff = createFileDiff(
      'test.ts',
      Buffer.from('same\nbefore\ntail\n'),
      Buffer.from('same\nafter\ntail\n')
    )!;
    expect(diff).toMatchObject({ additions: 1, deletions: 1 });
    expect(diff.text).toContain('-before\n+after\n');
    expect(diff.text).toContain('@@ -1,3 +1,3 @@');
    expect(createFileDiff('x', Buffer.from('a\r\n'), Buffer.from('a\n'))).toMatchObject({
      additions: 1,
      deletions: 1
    });
    expect(createFileDiff('x', Buffer.from('a'), Buffer.from('a\n'))!.text).toContain(
      '\\ No newline at end of file'
    );
  });
  it('rejects binary data without lossy decoding', () => {
    expect(createFileDiff('x', Buffer.from([255]), Buffer.from('x'))).toBeUndefined();
    expect(createFileDiff('x', undefined, Buffer.from('a\0'))).toBeUndefined();
  });
});
