import { describe, expect, it } from 'vitest';
import { structuredToolArtifacts } from '../../src/tools/output-projection.js';
import type { AgentToolImageArtifact } from '../../src/tools/contracts.js';

describe('managed image artifacts', () => {
  const artifact = (format: 'png' | 'gif'): AgentToolImageArtifact => ({
    kind: 'image',
    name: `image_test.${format}`,
    mimeType: `image/${format}`,
    byteSize: 42,
    sha256: 'a'.repeat(64),
    fileName: `image_test.${format}`
  });

  it.each(['png', 'gif'] as const)(
    'preserves %s metadata without sharing mutable state',
    (format) => {
      const input = artifact(format);
      const result = structuredToolArtifacts([input]);
      expect(result).toEqual([input]);
      expect(result?.[0]).not.toBe(input);
    }
  );

  it.each([
    { mimeType: 'image/png', fileName: 'image_test.gif' },
    { mimeType: 'image/gif', fileName: 'image_test.png' },
    { mimeType: 'image/svg+xml', fileName: 'image_test.svg' },
    { mimeType: 'image/gif', fileName: '../image_test.gif' }
  ])('rejects mismatched or unsafe artifact $mimeType/$fileName', (overrides) => {
    expect(() =>
      structuredToolArtifacts([{ ...artifact('gif'), ...overrides } as AgentToolImageArtifact])
    ).toThrow(expect.objectContaining({ code: 'MAR_AGENT_TOOL_OUTPUT_INVALID' }));
  });
});
