import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError } from '../../../error.js';
import { inlineMediaHistory } from '../../inline-media.js';
import { copyToolResultResources } from '../../tool-result-resources.js';
import type { SessionMeta, SessionRecord } from '../types.js';
import { syncJsonlDirectory } from './fs-durability.js';
import { forkedPayload, stageSessionSegments } from './history.js';
import { copyGeneratedImages, generatedImageFileNames } from './images.js';
import { sessionDirectoryExists } from './open-recovery.js';
import { copyResources } from './resources.js';

export async function forkSessionOperation(
  source: SessionMeta,
  records: readonly SessionRecord[],
  input: { readonly boundaryTurnId: string | null; readonly title: string },
  sourceRoot: string,
  sourceDirectory: string,
  owner: {
    begin(target: SessionMeta): Promise<{ directory: string; release(): Promise<void> }>;
    publish(target: SessionMeta, copied: readonly SessionRecord[]): Promise<void>;
    reject(target: SessionMeta, error: unknown): Promise<boolean>;
  }
) {
  const sourceSessionId = source.id;
  const boundaryIndex =
    input.boundaryTurnId === null
      ? -1
      : records.findLastIndex((record) => record.turnId === input.boundaryTurnId);
  if (input.boundaryTurnId !== null && boundaryIndex < 0)
    throw new AgentError('MAR_AGENT_REWIND_TARGET_INVALID', 'Session rewind target was not found.');
  const createdAt = new Date().toISOString();
  const targetId = randomUUID();
  const generation = randomUUID();
  const target: SessionMeta = {
    id: targetId,
    title: input.title,
    workspace: source.workspace,
    createdAt,
    lastActivityAt: createdAt,
    source: { type: 'user' },
    storage: { encoding: 2, generation },
    nextSequence: 1,
    automaticTitlePending: false,
    resume: {
      version: 1,
      userTurns: 0,
      todoRevision: 0,
      executionModelIndexed: true,
      firstUserMessageIndexed: true
    },
    segments: []
  };
  const publication = await owner.begin(target);
  const targetDirectory = join(publication.directory, 'v2', generation);
  let discard = false;
  let failed = false;
  try {
    await mkdir(join(publication.directory, 'v2'), { mode: 0o700 });
    await mkdir(targetDirectory, { mode: 0o700 });
    await syncJsonlDirectory(join(publication.directory, 'v2'));
    await syncJsonlDirectory(publication.directory);
    const copied: SessionRecord[] = [
      {
        recordId: randomUUID(),
        sequence: 1,
        timestamp: createdAt,
        sessionId: target.id,
        type: 'session.created',
        payload: {
          title: target.title,
          workspace: target.workspace,
          automaticTitle: false,
          source: target.source
        }
      }
    ];
    const retained = input.boundaryTurnId === null ? [] : records.slice(1, boundaryIndex + 1);
    const inlineState = inlineMediaHistory(retained).state;
    const stateAnchor =
      inlineState &&
      retained.findLast(
        (record) => record.type === 'resource.window' || record.type === 'compact.completed'
      );
    const forkIdentities = new Map<string, { recordId: string; sequence: number }>();
    for (const record of retained) {
      if (record.type === 'context.gc.completed' || record.type === 'responses.continuation')
        continue;
      const identity = { recordId: randomUUID(), sequence: copied.length + 1 };
      forkIdentities.set(record.recordId, identity);
      copied.push({
        ...identity,
        sessionId: target.id,
        type: record.type,
        payload: forkedPayload(
          record.type,
          record === stateAnchor
            ? record.type === 'resource.window'
              ? inlineState
              : {
                  ...(record.payload as Record<string, unknown>),
                  inlineMediaState: inlineState
                }
            : record.payload,
          sourceSessionId,
          target.id,
          input.title,
          forkIdentities
        ),
        ...(record.executionId === undefined ? {} : { executionId: record.executionId }),
        ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
        timestamp: record.timestamp
      });
    }
    // A fork is unpublished until every segment and referenced image is durable.
    const staged = await stageSessionSegments(targetDirectory, copied, 'fork');
    for (const file of staged.files) await rename(file.temporaryPath, file.path);
    target.segments = staged.segments;
    target.nextSequence = copied.length + 1;
    await copyToolResultResources(sourceDirectory, targetDirectory, copied);
    await copyGeneratedImages(sourceRoot, publication.directory, generatedImageFileNames(retained));
    await copyResources(sourceDirectory, targetDirectory, retained);
    for (const path of [
      join(targetDirectory, 'resources'),
      join(targetDirectory, 'tool_results'),
      join(publication.directory, 'generated_images')
    ])
      if (await sessionDirectoryExists(path)) await syncJsonlDirectory(path);
    await syncJsonlDirectory(targetDirectory);
    await syncJsonlDirectory(publication.directory);
    target.lastActivityAt = target.createdAt;
    await owner.publish(target, copied);
    await rm(join(publication.directory, 'publication-pending'), { force: true });
    return {
      id: target.id,
      title: target.title,
      workspace: target.workspace,
      createdAt: target.createdAt,
      lastActivityAt: target.createdAt,
      source: target.source
    };
  } catch (error) {
    failed = true;
    discard = await owner.reject(target, error).catch(() => false);
    throw error;
  } finally {
    const cleanup = async () => {
      try {
        await publication.release();
      } finally {
        if (discard) await rm(publication.directory, { recursive: true, force: true });
      }
    };
    if (failed) await cleanup().catch(() => undefined);
    else await cleanup();
  }
}
