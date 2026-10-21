import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { imageRefSchema } from '@myagentroam/protocol';
import type { CodexComposerInput } from '../codex-app-server.js';
import type { NodeAgentSession } from '../database.js';
import type { NodeMessageAttachmentInput } from '../runtime-model.js';
import type { NativeTranscriptImageAttachment } from '../native-session-history.js';
import {
  AttachmentDomainState,
  type SessionAttachmentRetention
} from './attachment-domain-state.js';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const IMAGE_CACHE_TTL_MS = 60 * 60_000;
const NATIVE_IMAGE_SOURCE_TTL_MS = 60 * 60_000;
const SESSION_ATTACHMENT_IDLE_TTL_MS = 30 * 60_000;

export interface CachedRunImages {
  images: readonly NodeMessageAttachmentInput[];
  localPaths: readonly (string | undefined)[];
  expiresAt: number | undefined;
  timer: NodeJS.Timeout | undefined;
}

interface NativeFileImageSource {
  readonly kind: 'file';
  readonly name: string;
  readonly mime: string;
  readonly path: string;
  readonly root: string;
}

interface NativeReaderImageSource {
  readonly kind: 'reader';
  readonly name: string;
  readonly mime: string;
  readonly byteSize?: number;
  readonly sourceId: string;
  readonly read: NonNullable<NativeTranscriptImageAttachment['read']>;
}

export type NativeImageSource = NativeFileImageSource | NativeReaderImageSource;

export interface NativeImageRegistrationOptions {
  readonly reuseCachedRunImages?: boolean;
}

export type RunnerImageAttachment = NodeMessageAttachmentInput & {
  readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
};

export class RunAttachmentService {
  readonly state = new AttachmentDomainState<CachedRunImages, NativeImageSource>();
  private disposed = false;
  private readonly fileResources = new Map<string, { workspaceId: string; path: string }>();

  constructor(
    private readonly nativeImageRoots: (session: NodeAgentSession) => readonly string[],
    private readonly sessionIsBusy: (sessionId: string) => boolean = () => false,
    private readonly temporaryRoot: () => string = () => {
      throw new Error('NODE_CONFIG_UNAVAILABLE');
    }
  ) {}

  protectSession(sessionId: string): () => void {
    this.assertOpen();
    const retained = this.sessionRetention(sessionId);
    retained.protections += 1;
    this.stopSessionTimer(retained);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.state.sessionRetentions.get(retained.sessionId);
      if (current === undefined) return;
      current.protections -= 1;
      this.refreshSession(current.sessionId);
    };
  }

  acceptSessionInput(sessionId: string): void {
    const retained = this.state.sessionRetentions.get(sessionId);
    if (retained === undefined) return;
    this.stopSessionTimer(retained);
    retained.deadline = undefined;
    this.refreshSession(sessionId);
  }

  retainSessionFiles(sessionId: string, runId: string): void {
    this.assertOpen();
    if (!this.state.runFileDirectories.has(runId)) return;
    const retained = this.sessionRetention(sessionId);
    retained.runs.add(runId);
    this.state.runFileSessions.set(runId, sessionId);
    this.refreshSession(sessionId);
  }

  adoptSessionFiles(
    sessionId: string,
    runId: string,
    directories: readonly string[],
    workspaceId: string,
    paths: readonly string[]
  ): void {
    this.assertOpen();
    if (directories.length === 0) return;
    this.state.runFileDirectories.set(runId, [...directories]);
    this.registerFileResources(workspaceId, paths);
    this.retainSessionFiles(sessionId, runId);
  }

  resourcePath(path: string): string {
    return `mar-attachment://${basename(dirname(path))}/${basename(path)}`;
  }

  fileResource(workspaceId: string, resourcePath: string): string | undefined {
    const resource = this.fileResources.get(resourcePath);
    return resource?.workspaceId === workspaceId ? resource.path : undefined;
  }

  private registerFileResources(workspaceId: string, paths: readonly string[]): void {
    for (const path of paths)
      this.fileResources.set(this.resourcePath(path), { workspaceId, path });
  }

  refreshSession(sessionId: string): void {
    if (this.disposed) return;
    const retained = this.state.sessionRetentions.get(sessionId);
    if (retained === undefined) return;
    this.stopSessionTimer(retained);
    if (retained.protections > 0) return;
    if (this.sessionIsBusy(sessionId)) {
      retained.deadline = undefined;
      return;
    }
    if (retained.runs.size === 0) {
      this.state.sessionRetentions.delete(sessionId);
      return;
    }
    retained.deadline ??= Date.now() + SESSION_ATTACHMENT_IDLE_TTL_MS;
    const timer = setTimeout(
      async () => {
        if (this.state.sessionRetentions.get(sessionId) !== retained || retained.timer !== timer)
          return;
        retained.timer = undefined;
        if (retained.protections > 0 || this.sessionIsBusy(sessionId)) {
          this.refreshSession(sessionId);
          return;
        }
        await this.releaseSession(sessionId);
      },
      Math.max(0, retained.deadline - Date.now())
    );
    timer.unref();
    retained.timer = timer;
  }

  migrateSession(previousId: string, nextId: string): void {
    if (previousId === nextId) return;
    const previous = this.state.sessionRetentions.get(previousId);
    if (previous === undefined) return;
    this.stopSessionTimer(previous);
    const existing = this.state.sessionRetentions.get(nextId);
    if (existing !== undefined) {
      this.stopSessionTimer(existing);
      for (const runId of previous.runs) existing.runs.add(runId);
      existing.protections += previous.protections;
      existing.deadline = Math.max(existing.deadline ?? 0, previous.deadline ?? 0) || undefined;
    } else this.state.sessionRetentions.set(nextId, previous);
    previous.sessionId = nextId;
    this.state.sessionRetentions.delete(previousId);
    for (const runId of previous.runs) this.state.runFileSessions.set(runId, nextId);
    this.refreshSession(nextId);
  }

  async discardFiles(runId: string): Promise<void> {
    const directories = this.state.runFileDirectories.get(runId);
    this.state.runFileDirectories.delete(runId);
    if (directories !== undefined)
      for (const [resourcePath, resource] of this.fileResources)
        if (directories.includes(dirname(resource.path))) this.fileResources.delete(resourcePath);
    const sessionId = this.state.runFileSessions.get(runId);
    this.state.runFileSessions.delete(runId);
    if (sessionId !== undefined) {
      this.state.sessionRetentions.get(sessionId)?.runs.delete(runId);
      this.refreshSession(sessionId);
    }
    if (directories !== undefined)
      await Promise.all(
        directories.map((directory) =>
          rm(directory, { recursive: true, force: true }).catch(() => undefined)
        )
      );
  }

  async releaseSession(sessionId: string): Promise<void> {
    const retained = this.state.sessionRetentions.get(sessionId);
    if (retained === undefined) return;
    this.stopSessionTimer(retained);
    this.state.sessionRetentions.delete(sessionId);
    await Promise.all([...retained.runs].map((runId) => this.discardFiles(runId)));
  }

  private sessionRetention(sessionId: string): SessionAttachmentRetention {
    const existing = this.state.sessionRetentions.get(sessionId);
    if (existing !== undefined) return existing;
    const retained: SessionAttachmentRetention = {
      sessionId,
      runs: new Set(),
      protections: 0,
      deadline: undefined,
      timer: undefined
    };
    this.state.sessionRetentions.set(sessionId, retained);
    return retained;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('NODE_STOPPED');
  }

  private stopSessionTimer(retained: SessionAttachmentRetention): void {
    if (retained.timer !== undefined) clearTimeout(retained.timer);
    retained.timer = undefined;
  }

  async materializeCodex(
    runId: string,
    attachments: readonly RunnerImageAttachment[]
  ): Promise<readonly Extract<CodexComposerInput, { readonly type: 'localImage' }>[]> {
    if (attachments.length === 0) return [];
    this.assertOpen();
    const directory = await mkdtemp(join(tmpdir(), 'myagentroam-attachment-'));
    this.state.runDirectories.set(runId, directory);
    try {
      this.assertOpen();
      const inputs = await Promise.all(
        attachments.map(async (attachment, index) => {
          const extension = attachment.mime.slice('image/'.length).replace('jpeg', 'jpg');
          const path = join(directory, `${index + 1}.${extension}`);
          await writeFile(path, Buffer.from(attachment.dataBase64, 'base64'), { mode: 0o600 });
          return { type: 'localImage' as const, path };
        })
      );
      this.assertOpen();
      const cached = this.state.runImages.get(runId);
      if (cached !== undefined) cached.localPaths = inputs.map((input) => input.path);
      return inputs;
    } catch (error) {
      this.cleanup(runId);
      throw error;
    }
  }

  async persistFiles(
    workspaceId: string,
    runId: string,
    attachments: readonly NodeMessageAttachmentInput[]
  ): Promise<readonly string[]> {
    if (attachments.length === 0) return [];
    this.assertOpen();
    const filesDirectory = this.temporaryRoot();
    await mkdir(filesDirectory, { recursive: true, mode: 0o700 });
    const filesMetadata = await lstat(filesDirectory);
    if (!filesMetadata.isDirectory() || filesMetadata.isSymbolicLink())
      throw new Error('MESSAGE_ATTACHMENT_DIRECTORY_INVALID');
    const createdDirectories: string[] = [];
    try {
      const paths: string[] = [];
      for (const attachment of attachments) {
        this.assertOpen();
        const directory = join(filesDirectory, randomUUID());
        await mkdir(directory, { mode: 0o700 });
        createdDirectories.push(directory);
        this.state.runFileDirectories.set(runId, [
          ...(this.state.runFileDirectories.get(runId) ?? []),
          directory
        ]);
        const path = join(directory, attachment.name);
        await writeFile(path, Buffer.from(attachment.dataBase64, 'base64'), {
          flag: 'wx',
          mode: 0o600
        });
        paths.push(path);
      }
      this.assertOpen();
      this.registerFileResources(workspaceId, paths);
      return paths;
    } catch (error) {
      const directories = this.state.runFileDirectories.get(runId);
      if (directories !== undefined) {
        const retained = directories.filter((directory) => !createdDirectories.includes(directory));
        if (retained.length === 0) this.state.runFileDirectories.delete(runId);
        else this.state.runFileDirectories.set(runId, retained);
      }
      await Promise.all(
        createdDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
      );
      throw error;
    }
  }

  cleanup(runId: string): void {
    const directory = this.state.runDirectories.get(runId);
    if (directory !== undefined) {
      this.state.runDirectories.delete(runId);
      void rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!this.state.runFileSessions.has(runId)) void this.discardFiles(runId);
  }

  cache(runId: string, images: readonly NodeMessageAttachmentInput[]): void {
    if (images.length === 0) return;
    this.assertOpen();
    this.clear(runId);
    this.state.runImages.set(runId, {
      images,
      localPaths: images.map(() => undefined),
      expiresAt: undefined,
      timer: undefined
    });
  }

  move(previousId: string, nextId: string): void {
    const images = this.state.runImages.get(previousId);
    if (images !== undefined) {
      this.state.runImages.delete(previousId);
      this.state.runImages.set(nextId, images);
    }
    const directory = this.state.runDirectories.get(previousId);
    if (directory !== undefined) {
      this.state.runDirectories.delete(previousId);
      this.state.runDirectories.set(nextId, directory);
    }
    const fileDirectory = this.state.runFileDirectories.get(previousId);
    if (fileDirectory !== undefined) {
      this.state.runFileDirectories.delete(previousId);
      this.state.runFileDirectories.set(nextId, fileDirectory);
    }
    const sessionId = this.state.runFileSessions.get(previousId);
    if (sessionId !== undefined) {
      this.state.runFileSessions.delete(previousId);
      this.state.runFileSessions.set(nextId, sessionId);
      const retained = this.state.sessionRetentions.get(sessionId);
      retained?.runs.delete(previousId);
      retained?.runs.add(nextId);
    }
  }

  append(
    runId: string,
    images: readonly NodeMessageAttachmentInput[]
  ): readonly Record<string, unknown>[] {
    if (images.length === 0) return [];
    const cached = this.state.runImages.get(runId);
    const existing = cached?.images ?? [];
    const imageIndex = existing.length;
    const next = [...existing, ...images];
    if (cached === undefined)
      this.state.runImages.set(runId, {
        images: next,
        localPaths: images.map(() => undefined),
        expiresAt: undefined,
        timer: undefined
      });
    else {
      cached.images = next;
      cached.localPaths = [...cached.localPaths, ...images.map(() => undefined)];
    }
    return images.map((image, index) => ({
      name: image.name,
      mime: image.mime,
      byteSize: Buffer.byteLength(image.dataBase64, 'base64'),
      runId,
      imageIndex: imageIndex + index
    }));
  }

  read(runId: string, imageIndex: number): NodeMessageAttachmentInput | undefined {
    const cached = this.state.runImages.get(runId);
    if (cached === undefined) return undefined;
    if (cached.expiresAt !== undefined && cached.expiresAt <= Date.now()) {
      this.clear(runId);
      return undefined;
    }
    return cached.images[imageIndex];
  }

  registerNative(
    session: NodeAgentSession,
    images: readonly NativeTranscriptImageAttachment[]
  ): readonly Record<string, unknown>[] {
    return this.registerNativeImages(
      `native-history:${session.id}`,
      this.nativeImageRoots(session),
      images
    );
  }

  registerNativeImages(
    runId: string,
    nativeRoots: readonly string[],
    images: readonly NativeTranscriptImageAttachment[],
    options: NativeImageRegistrationOptions = {}
  ): readonly Record<string, unknown>[] {
    const roots = nativeRoots.map((root) => resolve(root));
    const sources =
      this.state.nativeHistoryImages.get(runId) ?? new Map<string, NativeImageSource>();
    const attachments: Record<string, unknown>[] = [];
    for (const image of images) {
      const cached =
        options.reuseCachedRunImages === false || image.localPath === undefined
          ? undefined
          : this.cachedAttachmentByPath(image.localPath);
      if (cached !== undefined) {
        attachments.push(cached);
        continue;
      }
      if (image.read !== undefined) {
        if (
          typeof image.sourceId !== 'string' ||
          image.sourceId.length === 0 ||
          !image.mime.startsWith('image/')
        ) {
          attachments.push({ name: image.name, mime: image.mime });
          continue;
        }
        const imageRef = nativeImageReference('reader', image.sourceId);
        if (imageRef === undefined) {
          attachments.push({ name: image.name, mime: image.mime });
          continue;
        }
        const source: NativeReaderImageSource = {
          kind: 'reader',
          name: image.name,
          mime: image.mime,
          ...(image.byteSize === undefined ? {} : { byteSize: image.byteSize }),
          sourceId: image.sourceId,
          read: image.read
        };
        sources.set(imageRef, source);
        attachments.push({
          name: image.name,
          mime: image.mime,
          ...(image.byteSize === undefined ? {} : { byteSize: image.byteSize }),
          runId,
          imageRef
        });
        continue;
      }
      if (image.localPath !== undefined && isComposerTemporaryImagePath(image.localPath)) continue;
      if (roots.length === 0) continue;
      if (image.localPath === undefined || !image.mime.startsWith('image/')) {
        attachments.push({ name: image.name, mime: image.mime });
        continue;
      }
      const path = resolve(image.localPath);
      const root = roots.find((candidate) => {
        const relation = relative(candidate, path);
        return relation.length > 0 && !relation.startsWith('..') && !isAbsolute(relation);
      });
      if (root === undefined) {
        attachments.push({ name: image.name, mime: image.mime });
        continue;
      }
      // Derive identity from the original source, never its registration position.
      // The path digest hides physical paths; it is not a content/version hash.
      const imageRef = nativeImageReference(
        'file',
        image.sourceId === undefined
          ? createHash('sha256').update(path).digest('hex')
          : image.sourceId
      );
      if (imageRef === undefined) {
        attachments.push({ name: image.name, mime: image.mime });
        continue;
      }
      const previous = sources.get(imageRef);
      if (previous !== undefined && (previous.kind !== 'file' || previous.path !== path)) {
        attachments.push({ name: image.name, mime: image.mime });
        continue;
      }
      sources.set(imageRef, { kind: 'file', name: image.name, mime: image.mime, path, root });
      attachments.push({ name: image.name, mime: image.mime, runId, imageRef });
    }
    if (sources.size > 0) {
      this.state.nativeHistoryImages.set(runId, sources);
      const previousTimer = this.state.nativeHistoryImageTimers.get(runId);
      if (previousTimer !== undefined) clearTimeout(previousTimer);
      const timer = setTimeout(() => {
        this.state.nativeHistoryImageTimers.delete(runId);
        this.state.nativeHistoryImages.delete(runId);
      }, NATIVE_IMAGE_SOURCE_TTL_MS);
      timer.unref();
      this.state.nativeHistoryImageTimers.set(runId, timer);
    }
    return attachments;
  }

  private cachedAttachmentByPath(path: string): Record<string, unknown> | undefined {
    const wanted = resolve(path);
    for (const [runId, cached] of this.state.runImages) {
      if (cached.expiresAt !== undefined && cached.expiresAt <= Date.now()) {
        this.clear(runId);
        continue;
      }
      const imageIndex = cached.localPaths.findIndex(
        (candidate) => candidate !== undefined && resolve(candidate) === wanted
      );
      if (imageIndex < 0) continue;
      const image = cached.images[imageIndex];
      if (image === undefined) continue;
      return {
        name: image.name,
        mime: image.mime,
        byteSize: Buffer.byteLength(image.dataBase64, 'base64'),
        runId,
        imageIndex
      };
    }
    return undefined;
  }

  async readNative(
    runId: string,
    imageRef: string
  ): Promise<NodeMessageAttachmentInput | undefined> {
    const source = this.state.nativeHistoryImages.get(runId)?.get(imageRef);
    if (source === undefined) return undefined;
    try {
      if (source.kind === 'reader') {
        const image = await source.read();
        if (
          image === undefined ||
          image.name !== source.name ||
          image.mime !== source.mime ||
          !canonicalBase64(image.dataBase64)
        )
          return undefined;
        const byteSize = Buffer.byteLength(image.dataBase64, 'base64');
        if (
          byteSize <= 0 ||
          byteSize > MAX_ATTACHMENT_BYTES ||
          (source.byteSize !== undefined && source.byteSize !== byteSize)
        )
          return undefined;
        return { name: source.name, mime: source.mime, dataBase64: image.dataBase64 };
      }
      const [actualRoot, actualPath] = await Promise.all([
        realpath(source.root),
        realpath(source.path)
      ]);
      const relation = relative(actualRoot, actualPath);
      if (relation.length === 0 || relation.startsWith('..') || isAbsolute(relation))
        return undefined;
      const info = await lstat(actualPath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_ATTACHMENT_BYTES) return undefined;
      return {
        name: source.name,
        mime: source.mime,
        dataBase64: (await readFile(actualPath)).toString('base64')
      };
    } catch {
      return undefined;
    }
  }

  expire(runId: string): void {
    const cached = this.state.runImages.get(runId);
    if (cached === undefined || cached.expiresAt !== undefined) return;
    cached.expiresAt = Date.now() + IMAGE_CACHE_TTL_MS;
    cached.timer = setTimeout(() => this.clear(runId), IMAGE_CACHE_TTL_MS);
  }

  clear(runId: string): void {
    const cached = this.state.runImages.get(runId);
    if (cached?.timer !== undefined) clearTimeout(cached.timer);
    this.state.runImages.delete(runId);
  }

  dispose(): void {
    this.disposed = true;
    for (const retained of this.state.sessionRetentions.values()) this.stopSessionTimer(retained);
    this.state.sessionRetentions.clear();
    this.state.runFileSessions.clear();
    for (const runId of new Set([
      ...this.state.runDirectories.keys(),
      ...this.state.runFileDirectories.keys()
    ]))
      this.cleanup(runId);
    for (const runId of this.state.runImages.keys()) this.clear(runId);
    for (const timer of this.state.nativeHistoryImageTimers.values()) clearTimeout(timer);
    this.state.nativeHistoryImageTimers.clear();
    this.state.nativeHistoryImages.clear();
  }
}

function nativeImageReference(kind: 'file' | 'reader', identity: string): string | undefined {
  try {
    const reference = `${kind}:${encodeURIComponent(identity)}`;
    return imageRefSchema.safeParse(reference).success ? reference : undefined;
  } catch {
    return undefined;
  }
}

function canonicalBase64(value: string): boolean {
  if (value.length === 0) return false;
  const data = Buffer.from(value, 'base64');
  return data.length > 0 && data.toString('base64') === value;
}

function isComposerTemporaryImagePath(path: string): boolean {
  const directory = dirname(resolve(path));
  return (
    basename(directory).startsWith('myagentroam-attachment-') &&
    resolve(dirname(directory)) === resolve(tmpdir())
  );
}
