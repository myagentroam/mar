import { randomUUID } from 'node:crypto';
import { readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { toolResultResourceFiles } from '../../tool-result-resources.js';
import {
  beginSessionStorageTransaction,
  retiredSessionTrashPath,
  recoverSessionStorageTransaction,
  type SessionStorageTransaction
} from './transaction-recovery.js';
import { deriveExecutionState } from '../execution-state.js';
import {
  renameIfExists,
  retainedSessionTitle,
  stageRollbackSegments,
  stageSessionSegments,
  stageUnreferencedImages
} from './history.js';
import { generatedImageFileNames } from './images.js';
import { CONTEXTUAL_WORLD_STATE_FILE } from './open-recovery.js';
import { resourceFiles } from './resources.js';
import { syncJsonlDirectory } from './fs-durability.js';
import type { SessionMeta, SessionRecord } from '../types.js';

interface HistoryReplacementContext {
  readonly directory: string;
  readonly sessionDirectory: string;
  readonly targetGeneration?: string;
  segmentPaths(): Promise<string[]>;
  settleIndex(
    request: HistoryIndexRequest,
    recover: (committed: boolean) => Promise<void>
  ): Promise<HistoryIndexOutcome>;
}

interface HistoryIndexBase {
  readonly transactionId: string;
  readonly nextSequence: number;
  readonly segments: NonNullable<SessionMeta['segments']>;
  readonly targetGeneration?: string;
}

type HistoryIndexChange = HistoryIndexBase &
  (
    | {
        readonly kind: 'rollback';
        readonly title?: string;
        readonly state: ReturnType<typeof deriveExecutionState>;
      }
    | { readonly kind: 'clear'; readonly clearedAt: string }
  );

type HistoryIndexRequest =
  | { readonly kind: 'apply'; readonly change: HistoryIndexChange }
  | { readonly kind: 'recover'; readonly transactionId: string; readonly error: unknown };

export type HistoryIndexOutcome =
  | {
      readonly status: 'committed';
      readonly meta: SessionMeta;
      readonly error?: unknown;
      readonly recoveryRequired?: true;
    }
  | { readonly status: 'not-committed' | 'unknown'; readonly error: unknown };

/** Execute one rollback/clear transaction while its caller holds maintenance. */
export async function replaceSessionHistory(
  meta: SessionMeta,
  prefix: readonly SessionRecord[],
  operation: { kind: 'rollback'; reuseSegments: boolean } | { kind: 'clear'; clearedAt: string },
  context: HistoryReplacementContext
) {
  const retained =
    operation.kind === 'rollback'
      ? prefix.filter((record) => record.type !== 'responses.continuation')
      : prefix;
  const targetDirectory =
    context.targetGeneration === undefined
      ? context.directory
      : join(context.sessionDirectory, 'v2', context.targetGeneration);
  const incremental =
    operation.kind === 'rollback' &&
    operation.reuseSegments &&
    meta.storage?.encoding === 2 &&
    meta.segments !== undefined;
  const staged = incremental
    ? await stageRollbackSegments(targetDirectory, prefix, meta.segments!)
    : await stageSessionSegments(targetDirectory, retained);
  const transactionId = randomUUID();
  const targetNextSequence = operation.kind === 'clear' ? 2 : (retained.at(-1)?.sequence ?? 0) + 1;
  const contextualWorldStatePath = join(context.directory, CONTEXTUAL_WORLD_STATE_FILE);
  const contextualWorldStateBackup = `${contextualWorldStatePath}.${targetNextSequence}.${transactionId}.${operation.kind}-backup`;
  const originalTransactionId = meta.storageTransactionId;
  const originalPaths = await context.segmentPaths();
  const retiredPaths = await retiredSessionPaths(
    context.sessionDirectory,
    context.directory,
    targetDirectory
  );
  const backups = originalPaths
    .filter((path) => !staged.reused?.has(basename(path)))
    .map((path) => ({
      path,
      backup: `${path}.${transactionId}.${operation.kind}-backup`
    }));
  const transaction: SessionStorageTransaction = {
    version: 1,
    id: transactionId,
    kind: operation.kind,
    originalSegments: backups.map((item) => basename(item.path)),
    stagedSegments: staged.files.map((item) => ({
      path: basename(item.path),
      temporary: basename(item.temporaryPath)
    })),
    sidecarBackup: basename(contextualWorldStateBackup),
    retiredPaths,
    ...(context.targetGeneration === undefined
      ? {}
      : { targetGeneration: context.targetGeneration })
  };
  let committed = false;
  let uncertain = false;
  const recover = (selected: boolean) =>
    recoverSessionStorageTransaction(
      context.directory,
      selected ? transactionId : originalTransactionId,
      context.sessionDirectory
    );
  try {
    await beginSessionStorageTransaction(context.directory, transaction);
    await syncJsonlDirectory(context.directory);
    await renameIfExists(contextualWorldStatePath, contextualWorldStateBackup);
    await stageUnreferencedImages(
      context.sessionDirectory,
      'generated_images',
      operation.kind === 'rollback' ? new Set(generatedImageFileNames(retained)) : new Set(),
      transactionId
    );
    await stageUnreferencedImages(
      context.directory,
      'resources',
      operation.kind === 'rollback' ? resourceFiles(retained) : new Set(),
      transactionId
    );
    await stageUnreferencedImages(
      context.directory,
      'tool_results',
      operation.kind === 'rollback' ? toolResultResourceFiles(retained) : new Set(),
      transactionId
    );
    for (const path of retiredPaths)
      await renameIfExists(
        join(context.sessionDirectory, path),
        retiredSessionTrashPath(context.sessionDirectory, path, transactionId)
      );
    for (const item of backups) await rename(item.path, item.backup);
    for (const item of staged.files) {
      await rename(item.temporaryPath, item.path);
    }
    for (const directory of new Set([
      context.directory,
      context.sessionDirectory,
      targetDirectory,
      join(context.sessionDirectory, 'v2'),
      join(context.sessionDirectory, 'generated_images'),
      join(context.directory, 'resources'),
      join(context.directory, 'tool_results')
    ])) {
      try {
        await syncJsonlDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const title = operation.kind === 'rollback' ? retainedSessionTitle(retained, '') : '';
    const outcome = await context.settleIndex(
      {
        kind: 'apply',
        change: {
          transactionId,
          nextSequence: targetNextSequence,
          segments: staged.segments,
          ...(context.targetGeneration === undefined
            ? {}
            : { targetGeneration: context.targetGeneration }),
          ...(operation.kind === 'rollback'
            ? {
                kind: 'rollback' as const,
                state: deriveExecutionState(retained),
                ...(title ? { title } : {})
              }
            : { kind: 'clear' as const, clearedAt: operation.clearedAt })
        }
      },
      recover
    );
    if (outcome.status !== 'committed' || outcome.error !== undefined) {
      uncertain =
        outcome.status === 'unknown' ||
        (outcome.status === 'committed' && outcome.recoveryRequired === true);
      return outcome;
    }
    committed = true;
    try {
      await recover(true);
      return outcome;
    } catch (error) {
      uncertain = true;
      return { status: 'committed', meta: outcome.meta, error, recoveryRequired: true } as const;
    }
  } catch (error) {
    if (committed) {
      uncertain = true;
      return { status: 'unknown', error } as const;
    }
    const outcome = await context.settleIndex({ kind: 'recover', transactionId, error }, recover);
    uncertain =
      outcome.status === 'unknown' ||
      (outcome.status === 'committed' && outcome.recoveryRequired === true);
    return outcome;
  } finally {
    if (!uncertain)
      await Promise.all(staged.files.map((item) => rm(item.temporaryPath, { force: true }))).catch(
        () => undefined
      );
  }
}

async function retiredSessionPaths(
  root: string,
  active: string,
  target: string
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = entries
    .filter(
      (entry) =>
        root !== active &&
        ((entry.isFile() &&
          (/^events-\d{6}\.jsonl$/u.test(entry.name) ||
            entry.name === 'context-world-state.json')) ||
          (entry.isDirectory() && ['resources', 'tool_results'].includes(entry.name)))
    )
    .map((entry) => entry.name);
  const generations = await readdir(join(root, 'v2'), { withFileTypes: true });
  for (const entry of generations) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/u.test(entry.name)) continue;
    const relative = `v2/${entry.name}`;
    if (join(root, relative) !== active && join(root, relative) !== target) paths.push(relative);
  }
  return paths;
}
