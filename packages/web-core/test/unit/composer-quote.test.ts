import { describe, expect, it } from 'vitest';
import {
  serializeComposerTag,
  type ComposerQuoteDraft,
  type ComposerReference
} from '@myagentroam/protocol';
import { normalizeComposerReferences } from '../../src/service/file-reference-service.js';
import { appendComposerQuote } from '../../src/util/composer-quote.js';
import { composerMessagePresentation } from '../../src/util/composer-message.js';
import { displayConversationItem } from '../../src/util/conversation-domain.js';
import { unifiedDiffLines } from '../../src/util/quote-selection.js';

function fileQuoteDraft(text = 'selected excerpt', startLine = 4): ComposerQuoteDraft {
  return {
    type: 'quote',
    label: `main.ts:${startLine}`,
    source: 'file',
    path: 'src/main.ts',
    origin: 'WORKING_TREE',
    startLine,
    endLine: startLine,
    text
  };
}

function fileQuote(id: string, text = 'selected excerpt', startLine = 4): ComposerReference {
  return { ...fileQuoteDraft(text, startLine), id };
}

describe('Composer quote snapshots', () => {
  it('appends multiple same-file quotes with independent IDs without mutating mentions or references', () => {
    const fileReference: ComposerReference = {
      type: 'file',
      path: 'src/main.ts',
      label: 'main.ts'
    };
    const originalReferences: readonly ComposerReference[] = [fileReference];
    const input = 'Review @src/main.ts and keep this mention';

    const first = appendComposerQuote(
      originalReferences,
      fileQuoteDraft('first excerpt'),
      input,
      'q-1'
    );
    const second = appendComposerQuote(first, fileQuoteDraft('second excerpt', 8), input, 'q-2');

    expect(first).not.toBe(originalReferences);
    expect(second).not.toBe(first);
    expect(originalReferences).toEqual([fileReference]);
    expect(input).toBe('Review @src/main.ts and keep this mention');
    expect(second).toEqual([
      fileReference,
      fileQuote('q-1', 'first excerpt'),
      fileQuote('q-2', 'second excerpt', 8)
    ]);
    expect(second.filter((reference) => reference.type === 'quote').map(({ id }) => id)).toEqual([
      'q-1',
      'q-2'
    ]);
  });

  it('refuses additions beyond reference-count and serialized-byte capacity', () => {
    const atCountLimit: ComposerReference[] = Array.from({ length: 128 }, (_, index) => ({
      type: 'file',
      path: `src/file-${index}.ts`,
      label: `file-${index}.ts`
    }));
    expect(() => appendComposerQuote(atCountLimit, fileQuoteDraft(), '', 'too-many')).toThrow(
      'COMPOSER_TAG_INVALID'
    );
    expect(atCountLimit).toHaveLength(128);

    const largeReferences: ComposerReference[] = Array.from({ length: 16 }, (_, index) => ({
      type: 'quote',
      id: `large-${index}`,
      label: 'Large excerpt',
      source: 'assistant',
      messageId: 'message-1',
      text: 'x'.repeat(8000)
    }));
    expect(() =>
      serializeComposerTag('mar_references', { references: largeReferences })
    ).not.toThrow();
    expect(() =>
      appendComposerQuote(largeReferences, fileQuoteDraft('y'.repeat(8000)), '', 'over-budget')
    ).toThrow('COMPOSER_TAG_INVALID');
  });

  it('enforces the 100000-character message budget at the exact boundary', () => {
    const draft = fileQuoteDraft();
    const serialized = serializeComposerTag('mar_references', {
      references: [{ ...draft, id: 'at-limit' }]
    });
    const inputAtLimit = 'x'.repeat(100_000 - serialized.length - 1);

    expect(appendComposerQuote([], draft, inputAtLimit, 'at-limit')).toHaveLength(1);
    expect(() => appendComposerQuote([], draft, `${inputAtLimit}x`, 'at-limit')).toThrow(
      'COMPOSER_TAG_INVALID'
    );
  });

  it('restores saved quote source and text snapshots while normalizing draft references', () => {
    const fileReference: ComposerReference = {
      type: 'file',
      path: 'src/main.ts',
      label: 'main.ts'
    };
    const quote: ComposerReference = {
      type: 'quote',
      id: 'restored-quote',
      label: 'main.ts:4',
      source: 'file',
      path: 'src/main.ts',
      origin: 'HISTORY',
      revision: 'commit-abc',
      startLine: 4,
      endLine: 4,
      unsaved: false,
      text: 'the original saved excerpt'
    };
    const persisted = JSON.parse(JSON.stringify([fileReference, quote])) as unknown;

    expect(normalizeComposerReferences(persisted)).toEqual([fileReference, quote]);
  });

  it('maps old and new lines across multiple diff hunks without numbering metadata as body', () => {
    const diff = [
      'diff --git a/src/main.ts b/src/main.ts',
      'index abc123..def456 100644',
      '--- a/src/main.ts',
      '+++ b/src/main.ts',
      '@@ -4,3 +4,4 @@ first hunk',
      ' unchanged before',
      '---删除行',
      '+新增行',
      '+第二行',
      ' unchanged after',
      '\\ No newline at end of file',
      '@@ -20,1 +21,1 @@ second hunk',
      '-old value',
      '+new value'
    ].join('\n');
    const rows = unifiedDiffLines(diff);

    expect(rows.find(({ text }) => text === '---删除行')).toEqual({
      text: '---删除行',
      oldLine: 5
    });
    expect(rows.find(({ text }) => text === '+新增行')).toEqual({ text: '+新增行', newLine: 5 });
    expect(rows.find(({ text }) => text === '+第二行')).toEqual({ text: '+第二行', newLine: 6 });
    expect(rows.find(({ text }) => text === ' unchanged after')).toEqual({
      text: ' unchanged after',
      oldLine: 6,
      newLine: 7
    });
    expect(rows.filter(({ hunk }) => hunk)).toEqual([
      { text: '@@ -4,3 +4,4 @@ first hunk', hunk: true },
      { text: '@@ -20,1 +21,1 @@ second hunk', hunk: true }
    ]);
    for (const text of [
      'diff --git a/src/main.ts b/src/main.ts',
      'index abc123..def456 100644',
      '--- a/src/main.ts',
      '+++ b/src/main.ts',
      '\\ No newline at end of file'
    ])
      expect(rows.find((row) => row.text === text)).toEqual({ text });
    expect(rows.find(({ text }) => text === '-old value')).toEqual({
      text: '-old value',
      oldLine: 20
    });
    expect(rows.find(({ text }) => text === '+new value')).toEqual({
      text: '+new value',
      newLine: 21
    });
  });

  it('presents quote-only user messages and keeps fenced quote XML as ordinary body text', () => {
    const quote = fileQuote('visible-quote', 'the quoted text');
    const tag = serializeComposerTag('mar_references', { references: [quote] });
    const presentation = composerMessagePresentation({ text: tag });

    expect(presentation).toMatchObject({ text: '', references: [quote] });
    expect(
      displayConversationItem({
        id: 'quote-only',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: tag }
      })
    ).toBe(true);

    const fenced = `Example:\n\`\`\`xml\n${tag}\n\`\`\``;
    expect(composerMessagePresentation({ text: fenced })).toMatchObject({
      text: fenced,
      references: []
    });
  });
});
