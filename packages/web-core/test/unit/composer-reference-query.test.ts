import { describe, expect, it } from 'vitest';
import { composerReferenceAtCursor } from '../../src/util/composer-reference-query.js';

describe('Composer reference query', () => {
  it('recognizes explicit session queries without consuming surrounding text', () => {
    expect(composerReferenceAtCursor('before @session topic after', 18)).toEqual({
      start: 7,
      end: 21,
      query: 'to',
      sessionOnly: true
    });
    expect(composerReferenceAtCursor('@session', 8)).toEqual({
      start: 0,
      end: 8,
      query: '',
      sessionOnly: true
    });
    expect(composerReferenceAtCursor('@session.ts', 11)).toEqual({
      start: 0,
      end: 11,
      query: 'session.ts',
      sessionOnly: false
    });
    expect(composerReferenceAtCursor('mail@example.com', 16)).toBeUndefined();
    expect(composerReferenceAtCursor('@session topic after', 20)).toBeUndefined();
  });
  it('keeps quotes literal and leaves @session as a file query without a session source', () => {
    expect(composerReferenceAtCursor('@file"name', 10)).toMatchObject({
      query: 'file"name',
      end: 10,
      sessionOnly: false
    });
    expect(composerReferenceAtCursor('@session', 8, false)).toMatchObject({
      query: 'session',
      sessionOnly: false
    });
  });
});
