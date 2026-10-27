import { AgentError } from '../../error.js';
import type { ClientToolDefinition, McpToolCatalog } from '../contracts.js';

export const MCP_DEFINITION_LIMITS = Object.freeze({
  depth: 64,
  nodes: 32768,
  definitionBytes: 256 * 1024,
  catalogBytes: 16 * 1024 * 1024,
  tools: 10000,
  servers: 256
});

function invalid(): never {
  throw new AgentError(
    'MAR_AGENT_MCP_CATALOG_INVALID',
    'MCP catalog contains invalid or oversized definitions.'
  );
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

/** Bound all JSON, including unknown extension keywords, before recursive lowering. */
function assertJson(value: unknown): void {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.exit) {
      seen.delete(current.value as object);
      continue;
    }
    if (++nodes > MCP_DEFINITION_LIMITS.nodes || current.depth > MCP_DEFINITION_LIMITS.depth)
      invalid();
    const item = current.value;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      continue;
    if (!Array.isArray(item) && !record(item)) invalid();
    if (seen.has(item)) invalid();
    seen.add(item);
    stack.push({ value: item, depth: current.depth, exit: true });
    for (const child of Object.values(item)) stack.push({ value: child, depth: current.depth + 1 });
  }
}

function assertSchema(schema: unknown): void {
  if (!record(schema) || schema.type !== 'object') invalid();
  assertJson(schema);
  const stack: unknown[] = [schema];
  const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'boolean') continue;
    if (!record(value)) invalid();
    if (value.type !== undefined) {
      const entries = Array.isArray(value.type) ? value.type : [value.type];
      if (
        !entries.length ||
        new Set(entries).size !== entries.length ||
        entries.some((type) => typeof type !== 'string' || !types.has(type))
      )
        invalid();
    }
    if (
      value.required !== undefined &&
      (!Array.isArray(value.required) ||
        value.required.some((name) => typeof name !== 'string') ||
        new Set(value.required).size !== value.required.length)
    )
      invalid();
    for (const key of [
      'properties',
      'patternProperties',
      '$defs',
      'definitions',
      'dependentSchemas'
    ]) {
      const children = value[key];
      if (children === undefined) continue;
      if (!record(children)) invalid();
      stack.push(...Object.values(children));
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      const children = value[key];
      if (children === undefined) continue;
      if (!Array.isArray(children) || !children.length) invalid();
      stack.push(...children);
    }
    for (const key of [
      'additionalProperties',
      'unevaluatedProperties',
      'additionalItems',
      'unevaluatedItems',
      'contains',
      'propertyNames',
      'not',
      'if',
      'then',
      'else',
      'items'
    ]) {
      const child = value[key];
      if (child !== undefined) {
        if (key === 'items' && Array.isArray(child)) stack.push(...child);
        else stack.push(child);
      }
    }
    for (const key of ['$ref', '$id', '$schema', 'title', 'description', 'format', 'pattern'])
      if (value[key] !== undefined && typeof value[key] !== 'string') invalid();
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
      if (
        value[key] !== undefined &&
        (typeof value[key] !== 'number' ||
          !Number.isFinite(value[key]) ||
          (key === 'multipleOf' && Number(value[key]) <= 0))
      )
        invalid();
    for (const key of [
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'minProperties',
      'maxProperties'
    ])
      if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0))
        invalid();
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) invalid();
  }
}

/** Shared Host and Node publication boundary, not a provider-specific conversion. */
export function assertMcpToolDefinition(
  value: unknown,
  options: { nativeToolNames?: boolean } = {}
): asserts value is ClientToolDefinition {
  if (
    !record(value) ||
    !text(value.name, 256) ||
    (!options.nativeToolNames && !/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/u.test(value.name)) ||
    typeof value.description !== 'string' ||
    value.description.length > 65536 ||
    (value.parallelSafety !== undefined &&
      !['safe', 'serial'].includes(String(value.parallelSafety))) ||
    (value.agentScope !== undefined &&
      !['ROOT_AND_SUBAGENTS', 'ROOT_ONLY'].includes(String(value.agentScope))) ||
    (value.allowedCallers !== undefined &&
      (!Array.isArray(value.allowedCallers) ||
        !value.allowedCallers.length ||
        value.allowedCallers.some((caller) => caller !== 'direct' && caller !== 'programmatic'))) ||
    (value.codeModeExposure !== undefined && value.codeModeExposure !== 'both') ||
    (value.inputMode !== undefined && value.inputMode !== 'json')
  )
    invalid();
  assertJson(value);
  assertSchema(value.inputSchema);
  if (value.outputSchema !== undefined) assertSchema(value.outputSchema);
  if (Buffer.byteLength(JSON.stringify(value)) > MCP_DEFINITION_LIMITS.definitionBytes) invalid();
}

export function assertMcpToolCatalog(
  value: unknown,
  options: { nativeToolNames?: boolean } = {}
): asserts value is McpToolCatalog {
  if (
    !record(value) ||
    typeof value.revision !== 'string' ||
    value.revision.length > 512 ||
    !onlyKeys(value, ['revision', 'servers', 'tools']) ||
    !Array.isArray(value.servers) ||
    value.servers.length > MCP_DEFINITION_LIMITS.servers ||
    !Array.isArray(value.tools) ||
    value.tools.length > MCP_DEFINITION_LIMITS.tools
  )
    invalid();
  const servers = new Set<string>();
  for (const server of value.servers) {
    if (
      !record(server) ||
      !text(server.id, 512) ||
      !text(server.name, 256) ||
      servers.has(server.id) ||
      !onlyKeys(server, ['id', 'name', 'description', 'instructions']) ||
      (server.description !== undefined &&
        (typeof server.description !== 'string' || server.description.length > 65536)) ||
      (server.instructions !== undefined &&
        (typeof server.instructions !== 'string' || server.instructions.length > 65536))
    )
      invalid();
    servers.add(server.id);
  }
  const names = new Set<string>();
  for (const tool of value.tools) {
    if (
      !record(tool) ||
      !text(tool.serverId, 512) ||
      !servers.has(tool.serverId) ||
      !onlyKeys(tool, [
        'definition',
        'serverId',
        'rawName',
        'sourceIdentity',
        'definitionRevision',
        'lifetime',
        'exposure',
        'annotations'
      ]) ||
      !text(tool.rawName, 256) ||
      !text(tool.sourceIdentity, 512) ||
      !text(tool.definitionRevision, 512) ||
      !['session', 'execution'].includes(String(tool.lifetime)) ||
      !['direct', 'deferred'].includes(String(tool.exposure))
    )
      invalid();
    assertMcpToolDefinition(tool.definition, options);
    if (tool.annotations !== undefined) {
      if (!record(tool.annotations)) invalid();
      assertJson(tool.annotations);
    }
    if (names.has(tool.definition.name)) invalid();
    names.add(tool.definition.name);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MCP_DEFINITION_LIMITS.catalogBytes) invalid();
}
