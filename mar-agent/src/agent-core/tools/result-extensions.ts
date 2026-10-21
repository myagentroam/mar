import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { MarAgentError } from '../error.js';
import { z } from 'zod';
import { createFileDiff, FileDiffLimitError } from './file-change-diff.js';
import type { ToolExecutionResult } from './contracts.js';

const diffSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    resourceRef: z.string().uuid(),
    format: z.literal('unified-diff'),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }),
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(['unsupported-content', 'limit-exceeded', 'capture-failed', 'storage-failed'])
  })
]);
export const fileChangesExtensionSchema = z.object({
  type: z.literal('file_changes'),
  version: z.literal(1),
  entries: z
    .array(
      z.object({
        changeId: z.string().uuid(),
        path: z.string().min(1).max(8192),
        change: z.enum(['added', 'modified', 'deleted']),
        additions: z.number().int().nonnegative().nullable(),
        deletions: z.number().int().nonnegative().nullable(),
        diff: diffSchema
      })
    )
    .max(200)
});
export type ToolResultExtension = z.infer<typeof fileChangesExtensionSchema>;
export type FileChangeEvidence = ToolResultExtension['entries'][number];
export type AvailableToolResultResource = Extract<
  FileChangeEvidence['diff'],
  { status: 'available' }
>;
export type ToolResultResourceWriter = (text: string) => Promise<AvailableToolResultResource>;

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
    throw new MarAgentError(
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
