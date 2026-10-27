import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AgentError } from '../error.js';
import { createFileDiff, FileDiffLimitError } from './file-change-diff.js';
import type { ToolExecutionResult } from './contracts.js';

import {
  fileChangesExtensionSchema,
  type ToolResultExtension,
  type FileChangeEvidence,
  type ToolResultResourceWriter
} from './result-extension-contract.js';
export { fileChangesExtensionSchema } from './result-extension-contract.js';
export type {
  ToolResultExtension,
  FileChangeEvidence,
  AvailableToolResultResource,
  ToolResultResourceWriter
} from './result-extension-contract.js';

export function parseToolResultExtensions(value: unknown): ToolResultExtension[] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const extensions: ToolResultExtension[] = [];
  const ids = new Set<string>();
  for (const input of value) {
    const parsed = fileChangesExtensionSchema.safeParse(input);
    if (!parsed.success || extensions.some((entry) => entry.type === parsed.data.type)) continue;
    if (
      new Set(parsed.data.entries.map((entry) => entry.changeId)).size !==
        parsed.data.entries.length ||
      parsed.data.entries.some((entry) => ids.has(entry.changeId))
    )
      continue;
    parsed.data.entries.forEach((entry) => ids.add(entry.changeId));
    extensions.push(parsed.data);
  }
  return extensions.length && Buffer.byteLength(JSON.stringify(extensions)) <= 1024 * 1024
    ? extensions
    : undefined;
}

const capture = new AsyncLocalStorage<{
  entries: FileChangeEvidence[];
  bytes: number;
  reservedEntries: number;
  descriptorBytes: number;
  write?: ToolResultResourceWriter;
}>();
const failures = new WeakMap<object, ToolResultExtension[]>();
export function failedToolResultExtensions(error: unknown): ToolResultExtension[] | undefined {
  return error !== null && typeof error === 'object' ? failures.get(error) : undefined;
}

/** Reserve a complete invocation's descriptors before any leaf commits, including wrapped calls. */
export function reserveFileChangePaths(paths: readonly string[]): void {
  const context = capture.getStore();
  const entries = (context?.reservedEntries ?? 0) + paths.length;
  const bytes =
    (context?.descriptorBytes ?? 256) +
    paths.reduce((sum, path) => sum + Buffer.byteLength(JSON.stringify(path)) + 512, 0);
  if (entries > 200 || bytes > 1024 * 1024 || paths.some((path) => path.length > 8192))
    throw new AgentError(
      'MAR_AGENT_TOOL_OUTPUT_LIMIT',
      'Patch paths exceed the file evidence descriptor limit.'
    );
  if (context) {
    context.reservedEntries = entries;
    context.descriptorBytes = bytes;
  }
}

/** Only the SDK's real file commit calls this producer; arbitrary result fields are ignored. */
export async function captureFileChange(
  path: string,
  before?: Buffer,
  after?: Buffer
): Promise<void> {
  const context = capture.getStore();
  if (!context) return;
  const entry: FileChangeEvidence = {
    changeId: randomUUID(),
    path,
    change: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
    additions: null,
    deletions: null,
    diff: { status: 'unavailable', reason: 'capture-failed' }
  };
  context.entries.push(entry);
  try {
    const diff = createFileDiff(path, before, after);
    if (!diff) {
      entry.diff = { status: 'unavailable', reason: 'unsupported-content' };
      return;
    }
    entry.additions = diff.additions;
    entry.deletions = diff.deletions;
    context.bytes += Buffer.byteLength(diff.text);
    if (context.bytes > 32 * 1024 * 1024)
      entry.diff = { status: 'unavailable', reason: 'limit-exceeded' };
    else if (context.write) entry.diff = await context.write(diff.text);
    else entry.diff = { status: 'unavailable', reason: 'storage-failed' };
  } catch (error) {
    entry.diff = {
      status: 'unavailable',
      reason: error instanceof FileDiffLimitError ? 'limit-exceeded' : 'storage-failed'
    };
  }
}

/** Own a physical invocation, including all real leaf effects retained across wrappers. */
export async function withToolResultExtensions(
  write: ToolResultResourceWriter | undefined,
  run: () => Promise<ToolExecutionResult>
): Promise<ToolExecutionResult> {
  const context = {
    entries: [] as FileChangeEvidence[],
    bytes: 0,
    reservedEntries: 0,
    descriptorBytes: 256,
    ...(write ? { write } : {})
  };
  return capture.run(context, async () => {
    const extensions = () =>
      parseToolResultExtensions([{ type: 'file_changes', version: 1, entries: context.entries }]);
    try {
      const { resultExtensions: _ignored, ...result } = await run();
      const resultExtensions = context.entries.length ? extensions() : undefined;
      return resultExtensions ? { ...result, resultExtensions } : result;
    } catch (error) {
      if (context.entries.length && error !== null && typeof error === 'object')
        failures.set(error, extensions()!);
      throw error;
    }
  });
}
