import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  fileChangeDiffSchema,
  toolResultResourceInputSchema,
  toolResultResourcePageSchema
} from '../../src/tool-result-resource.js';

const pageLimit = 256 * 1024;
const resourceLimit = 16 * 1024 * 1024;
const page = {
  resourceRef: '11111111-1111-4111-8111-111111111111',
  type: 'file_changes',
  version: 1,
  format: 'unified-diff',
  sha256: 'a'.repeat(64),
  byteSize: resourceLimit,
  content: '',
  nextCursor: 'opaque-next-page'
};

const encodings = [
  { name: 'ASCII', unit: 'a', unitBytes: 1 },
  { name: 'Chinese', unit: '界', unitBytes: 3 },
  { name: 'four-byte characters', unit: '😀', unitBytes: 4 },
  { name: 'mixed text', unit: 'a界😀', unitBytes: 8 }
];

describe('tool result resource pages', () => {
  describe.each(encodings)('$name UTF-8 byte limits', ({ unit, unitBytes }) => {
    it.each([
      { label: 'one byte below the limit', bytes: pageLimit - 1, accepted: true },
      { label: 'exactly at the limit', bytes: pageLimit, accepted: true },
      { label: 'one byte above the limit', bytes: pageLimit + 1, accepted: false }
    ])('$label', ({ bytes, accepted }) => {
      const content = unit.repeat(Math.floor(bytes / unitBytes)) + 'a'.repeat(bytes % unitBytes);
      expect(Buffer.byteLength(content, 'utf8')).toBe(bytes);
      const result = toolResultResourcePageSchema.safeParse({ ...page, content });
      expect(result.success).toBe(accepted);
      if (result.success) {
        expect(result.data).toEqual({ ...page, content });
      } else {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: ['content'] })])
        );
      }
    });
  });

  it('rejects 100000 Chinese characters despite their short string length', () => {
    const content = '汉'.repeat(100000);
    expect(content.length).toBeLessThan(pageLimit);
    expect(Buffer.byteLength(content, 'utf8')).toBe(300000);
    expect(toolResultResourcePageSchema.safeParse({ ...page, content }).success).toBe(false);
  });

  it('preserves empty content and optional cursor semantics', () => {
    const { nextCursor: _nextCursor, ...lastPage } = page;
    expect(toolResultResourcePageSchema.parse({ ...lastPage, byteSize: 0 })).toEqual({
      ...lastPage,
      byteSize: 0
    });
    expect(toolResultResourcePageSchema.parse(page)).toEqual(page);
  });

  it.each([
    { field: 'resourceRef', value: 'not-a-uuid' },
    { field: 'type', value: 'other' },
    { field: 'version', value: 2 },
    { field: 'format', value: 'other' },
    { field: 'sha256', value: 'A'.repeat(64) },
    { field: 'sha256', value: 'a'.repeat(63) },
    { field: 'byteSize', value: -1 },
    { field: 'byteSize', value: 0.5 },
    { field: 'byteSize', value: resourceLimit + 1 },
    { field: 'nextCursor', value: '' },
    { field: 'nextCursor', value: 'x'.repeat(1025) },
    { field: 'content', value: null },
    { field: 'unexpected', value: true }
  ])('rejects invalid $field=$value', ({ field, value }) => {
    expect(toolResultResourcePageSchema.safeParse({ ...page, [field]: value }).success).toBe(false);
  });

  it('accepts the maximum cursor length', () => {
    const nextCursor = 'x'.repeat(1024);
    expect(toolResultResourcePageSchema.parse({ ...page, nextCursor }).nextCursor).toBe(nextCursor);
  });
});

describe('tool result resource bounds', () => {
  it.each([4, pageLimit])('accepts a maxBytes request of %i', (maxBytes) => {
    const input = { resourceRef: page.resourceRef, maxBytes };
    expect(toolResultResourceInputSchema.parse(input)).toEqual(input);
  });

  it.each([3, pageLimit + 1])('rejects a maxBytes request of %i', (maxBytes) => {
    expect(
      toolResultResourceInputSchema.safeParse({ resourceRef: page.resourceRef, maxBytes }).success
    ).toBe(false);
  });

  it('preserves the 16 MiB resource descriptor limit', () => {
    const diff = {
      status: 'available',
      source: 'TOOL_CHANGE',
      resourceRef: page.resourceRef,
      format: page.format,
      byteSize: resourceLimit,
      sha256: page.sha256
    };
    expect(fileChangeDiffSchema.parse(diff)).toEqual(diff);
    expect(fileChangeDiffSchema.safeParse({ ...diff, byteSize: resourceLimit + 1 }).success).toBe(
      false
    );
  });
});
