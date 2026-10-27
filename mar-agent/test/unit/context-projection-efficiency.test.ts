import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host/local-agent-host.js';
import { parseModelImages } from '../../src/model/image.js';
import {
  parseCodeCalls,
  parseObservations
} from '../../src/session/code-observation-projection.js';
import {
  contextualChanges,
  type ContextualPart
} from '../../src/runtime/context/contextual-blocks.js';
import { restoreModelContext } from '../../src/runtime/context/projection.js';
import { restoreCompactTail } from '../../src/runtime/compaction/retained-context.js';
import type { ExtensionOperationContext } from '../../src/extensions/operation.js';

vi.mock('node:crypto', async (load) => {
  const actual = await load<typeof import('node:crypto')>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});
vi.mock('../../src/model/image.js', async (load) => {
  const actual = await load<typeof import('../../src/model/image.js')>();
  return { ...actual, parseModelImages: vi.fn(actual.parseModelImages) };
});
vi.mock('../../src/session/code-observation-projection.js', async (load) => {
  const actual = await load<typeof import('../../src/session/code-observation-projection.js')>();
  return {
    ...actual,
    parseCodeCalls: vi.fn(actual.parseCodeCalls),
    parseObservations: vi.fn(actual.parseObservations)
  };
});
beforeEach(() => vi.clearAllMocks());

const image = { resourceInputVersion: 1, mimeType: 'image/png', resourceId: 'a'.repeat(64) };

it('parses each persisted tool field once without relaxing malformed-field rejection', () => {
  const input = {
    role: 'tool',
    callId: 'call',
    content: 'result',
    images: [image],
    calls: [],
    observations: []
  };
  expect(restoreModelContext(input)).toMatchObject({
    images: [image],
    calls: [],
    observations: []
  });
  expect(parseModelImages).toHaveBeenCalledTimes(1);
  expect(parseCodeCalls).toHaveBeenCalledTimes(1);
  expect(parseObservations).toHaveBeenCalledTimes(1);
  expect(
    restoreModelContext({
      ...input,
      images: [{ ...image, resourceInputVersion: 2 }],
      calls: [{}],
      observations: [{}]
    })
  ).toEqual({ role: 'tool', callId: 'call', content: 'result' });
});

it('parses retained compact images once and still rejects future resource versions', () => {
  expect(
    restoreCompactTail({ role: 'assistant', content: 'retained', images: [image] })?.images
  ).toEqual([image]);
  expect(parseModelImages).toHaveBeenCalledTimes(1);
  expect(
    restoreCompactTail({
      role: 'assistant',
      content: 'retained',
      images: [{ ...image, resourceInputVersion: 2 }]
    })?.images
  ).toBeUndefined();
});

it('only hashes emitted contextual changes and preserves cache and authority changes', () => {
  const prior: ContextualPart = {
    id: 'test',
    source: 'host',
    authority: 'instruction',
    content: 'text',
    textBlocks: [{ text: 'text', cache: true }]
  };
  expect(contextualChanges([prior], [structuredClone(prior)])).toEqual([]);
  expect(createHash).not.toHaveBeenCalled();
  expect(contextualChanges([prior], [{ ...prior, textBlocks: [{ text: 'text' }] }])).toHaveLength(
    1
  );
  expect(createHash).toHaveBeenCalledTimes(1);
  expect(contextualChanges([prior], [{ ...prior, source: 'sdk' }])).toHaveLength(1);
  expect(createHash).toHaveBeenCalledTimes(2);
});

it('reuses captured static tool revisions across catalogs and execution checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-static-catalog-'));
  const host = new LocalAgentHost({
    homeDirectory: root,
    workspace: root,
    mcpTools: [
      { name: 'mcp__legacy__probe', description: 'Probe', inputSchema: { type: 'object' } }
    ],
    callMcpOperation: async () => ({ content: 'done' })
  });
  try {
    vi.mocked(createHash).mockClear();
    const first = host.extensionPorts.tools!.catalog('session');
    const second = host.extensionPorts.tools!.catalog('session');
    expect(second.map((tool) => tool.source)).toEqual(first.map((tool) => tool.source));
    const tool = second.find((tool) => tool.definition.name === 'mcp__legacy__probe')!;
    const call: ExtensionOperationContext = {
      operationId: 'operation',
      sessionId: 'session',
      sessionEpoch: 1,
      actor: 'extension',
      entry: 'native-api',
      signal: new AbortController().signal
    };
    expect(tool.available?.(call)).toBe(true);
    await expect(
      tool.execute({ name: tool.definition.name, arguments: {} }, call)
    ).resolves.toEqual({ content: 'done' });
    expect(createHash).not.toHaveBeenCalled();
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
