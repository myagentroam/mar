import { describe, expect, it } from 'vitest';
import { countModelTokens } from '@myagentroam/agent';
import { WebSnapshots } from '../../src/service/web-snapshots.js';
import { webSessionScope } from '../../src/service/web-fetch-contracts.js';

const document = (content: string) => ({
  content,
  url: 'https://example.test/',
  status: 200,
  contentType: 'text/html',
  title: 'Example',
  sourceTruncated: false
});

describe('web snapshots', () => {
  it('maps case-folded match positions back to the original Unicode text', () => {
    const snapshots = new WebSnapshots();
    const ref = snapshots.add('scope', document('İ'.repeat(100) + ' END'));
    const result = snapshots.find('scope', ref, 'end', 512);
    expect(result.content).toContain('END');
    expect(result.data.matchLines).toEqual([0]);
  });

  it('clears all sessions of a deleted hosted storage without affecting other domains', () => {
    const snapshots = new WebSnapshots();
    const root = webSessionScope('hosted', '/hosted/a', 'same-id');
    const child = webSessionScope('hosted', '/hosted/a', 'child');
    const other = webSessionScope('hosted', '/hosted/b', 'same-id');
    const normal = webSessionScope('workspace', '/hosted/a', 'same-id');
    const rootRef = snapshots.add(root, document('root'));
    const childRef = snapshots.add(child, document('child'));
    const otherRef = snapshots.add(other, document('other'));
    const normalRef = snapshots.add(normal, document('normal'));
    snapshots.clearHostedStorage('/hosted/a');
    expect(() => snapshots.open(root, rootRef, {})).toThrow();
    expect(() => snapshots.open(child, childRef, {})).toThrow();
    expect(snapshots.open(other, otherRef, {}).content).toContain('other');
    expect(snapshots.open(normal, normalRef, {}).content).toContain('normal');
  });
  it('reads a long line without losing its tail, within the complete content budget', () => {
    const snapshots = new WebSnapshots();
    const text = '甲'.repeat(4000) + 'end';
    const ref = snapshots.add('workspace/session', document(text));
    let cursor: string | undefined;
    let reconstructed = '';
    do {
      const result = snapshots.open('workspace/session', ref, {
        ...(cursor === undefined ? {} : { cursor }),
        maxTokens: 512
      });
      expect(countModelTokens(result.content)).toBeLessThanOrEqual(512);
      expect(result.content).toContain(ref);
      reconstructed += result.content.match(/\n0: ([^\n]*)/)?.[1] ?? '';
      cursor = result.data.nextCursor;
      if (cursor) expect(result.content).toContain(cursor);
    } while (cursor);
    expect(reconstructed).toBe(text);
  });

  it('isolates scopes, finds literal case-insensitive matches and clears only the target scope', () => {
    const snapshots = new WebSnapshots();
    const ref = snapshots.add('one/session', document('one\nREMOVE(filter)\nthree'));
    expect(() => snapshots.open('two/session', ref, {})).toThrow();
    const result = snapshots.find('one/session', ref, 'remove(FILTER)', 512);
    expect(result.content).toContain('1: REMOVE(filter)');
    expect(result.data.matchLines).toEqual([1]);
    expect(snapshots.find('one/session', ref, 'missing', 512).content).toContain('No matches');
    snapshots.clearScope('one/session');
    expect(() => snapshots.open('one/session', ref, {})).toThrow();
  });

  it('accounts for metadata and evicts least-recently used snapshots', () => {
    const snapshots = new WebSnapshots(700);
    const first = snapshots.add('scope', document('first'));
    const second = snapshots.add('scope', document('second'));
    snapshots.open('scope', first, {});
    snapshots.add('scope', document('third'));
    expect(() => snapshots.open('scope', second, {})).toThrow();
    expect(snapshots.open('scope', first, {}).content).toContain('first');
  });

  it('prioritizes a match behind long context and within a long line', () => {
    const snapshots = new WebSnapshots();
    const ref = snapshots.add(
      'scope',
      document(`${'x'.repeat(10_000)}\ncontext\n${'z'.repeat(10_000)}MATCH-HERE`)
    );
    const result = snapshots.find('scope', ref, 'match-here', 512);
    expect(result.data.matchLines).toEqual([2]);
    expect(result.content).toContain('MATCH-HERE');
    expect(countModelTokens(result.content)).toBeLessThanOrEqual(512);
  });

  it('leaves room to progress with multibyte metadata at the minimum budget', () => {
    const snapshots = new WebSnapshots();
    const ref = snapshots.add('scope', {
      ...document('MATCH-HERE'),
      title: '甲'.repeat(300),
      url: `https://example.test/${'x'.repeat(700)}`
    });
    const result = snapshots.find('scope', ref, 'MATCH-HERE', 512);
    expect(result.content).toContain('MATCH-HERE');
    expect(result.content).toContain('…');
    expect(result.data).toMatchObject({ hasMore: false });
    expect(countModelTokens(result.content)).toBeLessThanOrEqual(512);
  });

  it('counts empty line labels at high line numbers in the complete budget', () => {
    const snapshots = new WebSnapshots();
    const ref = snapshots.add('scope', {
      ...document('\n'.repeat(300_000)),
      title: '甲'.repeat(300),
      url: `https://example.test/${'x'.repeat(700)}`
    });
    const result = snapshots.open('scope', ref, { line: 100_000, maxTokens: 512 });
    expect(countModelTokens(result.content)).toBeLessThanOrEqual(512);
    expect(result.data.nextCursor).not.toBe('100000:0');
  });
});
