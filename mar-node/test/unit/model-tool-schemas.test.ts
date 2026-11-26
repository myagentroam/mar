import { describe, expect, it } from 'vitest';
import { whiteboardTool } from '../../src/orchestration/whiteboard/whiteboard-tool.js';
import { createBrowserUseExtensions } from '../../src/runner/mar-agent/browser-use-extensions.js';
import {
  computerUseToolDefinition,
  computerUseWaitToolDefinition
} from '../../src/runner/mar-agent/computer-use.js';
import {
  bytedArkImageGenToolDefinition,
  codexImageGenToolDefinition
} from '../../src/runner/mar-agent/image-generation.js';
import {
  webFetchToolDefinition,
  webSearchToolDefinition
} from '../../src/runner/mar-agent/web-tools-extensions.js';

const unsupportedComposition = [
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas'
];

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Visit schema nodes, not names of input properties or literal values.
function incompatibleComposition(value: unknown, path: string): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const schema = fields(value);
  return [
    ...unsupportedComposition
      .filter((key) => Object.hasOwn(schema, key))
      .map((key) => `${path}.${key}`),
    ...['properties', '$defs', 'definitions'].flatMap((key) =>
      Object.entries(fields(schema[key])).flatMap(([name, child]) =>
        incompatibleComposition(child, `${path}.${key}.${name}`)
      )
    ),
    ...['items', 'additionalProperties'].flatMap((key) =>
      incompatibleComposition(schema[key], `${path}.${key}`)
    ),
    ...(Array.isArray(schema.anyOf)
      ? schema.anyOf.flatMap((child, index) =>
          incompatibleComposition(child, `${path}.anyOf[${index}]`)
        )
      : [])
  ];
}

const browserTool = createBrowserUseExtensions({
  runId: 'schema-check',
  cliScope: 'a'.repeat(32),
  execute: async () => ({ content: '' })
}).tools![0]!;

describe('Node-owned MAR Agent model tool schemas', () => {
  it('accepts only the operands for the selected whiteboard action and operation', () => {
    const validate = whiteboardTool(
      () => ({}),
      () => 'execution'
    ).parseInput!;
    for (const input of [
      {},
      { action: 'read', boardId: 'a' },
      { action: 'read', entryId: 'w1' },
      { action: 'read', ops: [{ op: 'add', content: 'unexpected' }] },
      { action: 'join' },
      { action: 'leave', boardAgentId: 'a' },
      { action: 'leave', ops: [{ op: 'add', content: 'unexpected' }] },
      { action: 'join', boardAgentId: 'a', ops: [{ op: 'add', content: 'unexpected' }] },
      {
        action: 'update',
        expectedBoardId: 'a',
        ops: [{ op: 'add', content: 'new' }]
      },
      { action: 'update', boardAgentId: null, ops: null },
      { action: 'update', boardAgentId: 'a', ops: [] },
      { action: 'update', boardAgentId: 'a', ops: [{ op: 'update', id: 'w1', content: 'new' }] },
      {
        action: 'update',
        boardAgentId: 'a',
        ops: [{ op: 'del', id: 'w1', expectedRevision: 1, content: 'unexpected' }]
      }
    ])
      expect(() => validate(input)).toThrow(
        expect.objectContaining({ code: 'WHITEBOARD_INPUT_INVALID' })
      );
    expect(validate({ action: 'read' })).toEqual({ action: 'read' });
    expect(validate({ action: 'leave' })).toEqual({ action: 'leave' });
    expect(validate({ action: 'leave', boardAgentId: null, ops: null })).toEqual({
      action: 'leave'
    });
    expect(validate({ action: 'read', boardAgentId: 'b' })).toEqual({
      action: 'read',
      boardAgentId: 'b'
    });
    expect(validate({ action: 'join', boardAgentId: 'b', ops: null })).toEqual({
      action: 'join',
      boardAgentId: 'b'
    });
    const batch = {
      action: 'update',
      boardAgentId: 'a',
      ops: [
        { op: 'clear', expectedBoardRevision: 2 },
        { op: 'add', content: 'new' }
      ]
    };
    expect(validate(batch)).toEqual(batch);
  });

  it('accepts Responses strict-mode null placeholders when reading the whiteboard', () => {
    const tool = whiteboardTool(
      () => ({}),
      () => 'execution'
    );
    expect(tool.parseInput!({ action: 'read', boardAgentId: null, ops: null })).toEqual({
      action: 'read'
    });
  });

  it.each([
    browserTool,
    whiteboardTool(
      () => ({}),
      () => 'execution'
    ),
    computerUseToolDefinition,
    computerUseWaitToolDefinition,
    codexImageGenToolDefinition,
    bytedArkImageGenToolDefinition,
    webSearchToolDefinition,
    webFetchToolDefinition
  ])('$name is an object without unsupported OpenAI composition', ({ name, inputSchema }) => {
    expect(inputSchema).toMatchObject({ type: 'object' });
    expect(inputSchema).not.toHaveProperty('anyOf');
    expect(incompatibleComposition(inputSchema, name)).toEqual([]);
  });

  it('keeps browser commands in closed nested variants with the required operands', () => {
    expect(browserTool.inputSchema).toMatchObject({
      required: ['command'],
      additionalProperties: false,
      properties: {
        command: {
          anyOf: expect.arrayContaining([
            expect.objectContaining({
              type: 'object',
              additionalProperties: false,
              required: ['action'],
              properties: { action: { type: 'string', enum: ['describe'] } }
            }),
            expect.objectContaining({
              type: 'object',
              additionalProperties: false,
              required: ['action', 'tabId'],
              properties: {
                action: { type: 'string', enum: ['select'] },
                tabId: expect.objectContaining({ type: 'string', format: 'uuid' })
              }
            })
          ])
        }
      }
    });
  });

  it('preserves strict runtime validation for browser command operands', async () => {
    const extensions = createBrowserUseExtensions({
      runId: 'schema-check',
      cliScope: 'a'.repeat(32),
      execute: async (command) => ({ content: command.action })
    });
    const context = {
      mode: 'run',
      sessionId: 'schema-check',
      executionId: 'schema-check',
      signal: new AbortController().signal
    } as const;
    const invoke = (command: unknown) =>
      extensions.executeTool!({ name: browserTool.name, arguments: { command } }, context);
    const tabId = 'c102fe42-e5ac-47ee-abf4-ed84ce4f3b83';
    for (const command of [
      { action: 'select' },
      { action: 'select', tabId: 'not-a-uuid' },
      { action: 'describe', tabId }
    ]) {
      await expect(invoke(command)).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    }
    await expect(invoke({ action: 'select', tabId })).resolves.toEqual({ content: 'select' });
  });
});
