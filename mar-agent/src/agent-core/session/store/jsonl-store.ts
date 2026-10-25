import { randomUUID } from 'node:crypto';
import { inlineMediaHistory } from '../inline-media.js';
import type {
  SessionStore,
  SessionStoreMaintenance,
  SessionRecordInput,
  SessionStoreCompactInput
} from './contracts.js';
import { lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MarAgentError } from '../../error.js';
import { isModelImageUrl } from '../../model/image.js';
import { cloneCoreJson, type CoreCheckpoint, type CoreJsonValue } from '../../extensions/data.js';
import { acquireFileLock } from '../../storage/file-lock.js';
import { todoItemsFromSnapshot, type TodoSnapshot } from '../../tools/agent/todo.js';
import {
  applyCodeModeStateMutations,
  parseCodeModeStateMutations,
  restoreCodeModeState,
  type CodeModeStateEntry,
  type CodeModeStateMutation
} from '../../tools/code-mode/state.js';
import {
  contextGcBaseFromRecords,
  contextGcCheckpointIntervalEligible,
  latestValidContextGcCheckpoint,
  normalizeContextGcReplacements,
  sameContextGcBase,
  validateContextGcCheckpoint,
  type ContextGcCheckpointDraft,
  type ContextGcCheckpointPayload
} from '../context-gc-checkpoint.js';
import {
  bindToolResultResources,
  cleanupUnreferencedToolResources,
  completeToolResultResources,
  copyToolResultResources,
  readToolResultResource,
  toolResultResourceFiles,
  writeToolResultResource,
  type ToolResultResourceInput
} from '../tool-result-resources.js';
import {
  beginSessionStorageTransaction,
  isUnjournaledTransactionFile,
  recoverSessionStorageTransaction,
  type SessionStorageTransaction
} from '../transaction-recovery.js';
import type { SessionListInput, SessionSource, SessionTitleUpdateInput } from '../types.js';
import {
  extensionCheckpointFromPayload,
  indexExtensionCheckpoint,
  restoreExtensionCheckpoint,
  updateSessionCurrentState,
  type ExtensionCheckpointIndex,
  type SessionCurrentState
} from './current-state.js';
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  mergeSessionDerivedCache,
  normalizeSessionSource,
  persistSessionIndex,
  readSessionIndex,
  sessionListFilter,
  sessionMatchesFilter,
  sessionTreeIds
} from './directory-index.js';
import {
  deriveExecutionState,
  executionModelFromRecord,
  isCompactCheckpoint,
  isNativeUserTurn,
  sameResumeIndex,
  userMessagePreviewFromRecord
} from './execution-state.js';
import {
  forkedPayload,
  renameIfExists,
  restoreRenamedFiles,
  retainedSessionTitle,
  stageSessionSegments,
  stageUnreferencedImages
} from './history.js';
import {
  MAX_INPUT_IMAGES,
  copyGeneratedImages,
  generatedImageFileNames,
  inputImageReference,
  inputImageReferences,
  readInputImageBytes
} from './images.js';
import {
  persistResource,
  setResourceUrl,
  readResource,
  copyResources,
  resourceFiles,
  completeResources,
  recoverResources
} from './resources.js';
import {
  MAX_SEGMENT_BYTES,
  appendRecordBytes,
  readRecordPageFromTail,
  readRecords,
  readRecordsFromHead,
  readRecordsFromTail,
  repairSegmentTail,
  segmentNumberFromPath,
  type HistoryPagePositions
} from './records.js';
import type {
  RestoredSessionInputImage,
  SessionExecutionState,
  SessionIndex,
  SessionInputImage,
  SessionInputImageData,
  SessionInputImageMetadata,
  SessionMeta,
  SessionRecord
} from './types.js';

interface SessionWriterLease extends SessionCurrentState {
  owner: object | undefined;
  executing: boolean;
  retained: number;
  maintenance?: SessionStoreMaintenance;
  appendFailure?: { error: unknown };
  release: () => Promise<void>;
}

interface SharedStore {
  indexOperations: Promise<unknown>;
  writerLeases: Map<string, SessionWriterLease>;
  codeStateWrites: Map<string, Promise<unknown>>;
  recordWrites: Map<string, Promise<unknown>>;
  root: string;
  index: SessionIndex;
  pendingSessions: Map<string, SessionMeta>;
  references: number;
  closed: boolean;
  indexDirty: boolean;
  dirtySessionVersions: Map<string, number>;
  derivedOnlyDirtySessions: Set<string>;
  pendingPublishIds: Set<string>;
  segments: Map<string, number>;
  executionModelReads: Map<string, Promise<void>>;
  historyPagePositions: Map<string, HistoryPagePositions>;
}

const MAX_CONTEXTUAL_WORLD_STATE_BYTES = 8 * 1024 * 1024;

const CONTEXTUAL_WORLD_STATE_FILE = 'context-world-state.json';

/** SDK-owned JSONL history with per-HOME in-process sharing and cross-process file locks. */
export class JsonlSessionStore implements SessionStore {
  static readonly #instances = new Map<string, SharedStore>();
  static readonly #opening = new Map<string, Promise<SharedStore>>();
  readonly #shared: SharedStore;
  readonly #maintenance = new WeakMap<
    SessionStoreMaintenance,
    { sessionId: string; kind: 'clear' | 'delete' }
  >();
  #leaseClosed = false;
  private constructor(shared: SharedStore) {
    this.#shared = shared;
  }
  static async open(home: string) {
    const root = join(home, '.mar', 'agent');
    const existing = JsonlSessionStore.#instances.get(root);
    if (existing) {
      existing.references++;
      return new JsonlSessionStore(existing);
    }
    const pending = JsonlSessionStore.#opening.get(root);
    if (pending) {
      const shared = await pending;
      shared.references++;
      return new JsonlSessionStore(shared);
    }
    const opening = JsonlSessionStore.#openExclusive(root);
    JsonlSessionStore.#opening.set(root, opening);
    try {
      const shared = await opening;
      JsonlSessionStore.#instances.set(root, shared);
      return new JsonlSessionStore(shared);
    } finally {
      JsonlSessionStore.#opening.delete(root);
    }
  }
  /** Create a missing index only without Session directories; recover journals and marked creations. */
  static async #openExclusive(root: string) {
    const directory = join(root, 'sessions');
    const path = join(directory, 'index.json');
    await mkdir(directory, { recursive: true });
    const release = await acquireFileLock(join(directory, 'index.lock'));
    let index: SessionIndex;
    try {
      const disk = await readSessionIndex(path);
      if (disk) index = disk;
      else {
        const entries = await readdir(directory, { withFileTypes: true });
        if (entries.some((entry) => entry.isDirectory()))
          throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
        index = { version: 1, revision: 0, sessions: [] };
        await persistSessionIndex(path, index);
      }
    } finally {
      await release();
    }
    for (const session of index.sessions) {
      const directory = join(root, 'sessions', session.id);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (
        !names.includes('storage-transaction.json') &&
        !names.some(isUnjournaledTransactionFile) &&
        !names.some((name) =>
          /^context-world-state\.json\.\d+\.[0-9a-f-]+\.(?:rollback|clear)-backup$/u.test(name)
        )
      )
        continue;
      let releaseSession: () => Promise<void>;
      try {
        releaseSession = await acquireFileLock(
          join(directory, 'lock'),
          'Session already has a writer.',
          0
        );
      } catch (error) {
        if (error instanceof MarAgentError && error.code === 'MAR_AGENT_SESSION_LOCKED') continue;
        throw error;
      }
      try {
        // The index may have changed while waiting for the Session lock.
        const latest = await readSessionIndex(path);
        const current = latest?.sessions.find((item) => item.id === session.id);
        if (!current) continue;
        await recoverSessionStorageTransaction(directory, current.storageTransactionId);
        await recoverContextualWorldStateTransactions(root, current);
      } finally {
        await releaseSession();
      }
    }
    // A creation marker distinguishes our unpublished directories from unrelated files.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/iu.test(entry.name)) continue;
      const candidate = join(directory, entry.name);
      const marker = join(candidate, 'publication-pending');
      try {
        if (!(await lstat(marker)).isFile()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let releaseSession: () => Promise<void>;
      try {
        releaseSession = await acquireFileLock(
          join(candidate, 'lock'),
          'Session already has a writer.',
          0
        );
      } catch (error) {
        if (error instanceof MarAgentError && error.code === 'MAR_AGENT_SESSION_LOCKED') continue;
        throw error;
      }
      let unpublished = false;
      try {
        const latest = await readSessionIndex(path);
        if (!latest)
          throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
        unpublished = !latest.sessions.some((session) => session.id === entry.name);
        if (!unpublished) await rm(marker, { force: true });
      } finally {
        await releaseSession();
      }
      if (unpublished) await rm(candidate, { recursive: true, force: true });
    }
    return {
      root,
      index,
      indexOperations: Promise.resolve(),
      pendingSessions: new Map(),
      references: 1,
      closed: false,
      indexDirty: false,
      dirtySessionVersions: new Map<string, number>(),
      derivedOnlyDirtySessions: new Set<string>(),
      pendingPublishIds: new Set<string>(),
      codeStateWrites: new Map(),
      recordWrites: new Map(),
      writerLeases: new Map(),
      segments: new Map(),
      executionModelReads: new Map(),
      historyPagePositions: new Map()
    };
  }
  /** Merge dirty metadata with disk membership; only createdIds publish locally new entries. */
  async #saveIndex(deletedIds?: string | readonly string[], createdIds: readonly string[] = []) {
    return this.#serializeIndexOperation(() => this.#commitIndex(deletedIds, createdIds));
  }
  async #serializeIndexOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#shared.indexOperations.then(operation, operation);
    this.#shared.indexOperations = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
  async #commitIndex(deletedIds?: string | readonly string[], createdIds: readonly string[] = []) {
    const release = await acquireFileLock(join(this.#shared.root, 'sessions', 'index.lock'));
    const path = join(this.#shared.root, 'sessions', 'index.json');
    try {
      const disk = await readSessionIndex(path);
      if (!disk) throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
      const dirty = new Map(this.#shared.dirtySessionVersions);
      const derivedOnly = new Set(this.#shared.derivedOnlyDirtySessions);
      const sessions = new Map(disk.sessions.map((session) => [session.id, session]));
      const created = new Set(createdIds);
      for (const session of this.#shared.index.sessions) {
        const current = sessions.get(session.id);
        // Disk membership is authoritative: a stale in-memory snapshot cannot revive a deletion.
        if (created.has(session.id) || (current && dirty.has(session.id)))
          sessions.set(
            session.id,
            current && derivedOnly.has(session.id)
              ? mergeSessionDerivedCache(current, session)
              : structuredClone(session)
          );
      }
      for (const deletedId of typeof deletedIds === 'string' ? [deletedIds] : (deletedIds ?? []))
        sessions.delete(deletedId);
      const updated: SessionIndex = {
        version: 1,
        revision:
          createdIds.length > 0 ||
          deletedIds !== undefined ||
          [...dirty.keys()].some((id) => !derivedOnly.has(id))
            ? Math.max(disk.revision, this.#shared.index.revision) + 1
            : disk.revision,
        sessions: [...sessions.values()]
      };
      await persistSessionIndex(path, updated);
      for (const [id, version] of dirty) {
        // A different creation still needs its own index transaction to publish its directory.
        if (this.#shared.pendingPublishIds.has(id) && !created.has(id)) continue;
        if (this.#shared.dirtySessionVersions.get(id) === version) {
          this.#shared.dirtySessionVersions.delete(id);
          this.#shared.derivedOnlyDirtySessions.delete(id);
        }
      }
      for (const id of created) this.#shared.pendingPublishIds.delete(id);
      const pending = this.#shared.index.sessions.filter(
        (session) =>
          this.#shared.dirtySessionVersions.has(session.id) &&
          (sessions.has(session.id) || this.#shared.pendingPublishIds.has(session.id))
      );
      const replacements = new Map(pending.map((session) => [session.id, session]));
      const published = new Set(updated.sessions.map((session) => session.id));
      this.#shared.index = {
        ...updated,
        sessions: [
          ...updated.sessions.map((session) => replacements.get(session.id) ?? session),
          ...pending.filter((session) => !published.has(session.id))
        ]
      };
      this.#shared.indexDirty = this.#shared.dirtySessionVersions.size > 0;
    } finally {
      await release();
    }
  }
  async #refreshIndex() {
    return this.#serializeIndexOperation(() => this.#readCurrentIndex());
  }
  async #readCurrentIndex() {
    const disk = await readSessionIndex(join(this.#shared.root, 'sessions', 'index.json'));
    if (!disk) throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
    // A local unflushed revision may exceed another writer's committed revision.
    // Always refresh membership from disk, then overlay only our pending changes.
    const local = new Map(this.#shared.index.sessions.map((session) => [session.id, session]));
    const published = new Set(disk.sessions.map((session) => session.id));
    this.#shared.index = {
      ...disk,
      revision:
        this.#shared.indexDirty || this.#shared.pendingPublishIds.size > 0
          ? Math.max(disk.revision, this.#shared.index.revision)
          : disk.revision,
      sessions: disk.sessions
        .map((session) => {
          const current = local.get(session.id);
          if (!current || !this.#shared.dirtySessionVersions.has(session.id)) return session;
          return this.#shared.derivedOnlyDirtySessions.has(session.id)
            ? mergeSessionDerivedCache(session, current)
            : current;
        })
        .concat(
          this.#shared.index.sessions.filter(
            (session) =>
              this.#shared.pendingPublishIds.has(session.id) && !published.has(session.id)
          )
        )
    };
  }
  /** Hold the new Session lock and mark its directory until JSONL and index publication finish. */
  async #beginUnpublishedSession(sessionId: string) {
    const directory = join(this.#shared.root, 'sessions', sessionId);
    await mkdir(directory);
    const release = await acquireFileLock(
      join(directory, 'lock'),
      'Session already has a writer.',
      0
    );
    try {
      await writeFile(join(directory, 'publication-pending'), '1', {
        mode: 0o600,
        flag: 'wx',
        flush: true
      });
    } catch (error) {
      await release();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { directory, release };
  }
  async createSession(input: { title?: string; workspace: string; source?: SessionSource }) {
    this.#assertOpen();
    const source = normalizeSessionSource(input.source);
    if (source.type !== 'subagent') return this.#createSession(input, source);
    // Publish under the parent's existing serial domain so tree admission cannot miss a child.
    return this.#serializeRecordOperation(source.parentSessionId, async () => {
      this.#assertOpen();
      if (this.#shared.writerLeases.get(source.parentSessionId)?.maintenance)
        throw new MarAgentError('MAR_AGENT_SESSION_LOCKED', 'Session is under maintenance.');
      await this.getSession(source.parentSessionId);
      return this.#createSession(input, source);
    });
  }
  /** Append the durable creation record before making this Session visible in the index. */
  async #createSession(input: Parameters<SessionStore['createSession']>[0], source: SessionSource) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      title: input.title ?? 'New session',
      workspace: input.workspace,
      createdAt: now,
      lastActivityAt: now,
      source,
      nextSequence: 1,
      automaticTitlePending: input.title === undefined,
      resume: {
        version: 1,
        userTurns: 0,
        todoRevision: 0,
        executionModelIndexed: true,
        firstUserMessageIndexed: true
      },
      segments: []
    };
    const publication = await this.#beginUnpublishedSession(id);
    this.#shared.segments.set(id, 1);
    this.#shared.pendingSessions.set(id, meta);
    let discard = false;
    try {
      try {
        await this.append(id, {
          type: 'session.created',
          payload: {
            title: meta.title,
            workspace: meta.workspace,
            automaticTitle: input.title === undefined,
            source: meta.source
          }
        });
      } catch (error) {
        this.#shared.pendingSessions.delete(id);
        this.#shared.segments.delete(id);
        discard = true;
        throw error;
      }
      this.#shared.pendingSessions.delete(id);
      this.#shared.index.sessions.unshift(meta);
      this.#shared.pendingPublishIds.add(id);
      this.#markIndexDirty(id);
      try {
        await this.#saveIndex(undefined, [id]);
      } catch (error) {
        // A failed lock release can follow a committed index rename; do not unpublish that Session.
        // If the index cannot be read, leave the disk marker for recovery and keep the original error.
        const disk = await readSessionIndex(
          join(this.#shared.root, 'sessions', 'index.json')
        ).catch(() => undefined);
        if (disk?.sessions.some((session) => session.id === id)) {
          this.#shared.pendingPublishIds.delete(id);
          this.#shared.dirtySessionVersions.delete(id);
          this.#shared.indexDirty = this.#shared.dirtySessionVersions.size > 0;
        } else {
          // Keep the marker until disk membership can be checked during recovery.
          this.#shared.index.sessions = this.#shared.index.sessions.filter(
            (item) => item.id !== id
          );
          this.#shared.segments.delete(id);
          this.#shared.pendingPublishIds.delete(id);
          this.#shared.dirtySessionVersions.delete(id);
          this.#shared.indexDirty = this.#shared.dirtySessionVersions.size > 0;
          throw error;
        }
      }
      await rm(join(publication.directory, 'publication-pending'), { force: true });
      return meta;
    } finally {
      try {
        await publication.release();
      } finally {
        if (discard) await rm(publication.directory, { recursive: true, force: true });
      }
    }
  }
  #sessionDirectory(sessionId: string): string {
    this.#assertOpen();
    if (
      !this.#shared.index.sessions.some((session) => session.id === sessionId) &&
      !this.#shared.pendingSessions.has(sessionId)
    )
      throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return join(this.#shared.root, 'sessions', sessionId);
  }
  async readContextualWorldState(sessionId: string): Promise<unknown | undefined> {
    const path = join(this.#sessionDirectory(sessionId), CONTEXTUAL_WORLD_STATE_FILE);
    try {
      const pathInfo = await lstat(path);
      if (!pathInfo.isFile()) return undefined;
      const file = await open(path, 'r');
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_CONTEXTUAL_WORLD_STATE_BYTES) return undefined;
        const envelope = JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
        const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
        if (
          envelope.version !== 1 ||
          !Number.isSafeInteger(envelope.historySequence) ||
          (envelope.historySequence as number) < 1 ||
          meta === undefined ||
          (envelope.historySequence as number) >= meta.nextSequence
        )
          return undefined;
        return envelope.state;
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    }
  }
  async writeContextualWorldState(sessionId: string, state: unknown): Promise<void> {
    const directory = this.#sessionDirectory(sessionId);
    const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
    if (!meta) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    const path = join(directory, CONTEXTUAL_WORLD_STATE_FILE);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify({
      version: 1,
      historySequence: meta.nextSequence - 1,
      state
    });
    if (Buffer.byteLength(serialized) > MAX_CONTEXTUAL_WORLD_STATE_BYTES)
      throw new MarAgentError(
        'MAR_AGENT_HOST_LIMIT_EXCEEDED',
        'Contextual world state exceeds the storage limit.'
      );
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  /** Mark each image pending before publication; turn.user or lease recovery resolves ownership. */
  async persistInputImages(
    sessionId: string,
    images: readonly SessionInputImage[]
  ): Promise<SessionInputImageMetadata[]> {
    this.#assertOpen();
    if (images.length === 0) return [];
    if (images.length > MAX_INPUT_IMAGES)
      throw new MarAgentError(
        'MAR_AGENT_HOST_LIMIT_EXCEEDED',
        'Too many image inputs were provided.'
      );
    const resources: SessionInputImageMetadata[] = [];
    let total = 0;
    for (const image of images) {
      if (
        (image.url !== undefined && !isModelImageUrl(image.url)) ||
        (image.urlExpiresAt !== undefined &&
          (!Number.isSafeInteger(image.urlExpiresAt) ||
            image.urlExpiresAt <= 0 ||
            image.url === undefined))
      )
        throw new MarAgentError('MAR_AGENT_SESSION_INPUT_INVALID', 'Image model URL is invalid.');
      let resource = await this.persistResource(sessionId, image);
      if (image.url !== undefined && image.urlExpiresAt !== undefined)
        resource = await this.setResourceUrl(sessionId, resource.resourceId, {
          url: image.url,
          urlExpiresAt: image.urlExpiresAt
        });
      total += resource.byteSize;
      if (resource.byteSize > 5 * 1024 * 1024 || total > 10 * 1024 * 1024)
        throw new MarAgentError(
          'MAR_AGENT_HOST_LIMIT_EXCEEDED',
          'Image input exceeds the supported size limit.'
        );
      resources.push({
        ...resource,
        resourceInputVersion: 1,
        name: image.name,
        fileName: `${resource.resourceId}.bin`
      });
    }
    return resources;
  }
  async persistResource(sessionId: string, image: import('../../model/image.js').ModelImage) {
    this.#assertOpen();
    return this.#serializeRecordOperation(sessionId, () =>
      persistResource(join(this.#sessionDirectory(sessionId), 'resources'), image)
    );
  }
  async setResourceUrl(
    sessionId: string,
    resourceId: string,
    published: { url: string; urlExpiresAt: number }
  ) {
    this.#assertOpen();
    return this.#serializeRecordOperation(sessionId, () =>
      setResourceUrl(join(this.#sessionDirectory(sessionId), 'resources'), resourceId, published)
    );
  }
  async readResource(sessionId: string, resourceId: string) {
    this.#assertOpen();
    const directory = join(this.#sessionDirectory(sessionId), 'resources');
    if (!/^[a-f0-9]{64}$/u.test(resourceId)) return undefined;
    return this.#serializeRecordOperation(sessionId, async () => {
      try {
        await lstat(join(directory, `.${resourceId}.pending`));
        if (
          this.#shared.writerLeases.get(sessionId)?.appendFailure !== undefined ||
          !resourceFiles(await this.#readRecords(sessionId)).has(`${resourceId}.bin`)
        )
          return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return readResource(directory, resourceId);
    });
  }
  async writeToolResultResource(sessionId: string, text: string) {
    this.#assertOpen();
    if (!this.#shared.index.sessions.some((item) => item.id === sessionId))
      throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return writeToolResultResource(this.#sessionDirectory(sessionId), text);
  }

  async readToolResultResource(sessionId: string, input: ToolResultResourceInput) {
    this.#assertOpen();
    await this.#refreshIndex();
    if (!this.#shared.index.sessions.some((item) => item.id === sessionId))
      throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return readToolResultResource(
      this.#sessionDirectory(sessionId),
      sessionId,
      input,
      async (sequence) => {
        await this.#refreshIndex();
        return (
          await this.readPage(sessionId, { beforeSequence: sequence + 1, limit: 1 })
        ).records.find((record) => record.sequence === sequence);
      }
    );
  }

  async readInputImages(sessionId: string, value: unknown): Promise<RestoredSessionInputImage[]> {
    this.#assertOpen();
    const references = inputImageReferences(
      Array.isArray(value) ? value.filter((item) => item?.resourceInputVersion === 1) : undefined
    );
    if (references.length === 0) return [];
    const images: RestoredSessionInputImage[] = [];
    for (const reference of references) {
      if (reference.resourceId === undefined)
        throw new MarAgentError(
          'MAR_AGENT_SESSION_CORRUPT',
          'Session resource identity is missing.'
        );
      images.push({
        resourceInputVersion: 1,
        mimeType: reference.mimeType,
        byteSize: reference.byteSize,
        resourceId: reference.resourceId,
        ...(reference.url === undefined ? {} : { url: reference.url }),
        ...(reference.urlExpiresAt === undefined ? {} : { urlExpiresAt: reference.urlExpiresAt })
      });
    }
    return images;
  }
  async readInputImage(
    sessionId: string,
    input: { readonly sequence: number; readonly imageIndex: number }
  ): Promise<SessionInputImageData | undefined> {
    this.#assertOpen();
    if (
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 1 ||
      input.sequence >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(input.imageIndex) ||
      input.imageIndex < 0
    )
      return undefined;
    const page = await this.readPage(sessionId, {
      limit: 1,
      beforeSequence: input.sequence + 1
    });
    const record = page.records[0];
    if (
      record?.sequence !== input.sequence ||
      record.type !== 'turn.user' ||
      !isObject(record.payload)
    )
      return undefined;
    if (!Array.isArray(record.payload.images) || input.imageIndex >= record.payload.images.length)
      return undefined;
    if (record.payload.images[input.imageIndex]?.resourceInputVersion !== 1) return undefined;
    const reference = inputImageReference(record.payload.images[input.imageIndex]);
    if (reference === undefined) return undefined;
    if (reference.resourceId === undefined)
      throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session resource identity is missing.');
    const data = await readInputImageBytes(
      join(this.#sessionDirectory(sessionId), 'resources'),
      reference
    );
    return {
      name: reference.name,
      mimeType: reference.mimeType,
      byteSize: reference.byteSize,
      fileName: reference.fileName,
      sha256: reference.sha256,
      dataBase64: data.toString('base64')
    };
  }
  async forkSession(
    sourceSessionId: string,
    input: { readonly boundaryTurnId: string | null; readonly title: string }
  ) {
    this.#assertOpen();
    const release = await this.acquireSessionLease(sourceSessionId);
    try {
      const source = this.#shared.index.sessions.find((item) => item.id === sourceSessionId);
      if (!source) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      const records = await this.read(sourceSessionId);
      const boundaryIndex =
        input.boundaryTurnId === null
          ? -1
          : records.findLastIndex((record) => record.turnId === input.boundaryTurnId);
      if (input.boundaryTurnId !== null && boundaryIndex < 0)
        throw new MarAgentError(
          'MAR_AGENT_REWIND_TARGET_INVALID',
          'Session rewind target was not found.'
        );
      const createdAt = new Date().toISOString();
      const target: SessionMeta = {
        id: randomUUID(),
        title: input.title,
        workspace: source.workspace,
        createdAt,
        lastActivityAt: createdAt,
        source: { type: 'user' },
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
      const publication = await this.#beginUnpublishedSession(target.id);
      this.#shared.segments.set(target.id, 1);
      this.#shared.pendingSessions.set(target.id, target);
      let discard = false;
      try {
        const copied: SessionRecord[] = [
          {
            schemaVersion: 1,
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
            schemaVersion: 1,
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
        const staged = await stageSessionSegments(
          this.#sessionDirectory(target.id),
          copied,
          'fork'
        );
        for (const file of staged.files) await rename(file.temporaryPath, file.path);
        target.segments = staged.segments;
        target.nextSequence = copied.length + 1;
        this.#shared.segments.set(target.id, staged.segments.length);
        for (const record of copied) this.#applyRecordToResumeIndex(target, record);
        await copyToolResultResources(
          this.#sessionDirectory(sourceSessionId),
          this.#sessionDirectory(target.id),
          copied
        );
        await copyGeneratedImages(
          this.#sessionDirectory(sourceSessionId),
          this.#sessionDirectory(target.id),
          generatedImageFileNames(retained)
        );
        await copyResources(
          this.#sessionDirectory(sourceSessionId),
          this.#sessionDirectory(target.id),
          retained
        );
        target.lastActivityAt = target.createdAt;
        this.#shared.pendingSessions.delete(target.id);
        this.#shared.index = {
          version: 1,
          revision: this.#shared.index.revision + 1,
          sessions: [target, ...this.#shared.index.sessions]
        };
        this.#shared.pendingPublishIds.add(target.id);
        this.#markIndexDirty(target.id);
        await this.#saveIndex(undefined, [target.id]);
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
        this.#shared.pendingSessions.delete(target.id);
        const disk = await readSessionIndex(join(this.#shared.root, 'sessions', 'index.json'));
        if (disk?.sessions.some((session) => session.id === target.id))
          return {
            id: target.id,
            title: target.title,
            workspace: target.workspace,
            createdAt: target.createdAt,
            lastActivityAt: target.createdAt,
            source: target.source
          };
        const publishedIndex = this.#shared.index.sessions.findIndex(
          (item) => item.id === target.id
        );
        if (publishedIndex >= 0) {
          this.#shared.index.sessions.splice(publishedIndex, 1);
          this.#shared.index.revision++;
          this.#shared.pendingPublishIds.delete(target.id);
          this.#shared.dirtySessionVersions.delete(target.id);
          this.#shared.indexDirty = this.#shared.dirtySessionVersions.size > 0;
        }
        this.#shared.segments.delete(target.id);
        discard = true;
        throw error;
      } finally {
        try {
          await publication.release();
        } finally {
          if (discard) await rm(publication.directory, { recursive: true, force: true });
        }
      }
    } finally {
      await release();
    }
  }
  /** Replace history under a journal; the indexed transaction ID decides the commit side. */
  async rollbackSession(sessionId: string, input: { readonly boundaryTurnId: string | null }) {
    this.#assertOpen();
    const release = await this.acquireSessionLease(sessionId);
    try {
      const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
      if (!meta) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      const records = await this.read(sessionId);
      if (records[0]?.type !== 'session.created')
        throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
      const boundaryIndex =
        input.boundaryTurnId === null
          ? 0
          : records.findLastIndex((record) => record.turnId === input.boundaryTurnId);
      if (input.boundaryTurnId !== null && boundaryIndex < 0)
        throw new MarAgentError(
          'MAR_AGENT_ROLLBACK_TARGET_INVALID',
          'Session rollback target was not found.'
        );
      const retained = records
        .slice(0, boundaryIndex + 1)
        .filter((record) => record.type !== 'responses.continuation');
      return await this.#replaceHistory(meta, retained, { kind: 'rollback' });
    } finally {
      await release();
    }
  }
  async updateTitle(
    sessionId: string,
    title: string,
    input: SessionTitleUpdateInput = {},
    owner?: object
  ) {
    this.#assertOpen();
    const normalized = title.trim();
    if (!normalized)
      throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session title is required.');
    const release = await this.acquireSessionLease(sessionId, owner);
    try {
      const meta = this.#shared.index.sessions.find((item) => item.id === sessionId)!;
      if (input.expectedTitle !== undefined && meta.title !== input.expectedTitle) return false;
      if (input.automatic || input.executionId !== undefined) {
        const records = await this.read(sessionId);
        const latestTitle = records.findLast((record) => record.type === 'session.title.updated');
        if (
          input.automatic &&
          ((records[0]?.payload as { automaticTitle?: boolean })?.automaticTitle !== true ||
            (latestTitle?.payload as { automatic?: boolean })?.automatic === false)
        )
          return false;
        if (
          input.executionId !== undefined &&
          records.findLast((record) => record.type === 'turn.user')?.executionId !==
            input.executionId
        )
          return false;
      }
      await this.append(sessionId, {
        type: 'session.title.updated',
        payload: { title: normalized, automatic: input.automatic === true },
        ...(input.executionId ? { executionId: input.executionId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {})
      });
      return true;
    } finally {
      await release();
    }
  }
  /** Reset history with the same recovery journal while preserving the Session identity. */
  async clearSession(sessionId: string, maintenance?: SessionStoreMaintenance) {
    this.#assertOpen();
    const holding = maintenance ?? (await this.acquireSessionMaintenance(sessionId, 'clear'));
    this.#assertMaintenance(sessionId, 'clear', holding);
    let failed = false;
    try {
      const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
      if (!meta) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      const records = await this.read(sessionId);
      if (records[0]?.type !== 'session.created')
        throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
      const clearedAt = new Date().toISOString();
      const retained: SessionRecord[] = [
        {
          schemaVersion: 1,
          recordId: randomUUID(),
          sequence: 1,
          timestamp: meta.createdAt,
          sessionId,
          type: 'session.created',
          payload: {
            title: meta.title,
            workspace: meta.workspace,
            automaticTitle: meta.automaticTitlePending === true,
            source: normalizeSessionSource(meta.source)
          }
        }
      ];
      return await this.#replaceHistory(meta, retained, { kind: 'clear', clearedAt });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (!maintenance) {
        const releasing = holding.release();
        if (failed) await releasing.catch(() => undefined);
        else await releasing;
      }
    }
  }
  /** Called only while rollback or clear holds the maintenance lease. */
  async #replaceHistory(
    meta: SessionMeta,
    retained: readonly SessionRecord[],
    operation: { kind: 'rollback' } | { kind: 'clear'; clearedAt: string }
  ) {
    const sessionId = meta.id;
    const staged = await stageSessionSegments(this.#sessionDirectory(sessionId), retained);
    const transactionId = randomUUID();
    const targetNextSequence =
      operation.kind === 'clear' ? 2 : (retained.at(-1)?.sequence ?? 0) + 1;
    const contextualWorldStatePath = join(
      this.#sessionDirectory(sessionId),
      CONTEXTUAL_WORLD_STATE_FILE
    );
    const contextualWorldStateBackup = `${contextualWorldStatePath}.${targetNextSequence}.${transactionId}.${operation.kind}-backup`;
    let contextualWorldStateStaged = false;
    let generatedTrash: Array<{ from: string; to: string; trash: string }> = [];
    let resourceTrash: Array<{ from: string; to: string; trash: string }> = [];
    const originalMeta = structuredClone(meta);
    const originalIndexRevision = this.#shared.index.revision;
    const originalSegment = this.#shared.segments.get(sessionId);
    const originalPaths = await this.#segmentPaths(sessionId);
    const backups = originalPaths.map((path) => ({
      path,
      backup: `${path}.${transactionId}.${operation.kind}-backup`
    }));
    const transaction: SessionStorageTransaction = {
      version: 1,
      id: transactionId,
      kind: operation.kind,
      originalSegments: originalPaths.map((path) => basename(path)),
      stagedSegments: staged.files.map((item) => ({
        path: basename(item.path),
        temporary: basename(item.temporaryPath)
      })),
      sidecarBackup: basename(contextualWorldStateBackup)
    };
    const installedPaths: string[] = [];
    let committed = false;
    try {
      await beginSessionStorageTransaction(this.#sessionDirectory(sessionId), transaction);
      contextualWorldStateStaged = await renameIfExists(
        contextualWorldStatePath,
        contextualWorldStateBackup
      );
      generatedTrash = await stageUnreferencedImages(
        this.#sessionDirectory(sessionId),
        'generated_images',
        operation.kind === 'rollback' ? new Set(generatedImageFileNames(retained)) : new Set(),
        transactionId
      );
      resourceTrash.push(
        ...(await stageUnreferencedImages(
          this.#sessionDirectory(sessionId),
          'resources',
          operation.kind === 'rollback' ? resourceFiles(retained) : new Set(),
          transactionId
        )),
        ...(await stageUnreferencedImages(
          this.#sessionDirectory(sessionId),
          'tool_results',
          operation.kind === 'rollback' ? toolResultResourceFiles(retained) : new Set(),
          transactionId
        ))
      );
      for (const item of backups) await rename(item.path, item.backup);
      for (const item of staged.files) {
        await rename(item.temporaryPath, item.path);
        installedPaths.push(item.path);
      }
      if (operation.kind === 'rollback') {
        const state = deriveExecutionState(retained);
        const completedAt = new Date().toISOString();
        meta.title = retainedSessionTitle(retained, meta.title);
        meta.lastActivityAt = completedAt;
        meta.nextSequence = targetNextSequence;
        meta.storageTransactionId = transactionId;
        meta.automaticTitlePending = state.automaticTitlePending;
        meta.resume = state.resume;
      } else {
        meta.lastActivityAt = operation.clearedAt;
        meta.nextSequence = targetNextSequence;
        meta.storageTransactionId = transactionId;
        meta.resume = { version: 1, userTurns: 0, todoRevision: 0, firstUserMessageIndexed: true };
      }
      meta.segments = staged.segments;
      this.#shared.segments.set(
        sessionId,
        operation.kind === 'clear' ? 1 : (staged.segments.at(-1)?.number ?? 1)
      );
      this.#shared.index.revision++;
      this.#markIndexDirty(sessionId);
      await this.#saveIndex();
      committed = true;
      await recoverSessionStorageTransaction(this.#sessionDirectory(sessionId), transactionId);
      return {
        id: meta.id,
        title: meta.title,
        workspace: meta.workspace,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        source: normalizeSessionSource(meta.source)
      };
    } catch (error) {
      if (!committed) {
        committed = await this.#storageTransactionCommitted(sessionId, transactionId);
        if (committed) {
          this.#shared.dirtySessionVersions.delete(sessionId);
          this.#shared.indexDirty = this.#shared.dirtySessionVersions.size > 0;
          await recoverSessionStorageTransaction(this.#sessionDirectory(sessionId), transactionId);
        }
      }
      if (!committed) {
        await Promise.all(installedPaths.map((path) => rm(path, { force: true }))).catch(
          () => undefined
        );
        await restoreRenamedFiles(backups.map((item) => ({ from: item.backup, to: item.path })));
        if (contextualWorldStateStaged)
          await restoreRenamedFiles([
            { from: contextualWorldStateBackup, to: contextualWorldStatePath }
          ]);
        await restoreRenamedFiles([...generatedTrash, ...resourceTrash]);
        restoreSessionMeta(meta, originalMeta);
        this.#shared.index.revision = originalIndexRevision;
        if (originalSegment === undefined) this.#shared.segments.delete(sessionId);
        else this.#shared.segments.set(sessionId, originalSegment);
        this.#markIndexDirty(sessionId);
        await recoverSessionStorageTransaction(
          this.#sessionDirectory(sessionId),
          originalMeta.storageTransactionId
        );
      }
      throw error;
    } finally {
      await Promise.all(staged.files.map((item) => rm(item.temporaryPath, { force: true }))).catch(
        () => undefined
      );
    }
  }
  async getSession(sessionId: string) {
    this.#assertOpen();
    await this.#refreshIndex();
    const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
    if (!meta) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return {
      id: meta.id,
      title: meta.title,
      workspace: meta.workspace,
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      source: normalizeSessionSource(meta.source),
      automaticTitlePending: meta.automaticTitlePending === true
    };
  }
  /** Serialize physical writes and honor cancellation before entering the writer. */
  async append(
    sessionId: string,
    input: SessionRecordInput,
    options: { readonly signal?: AbortSignal } = {}
  ) {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    return this.#serializeRecordOperation(sessionId, () => {
      options.signal?.throwIfAborted();
      return this.#appendRecord(sessionId, input);
    });
  }
  async #serializeRecordOperation<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.#shared.recordWrites.get(sessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(action);
    this.#shared.recordWrites.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.#shared.recordWrites.get(sessionId) === operation)
        this.#shared.recordWrites.delete(sessionId);
    }
  }
  async #appendRecord(sessionId: string, input: SessionRecordInput) {
    this.#assertOpen();
    const writer = this.#shared.writerLeases.get(sessionId);
    if (writer?.appendFailure) throw writer.appendFailure.error;
    const before =
      this.#shared.index.sessions.find((item) => item.id === sessionId) ??
      this.#shared.pendingSessions.get(sessionId);
    if (!before) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    const published = !this.#shared.pendingSessions.has(sessionId);
    const record: SessionRecord = {
      schemaVersion: 1,
      recordId: randomUUID(),
      sequence: before.nextSequence,
      timestamp: input.timestamp ?? new Date().toISOString(),
      sessionId,
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      type: input.type,
      payload: input.payload
    };
    JSON.stringify(record); // Reject malformed payloads before binding resources.
    await bindToolResultResources(
      this.#sessionDirectory(sessionId),
      record,
      (sequence) => this.#readRecordAtSequence(before, sequence),
      true
    );
    const serialized = `${JSON.stringify(record)}\n`;
    let segment = await this.#currentSegment(sessionId);
    let path = this.#segmentPath(sessionId, segment);
    try {
      const current = await stat(path);
      if (current.size > 0 && current.size + Buffer.byteLength(serialized) > MAX_SEGMENT_BYTES) {
        segment += 1;
        this.#shared.segments.set(sessionId, segment);
        path = this.#segmentPath(sessionId, segment);
      }
    } catch {
      // The first append creates the first segment.
    }
    try {
      await appendRecordBytes(path, serialized, (error) => {
        if (writer) writer.appendFailure = { error };
      });
    } catch (error) {
      // A failed write/sync/close can leave a complete record on disk.
      const current = this.#shared.index.sessions.find((item) => item.id === sessionId) ?? before;
      if (current.resume?.userTurns !== undefined) {
        delete current.resume.userTurns;
        if (published) this.#markIndexDirty(sessionId);
      }
      const lease = this.#shared.writerLeases.get(sessionId);
      if (lease) {
        delete lease.codeState;
        delete lease.extensionCheckpoints;
      }
      throw error;
    }
    // Index refreshes and commits can replace metadata during file I/O. Publish all
    // durable-record metadata onto the current entry without another await boundary.
    const meta =
      this.#shared.index.sessions.find((item) => item.id === sessionId) ??
      this.#shared.pendingSessions.get(sessionId);
    if (!meta) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    meta.nextSequence = record.sequence + 1;
    const segmentMetadata = meta.segments ?? (meta.segments = []);
    const known = segmentMetadata.find((item) => item.number === segment);
    if (known) {
      known.lastSequence = record.sequence;
      known.bytes += Buffer.byteLength(serialized);
    } else
      segmentMetadata.push({
        number: segment,
        firstSequence: record.sequence,
        lastSequence: record.sequence,
        bytes: Buffer.byteLength(serialized)
      });
    meta.lastActivityAt = record.timestamp;
    this.#applyRecordToResumeIndex(meta, record);
    if (published) {
      this.#shared.index.revision++;
      this.#markIndexDirty(sessionId);
    }
    updateSessionCurrentState(this.#shared.writerLeases.get(sessionId), record.type, serialized);
    await completeToolResultResources(this.#sessionDirectory(sessionId), record);
    await completeResources(join(this.#sessionDirectory(sessionId), 'resources'), record);
    return record;
  }
  async read(sessionId: string): Promise<SessionRecord[]> {
    return this.#serializeRecordOperation(sessionId, () => this.#readRecords(sessionId));
  }
  async #readRecords(sessionId: string): Promise<SessionRecord[]> {
    this.#assertOpen();
    try {
      const records: SessionRecord[] = [];
      for (const path of await this.#segmentPaths(sessionId))
        records.push(...(await readRecords(path)));
      return records;
    } catch (cause) {
      if (cause instanceof MarAgentError) throw cause;
      throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.', { cause });
    }
  }
  async readCodeModeState(sessionId: string): Promise<CodeModeStateEntry[]> {
    return this.#serializeRecordOperation(sessionId, () => this.#readCodeModeState(sessionId));
  }
  async #readCodeModeState(sessionId: string): Promise<CodeModeStateEntry[]> {
    this.#assertOpen();
    const lease = this.#shared.writerLeases.get(sessionId);
    if (lease?.owner === undefined) return restoreCodeModeState(await this.#readRecords(sessionId));
    lease.codeState ??= restoreCodeModeState(await this.#readRecords(sessionId));
    return applyCodeModeStateMutations(lease.codeState, []);
  }
  async readExtensionCheckpoint(
    sessionId: string,
    extensionId: string,
    key: string
  ): Promise<CoreCheckpoint> {
    return this.#serializeRecordOperation(sessionId, () =>
      this.#readExtensionCheckpoint(sessionId, extensionId, key)
    );
  }
  async #readExtensionCheckpoint(
    sessionId: string,
    extensionId: string,
    key: string
  ): Promise<CoreCheckpoint> {
    this.#assertOpen();
    const lease = this.#shared.writerLeases.get(sessionId);
    if (lease?.owner === undefined)
      return restoreExtensionCheckpoint(await this.#readRecords(sessionId), extensionId, key);
    if (!lease.extensionCheckpoints) {
      const index: ExtensionCheckpointIndex = new Map();
      for (const record of await this.#readRecords(sessionId))
        if (record.type === 'extension.checkpoint.updated')
          indexExtensionCheckpoint(index, record.payload);
      lease.extensionCheckpoints = index;
    }
    return extensionCheckpointFromPayload(lease.extensionCheckpoints.get(extensionId)?.get(key));
  }
  async writeExtensionCheckpoint(
    sessionId: string,
    extensionId: string,
    key: string,
    value: CoreJsonValue | undefined,
    expectedRevision: number | undefined,
    input: { owner: object; signal: AbortSignal; executionId?: string; turnId?: string }
  ): Promise<CoreCheckpoint> {
    if (
      typeof key !== 'string' ||
      (expectedRevision !== undefined &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
    )
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_DATA_INVALID',
        'Checkpoint key or expected revision is invalid.'
      );
    const copied = value === undefined ? undefined : cloneCoreJson(value);
    input.signal.throwIfAborted();
    const release = await this.acquireSessionWriteLease(sessionId, input.owner);
    try {
      return await this.#serializeRecordOperation(sessionId, async () => {
        const current = await this.#readExtensionCheckpoint(sessionId, extensionId, key);
        if (expectedRevision !== undefined && expectedRevision !== current.revision)
          throw new MarAgentError(
            'MAR_AGENT_EXTENSION_DATA_CONFLICT',
            'Checkpoint revision changed before commit.'
          );
        input.signal.throwIfAborted();
        const revision = current.revision + 1;
        await this.#appendRecord(sessionId, {
          type: 'extension.checkpoint.updated',
          payload: {
            extensionId,
            key,
            revision,
            ...(copied === undefined ? { deleted: true } : { value: copied })
          },
          ...(input.executionId ? { executionId: input.executionId } : {}),
          ...(input.turnId ? { turnId: input.turnId } : {})
        });
        return { revision, ...(copied === undefined ? {} : { value: cloneCoreJson(copied) }) };
      });
    } finally {
      await release();
    }
  }
  async commitCodeModeState(
    sessionId: string,
    mutations: unknown,
    input: {
      readonly executionId: string;
      readonly turnId: string;
      readonly expectedState?: readonly CodeModeStateEntry[];
    }
  ): Promise<CodeModeStateEntry[]> {
    const operation = (this.#shared.codeStateWrites.get(sessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const parsed: CodeModeStateMutation[] = parseCodeModeStateMutations(mutations);
        if (parsed.length === 0) return this.readCodeModeState(sessionId);
        const current = await this.readCodeModeState(sessionId);
        if (input.expectedState && !isDeepStrictEqual(current, input.expectedState))
          throw new MarAgentError(
            'MAR_AGENT_CODE_STATE_CONFLICT',
            'Session state changed while this cell was running.'
          );
        const state = applyCodeModeStateMutations(current, parsed);
        await this.append(sessionId, {
          type: 'code.state.updated',
          payload: { mutations: parsed },
          executionId: input.executionId,
          turnId: input.turnId
        });
        return state;
      });
    this.#shared.codeStateWrites.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.#shared.codeStateWrites.get(sessionId) === operation)
        this.#shared.codeStateWrites.delete(sessionId);
    }
  }
  async readExecutionState(sessionId: string): Promise<SessionExecutionState> {
    this.#assertOpen();
    const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
    if (!meta) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    if (
      meta.resume?.version !== 1 ||
      typeof meta.automaticTitlePending !== 'boolean' ||
      meta.resume.compactSequence === undefined
    )
      return this.#rebuildExecutionState(meta);
    try {
      const contextRecords = await this.#readFromSequence(meta, meta.resume.compactSequence);
      if (
        contextRecords[0]?.sequence !== meta.resume.compactSequence ||
        !isCompactCheckpoint(contextRecords[0]) ||
        contextRecords.some((record, index) => index > 0 && isCompactCheckpoint(record))
      )
        return this.#rebuildExecutionState(meta);
      const todo = await this.#readIndexedTodo(meta, contextRecords);
      if (!todo) return this.#rebuildExecutionState(meta);
      return {
        automaticTitlePending: meta.automaticTitlePending,
        todo,
        contextRecords
      };
    } catch {
      return this.#rebuildExecutionState(meta);
    }
  }
  /** Compare the planned sequence inside the existing record writer queue. */
  async commitContextGc(
    sessionId: string,
    draft: ContextGcCheckpointDraft,
    planningRecords?: readonly SessionRecord[]
  ): Promise<SessionRecord> {
    this.#assertOpen();
    const records = planningRecords ?? (await this.readExecutionState(sessionId)).contextRecords;
    return this.#serializeRecordOperation(sessionId, async () => {
      const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
      if (!meta) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      const boundarySequence = meta.nextSequence - 1;
      if (boundarySequence !== draft.boundarySequence)
        throw new MarAgentError(
          'MAR_AGENT_SESSION_CORRUPT',
          'Context GC projection changed before checkpoint commit.'
        );
      if (
        records.at(-1)?.sequence !== boundarySequence ||
        records.at(-1)?.sessionId !== sessionId ||
        !sameContextGcBase(contextGcBaseFromRecords(records, boundarySequence), draft.base)
      )
        throw new MarAgentError(
          'MAR_AGENT_SESSION_CORRUPT',
          'Context GC planning boundary is invalid.'
        );
      const previous = latestValidContextGcCheckpoint(records, boundarySequence);
      if (
        (!draft.inlineMedia || draft.inlineMedia.reason === 'TEXT_GC') &&
        !contextGcCheckpointIntervalEligible(draft.trigger, previous?.payload.trigger)
      )
        throw new MarAgentError(
          'MAR_AGENT_SESSION_CORRUPT',
          'Context GC checkpoint interval validation failed.'
        );
      const plannedReplacements = normalizeContextGcReplacements(draft.replacements);
      if (!plannedReplacements || (plannedReplacements.length === 0 && !draft.inlineMedia))
        throw new MarAgentError(
          'MAR_AGENT_SESSION_CORRUPT',
          'Context GC checkpoint must contain a replacement.'
        );
      const replacements = normalizeContextGcReplacements([
        ...(previous?.payload.replacements ?? []),
        ...plannedReplacements
      ]);
      if (
        !replacements ||
        (previous &&
          isDeepStrictEqual(replacements, previous.payload.replacements) &&
          (!draft.inlineMedia ||
            isDeepStrictEqual(draft.inlineMedia, previous.payload.inlineMedia)))
      )
        throw new MarAgentError(
          'MAR_AGENT_SESSION_CORRUPT',
          'Context GC replacement map is invalid.'
        );
      const payload: ContextGcCheckpointPayload = {
        ...structuredClone(draft),
        checkpointId: randomUUID(),
        generation: (previous?.payload.generation ?? 0) + 1,
        replacements
      };
      const candidate: SessionRecord = {
        schemaVersion: 1,
        recordId: randomUUID(),
        sequence: boundarySequence + 1,
        timestamp: new Date().toISOString(),
        sessionId,
        type: 'context.gc.completed',
        payload
      };
      if (
        Buffer.byteLength(JSON.stringify(payload)) >= MAX_SEGMENT_BYTES ||
        validateContextGcCheckpoint(
          records,
          candidate,
          meta.workspace,
          previous?.payload.replacements
        ) === undefined
      )
        throw new MarAgentError(
          'MAR_AGENT_SESSION_CORRUPT',
          'Context GC checkpoint validation failed.'
        );
      const turnId = records.findLast((record) => record.type === 'execution.header')?.turnId;
      return this.#appendRecord(sessionId, {
        type: 'context.gc.completed',
        ...(turnId === undefined ? {} : { turnId }),
        payload
      });
    });
  }
  async readPage(
    sessionId: string,
    input: { limit?: number; beforeSequence?: number } = {}
  ): Promise<{ records: SessionRecord[]; previousBeforeSequence?: number }> {
    const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
    if (!meta) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    const before = input.beforeSequence ?? Number.POSITIVE_INFINITY;
    const limit = Math.min(1000, Math.max(1, input.limit ?? 100));
    const page: SessionRecord[] = [];
    let hasEarlier = false;
    const paths = (await this.#segmentPaths(sessionId)).reverse();
    for (const [pathIndex, path] of paths.entries()) {
      const segmentNumber = segmentNumberFromPath(path);
      const segment = meta.segments?.find((item) => item.number === segmentNumber);
      if (segment !== undefined && segment.firstSequence >= before) continue;
      const needed = limit - page.length;
      const window = await readRecordPageFromTail(
        path,
        before,
        needed,
        this.#shared.historyPagePositions
      );
      page.unshift(...window.records);
      if (window.hasEarlier) {
        hasEarlier = true;
        break;
      }
      if (page.length >= limit) {
        hasEarlier = pathIndex < paths.length - 1;
        break;
      }
    }
    const previousBeforeSequence = hasEarlier ? page[0]?.sequence : undefined;
    return { records: page, ...(previousBeforeSequence ? { previousBeforeSequence } : {}) };
  }
  async compact(
    sessionId: string,
    input: SessionStoreCompactInput,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<SessionRecord> {
    if (!input.summary.trim())
      throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Compact summary is required.');
    const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
    if (!meta) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return this.append(
      sessionId,
      {
        type: 'compact.completed',
        payload: {
          summary: input.summary,
          ...(input.pendingInputs?.length ? { pendingInputs: input.pendingInputs } : {}),
          ...(input.snapshotRecordId === undefined
            ? {}
            : { snapshotRecordId: input.snapshotRecordId }),
          ...(input.snapshotMessageCount === undefined
            ? {}
            : { snapshotMessageCount: input.snapshotMessageCount }),
          ...(input.replacementHistory === undefined
            ? {}
            : { replacementHistory: input.replacementHistory }),
          ...(input.retainedModelContext?.length
            ? { retainedModelContext: input.retainedModelContext }
            : {}),
          ...(input.inlineMediaState ? { inlineMediaState: input.inlineMediaState } : {}),
          ...(input.environment === undefined ? {} : { environment: input.environment }),
          boundarySequence: meta.nextSequence - 1,
          automatic: input.automatic === true,
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          ...(input.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: input.contextWindowTokens }),
          ...(input.usage === undefined ? {} : { usage: input.usage })
        },
        ...(input.executionId ? { executionId: input.executionId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {})
      },
      options
    );
  }
  /** A warm cell retains physical writer ownership between Executions of the same Agent. */
  async acquireSessionLease(sessionId: string, owner?: object): Promise<() => Promise<void>> {
    return this.#serializeRecordOperation(sessionId, async () => {
      this.#assertOpen();
      let lease = this.#shared.writerLeases.get(sessionId);
      if (lease) {
        if (lease.maintenance || lease.executing || owner === undefined || lease.owner !== owner)
          throw new MarAgentError('MAR_AGENT_SESSION_LOCKED', 'Session already has a writer.');
        if (lease.appendFailure) throw lease.appendFailure.error;
        lease.executing = true;
      } else {
        const release = await this.#acquireSessionLease(sessionId);
        lease = { owner, executing: true, retained: 0, release };
        this.#shared.writerLeases.set(sessionId, lease);
      }
      const current = lease;
      let released = false;
      return () =>
        this.#serializeRecordOperation(sessionId, async () => {
          if (released) return;
          released = true;
          current.executing = false;
          await this.#releaseUnusedWriter(sessionId, current);
        });
    });
  }
  hasRetainedSessionLease(sessionId: string, owner: object): boolean {
    const lease = this.#shared.writerLeases.get(sessionId);
    return lease?.owner === owner && lease.retained > 0;
  }
  async acquireSessionMaintenance(
    sessionId: string,
    kind: 'clear' | 'delete',
    owner?: object
  ): Promise<SessionStoreMaintenance> {
    this.#assertOpen();
    const acquired = new Map<string, SessionWriterLease>();
    let sessionIds: readonly string[] = [];
    let released = false;
    const holding: SessionStoreMaintenance = Object.freeze({
      get sessionIds() {
        return sessionIds;
      },
      release: async () => {
        if (released) return;
        released = true;
        this.#maintenance.delete(holding);
        let failure: { error: unknown } | undefined;
        for (const [id, writer] of [...acquired].reverse()) {
          try {
            await this.#serializeRecordOperation(id, async () => {
              delete writer.maintenance;
              await this.#releaseUnusedWriter(id, writer);
            });
          } catch (error) {
            failure ??= { error };
          }
        }
        if (failure) throw failure.error;
      }
    });
    try {
      // Re-read membership after acquiring writers; never hand the SDK a pre-lock tree snapshot.
      for (;;) {
        const tree = kind === 'delete' ? await this.sessionTree(sessionId) : [sessionId];
        for (const id of tree.toReversed()) {
          if (acquired.has(id)) continue;
          await this.#serializeRecordOperation(id, async () => {
            this.#assertOpen();
            let writer = this.#shared.writerLeases.get(id);
            if (
              writer &&
              (writer.maintenance ||
                owner === undefined ||
                writer.owner !== owner ||
                (kind === 'clear' && writer.executing))
            )
              throw new MarAgentError('MAR_AGENT_SESSION_LOCKED', 'Session already has a writer.');
            if (!writer) {
              // Deleting a stale index entry must not recreate its missing directory.
              const release =
                kind === 'delete' && !(await sessionDirectoryExists(this.#sessionDirectory(id)))
                  ? async () => {}
                  : await this.#acquireSessionLease(id);
              writer = { owner, executing: false, retained: 0, release };
              this.#shared.writerLeases.set(id, writer);
            }
            writer.maintenance = holding;
            acquired.set(id, writer);
          });
        }
        const current = kind === 'clear' ? tree : await this.sessionTree(sessionId);
        if (current.every((id) => acquired.has(id))) {
          sessionIds = Object.freeze(current);
          break;
        }
      }
      this.#maintenance.set(holding, { sessionId, kind });
      return holding;
    } catch (error) {
      await holding.release().catch(() => undefined);
      throw error;
    }
  }
  #assertMaintenance(
    sessionId: string,
    kind: 'clear' | 'delete',
    holding: SessionStoreMaintenance
  ) {
    const current = this.#maintenance.get(holding);
    if (current?.sessionId !== sessionId || current.kind !== kind)
      throw new MarAgentError(
        'MAR_AGENT_SESSION_LOCKED',
        'Session maintenance ownership is invalid.'
      );
  }
  /** Native writes join their Agent's sole writer, without admitting another Execution. */
  async acquireSessionWriteLease(sessionId: string, owner: object): Promise<() => Promise<void>> {
    return this.#serializeRecordOperation(sessionId, async () => {
      this.#assertOpen();
      let lease = this.#shared.writerLeases.get(sessionId);
      if (lease && (lease.maintenance || lease.owner !== owner))
        throw new MarAgentError('MAR_AGENT_SESSION_LOCKED', 'Session already has a writer.');
      if (lease?.appendFailure) throw lease.appendFailure.error;
      if (!lease) {
        const release = await this.#acquireSessionLease(sessionId);
        lease = { owner, executing: false, retained: 0, release };
        this.#shared.writerLeases.set(sessionId, lease);
      }
      lease.retained++;
      const current = lease;
      let released = false;
      return () =>
        this.#serializeRecordOperation(sessionId, async () => {
          if (released) return;
          released = true;
          current.retained--;
          await this.#releaseUnusedWriter(sessionId, current);
        });
    });
  }
  async retainSessionLease(sessionId: string, owner: object): Promise<() => Promise<void>> {
    return this.#serializeRecordOperation(sessionId, async () => {
      const lease = this.#shared.writerLeases.get(sessionId);
      if (!lease || lease.maintenance || !lease.executing || lease.owner !== owner)
        throw new MarAgentError(
          'MAR_AGENT_SESSION_LOCKED',
          'Retained work requires its originating Session writer.'
        );
      lease.retained++;
      let released = false;
      return () =>
        this.#serializeRecordOperation(sessionId, async () => {
          if (released) return;
          released = true;
          lease.retained--;
          await this.#releaseUnusedWriter(sessionId, lease);
        });
    });
  }
  async #releaseUnusedWriter(sessionId: string, lease: SessionWriterLease): Promise<void> {
    if (lease.maintenance || lease.executing || lease.retained) return;
    try {
      await lease.release();
    } finally {
      delete lease.codeState;
      delete lease.extensionCheckpoints;
      this.#shared.writerLeases.delete(sessionId);
    }
  }
  /** Recover files under the sole writer lock; flush dirty index state before releasing it. */
  async #acquireSessionLease(sessionId: string): Promise<() => Promise<void>> {
    this.#assertOpen();
    await this.#refreshIndex();
    if (!this.#shared.index.sessions.some((item) => item.id === sessionId))
      throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    const path = join(this.#shared.root, 'sessions', sessionId, 'lock');
    const release = await acquireFileLock(path, 'Session already has a writer.', 0);
    try {
      const disk = await readSessionIndex(join(this.#shared.root, 'sessions', 'index.json'));
      if (!disk) throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
      const current = disk.sessions.find((item) => item.id === sessionId);
      if (!current)
        throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      await recoverSessionStorageTransaction(
        this.#sessionDirectory(sessionId),
        current.storageTransactionId
      );
      await recoverContextualWorldStateTransactions(this.#shared.root, current);
      await this.#refreshIndex();
      await this.#reconcileTail(sessionId);
    } catch (error) {
      await release();
      throw error;
    }
    return async () => {
      try {
        if (this.#shared.indexDirty) await this.#saveIndex();
      } finally {
        await release();
      }
    };
  }
  async list(input: SessionListInput = {}) {
    this.#assertOpen();
    await this.#refreshIndex();
    const filter = sessionListFilter(input);
    const start = decodeSessionListCursor(input.cursor, this.#shared.index.revision, filter);
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const ordered = this.#shared.index.sessions
      .filter((session) => sessionMatchesFilter(session, filter))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const sessions = ordered.slice(start, start + limit).map((session) => ({
      id: session.id,
      title: session.title,
      ...(session.resume?.firstUserMessagePreview === undefined
        ? {}
        : { firstUserMessagePreview: session.resume.firstUserMessagePreview }),
      workspace: session.workspace,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      source: normalizeSessionSource(session.source),
      ...(session.resume?.modelId === undefined
        ? {}
        : {
            modelId: session.resume.modelId,
            ...(session.resume.modelName === undefined
              ? {}
              : { modelName: session.resume.modelName }),
            ...(session.resume.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: session.resume.reasoningEffort })
          })
    }));
    const next =
      start + limit < ordered.length
        ? encodeSessionListCursor(this.#shared.index.revision, start + limit, filter)
        : undefined;
    return { sessions, ...(next ? { nextCursor: next } : {}) };
  }
  async listSubagentChildren(parentSessionId: string) {
    this.#assertOpen();
    await this.#refreshIndex();
    return this.#shared.index.sessions
      .map((session) => ({ session, source: normalizeSessionSource(session.source) }))
      .filter(
        (
          item
        ): item is typeof item & {
          source: Extract<SessionSource, { type: 'subagent' }>;
        } => item.source.type === 'subagent' && item.source.parentSessionId === parentSessionId
      )
      .map(({ session, source }) => ({
        id: session.id,
        title: session.title,
        workspace: session.workspace,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        source,
        ...(session.resume?.modelId === undefined
          ? {}
          : {
              modelId: session.resume.modelId,
              ...(session.resume.modelName === undefined
                ? {}
                : { modelName: session.resume.modelName }),
              ...(session.resume.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: session.resume.reasoningEffort })
            })
      }));
  }
  async executionConfiguration(
    sessionId: string
  ): Promise<
    | { readonly modelId: string; readonly modelName?: string; readonly reasoningEffort?: string }
    | undefined
  > {
    this.#assertOpen();
    await this.#refreshIndex();
    let meta = this.#shared.index.sessions.find((session) => session.id === sessionId);
    if (meta === undefined)
      throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    if (meta.resume?.executionModelIndexed !== true) {
      await this.#ensureExecutionModelIndexed(sessionId);
      meta = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (meta === undefined)
        throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    }
    return meta.resume?.modelId === undefined
      ? undefined
      : {
          modelId: meta.resume.modelId,
          ...(meta.resume.modelName === undefined ? {} : { modelName: meta.resume.modelName }),
          ...(meta.resume.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: meta.resume.reasoningEffort })
        };
  }
  async sessionTree(sessionId: string): Promise<readonly string[]> {
    this.#assertOpen();
    await this.#refreshIndex();
    if (!this.#shared.index.sessions.some((session) => session.id === sessionId))
      throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return sessionTreeIds(this.#shared.index.sessions, sessionId);
  }
  #applyRecordToResumeIndex(meta: SessionMeta, record: SessionRecord) {
    if (record.type === 'turn.user') meta.automaticTitlePending = false;
    if (record.type === 'session.title.updated' && isObject(record.payload)) {
      if (typeof record.payload.title === 'string') meta.title = record.payload.title;
      meta.automaticTitlePending = false;
    }
    const resume = meta.resume;
    if (resume?.version !== 1 || !Number.isSafeInteger(resume.todoRevision)) return;
    if (resume.userTurns !== undefined && isNativeUserTurn(record)) resume.userTurns++;
    if (resume.firstUserMessageIndexed === true && resume.firstUserMessagePreview === undefined) {
      const preview = userMessagePreviewFromRecord(record);
      if (preview !== undefined) resume.firstUserMessagePreview = preview;
    }
    const executionModel = executionModelFromRecord(record);
    if (executionModel !== undefined) {
      resume.executionModelIndexed = true;
      resume.modelId = executionModel.modelId;
      if (executionModel.modelName === undefined) delete resume.modelName;
      else resume.modelName = executionModel.modelName;
      if (executionModel.reasoningEffort === undefined) delete resume.reasoningEffort;
      else resume.reasoningEffort = executionModel.reasoningEffort;
    }
    if (isCompactCheckpoint(record)) resume.compactSequence = record.sequence;
    if (record.type !== 'todo.updated' || !todoItemsFromSnapshot(record.payload)) return;
    resume.todoSequence = record.sequence;
    resume.todoRevision++;
  }
  async #readIndexedTodo(
    meta: SessionMeta,
    contextRecords: readonly SessionRecord[]
  ): Promise<TodoSnapshot | undefined> {
    const resume = meta.resume;
    if (
      resume?.version !== 1 ||
      !Number.isSafeInteger(resume.todoRevision) ||
      resume.todoRevision < 0
    )
      return undefined;
    const latestContextTodo = contextRecords.findLast(
      (record) =>
        record.type === 'todo.updated' && todoItemsFromSnapshot(record.payload) !== undefined
    );
    if (
      latestContextTodo &&
      (resume.todoSequence === undefined || latestContextTodo.sequence !== resume.todoSequence)
    )
      return undefined;
    if (resume.todoSequence === undefined)
      return resume.todoRevision === 0 ? { revision: 0, items: [] } : undefined;
    if (resume.todoRevision === 0) return undefined;
    const record =
      contextRecords.find((item) => item.sequence === resume.todoSequence) ??
      (await this.#readRecordAtSequence(meta, resume.todoSequence));
    if (record?.type !== 'todo.updated') return undefined;
    const items = todoItemsFromSnapshot(record.payload);
    return items ? { revision: resume.todoRevision, items } : undefined;
  }
  async #readRecordAtSequence(
    meta: SessionMeta,
    sequence: number
  ): Promise<SessionRecord | undefined> {
    const segment = meta.segments?.find(
      (item) => item.firstSequence <= sequence && item.lastSequence >= sequence
    );
    if (!segment) return undefined;
    return (await readRecords(this.#segmentPath(meta.id, segment.number))).find(
      (record) => record.sequence === sequence
    );
  }
  async #readFromSequence(meta: SessionMeta, sequence: number): Promise<SessionRecord[]> {
    const segments = (meta.segments ?? [])
      .filter((item) => item.lastSequence >= sequence)
      .sort((left, right) => left.number - right.number);
    if (segments.length === 0)
      throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session resume index is invalid.');
    const records: SessionRecord[] = [];
    for (const segment of segments)
      records.push(
        ...(await readRecords(this.#segmentPath(meta.id, segment.number))).filter(
          (record) => record.sequence >= sequence
        )
      );
    return records;
  }
  async #rebuildExecutionState(meta: SessionMeta): Promise<SessionExecutionState> {
    const state = deriveExecutionState(await this.read(meta.id));
    if (
      meta.automaticTitlePending !== state.automaticTitlePending ||
      !sameResumeIndex(meta.resume, state.resume)
    ) {
      meta.automaticTitlePending = state.automaticTitlePending;
      meta.resume = state.resume;
      this.#shared.index.revision++;
      this.#markIndexDirty(meta.id);
    }
    return {
      automaticTitlePending: state.automaticTitlePending,
      todo: state.todo,
      contextRecords: state.contextRecords
    };
  }
  /** Counts native input records, not the post-Compact model context. */
  async userTurnCount(sessionId: string): Promise<number> {
    return this.#serializeRecordOperation(sessionId, async () => {
      this.#assertOpen();
      await this.#refreshIndex();
      const before = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (!before) throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      const indexed = before.resume?.userTurns;
      if (indexed !== undefined && this.#shared.writerLeases.has(sessionId)) return indexed;
      const nextSequence = before.nextSequence;
      const transactionId = before.storageTransactionId;
      const paths = await this.#segmentPaths(sessionId);
      let count = indexed ?? 0;
      let lastSequence = 0;
      let reachedPrefix = false;
      if (indexed !== undefined) {
        // No local writer: a previous writer may have committed bytes but not its index.
        for (const path of [...paths].reverse()) {
          for await (const record of readRecordsFromTail(path)) {
            lastSequence = Math.max(lastSequence, record.sequence);
            if (record.sequence < nextSequence) {
              reachedPrefix = true;
              break;
            }
            if (isNativeUserTurn(record)) count++;
          }
          if (reachedPrefix) break;
        }
      }
      if (indexed === undefined || lastSequence < nextSequence - 1) {
        count = 0;
        lastSequence = 0;
        for (const path of paths) {
          for await (const record of readRecordsFromHead(path)) {
            lastSequence = record.sequence;
            if (isNativeUserTurn(record)) count++;
          }
        }
      }
      await this.#refreshIndex();
      const current = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (!current)
        throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      if (current.storageTransactionId !== transactionId) {
        // The indexed prefix no longer belongs to this history. Fall back to the
        // ordinary physical read boundary without caching or a conflict error.
        count = 0;
        for (const path of await this.#segmentPaths(sessionId))
          for await (const record of readRecordsFromHead(path))
            if (isNativeUserTurn(record)) count++;
        return count;
      }
      if (
        current.nextSequence === nextSequence &&
        lastSequence === nextSequence - 1 &&
        current.resume?.userTurns === undefined
      ) {
        (current.resume ??= { version: 1, todoRevision: 0 }).userTurns = count;
        this.#markIndexDirty(sessionId, true);
      }
      return count;
    });
  }

  async firstUserMessagePreview(sessionId: string): Promise<string | undefined> {
    this.#assertOpen();
    await this.#refreshIndex();
    await this.#ensureFirstUserMessageIndexed(sessionId);
    return this.#shared.index.sessions.find((session) => session.id === sessionId)?.resume
      ?.firstUserMessagePreview;
  }
  async #ensureFirstUserMessageIndexed(sessionId: string): Promise<void> {
    for (;;) {
      const before = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (before === undefined)
        throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      if (before.resume?.firstUserMessageIndexed === true) return;
      const nextSequence = before.nextSequence;
      const transactionId = before.storageTransactionId;
      let preview: string | undefined;
      try {
        for (const path of await this.#segmentPaths(sessionId)) {
          for await (const record of readRecordsFromHead(path)) {
            preview = userMessagePreviewFromRecord(record);
            if (preview !== undefined) break;
          }
          if (preview !== undefined) break;
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          !(error instanceof MarAgentError && error.code === 'MAR_AGENT_SESSION_NOT_FOUND')
        )
          throw error;
      }
      await this.#refreshIndex();
      const current = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (current === undefined)
        throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      if (current.resume?.firstUserMessageIndexed === true) return;
      if (current.nextSequence !== nextSequence || current.storageTransactionId !== transactionId)
        continue;
      const resume = (current.resume ??= { version: 1, todoRevision: 0 });
      resume.firstUserMessageIndexed = true;
      if (preview !== undefined) resume.firstUserMessagePreview = preview;
      // Derived preview caches do not change list membership, ordering or filters.
      this.#markIndexDirty(sessionId, true);
      return;
    }
  }
  async #ensureExecutionModelIndexed(sessionId: string): Promise<void> {
    const pending = this.#shared.executionModelReads.get(sessionId);
    if (pending !== undefined) return pending;
    const read = this.#backfillExecutionModel(sessionId).finally(() => {
      if (this.#shared.executionModelReads.get(sessionId) === read)
        this.#shared.executionModelReads.delete(sessionId);
    });
    this.#shared.executionModelReads.set(sessionId, read);
    return read;
  }
  async #backfillExecutionModel(sessionId: string): Promise<void> {
    for (;;) {
      const before = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (before === undefined)
        throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      if (before.resume?.executionModelIndexed === true) return;
      const nextSequence = before.nextSequence;
      const transactionId = before.storageTransactionId;
      const model = await this.#readLatestExecutionModel(sessionId);
      // Refresh can replace metadata objects while unrelated sessions are being read.
      // Merge only into the current entry, and retry if the authoritative history changed.
      await this.#refreshIndex();
      const current = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (current === undefined)
        throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      if (current.resume?.executionModelIndexed === true) return;
      if (current.nextSequence !== nextSequence || current.storageTransactionId !== transactionId)
        continue;
      // A missing resume index stays incomplete (no compact boundary); execution
      // recovery will rebuild it separately instead of doing so during discovery.
      const resume = (current.resume ??= { version: 1, todoRevision: 0 });
      resume.executionModelIndexed = true;
      delete resume.modelId;
      delete resume.modelName;
      delete resume.reasoningEffort;
      if (model !== undefined) Object.assign(resume, model);
      this.#shared.index.revision++;
      this.#markIndexDirty(sessionId);
      return;
    }
  }
  async #readLatestExecutionModel(
    sessionId: string
  ): Promise<ReturnType<typeof executionModelFromRecord>> {
    try {
      for (const path of (await this.#segmentPaths(sessionId)).reverse())
        for await (const record of readRecordsFromTail(path)) {
          const model = executionModelFromRecord(record);
          if (model !== undefined) return model;
        }
      return undefined;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error instanceof MarAgentError && error.code === 'MAR_AGENT_SESSION_NOT_FOUND')
      )
        return undefined;
      throw error;
    }
  }
  async delete(
    sessionId: string,
    maintenance?: SessionStoreMaintenance
  ): Promise<{ readonly deleted: boolean }> {
    this.#assertOpen();
    const holding = maintenance ?? (await this.acquireSessionMaintenance(sessionId, 'delete'));
    this.#assertMaintenance(sessionId, 'delete', holding);
    const tree = holding.sessionIds;
    let failed = false;
    try {
      const deleted = await sessionDirectoryExists(join(this.#shared.root, 'sessions', sessionId));
      for (const id of tree.toReversed()) {
        await rm(join(this.#shared.root, 'sessions', id), { recursive: true, force: true });
        this.#shared.segments.delete(id);
      }
      const deletedSet = new Set(tree);
      this.#shared.index.sessions = this.#shared.index.sessions.filter(
        (session) => !deletedSet.has(session.id)
      );
      this.#shared.index.revision++;
      await this.#saveIndex(tree);
      return { deleted };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (!maintenance) {
        const releasing = holding.release();
        if (failed) await releasing.catch(() => undefined);
        else await releasing;
      }
    }
  }
  #assertOpen() {
    if (this.#leaseClosed || this.#shared.closed)
      throw new MarAgentError('MAR_AGENT_DISPOSED', 'Session store is closed.');
  }
  #markIndexDirty(sessionId: string, derivedOnly = false): void {
    if (!derivedOnly) this.#shared.derivedOnlyDirtySessions.delete(sessionId);
    else if (!this.#shared.dirtySessionVersions.has(sessionId))
      this.#shared.derivedOnlyDirtySessions.add(sessionId);
    this.#shared.indexDirty = true;
    this.#shared.dirtySessionVersions.set(
      sessionId,
      (this.#shared.dirtySessionVersions.get(sessionId) ?? 0) + 1
    );
  }
  async #storageTransactionCommitted(sessionId: string, transactionId: string): Promise<boolean> {
    const disk = await readSessionIndex(join(this.#shared.root, 'sessions', 'index.json'));
    return (
      disk?.sessions.some(
        (session) => session.id === sessionId && session.storageTransactionId === transactionId
      ) ?? false
    );
  }
  #segmentPath(sessionId: string, segment: number) {
    return join(
      this.#shared.root,
      'sessions',
      sessionId,
      `events-${String(segment).padStart(6, '0')}.jsonl`
    );
  }
  async #segmentPaths(sessionId: string) {
    const directory = join(this.#shared.root, 'sessions', sessionId);
    const names = (await readdir(directory))
      .filter((name) => /^events-\d{6}\.jsonl$/.test(name))
      .sort();
    if (names.length === 0)
      throw new MarAgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return names.map((name) => join(directory, name));
  }
  async #currentSegment(sessionId: string) {
    const cached = this.#shared.segments.get(sessionId);
    if (cached !== undefined) return cached;
    const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
    const indexed = meta?.segments?.at(-1)?.number;
    if (indexed !== undefined) {
      this.#shared.segments.set(sessionId, indexed);
      return indexed;
    }
    const paths = await this.#segmentPaths(sessionId);
    const match = /events-(\d{6})\.jsonl$/.exec(paths.at(-1)!);
    const segment = Number(match?.[1] ?? 1);
    this.#shared.segments.set(sessionId, segment);
    return segment;
  }
  /** Repair the last segment and pending images under the lease, then sync sequence metadata. */
  async #reconcileTail(sessionId: string) {
    const paths = await this.#segmentPaths(sessionId);
    const latestPath = paths.at(-1)!;
    await repairSegmentTail(latestPath);
    const records = await readRecords(latestPath);
    await recoverResources(join(this.#sessionDirectory(sessionId), 'resources'), () =>
      this.#readRecords(sessionId)
    );
    await cleanupUnreferencedToolResources(this.#sessionDirectory(sessionId), () =>
      this.#readRecords(sessionId)
    );
    const last = records.at(-1);
    const match = /events-(\d{6})\.jsonl$/.exec(latestPath);
    const segment = Number(match?.[1] ?? 1);
    this.#shared.segments.set(sessionId, segment);
    if (last === undefined)
      throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
    const bytes = (await stat(latestPath)).size;
    const firstSequence = records[0]!.sequence;
    // Tail recovery must publish onto metadata that is current after all file I/O.
    const meta = this.#shared.index.sessions.find((item) => item.id === sessionId)!;
    const known = meta.segments?.find((item) => item.number === segment);
    const titleRecord = records.findLast(
      (record) =>
        record.type === 'session.title.updated' &&
        typeof (record.payload as { title?: unknown }).title === 'string'
    );
    const recoveredTitle = (titleRecord?.payload as { title?: string } | undefined)?.title;
    const changed =
      meta.nextSequence !== last.sequence + 1 ||
      known?.bytes !== bytes ||
      (recoveredTitle !== undefined && meta.title !== recoveredTitle);
    meta.nextSequence = last.sequence + 1;
    if (recoveredTitle !== undefined) meta.title = recoveredTitle;
    meta.lastActivityAt =
      meta.lastActivityAt < last.timestamp ? last.timestamp : meta.lastActivityAt;
    if (!meta.segments) meta.segments = [];
    if (known) {
      known.firstSequence = firstSequence;
      known.lastSequence = last.sequence;
      known.bytes = bytes;
    } else
      meta.segments.push({ number: segment, firstSequence, lastSequence: last.sequence, bytes });
    if (changed) {
      delete meta.automaticTitlePending;
      delete meta.resume;
      this.#shared.index.revision++;
      this.#markIndexDirty(sessionId);
    }
  }
  async close() {
    if (this.#leaseClosed) return;
    this.#leaseClosed = true;
    this.#shared.references--;
    if (this.#shared.references > 0) return;
    if (this.#shared.indexDirty) await this.#saveIndex();
    this.#shared.closed = true;
    JsonlSessionStore.#instances.delete(this.#shared.root);
  }
}

async function sessionDirectoryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function recoverContextualWorldStateTransactions(
  root: string,
  meta: SessionMeta
): Promise<void> {
  const directory = join(root, 'sessions', meta.id);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const pattern = /^context-world-state\.json\.(\d+)\.[0-9a-f-]+\.(?:rollback|clear)-backup$/u;
  const backups = names.filter((name) => pattern.test(name));
  if (backups.length === 0) return;
  const eventNames = names.filter((name) => /^events-\d{6}\.jsonl$/u.test(name)).sort();
  const latestEventName = eventNames.at(-1);
  if (latestEventName === undefined)
    throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
  const latestRecords = await readRecords(join(directory, latestEventName));
  const actualNextSequence = (latestRecords.at(-1)?.sequence ?? 0) + 1;
  const canonical = join(directory, CONTEXTUAL_WORLD_STATE_FILE);
  for (const name of backups) {
    const match = pattern.exec(name)!;
    const backup = join(directory, name);
    const targetNextSequence = Number(match[1]);
    if (actualNextSequence === targetNextSequence || (await sessionDirectoryExists(canonical)))
      await rm(backup, { force: true });
    else await rename(backup, canonical);
  }
}

function restoreSessionMeta(meta: SessionMeta, original: SessionMeta): void {
  meta.id = original.id;
  meta.title = original.title;
  meta.workspace = original.workspace;
  meta.createdAt = original.createdAt;
  meta.lastActivityAt = original.lastActivityAt;
  if (original.source === undefined) delete meta.source;
  else meta.source = structuredClone(original.source);
  meta.nextSequence = original.nextSequence;
  if (original.automaticTitlePending === undefined) delete meta.automaticTitlePending;
  else meta.automaticTitlePending = original.automaticTitlePending;
  if (original.resume === undefined) delete meta.resume;
  else meta.resume = structuredClone(original.resume);
  if (original.segments === undefined) delete meta.segments;
  else meta.segments = structuredClone(original.segments);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
