import { randomUUID } from 'node:crypto';
import { rollbackBoundaryIndex, type AgentSessionRollbackInput } from '../../rollback.js';
import type {
  SessionStore,
  SessionStoreMaintenance,
  SessionRecordInput,
  SessionStoreCompactInput
} from '../contracts.js';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentError } from '../../../error.js';
import { isModelImageUrl } from '../../../model/image.js';
import {
  cloneCoreJson,
  type ExtensionCheckpoint,
  type ExtensionJsonValue
} from '../../extension-checkpoint.js';
import { acquireFileLock } from '../../../storage/file-lock.js';
import { todoItemsFromSnapshot, type TodoSnapshot } from '../../todo.js';
import {
  applyCodeModeStateMutations,
  parseCodeModeStateMutations,
  restoreCodeModeState,
  type CodeModeStateEntry,
  type CodeModeStateMutation
} from '../../code-state.js';
import {
  contextGcBaseFromRecords,
  contextGcCheckpointIntervalEligible,
  latestValidContextGcCheckpoint,
  normalizeContextGcReplacements,
  sameContextGcBase,
  validateContextGcCheckpoint,
  type ContextGcCheckpointDraft,
  type ContextGcCheckpointPayload
} from '../../context-gc-checkpoint.js';
import {
  recordToolResources,
  readToolResultResource,
  writeToolResultResource,
  type ToolResultResourceInput
} from '../../tool-result-resources.js';
import {
  beginTreeDeleteTransaction,
  finishTreeDelete,
  finishTreeDeletePreparation,
  readTreeDeleteTransaction,
  recoverSessionStorageTransaction,
  stageTreeDelete,
  type SessionTreeDeleteTransaction
} from './transaction-recovery.js';
import type { SessionListInput, SessionSource, SessionTitleUpdateInput } from '../../types.js';
import {
  extensionCheckpointFromPayload,
  indexExtensionCheckpoint,
  restoreExtensionCheckpoint,
  updateSessionCurrentState,
  type ExtensionCheckpointIndex,
  type SessionCurrentState
} from '../current-state.js';
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  mergeSessionDerivedCache,
  normalizeSessionSource,
  persistFormatSelection,
  readSessionIndex,
  restoreSessionIndexMeta,
  sessionListFilter,
  sessionMatchesFilter,
  sessionTreeIds,
  upgradeSessionIndex
} from './directory-index.js';
import {
  admitWorldStateVersion,
  preflightRetiredRecovery,
  preflightV1Session,
  preflightV2Recovery
} from './jsonl-admission.js';
import { prepareJsonlV2Generation } from './jsonl-migration.js';
import { syncJsonlDirectory } from './fs-durability.js';
import { withSessionReadDrain, withSessionReadPin } from './read-pins.js';
import {
  deriveExecutionState,
  executionModelFromRecord,
  isCompactCheckpoint,
  isNativeUserTurn,
  sameResumeIndex,
  userMessagePreviewFromRecord
} from '../execution-state.js';
import { forkSessionOperation } from './fork-session.js';
import {
  MAX_INPUT_IMAGES,
  inputImageReference,
  inputImageReferences,
  readInputImageBytes
} from './images.js';
import { persistResource, setResourceUrl, readResource, resourceFiles } from './resources.js';
import {
  CONTEXTUAL_WORLD_STATE_FILE,
  openJsonlIndex,
  reclaimUnpublishedSessions,
  recoverContextualWorldStateTransactions,
  recoverJsonlTail,
  sessionDirectoryExists
} from './open-recovery.js';
import { JsonlStorePool } from './store-pool.js';
import { acquireTreeMaintenance } from './tree-maintenance.js';
import { commitSessionIndex, ParentPublicationRejected } from './index-transaction.js';
import { replaceSessionHistory } from './history-replacement.js';
import { appendSessionRecord } from './record-append.js';
import {
  MAX_SEGMENT_BYTES,
  SessionHistoryPageReader,
  readRecords,
  readRecordsFromHead,
  readRecordsFromTail
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
} from '../types.js';

interface SessionWriterLease extends SessionCurrentState {
  owner: object | undefined;
  executing: boolean;
  retained: number;
  maintenance?: SessionStoreMaintenance;
  appendFailure?: { error: unknown };
  historyFailure?: { error: unknown };
  pendingResource?: Set<string>;
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
  historyPages: SessionHistoryPageReader;
  rootFailure?: { error: unknown };
  rootConfirmed: boolean;
  publicationRecovery?: Promise<void>;
  migrationFailures: Map<string, { error: unknown; unreadable: boolean }>;
}

const MAX_CONTEXTUAL_WORLD_STATE_BYTES = 8 * 1024 * 1024;

/** SDK-owned JSONL history with per-HOME in-process sharing and cross-process file locks. */
export class JsonlSessionStore implements SessionStore {
  static readonly #pool = new JsonlStorePool<SharedStore>();
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
    return new JsonlSessionStore(
      await JsonlSessionStore.#pool.acquire(root, () => JsonlSessionStore.#openExclusive(root))
    );
  }
  /** Create a missing index only without Session directories; recover journals and marked creations. */
  static async #openExclusive(root: string) {
    const index = await openJsonlIndex(root);
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
      historyPages: new SessionHistoryPageReader(),
      rootConfirmed: false,
      migrationFailures: new Map()
    };
  }
  /** Merge dirty metadata with disk membership; only createdIds publish locally new entries. */
  async #saveIndex(
    deletedIds?: string | readonly string[],
    createdIds: readonly string[] = [],
    onPersisted?: () => void
  ) {
    return this.#serializeIndexOperation(() =>
      this.#commitIndex(deletedIds, createdIds, onPersisted)
    );
  }
  async #serializeIndexOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#shared.indexOperations.then(operation, operation);
    this.#shared.indexOperations = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
  async #commitIndex(
    deletedIds?: string | readonly string[],
    createdIds: readonly string[] = [],
    onPersisted?: () => void,
    storageSelection?: { readonly before: SessionMeta; readonly generation: string },
    deleteExpected?: readonly SessionMeta[]
  ) {
    if (this.#shared.rootFailure) throw this.#shared.rootFailure.error;
    await commitSessionIndex(
      this.#shared.root,
      () => ({
        index: this.#shared.index,
        dirty: new Map(this.#shared.dirtySessionVersions),
        derivedOnly: new Set(this.#shared.derivedOnlyDirtySessions)
      }),
      (updated, dirty, created) => {
        for (const [id, version] of dirty) {
          // A different creation still needs its own index transaction to publish its directory.
          if (this.#shared.pendingPublishIds.has(id) && !created.has(id)) continue;
          if (this.#shared.dirtySessionVersions.get(id) === version) {
            this.#shared.dirtySessionVersions.delete(id);
            this.#shared.derivedOnlyDirtySessions.delete(id);
          }
        }
        for (const id of created) this.#shared.pendingPublishIds.delete(id);
        const published = new Set(updated.sessions.map((session) => session.id));
        const pending = this.#shared.index.sessions.filter(
          (session) =>
            this.#shared.dirtySessionVersions.has(session.id) &&
            (published.has(session.id) || this.#shared.pendingPublishIds.has(session.id))
        );
        const replacements = new Map(pending.map((session) => [session.id, session]));
        this.#shared.index = {
          ...updated,
          sessions: [
            ...updated.sessions.map((session) => {
              const local = replacements.get(session.id);
              if (!local) return session;
              return session.storage === undefined ? local : { ...local, storage: session.storage };
            }),
            ...pending.filter((session) => !published.has(session.id))
          ]
        };
        this.#shared.indexDirty = this.#shared.dirtySessionVersions.size > 0;
      },
      deletedIds,
      createdIds,
      onPersisted,
      storageSelection,
      deleteExpected
    );
  }
  /** Fence new opens of the legacy SDK without waiting on any Session while holding the index lock. */
  async #ensureRootV2(): Promise<void> {
    if (this.#shared.rootFailure) throw this.#shared.rootFailure.error;
    if (this.#shared.rootConfirmed && this.#shared.index.version === 2) {
      await this.#refreshIndex();
      if (this.#shared.index.version === 2) {
        await this.#recoverPublications();
        return;
      }
    }
    await this.#serializeIndexOperation(async () => {
      if (this.#shared.rootFailure) throw this.#shared.rootFailure.error;
      const path = join(this.#shared.root, 'sessions', 'index.json');
      const release = await acquireFileLock(join(this.#shared.root, 'sessions', 'index.lock'));
      let failure: unknown;
      try {
        const disk = await readSessionIndex(path);
        if (!disk) throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
        try {
          if (disk.version === 1) await persistFormatSelection(path, upgradeSessionIndex(disk));
          else await syncJsonlDirectory(join(this.#shared.root, 'sessions'));
        } catch (error) {
          // A failed rename or directory sync is not proof that the fence is absent.
          await readSessionIndex(path).catch(() => undefined);
          this.#shared.rootFailure = { error };
          throw error;
        }
        this.#shared.rootConfirmed = true;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (failure !== undefined) await release().catch(() => undefined);
        else await release();
      }
      await this.#readCurrentIndex();
    });
    await this.#recoverPublications();
  }
  async #recoverPublications(): Promise<void> {
    this.#shared.publicationRecovery ??= reclaimUnpublishedSessions(this.#shared.root);
    await this.#shared.publicationRecovery;
  }
  async #refreshIndex() {
    return this.#serializeIndexOperation(() => this.#readCurrentIndex());
  }
  async #readCurrentIndex() {
    const disk = await readSessionIndex(join(this.#shared.root, 'sessions', 'index.json'));
    if (!disk) throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
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
            : session.storage === undefined
              ? current
              : { ...current, storage: session.storage };
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
    if (source.parentSessionId === undefined) return this.#createSession(input, source);
    const parentSessionId = source.parentSessionId;
    // Publish under the parent's existing serial domain so tree admission cannot miss a child.
    return this.#serializeRecordOperation(parentSessionId, async () => {
      this.#assertOpen();
      if (this.#shared.writerLeases.get(parentSessionId)?.maintenance)
        throw new AgentError('MAR_AGENT_SESSION_LOCKED', 'Session is under maintenance.');
      const release = await this.#acquirePublicationGate(parentSessionId, 5000);
      let failure: unknown;
      try {
        await this.#recoverPendingTreeDelete(parentSessionId);
        if (this.#shared.writerLeases.get(parentSessionId)?.maintenance)
          throw new AgentError('MAR_AGENT_SESSION_LOCKED', 'Session is under maintenance.');
        await this.getSession(parentSessionId);
        return await this.#createSession(input, source);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (failure !== undefined) await release().catch(() => undefined);
        else await release();
      }
    });
  }
  async #acquirePublicationGate(sessionId: string, waitMs = 0): Promise<() => Promise<void>> {
    this.#sessionRoot(sessionId);
    const directory = join(this.#shared.root, 'sessions', '.publication-locks');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return acquireFileLock(join(directory, sessionId), 'Session is under maintenance.', waitMs);
  }
  /** Append the durable creation record before making this Session visible in the index. */
  async #createSession(input: Parameters<SessionStore['createSession']>[0], source: SessionSource) {
    await this.#ensureRootV2();
    const id = randomUUID();
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      title: input.title ?? 'New session',
      workspace: input.workspace,
      createdAt: now,
      lastActivityAt: now,
      source,
      storage: { encoding: 2, generation: randomUUID() },
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
    let creationFailure: unknown;
    try {
      try {
        const generationDirectory = this.#directoryForMeta(id, meta);
        await mkdir(generationDirectory, { recursive: true, mode: 0o700 });
        await syncJsonlDirectory(join(publication.directory, 'v2'));
        await syncJsonlDirectory(publication.directory);
        await this.append(id, {
          type: 'session.created',
          payload: {
            title: meta.title,
            workspace: meta.workspace,
            automaticTitle: input.title === undefined,
            source: meta.source
          }
        });
        await syncJsonlDirectory(generationDirectory);
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
      let persisted = false;
      try {
        await this.#saveIndex(undefined, [id], () => {
          persisted = true;
        });
      } catch (error) {
        if (!persisted) {
          if (error instanceof ParentPublicationRejected) {
            discard = true;
            this.#shared.index.sessions = this.#shared.index.sessions.filter(
              (item) => item.id !== id
            );
            this.#shared.segments.delete(id);
            this.#shared.pendingPublishIds.delete(id);
            this.#shared.dirtySessionVersions.delete(id);
            this.#shared.indexDirty = this.#shared.dirtySessionVersions.size > 0;
            throw error;
          }
          // A failed lock release can follow a committed index rename; do not unpublish that Session.
          // If the index cannot be read, leave the disk marker for recovery and keep the original error.
          const disk = await readSessionIndex(
            join(this.#shared.root, 'sessions', 'index.json')
          ).catch(() => undefined);
          if (disk?.sessions.some((session) => session.id === id)) {
            this.#shared.pendingPublishIds.delete(id);
            this.#shared.dirtySessionVersions.delete(id);
            this.#shared.indexDirty = this.#shared.dirtySessionVersions.size > 0;
            this.#shared.migrationFailures.set(id, { error, unreadable: true });
            throw error;
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
      }
      await rm(join(publication.directory, 'publication-pending'), { force: true });
      return meta;
    } catch (error) {
      creationFailure = error;
      throw error;
    } finally {
      if (creationFailure !== undefined) {
        await publication.release().catch(() => undefined);
        if (discard)
          await rm(publication.directory, { recursive: true, force: true }).catch(() => undefined);
      } else await publication.release();
    }
  }
  #sessionDirectory(sessionId: string): string {
    this.#assertOpen();
    const migrationFailure = this.#shared.migrationFailures.get(sessionId);
    if (migrationFailure?.unreadable) throw migrationFailure.error;
    const failure = this.#shared.writerLeases.get(sessionId)?.historyFailure;
    if (failure) throw failure.error;
    if (
      !this.#shared.index.sessions.some((session) => session.id === sessionId) &&
      !this.#shared.pendingSessions.has(sessionId)
    )
      throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    const meta =
      this.#shared.pendingSessions.get(sessionId) ??
      this.#shared.index.sessions.find((session) => session.id === sessionId);
    return this.#directoryForMeta(sessionId, meta);
  }
  #directoryForMeta(sessionId: string, meta?: SessionMeta): string {
    const root = join(this.#shared.root, 'sessions', sessionId);
    return meta?.storage?.encoding === 2 ? join(root, 'v2', meta.storage.generation) : root;
  }
  #sessionRoot(sessionId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(sessionId))
      throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return join(this.#shared.root, 'sessions', sessionId);
  }
  #encoding(sessionId: string): number {
    const meta =
      this.#shared.pendingSessions.get(sessionId) ??
      this.#shared.index.sessions.find((session) => session.id === sessionId);
    return meta?.storage?.encoding ?? 1;
  }
  async readContextualWorldState(sessionId: string): Promise<unknown | undefined> {
    return withSessionReadPin(this.#sessionRoot(sessionId), async () => {
      await this.#refreshIndex();
      const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
      if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      await this.#segmentPaths(sessionId, meta);
      const path = join(this.#directoryForMeta(sessionId, meta), CONTEXTUAL_WORLD_STATE_FILE);
      try {
        const envelope = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        admitWorldStateVersion(envelope);
        if (
          envelope.version !== 1 ||
          !Number.isSafeInteger(envelope.historySequence) ||
          (envelope.historySequence as number) < 1 ||
          (envelope.historySequence as number) >= meta.nextSequence
        )
          return undefined;
        return envelope.state;
      } catch (error) {
        if (error instanceof AgentError && error.code === 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED')
          throw error;
        return undefined;
      }
    });
  }
  async writeContextualWorldState(sessionId: string, state: unknown): Promise<void> {
    return this.#serializeRecordOperation(sessionId, () =>
      this.#withWriteAdmission(sessionId, async () => {
        const directory = this.#sessionDirectory(sessionId);
        const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
        if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        const path = join(directory, CONTEXTUAL_WORLD_STATE_FILE);
        const temporary = `${path}.${randomUUID()}.tmp`;
        const serialized = JSON.stringify({
          version: 1,
          historySequence: meta.nextSequence - 1,
          state
        });
        if (Buffer.byteLength(serialized) > MAX_CONTEXTUAL_WORLD_STATE_BYTES)
          throw new AgentError(
            'MAR_AGENT_HOST_LIMIT_EXCEEDED',
            'Contextual world state exceeds the storage limit.'
          );
        try {
          await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      })
    );
  }
  /** Mark each image pending before publication; turn.user or lease recovery resolves ownership. */
  async persistInputImages(
    sessionId: string,
    images: readonly SessionInputImage[]
  ): Promise<SessionInputImageMetadata[]> {
    this.#assertOpen();
    if (images.length === 0) return [];
    if (images.length > MAX_INPUT_IMAGES)
      throw new AgentError('MAR_AGENT_HOST_LIMIT_EXCEEDED', 'Too many image inputs were provided.');
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
        throw new AgentError('MAR_AGENT_SESSION_INPUT_INVALID', 'Image model URL is invalid.');
      let resource = await this.persistResource(sessionId, image);
      if (image.url !== undefined && image.urlExpiresAt !== undefined)
        resource = await this.setResourceUrl(sessionId, resource.resourceId, {
          url: image.url,
          urlExpiresAt: image.urlExpiresAt
        });
      total += resource.byteSize;
      if (resource.byteSize > 5 * 1024 * 1024 || total > 10 * 1024 * 1024)
        throw new AgentError(
          'MAR_AGENT_HOST_LIMIT_EXCEEDED',
          'Image input exceeds the supported size limit.'
        );
      resources.push({
        ...resource,
        resourceInputVersion: 1,
        name: image.name
      });
    }
    return resources;
  }
  async persistResource(sessionId: string, image: import('../../../model/image.js').ModelImage) {
    this.#assertOpen();
    return this.#serializeRecordOperation(sessionId, () =>
      this.#withWriteAdmission(
        sessionId,
        () => persistResource(join(this.#sessionDirectory(sessionId), 'resources'), image),
        true
      )
    );
  }
  async setResourceUrl(
    sessionId: string,
    resourceId: string,
    published: { url: string; urlExpiresAt: number }
  ) {
    this.#assertOpen();
    return this.#serializeRecordOperation(sessionId, () =>
      this.#withWriteAdmission(sessionId, () =>
        setResourceUrl(join(this.#sessionDirectory(sessionId), 'resources'), resourceId, published)
      )
    );
  }
  async readResource(sessionId: string, resourceId: string) {
    this.#assertOpen();
    if (!/^[a-f0-9]{64}$/u.test(resourceId)) return undefined;
    return this.#serializeRecordOperation(sessionId, () =>
      withSessionReadPin(this.#sessionRoot(sessionId), async () => {
        await this.#refreshIndex();
        const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
        if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        await this.#segmentPaths(sessionId, meta);
        const directory = join(this.#directoryForMeta(sessionId, meta), 'resources');
        let pending = false;
        try {
          await lstat(join(directory, `.${resourceId}.pending`));
          pending = true;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new AgentError(
              'MAR_AGENT_IMAGE_UNAVAILABLE',
              'Session image resource is unavailable.',
              {
                cause
              }
            );
        }
        if (
          pending &&
          (this.#shared.writerLeases.get(sessionId)?.appendFailure !== undefined ||
            !resourceFiles(await this.#readRecords(sessionId, meta)).has(`${resourceId}.bin`))
        )
          return undefined;
        return readResource(directory, resourceId);
      })
    );
  }
  async writeToolResultResource(sessionId: string, text: string) {
    this.#assertOpen();
    if (!this.#shared.index.sessions.some((item) => item.id === sessionId))
      throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    return this.#serializeRecordOperation(sessionId, () =>
      this.#withWriteAdmission(
        sessionId,
        () => writeToolResultResource(this.#sessionDirectory(sessionId), text),
        true
      )
    );
  }

  async readToolResultResource(sessionId: string, input: ToolResultResourceInput) {
    return withSessionReadPin(this.#sessionRoot(sessionId), async () => {
      this.#assertOpen();
      await this.#refreshIndex();
      if (!this.#shared.index.sessions.some((item) => item.id === sessionId))
        throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      const meta = this.#shared.index.sessions.find((item) => item.id === sessionId)!;
      await this.#segmentPaths(sessionId, meta);
      return readToolResultResource(
        this.#directoryForMeta(sessionId, meta),
        sessionId,
        input,
        async (sequence) => {
          return (
            await this.#shared.historyPages.read(
              meta,
              { beforeSequence: sequence + 1, limit: 1 },
              () => this.#segmentPaths(sessionId, meta)
            )
          ).records.find((record) => record.sequence === sequence);
        }
      );
    });
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
        throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session resource identity is missing.');
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
    return withSessionReadPin(this.#sessionRoot(sessionId), async () => {
      this.#assertOpen();
      if (
        !Number.isSafeInteger(input.sequence) ||
        input.sequence < 1 ||
        input.sequence >= Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(input.imageIndex) ||
        input.imageIndex < 0
      )
        return undefined;
      await this.#refreshIndex();
      const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
      if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      await this.#assertReadable(sessionId, meta);
      const page = await this.#shared.historyPages.read(
        meta,
        {
          limit: 1,
          beforeSequence: input.sequence + 1
        },
        () => this.#segmentPaths(sessionId, meta)
      );
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
        throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session resource identity is missing.');
      const data = await readInputImageBytes(
        join(this.#directoryForMeta(sessionId, meta), 'resources'),
        reference
      );
      return {
        name: reference.name,
        resourceInputVersion: 1,
        resourceId: reference.resourceId,
        mimeType: reference.mimeType,
        byteSize: reference.byteSize,
        sha256: reference.sha256,
        ...(reference.url === undefined ? {} : { url: reference.url }),
        ...(reference.urlExpiresAt === undefined ? {} : { urlExpiresAt: reference.urlExpiresAt }),
        dataBase64: data.toString('base64')
      };
    });
  }
  async forkSession(
    sourceSessionId: string,
    input: { readonly boundaryTurnId: string | null; readonly title: string }
  ) {
    return this.#serializeRecordOperation(sourceSessionId, async () => {
      this.#assertOpen();
      await this.#recoverPendingTreeDelete(sourceSessionId);
      if (this.#shared.writerLeases.has(sourceSessionId))
        throw new AgentError('MAR_AGENT_SESSION_LOCKED', 'Session already has a writer.');
      const sourceRoot = join(this.#shared.root, 'sessions', sourceSessionId);
      const release = await acquireFileLock(join(sourceRoot, 'lock'));
      let sourceFailed = false;
      try {
        await this.#refreshIndex();
        const source = this.#shared.index.sessions.find((item) => item.id === sourceSessionId);
        if (!source) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        if (source.storage?.encoding !== 2) await preflightV1Session(sourceRoot);
        await this.#ensureRootV2();
        const records = await this.#readRecords(sourceSessionId);
        let publicationConfirmed = false;
        return await forkSessionOperation(
          source,
          records,
          input,
          sourceRoot,
          this.#sessionDirectory(sourceSessionId),
          {
            begin: async (target) => {
              const publication = await this.#beginUnpublishedSession(target.id);
              this.#shared.segments.set(target.id, 1);
              this.#shared.pendingSessions.set(target.id, target);
              return publication;
            },
            publish: async (target, copied) => {
              this.#shared.segments.set(target.id, target.segments!.length);
              for (const record of copied) this.#applyRecordToResumeIndex(target, record);
              this.#shared.pendingSessions.delete(target.id);
              this.#shared.index = {
                version: 2,
                revision: this.#shared.index.revision + 1,
                sessions: [target, ...this.#shared.index.sessions]
              };
              this.#shared.pendingPublishIds.add(target.id);
              this.#markIndexDirty(target.id);
              try {
                await this.#saveIndex(undefined, [target.id], () => {
                  publicationConfirmed = true;
                });
              } catch (error) {
                if (!publicationConfirmed) throw error;
              }
            },
            reject: async (target, error) => {
              this.#shared.pendingSessions.delete(target.id);
              if (publicationConfirmed) {
                this.#shared.migrationFailures.set(target.id, { error, unreadable: true });
                return false;
              }
              let disk;
              try {
                disk = await readSessionIndex(join(this.#shared.root, 'sessions', 'index.json'));
              } catch {
                this.#shared.migrationFailures.set(target.id, { error, unreadable: true });
                return false;
              }
              if (!disk || disk.sessions.some((session) => session.id === target.id)) {
                this.#shared.migrationFailures.set(target.id, { error, unreadable: true });
                return false;
              }
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
              return true;
            }
          }
        );
      } catch (error) {
        sourceFailed = true;
        throw error;
      } finally {
        if (sourceFailed) await release().catch(() => undefined);
        else await release();
      }
    });
  }
  /** Replace history under a journal; the indexed transaction ID decides the commit side. */
  async rollbackSession(sessionId: string, input: AgentSessionRollbackInput) {
    this.#assertOpen();
    const release = await this.acquireSessionLease(sessionId);
    let failed = false;
    try {
      const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
      if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      const records = await this.read(sessionId);
      if (records[0]?.type !== 'session.created')
        throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
      const boundaryIndex = rollbackBoundaryIndex(records, input);
      const retained = records
        .slice(0, boundaryIndex + 1)
        .filter((record) => record.type !== 'responses.continuation');
      return await this.#replaceHistory(meta, retained, { kind: 'rollback' });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (failed) await release().catch(() => undefined);
      else await release();
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
      throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session title is required.');
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
      if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      const records = await this.read(sessionId);
      if (records[0]?.type !== 'session.created')
        throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
      const clearedAt = new Date().toISOString();
      const retained: SessionRecord[] = [
        {
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
    const shared = this.#shared;
    let indexConfirmed = false;
    const before = structuredClone(meta);
    const invalidate = (error: unknown) => {
      const writer = shared.writerLeases.get(sessionId);
      if (writer) {
        writer.appendFailure ??= { error };
        writer.historyFailure ??= { error };
        delete writer.codeState;
        delete writer.extensionCheckpoints;
      }
      shared.dirtySessionVersions.delete(sessionId);
      shared.derivedOnlyDirtySessions.delete(sessionId);
      shared.indexDirty = shared.dirtySessionVersions.size > 0;
      shared.segments.delete(sessionId);
    };
    const targetGeneration =
      operation.kind === 'clear' && (meta.storage?.encoding ?? 1) === 1 ? randomUUID() : undefined;
    return withSessionReadDrain(this.#sessionRoot(sessionId), async () => {
      if (targetGeneration !== undefined) {
        const parent = join(this.#sessionRoot(sessionId), 'v2');
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await mkdir(join(parent, targetGeneration), { mode: 0o700 });
        await syncJsonlDirectory(parent);
        await syncJsonlDirectory(this.#sessionRoot(sessionId));
      }
      const result = await replaceSessionHistory(meta, retained, operation, {
        directory: this.#sessionDirectory(sessionId),
        sessionDirectory: this.#sessionRoot(sessionId),
        ...(targetGeneration === undefined ? {} : { targetGeneration }),
        segmentPaths: () => this.#segmentPaths(sessionId),
        settleIndex: (request, recover) =>
          this.#serializeIndexOperation(async () => {
            let current: SessionMeta | undefined;
            let previous: SessionMeta | undefined;
            let previousRevision = 0;
            let previousSegment: number | undefined;
            try {
              if (request.kind === 'recover') throw request.error;
              const change = request.change;
              current = shared.index.sessions.find((item) => item.id === sessionId);
              if (!current)
                throw new AgentError(
                  'MAR_AGENT_SESSION_CORRUPT',
                  'Session index entry is missing.'
                );
              previous = structuredClone(current);
              previousRevision = shared.index.revision;
              previousSegment = shared.segments.get(sessionId);
              if (change.kind === 'rollback') {
                current.title = change.title ?? current.title;
                current.lastActivityAt = new Date().toISOString();
                current.automaticTitlePending = change.state.automaticTitlePending;
                current.resume = change.state.resume;
              } else {
                current.lastActivityAt = change.clearedAt;
                current.resume = {
                  version: 1,
                  userTurns: 0,
                  todoRevision: 0,
                  firstUserMessageIndexed: true
                };
              }
              current.nextSequence = change.nextSequence;
              current.storageTransactionId = change.transactionId;
              current.segments = change.segments;
              if (change.targetGeneration !== undefined)
                current.storage = { encoding: 2, generation: change.targetGeneration };
              shared.segments.set(
                sessionId,
                change.kind === 'clear' ? 1 : (change.segments.at(-1)?.number ?? 1)
              );
              shared.index.revision++;
              this.#markIndexDirty(sessionId);
              await this.#commitIndex(
                undefined,
                [],
                () => {
                  indexConfirmed = true;
                },
                targetGeneration === undefined
                  ? undefined
                  : { before, generation: targetGeneration }
              );
              return { status: 'committed', meta: structuredClone(current) } as const;
            } catch (error) {
              try {
                const selected = await this.#storageTransactionCommitted(
                  sessionId,
                  request.kind === 'apply' ? request.change.transactionId : request.transactionId
                );
                if (selected && !indexConfirmed)
                  throw new AgentError(
                    'MAR_AGENT_SESSION_CORRUPT',
                    'History transaction durability is uncertain.'
                  );
                if (selected) {
                  shared.dirtySessionVersions.delete(sessionId);
                  shared.indexDirty = shared.dirtySessionVersions.size > 0;
                  await recover(true);
                  return { status: 'committed', meta: structuredClone(current!), error } as const;
                }
                await recover(false);
                if (current && previous) {
                  restoreSessionIndexMeta(current, previous);
                  shared.index.revision = previousRevision;
                  if (previousSegment === undefined) shared.segments.delete(sessionId);
                  else shared.segments.set(sessionId, previousSegment);
                  this.#markIndexDirty(sessionId);
                }
                return { status: 'not-committed', error } as const;
              } catch {
                invalidate(error);
                return { status: 'unknown', error } as const;
              }
            }
          })
      });
      if (
        result.status === 'unknown' ||
        (result.status === 'committed' && result.recoveryRequired)
      ) {
        invalidate(result.error);
      }
      if (result.status !== 'committed' || result.error !== undefined) throw result.error;
      shared.migrationFailures.delete(sessionId);
      return {
        id: result.meta.id,
        title: result.meta.title,
        workspace: result.meta.workspace,
        createdAt: result.meta.createdAt,
        lastActivityAt: result.meta.lastActivityAt,
        source: normalizeSessionSource(result.meta.source)
      };
    });
  }
  async getSession(sessionId: string) {
    this.#assertOpen();
    return withSessionReadPin(
      this.#sessionRoot(sessionId),
      async () => {
        await this.#refreshIndex();
        const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
        if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        return {
          id: meta.id,
          title: meta.title,
          workspace: meta.workspace,
          createdAt: meta.createdAt,
          lastActivityAt: meta.lastActivityAt,
          source: normalizeSessionSource(meta.source),
          automaticTitlePending: meta.automaticTitlePending === true
        };
      },
      true
    );
  }
  /** Serialize physical writes and honor cancellation before entering the writer. */
  async append(
    sessionId: string,
    input: SessionRecordInput,
    options: { readonly signal?: AbortSignal } = {}
  ) {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    return this.#serializeRecordOperation(sessionId, () =>
      this.#withWriteAdmission(sessionId, async () => {
        options.signal?.throwIfAborted();
        const writer = this.#shared.writerLeases.get(sessionId);
        try {
          const result = await this.#appendRecord(sessionId, input);
          if (writer?.pendingResource) {
            for (const name of resourceFiles([result]))
              if (name.endsWith('.bin'))
                writer.pendingResource.delete(`image:${name.slice(0, -4)}`);
            for (const resource of recordToolResources(result))
              writer.pendingResource.delete(`tool:${resource.resourceRef}`);
            if (writer.pendingResource.size === 0) {
              delete writer.pendingResource;
              writer.retained--;
              await this.#releaseUnusedWriter(sessionId, writer);
            }
          }
          return result;
        } catch (error) {
          if (writer?.pendingResource && !writer.executing && !writer.appendFailure) {
            delete writer.pendingResource;
            writer.retained--;
            await this.#releaseUnusedWriter(sessionId, writer).catch(() => undefined);
          }
          throw error;
        }
      })
    );
  }
  /** Called inside the Session serial queue; existing leases already own the physical lock. */
  async #withWriteAdmission<T>(
    sessionId: string,
    action: () => Promise<T>,
    holdPending = false
  ): Promise<T> {
    if (this.#shared.pendingSessions.has(sessionId)) return action();
    const existing = this.#shared.writerLeases.get(sessionId);
    if (existing) {
      const recoveryFailure = this.#shared.migrationFailures.get(sessionId);
      if (recoveryFailure) throw recoveryFailure.error;
      if (existing.appendFailure) throw existing.appendFailure.error;
      if (existing.historyFailure) throw existing.historyFailure.error;
      if (existing.maintenance)
        throw new AgentError('MAR_AGENT_SESSION_LOCKED', 'Session is under maintenance.');
      const result = await action();
      if (holdPending && existing.pendingResource) this.#trackPendingResource(existing, result);
      return result;
    }
    const release = await this.#acquireSessionLease(sessionId);
    const writer: SessionWriterLease = { owner: undefined, executing: false, retained: 0, release };
    this.#shared.writerLeases.set(sessionId, writer);
    let failure: unknown;
    try {
      const result = await action();
      if (holdPending) {
        writer.pendingResource = new Set();
        this.#trackPendingResource(writer, result);
        writer.retained++;
      }
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (failure !== undefined)
        await this.#releaseUnusedWriter(sessionId, writer).catch(() => undefined);
      else await this.#releaseUnusedWriter(sessionId, writer);
    }
  }
  #trackPendingResource(writer: SessionWriterLease, value: unknown): void {
    if (!isObject(value) || !writer.pendingResource) return;
    if (typeof value.resourceId === 'string')
      writer.pendingResource.add(`image:${value.resourceId}`);
    if (typeof value.resourceRef === 'string')
      writer.pendingResource.add(`tool:${value.resourceRef}`);
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
    const recoveryFailure = this.#shared.migrationFailures.get(sessionId);
    if (recoveryFailure) throw recoveryFailure.error;
    const writer = this.#shared.writerLeases.get(sessionId);
    if (writer?.appendFailure) throw writer.appendFailure.error;
    const before =
      this.#shared.index.sessions.find((item) => item.id === sessionId) ??
      this.#shared.pendingSessions.get(sessionId);
    if (!before) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    const published = !this.#shared.pendingSessions.has(sessionId);
    return appendSessionRecord(sessionId, input, {
      sequence: before.nextSequence,
      directory: () => this.#sessionDirectory(sessionId),
      readRecordAtSequence: (sequence) => this.#readRecordAtSequence(before, sequence),
      currentSegment: () => this.#currentSegment(sessionId),
      segmentPath: (segment) => this.#segmentPath(sessionId, segment),
      setCurrentSegment: (segment) => this.#shared.segments.set(sessionId, segment),
      markWriteFailure: (error) => {
        if (writer) writer.appendFailure = { error };
      },
      invalidateAfterWriteFailure: () => {
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
      },
      publish: (record, serialized, segment) => {
        // Index refreshes and commits can replace metadata during file I/O. Publish all
        // durable-record metadata onto the current entry without another await boundary.
        const meta =
          this.#shared.index.sessions.find((item) => item.id === sessionId) ??
          this.#shared.pendingSessions.get(sessionId);
        if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
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
        updateSessionCurrentState(
          this.#shared.writerLeases.get(sessionId),
          record.type,
          serialized
        );
      }
    });
  }
  async read(sessionId: string): Promise<SessionRecord[]> {
    return this.#serializeRecordOperation(sessionId, () => this.#readRecords(sessionId));
  }
  async #readRecords(sessionId: string, selectedMeta?: SessionMeta): Promise<SessionRecord[]> {
    return withSessionReadPin(this.#sessionRoot(sessionId), async () => {
      this.#assertOpen();
      if (!selectedMeta) await this.#refreshIndex();
      const failure = this.#shared.writerLeases.get(sessionId)?.historyFailure;
      if (failure) throw failure.error;
      const migrationFailure = this.#shared.migrationFailures.get(sessionId);
      if (migrationFailure?.unreadable) throw migrationFailure.error;
      try {
        const records: SessionRecord[] = [];
        const meta =
          selectedMeta ?? this.#shared.index.sessions.find((item) => item.id === sessionId);
        const encoding = meta?.storage?.encoding ?? 1;
        for (const path of await this.#segmentPaths(sessionId, meta))
          records.push(...(await readRecords(path, encoding)));
        return records;
      } catch (cause) {
        if (cause instanceof AgentError) throw cause;
        throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.', { cause });
      }
    });
  }
  async readCodeModeState(sessionId: string): Promise<CodeModeStateEntry[]> {
    return this.#serializeRecordOperation(sessionId, () =>
      withSessionReadPin(this.#sessionRoot(sessionId), () => this.#readCodeModeState(sessionId))
    );
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
  ): Promise<ExtensionCheckpoint> {
    return this.#serializeRecordOperation(sessionId, () =>
      withSessionReadPin(this.#sessionRoot(sessionId), () =>
        this.#readExtensionCheckpoint(sessionId, extensionId, key)
      )
    );
  }
  async #readExtensionCheckpoint(
    sessionId: string,
    extensionId: string,
    key: string
  ): Promise<ExtensionCheckpoint> {
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
    value: ExtensionJsonValue | undefined,
    expectedRevision: number | undefined,
    input: { owner: object; signal: AbortSignal; executionId?: string; turnId?: string }
  ): Promise<ExtensionCheckpoint> {
    if (
      typeof key !== 'string' ||
      (expectedRevision !== undefined &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
    )
      throw new AgentError(
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
          throw new AgentError(
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
          throw new AgentError(
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
    return this.#serializeRecordOperation(sessionId, () =>
      withSessionReadPin(this.#sessionRoot(sessionId), async () => {
        this.#assertOpen();
        await this.#refreshIndex();
        const failure = this.#shared.writerLeases.get(sessionId)?.historyFailure;
        if (failure) throw failure.error;
        const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
        if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        await this.#assertReadable(sessionId, meta);
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
      })
    );
  }
  /** Compare the planned sequence inside the existing record writer queue. */
  async commitContextGc(
    sessionId: string,
    draft: ContextGcCheckpointDraft,
    planningRecords?: readonly SessionRecord[]
  ): Promise<SessionRecord> {
    this.#assertOpen();
    const records = planningRecords ?? (await this.readExecutionState(sessionId)).contextRecords;
    return this.#serializeRecordOperation(sessionId, () =>
      this.#withWriteAdmission(sessionId, async () => {
        const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
        if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        const boundarySequence = meta.nextSequence - 1;
        if (boundarySequence !== draft.boundarySequence)
          throw new AgentError(
            'MAR_AGENT_SESSION_CORRUPT',
            'Context GC projection changed before checkpoint commit.'
          );
        if (
          records.at(-1)?.sequence !== boundarySequence ||
          records.at(-1)?.sessionId !== sessionId ||
          !sameContextGcBase(contextGcBaseFromRecords(records, boundarySequence), draft.base)
        )
          throw new AgentError(
            'MAR_AGENT_SESSION_CORRUPT',
            'Context GC planning boundary is invalid.'
          );
        const previous = latestValidContextGcCheckpoint(records, boundarySequence);
        if (
          (!draft.inlineMedia || draft.inlineMedia.reason === 'TEXT_GC') &&
          !contextGcCheckpointIntervalEligible(draft.trigger, previous?.payload.trigger)
        )
          throw new AgentError(
            'MAR_AGENT_SESSION_CORRUPT',
            'Context GC checkpoint interval validation failed.'
          );
        const plannedReplacements = normalizeContextGcReplacements(draft.replacements);
        if (!plannedReplacements || (plannedReplacements.length === 0 && !draft.inlineMedia))
          throw new AgentError(
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
          throw new AgentError(
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
          throw new AgentError(
            'MAR_AGENT_SESSION_CORRUPT',
            'Context GC checkpoint validation failed.'
          );
        const turnId = records.findLast((record) => record.type === 'execution.header')?.turnId;
        return this.#appendRecord(sessionId, {
          type: 'context.gc.completed',
          ...(turnId === undefined ? {} : { turnId }),
          payload
        });
      })
    );
  }
  async readPage(
    sessionId: string,
    input: { limit?: number; beforeSequence?: number } = {}
  ): Promise<{ records: SessionRecord[]; previousBeforeSequence?: number }> {
    return withSessionReadPin(this.#sessionRoot(sessionId), async () => {
      await this.#refreshIndex();
      const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
      if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      await this.#assertReadable(sessionId, meta);
      return this.#shared.historyPages.read(meta, input, () => this.#segmentPaths(sessionId, meta));
    });
  }
  async compact(
    sessionId: string,
    input: SessionStoreCompactInput,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<SessionRecord> {
    if (!input.summary.trim())
      throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Compact summary is required.');
    const recoveryFailure = this.#shared.migrationFailures.get(sessionId);
    if (recoveryFailure && this.#shared.writerLeases.has(sessionId)) throw recoveryFailure.error;
    await this.#recoverPendingTreeDelete(sessionId);
    const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
    if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
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
        const adoptPending =
          !!lease.pendingResource && !lease.executing && lease.owner === undefined;
        if (
          lease.maintenance ||
          lease.executing ||
          (!adoptPending && (owner === undefined || lease.owner !== owner))
        )
          throw new AgentError('MAR_AGENT_SESSION_LOCKED', 'Session already has a writer.');
        if (lease.appendFailure) throw lease.appendFailure.error;
        if (adoptPending) lease.owner = owner;
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
          if (current.pendingResource) {
            delete current.pendingResource;
            current.retained--;
          }
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
    owner?: object,
    members?: readonly string[]
  ): Promise<SessionStoreMaintenance> {
    this.#assertOpen();
    const ids = members === undefined ? [sessionId] : [...members];
    if (
      ids.length === 0 ||
      !ids.includes(sessionId) ||
      new Set(ids).size !== ids.length ||
      (kind === 'clear' && (ids.length !== 1 || ids[0] !== sessionId))
    )
      throw new AgentError('MAR_AGENT_SESSION_INVALID', 'Invalid Session maintenance members.');
    ids.sort();
    for (const id of ids) this.#sessionRoot(id);
    await this.#recoverPendingTreeDelete(sessionId);
    return acquireTreeMaintenance({
      sessionId,
      kind,
      tree: async () => {
        await this.#refreshIndex();
        if (ids.some((id) => !this.#shared.index.sessions.some((session) => session.id === id)))
          throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        return ids;
      },
      acquire: (id, holding, registerGate) =>
        this.#serializeRecordOperation(id, async () => {
          this.#assertOpen();
          registerGate(await this.#acquirePublicationGate(id));
          let writer = this.#shared.writerLeases.get(id);
          if (
            writer &&
            (writer.maintenance ||
              owner === undefined ||
              writer.owner !== owner ||
              (kind === 'clear' && writer.executing))
          )
            throw new AgentError('MAR_AGENT_SESSION_LOCKED', 'Session already has a writer.');
          if (!writer) {
            const release =
              kind === 'delete' && !(await sessionDirectoryExists(this.#sessionRoot(id)))
                ? async () => {}
                : await this.#acquireSessionLease(id, kind);
            writer = { owner, executing: false, retained: 0, release };
            this.#shared.writerLeases.set(id, writer);
          }
          writer.maintenance = holding;
          const current = writer;
          return () =>
            this.#serializeRecordOperation(id, async () => {
              delete current.maintenance;
              await this.#releaseUnusedWriter(id, current);
            });
        }),
      admitted: (holding) => this.#maintenance.set(holding, { sessionId, kind }),
      released: (holding) => this.#maintenance.delete(holding)
    });
  }
  #assertMaintenance(
    sessionId: string,
    kind: 'clear' | 'delete',
    holding: SessionStoreMaintenance
  ) {
    const current = this.#maintenance.get(holding);
    if (current?.sessionId !== sessionId || current.kind !== kind)
      throw new AgentError('MAR_AGENT_SESSION_LOCKED', 'Session maintenance ownership is invalid.');
  }
  /** Native writes join their Agent's sole writer, without admitting another Execution. */
  async acquireSessionWriteLease(sessionId: string, owner: object): Promise<() => Promise<void>> {
    return this.#serializeRecordOperation(sessionId, async () => {
      this.#assertOpen();
      let lease = this.#shared.writerLeases.get(sessionId);
      const recoveryFailure = this.#shared.migrationFailures.get(sessionId);
      if (lease && recoveryFailure) throw recoveryFailure.error;
      if (lease && (lease.maintenance || lease.owner !== owner))
        throw new AgentError('MAR_AGENT_SESSION_LOCKED', 'Session already has a writer.');
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
        throw new AgentError(
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
  async #acquireSessionLease(
    sessionId: string,
    mode: 'write' | 'clear' | 'delete' = 'write'
  ): Promise<() => Promise<void>> {
    this.#assertOpen();
    await this.#recoverPendingTreeDelete(sessionId);
    const priorFailure = this.#shared.migrationFailures.get(sessionId);
    if (priorFailure && (mode === 'write' || (mode === 'clear' && priorFailure.unreadable)))
      throw priorFailure.error;
    await this.#refreshIndex();
    if (!this.#shared.index.sessions.some((item) => item.id === sessionId))
      throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    const path = join(this.#shared.root, 'sessions', sessionId, 'lock');
    const release = await acquireFileLock(path, 'Session already has a writer.', 0);
    try {
      const disk = await readSessionIndex(join(this.#shared.root, 'sessions', 'index.json'));
      if (!disk) throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
      const current = disk.sessions.find((item) => item.id === sessionId);
      if (!current) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      if (mode !== 'delete') {
        const sessionRoot = join(this.#shared.root, 'sessions', sessionId);
        if ((current.storage?.encoding ?? 1) === 1) {
          await preflightV1Session(sessionRoot);
          await preflightRetiredRecovery(sessionRoot, sessionRoot);
        } else {
          if (await sessionDirectoryExists(join(sessionRoot, 'storage-transaction.json'))) {
            await preflightV1Session(sessionRoot);
            await preflightRetiredRecovery(sessionRoot, sessionRoot);
          }
          const activeDirectory = this.#directoryForMeta(sessionId, current);
          await preflightV2Recovery(activeDirectory);
          await preflightRetiredRecovery(sessionRoot, activeDirectory);
        }
      }
      await this.#ensureRootV2();
      await rm(join(this.#sessionRoot(sessionId), 'publication-pending'), { force: true });
      if (mode !== 'delete') {
        await withSessionReadDrain(this.#sessionRoot(sessionId), async () => {
          await this.#refreshIndex();
          const sessionRoot = this.#sessionRoot(sessionId);
          const activeDirectory = this.#sessionDirectory(sessionId);
          if (
            activeDirectory !== sessionRoot &&
            (await sessionDirectoryExists(join(sessionRoot, 'storage-transaction.json')))
          )
            await recoverSessionStorageTransaction(
              sessionRoot,
              current.storageTransactionId,
              sessionRoot
            );
          await recoverSessionStorageTransaction(
            activeDirectory,
            current.storageTransactionId,
            sessionRoot
          );
          await recoverContextualWorldStateTransactions(this.#shared.root, current);
          await this.#refreshIndex();
          await this.#reconcileTail(sessionId);
        });
        if (mode === 'clear' && this.#shared.indexDirty) await this.#saveIndex();
        if (mode === 'write' && this.#encoding(sessionId) === 1) {
          if (this.#shared.indexDirty) await this.#saveIndex();
          await this.#migrateV1Session(sessionId);
        }
      }
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
    return async () => {
      let failure: unknown;
      try {
        if (this.#shared.indexDirty) await this.#saveIndex();
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (failure !== undefined) await release().catch(() => undefined);
        else await release();
      }
    };
  }
  /** The Session lock is held; conversion is outside the short index selection transaction. */
  async #migrateV1Session(sessionId: string): Promise<void> {
    const source = join(this.#shared.root, 'sessions', sessionId);
    const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
    if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    const generation = randomUUID();
    const parent = join(source, 'v2');
    const destination = join(parent, generation);
    let commitAttempted = false;
    let visible: 'v1' | 'v2' | 'unknown' = 'v1';
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const candidate = await prepareJsonlV2Generation({
        source,
        destination,
        sessionId,
        nextSequence: meta.nextSequence
      });
      await syncJsonlDirectory(parent);
      await syncJsonlDirectory(source);
      await this.#serializeIndexOperation(async () => {
        const path = join(this.#shared.root, 'sessions', 'index.json');
        const release = await acquireFileLock(join(this.#shared.root, 'sessions', 'index.lock'));
        let failure: unknown;
        try {
          const disk = await readSessionIndex(path);
          const current = disk?.sessions.find((item) => item.id === sessionId);
          if (
            !disk ||
            disk.version !== 2 ||
            !current ||
            current.storage?.encoding !== 1 ||
            current.nextSequence !== meta.nextSequence ||
            current.storageTransactionId !== meta.storageTransactionId
          )
            throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session migration index changed.');
          const replacement: SessionMeta = {
            ...current,
            storage: { encoding: 2, generation },
            segments: candidate.segments
          };
          const updated: SessionIndex = {
            ...disk,
            sessions: disk.sessions.map((entry) => (entry.id === sessionId ? replacement : entry))
          };
          commitAttempted = true;
          try {
            await persistFormatSelection(path, updated);
            visible = 'v2';
          } catch (error) {
            const check = await readSessionIndex(path).catch(() => undefined);
            const choice = check?.sessions.find((entry) => entry.id === sessionId)?.storage;
            visible =
              choice?.encoding === 1
                ? 'v1'
                : choice?.encoding === 2 && choice.generation === generation
                  ? 'v2'
                  : 'unknown';
            throw error;
          }
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          if (failure !== undefined) await release().catch(() => undefined);
          else await release();
        }
        await this.#readCurrentIndex();
      });
      this.#shared.segments.delete(sessionId);
    } catch (error) {
      if (visible === 'v1') {
        // This candidate cannot be selected; preserve the original failure if cleanup fails.
        await rm(destination, { recursive: true, force: true })
          .then(() => syncJsonlDirectory(parent))
          .catch(() => undefined);
      }
      this.#shared.migrationFailures.set(sessionId, {
        error,
        unreadable: commitAttempted && visible !== 'v1'
      });
      throw error;
    }
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
    if (!/^[0-9a-f-]{36}$/iu.test(parentSessionId)) return [];
    return withSessionReadPin(
      this.#sessionRoot(parentSessionId),
      async () => {
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
      },
      true
    );
  }
  async executionConfiguration(
    sessionId: string
  ): Promise<
    | { readonly modelId: string; readonly modelName?: string; readonly reasoningEffort?: string }
    | undefined
  > {
    this.#assertOpen();
    return withSessionReadPin(
      this.#sessionRoot(sessionId),
      async () => {
        await this.#refreshIndex();
        let meta = this.#shared.index.sessions.find((session) => session.id === sessionId);
        if (meta === undefined)
          throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        if (meta.resume?.executionModelIndexed !== true) {
          await this.#ensureExecutionModelIndexed(sessionId);
          meta = this.#shared.index.sessions.find((session) => session.id === sessionId);
          if (meta === undefined)
            throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
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
      },
      true
    );
  }
  async sessionTree(sessionId: string): Promise<readonly string[]> {
    this.#assertOpen();
    return withSessionReadPin(
      this.#sessionRoot(sessionId),
      async () => {
        await this.#refreshIndex();
        if (!this.#shared.index.sessions.some((session) => session.id === sessionId))
          throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        return sessionTreeIds(this.#shared.index.sessions, sessionId);
      },
      true
    );
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
    return (
      await readRecords(
        this.#segmentPath(meta.id, segment.number, meta),
        meta.storage?.encoding ?? 1
      )
    ).find((record) => record.sequence === sequence);
  }
  async #readFromSequence(meta: SessionMeta, sequence: number): Promise<SessionRecord[]> {
    const segments = (meta.segments ?? [])
      .filter((item) => item.lastSequence >= sequence)
      .sort((left, right) => left.number - right.number);
    if (segments.length === 0)
      throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session resume index is invalid.');
    const records: SessionRecord[] = [];
    for (const segment of segments)
      records.push(
        ...(
          await readRecords(
            this.#segmentPath(meta.id, segment.number, meta),
            meta.storage?.encoding ?? 1
          )
        ).filter((record) => record.sequence >= sequence)
      );
    return records;
  }
  async #rebuildExecutionState(meta: SessionMeta): Promise<SessionExecutionState> {
    const state = deriveExecutionState(await this.#readRecords(meta.id, meta));
    if (
      meta.automaticTitlePending !== state.automaticTitlePending ||
      !sameResumeIndex(meta.resume, state.resume)
    ) {
      meta.automaticTitlePending = state.automaticTitlePending;
      meta.resume = state.resume;
      this.#shared.index.revision++;
      if ((meta.storage?.encoding ?? 1) === 2) this.#markIndexDirty(meta.id);
    }
    return {
      automaticTitlePending: state.automaticTitlePending,
      todo: state.todo,
      contextRecords: state.contextRecords
    };
  }
  /** Counts native input records, not the post-Compact model context. */
  async userTurnCount(sessionId: string): Promise<number> {
    return this.#serializeRecordOperation(sessionId, () =>
      withSessionReadPin(this.#sessionRoot(sessionId), async () => {
        this.#assertOpen();
        await this.#refreshIndex();
        const before = this.#shared.index.sessions.find((session) => session.id === sessionId);
        if (!before) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        const indexed = before.resume?.userTurns;
        if (indexed !== undefined && this.#shared.writerLeases.has(sessionId)) return indexed;
        const nextSequence = before.nextSequence;
        const transactionId = before.storageTransactionId;
        const paths = await this.#segmentPaths(sessionId, before);
        const encoding = before.storage?.encoding ?? 1;
        let count = indexed ?? 0;
        let lastSequence = 0;
        let reachedPrefix = false;
        if (indexed !== undefined) {
          // No local writer: a previous writer may have committed bytes but not its index.
          for (const path of [...paths].reverse()) {
            for await (const record of readRecordsFromTail(path, undefined, encoding)) {
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
            for await (const record of readRecordsFromHead(path, encoding)) {
              lastSequence = record.sequence;
              if (isNativeUserTurn(record)) count++;
            }
          }
        }
        await this.#refreshIndex();
        const current = this.#shared.index.sessions.find((session) => session.id === sessionId);
        if (!current) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        if (current.storageTransactionId !== transactionId) {
          // The indexed prefix no longer belongs to this history. Fall back to the
          // ordinary physical read boundary without caching or a conflict error.
          count = 0;
          for (const path of await this.#segmentPaths(sessionId, current))
            for await (const record of readRecordsFromHead(path, current.storage?.encoding ?? 1))
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
      })
    );
  }

  async firstUserMessagePreview(sessionId: string): Promise<string | undefined> {
    return withSessionReadPin(this.#sessionRoot(sessionId), async () => {
      this.#assertOpen();
      await this.#refreshIndex();
      await this.#ensureFirstUserMessageIndexed(sessionId);
      return this.#shared.index.sessions.find((session) => session.id === sessionId)?.resume
        ?.firstUserMessagePreview;
    });
  }
  async #ensureFirstUserMessageIndexed(sessionId: string): Promise<void> {
    for (;;) {
      const before = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (before === undefined)
        throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      if (before.resume?.firstUserMessageIndexed === true) return;
      const nextSequence = before.nextSequence;
      const transactionId = before.storageTransactionId;
      let preview: string | undefined;
      try {
        for (const path of await this.#segmentPaths(sessionId, before)) {
          for await (const record of readRecordsFromHead(path, before.storage?.encoding ?? 1)) {
            preview = userMessagePreviewFromRecord(record);
            if (preview !== undefined) break;
          }
          if (preview !== undefined) break;
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          !(error instanceof AgentError && error.code === 'MAR_AGENT_SESSION_NOT_FOUND')
        )
          throw error;
      }
      await this.#refreshIndex();
      const current = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (current === undefined)
        throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
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
        throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      if (before.resume?.executionModelIndexed === true) return;
      const nextSequence = before.nextSequence;
      const transactionId = before.storageTransactionId;
      const model = await this.#readLatestExecutionModel(sessionId);
      // Refresh can replace metadata objects while unrelated sessions are being read.
      // Merge only into the current entry, and retry if the authoritative history changed.
      await this.#refreshIndex();
      const current = this.#shared.index.sessions.find((session) => session.id === sessionId);
      if (current === undefined)
        throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
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
      if ((current.storage?.encoding ?? 1) === 2) this.#markIndexDirty(sessionId);
      return;
    }
  }
  async #readLatestExecutionModel(
    sessionId: string
  ): Promise<ReturnType<typeof executionModelFromRecord>> {
    return withSessionReadPin(this.#sessionRoot(sessionId), async () => {
      try {
        const meta = this.#shared.index.sessions.find((item) => item.id === sessionId);
        for (const path of (await this.#segmentPaths(sessionId, meta)).reverse())
          for await (const record of readRecordsFromTail(
            path,
            undefined,
            meta?.storage?.encoding ?? 1
          )) {
            const model = executionModelFromRecord(record);
            if (model !== undefined) return model;
          }
        return undefined;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error instanceof AgentError && error.code === 'MAR_AGENT_SESSION_NOT_FOUND')
        )
          return undefined;
        throw error;
      }
    });
  }
  async #withTreeReadDrains<T>(ids: readonly string[], action: () => Promise<T>): Promise<T> {
    const ordered = [...ids].sort();
    const take = (index: number): Promise<T> =>
      index === ordered.length
        ? action()
        : withSessionReadDrain(this.#sessionRoot(ordered[index]!), () => take(index + 1));
    return take(0);
  }
  async #treeDeleteCommitted(transaction: SessionTreeDeleteTransaction): Promise<boolean> {
    const root = join(this.#shared.root, 'sessions');
    return this.#serializeIndexOperation(async () => {
      const release = await acquireFileLock(join(root, 'index.lock'));
      let failure: unknown;
      try {
        // Lock against another rename between durability confirmation and reading the decision.
        await syncJsonlDirectory(root);
        const disk = await readSessionIndex(join(root, 'index.json'));
        if (!disk) throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
        const count = transaction.members.filter((member) =>
          disk.sessions.some((entry) => entry.id === member.id)
        ).length;
        if (count !== 0 && count !== transaction.members.length)
          throw new AgentError(
            'MAR_AGENT_SESSION_CORRUPT',
            'Session deletion outcome is indeterminate.'
          );
        if (count !== 0)
          for (const member of transaction.members) {
            const current = disk.sessions.find((entry) => entry.id === member.id)!;
            const identity = member.identity;
            if (
              current.createdAt !== identity.createdAt ||
              current.workspace !== identity.workspace ||
              current.nextSequence !== identity.nextSequence ||
              current.storageTransactionId !== identity.storageTransactionId ||
              !isDeepStrictEqual(current.source, identity.source) ||
              !isDeepStrictEqual(current.storage, identity.storage)
            )
              throw new AgentError(
                'MAR_AGENT_SESSION_CORRUPT',
                'Session deletion identity changed.'
              );
          }
        return count === 0;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (failure !== undefined) await release().catch(() => undefined);
        else await release();
      }
    });
  }
  async #recoverPendingTreeDelete(sessionId: string): Promise<void> {
    this.#sessionRoot(sessionId);
    const root = join(this.#shared.root, 'sessions');
    const transaction = await readTreeDeleteTransaction(root, sessionId);
    if (!transaction) return;
    const releases: Array<() => Promise<void>> = [];
    let failure: unknown;
    try {
      for (const member of [...transaction.members].sort((a, b) => a.id.localeCompare(b.id))) {
        if (await sessionDirectoryExists(join(root, member.id)))
          releases.push(
            await acquireFileLock(join(root, member.id, 'lock'), 'Session already has a writer.', 0)
          );
      }
      await this.#withTreeReadDrains(
        transaction.members.map((member) => member.id),
        async () => {
          // Confirm the journal phase is durable before choosing its recovery path.
          await syncJsonlDirectory(join(root, '.delete-pending'));
          const current = await readTreeDeleteTransaction(root, sessionId);
          if (!current) return;
          if (current.id !== transaction.id)
            throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session deletion journal changed.');
          if (current.phase === 'preparing' || current.phase === 'restored')
            await finishTreeDeletePreparation(root, current, syncJsonlDirectory);
          else {
            const committed = await this.#treeDeleteCommitted(current);
            await finishTreeDelete(root, current, committed, syncJsonlDirectory);
          }
        }
      );
      for (const member of transaction.members) this.#shared.migrationFailures.delete(member.id);
      await this.#refreshIndex();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      let releaseFailure: unknown;
      for (const release of releases.reverse()) {
        try {
          await release();
        } catch (error) {
          releaseFailure ??= error;
        }
      }
      if (failure === undefined && releaseFailure !== undefined) throw releaseFailure;
    }
  }
  async delete(
    sessionId: string,
    maintenance?: SessionStoreMaintenance
  ): Promise<{ readonly deleted: boolean }> {
    this.#assertOpen();
    const holding = maintenance ?? (await this.acquireSessionMaintenance(sessionId, 'delete'));
    this.#assertMaintenance(sessionId, 'delete', holding);
    const tree = [sessionId, ...holding.sessionIds.filter((id) => id !== sessionId)];
    let failed = false;
    try {
      // Same-owner Executions may have left newer target metadata dirty in memory.
      // Publish that state before using it as the tree deletion CAS baseline.
      if (this.#shared.indexDirty) await this.#saveIndex();
      const root = join(this.#shared.root, 'sessions');
      const expected = tree.map((id) => {
        const meta = this.#shared.index.sessions.find((entry) => entry.id === id);
        if (!meta) throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
        return structuredClone(meta);
      });
      const members = await Promise.all(
        expected.map(async (meta) => ({
          id: meta.id,
          existed: await sessionDirectoryExists(this.#sessionRoot(meta.id)),
          identity: {
            createdAt: meta.createdAt,
            workspace: meta.workspace,
            ...(meta.source === undefined ? {} : { source: meta.source }),
            ...(meta.storage === undefined ? {} : { storage: meta.storage }),
            ...(meta.storageTransactionId === undefined
              ? {}
              : { storageTransactionId: meta.storageTransactionId }),
            nextSequence: meta.nextSequence
          }
        }))
      );
      const deleted = members.find((member) => member.id === sessionId)?.existed ?? false;
      const transaction: SessionTreeDeleteTransaction = {
        version: 1,
        kind: 'delete',
        id: randomUUID(),
        members
      };
      await this.#withTreeReadDrains(tree, async () => {
        let committed = false;
        try {
          await beginTreeDeleteTransaction(root, transaction, syncJsonlDirectory);
          await stageTreeDelete(root, transaction, syncJsonlDirectory);
          await this.#serializeIndexOperation(() =>
            this.#commitIndex(
              tree,
              [],
              () => {
                committed = true;
              },
              undefined,
              expected
            )
          );
          await finishTreeDelete(root, transaction, true, syncJsonlDirectory);
        } catch (error) {
          try {
            let pending = await readTreeDeleteTransaction(root, sessionId);
            if (pending && pending.id !== transaction.id)
              throw new AgentError(
                'MAR_AGENT_SESSION_CORRUPT',
                'Session deletion journal changed.'
              );
            if (pending) {
              await syncJsonlDirectory(join(root, '.delete-pending'));
              pending = await readTreeDeleteTransaction(root, sessionId);
              if (!pending || pending.id !== transaction.id)
                throw new AgentError(
                  'MAR_AGENT_SESSION_CORRUPT',
                  'Session deletion journal changed.'
                );
              if (pending.phase === 'preparing' || pending.phase === 'restored')
                await finishTreeDeletePreparation(root, pending, syncJsonlDirectory);
              else {
                if (!committed) committed = await this.#treeDeleteCommitted(pending);
                await finishTreeDelete(root, pending, committed, syncJsonlDirectory);
              }
              await this.#refreshIndex();
            }
          } catch {
            for (const member of members)
              this.#shared.migrationFailures.set(member.id, { error, unreadable: true });
          }
          throw error;
        }
      });
      for (const id of tree) this.#shared.segments.delete(id);
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
      throw new AgentError('MAR_AGENT_DISPOSED', 'Session store is closed.');
  }
  #markIndexDirty(sessionId: string, derivedOnly = false): void {
    if (derivedOnly && this.#encoding(sessionId) === 1) return;
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
    if (!disk) throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
    const session = disk.sessions.find((item) => item.id === sessionId);
    if (!session)
      throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index entry is missing.');
    return session.storageTransactionId === transactionId;
  }
  #segmentPath(sessionId: string, segment: number, meta?: SessionMeta) {
    return join(
      meta ? this.#directoryForMeta(sessionId, meta) : this.#sessionDirectory(sessionId),
      `events-${String(segment).padStart(6, '0')}.jsonl`
    );
  }
  async #assertReadable(sessionId: string, meta: SessionMeta): Promise<void> {
    const failure = this.#shared.migrationFailures.get(sessionId);
    if (failure?.unreadable) throw failure.error;
    const historyFailure = this.#shared.writerLeases.get(sessionId)?.historyFailure;
    if (historyFailure) throw historyFailure.error;
    const directories = new Set([
      this.#sessionRoot(sessionId),
      this.#directoryForMeta(sessionId, meta)
    ]);
    for (const directory of directories) {
      try {
        await lstat(join(directory, 'storage-transaction.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session recovery is required.');
    }
  }
  async #segmentPaths(sessionId: string, meta?: SessionMeta) {
    const migrationFailure = this.#shared.migrationFailures.get(sessionId);
    if (migrationFailure?.unreadable) throw migrationFailure.error;
    const failure = this.#shared.writerLeases.get(sessionId)?.historyFailure;
    if (failure) throw failure.error;
    const selected = meta ?? this.#shared.index.sessions.find((item) => item.id === sessionId);
    if (selected) await this.#assertReadable(sessionId, selected);
    const directory = meta
      ? this.#directoryForMeta(sessionId, meta)
      : this.#sessionDirectory(sessionId);
    const entries = await readdir(directory);
    if (entries.includes('storage-transaction.json'))
      throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session recovery is required.');
    const names = entries.filter((name) => /^events-\d{6}\.jsonl$/.test(name)).sort();
    if (names.length === 0)
      throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
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
    const { records, segment } = await recoverJsonlTail(
      this.#sessionDirectory(sessionId),
      latestPath,
      () => this.#readRecords(sessionId),
      this.#encoding(sessionId)
    );
    const last = records.at(-1);
    this.#shared.segments.set(sessionId, segment);
    if (last === undefined)
      throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
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
    await JsonlSessionStore.#pool.release(this.#shared, () => {
      const pending = [...this.#shared.writerLeases.entries()].filter(
        ([, writer]) => writer.pendingResource && !writer.executing && !writer.maintenance
      );
      if (!pending.length && !this.#shared.indexDirty) return undefined;
      return (async () => {
        for (const [sessionId, writer] of pending) {
          delete writer.pendingResource;
          writer.retained--;
          await this.#releaseUnusedWriter(sessionId, writer);
        }
        if (this.#shared.indexDirty) await this.#saveIndex();
      })();
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
