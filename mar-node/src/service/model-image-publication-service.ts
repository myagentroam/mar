import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MarAgentError,
  openMarAgentSessionCatalog,
  type SessionImageResource
} from '@myagentroam/agent';
import { modelImageReadInputSchema, type ModelImageReadInput } from '@myagentroam/protocol';

const TTL_MS = 24 * 60 * 60_000;
type ResourceScope = { workspaceId: string } | { conversationId: string };
type PublicationSource = ResourceScope & { sessionId: string; homeDirectory: string };
interface Publication {
  version: 2;
  source: PublicationSource;
  resourceId: string;
  expiresAt: number;
  url: string;
}

/** Only capability metadata lives here. The SDK owns the sole immutable image file. */
export class ModelImagePublicationService {
  readonly #pending = new Map<string, Promise<{ url: string; urlExpiresAt: number }>>();
  #key: Promise<Buffer> | undefined;

  constructor(
    private readonly options: {
      directory: () => string;
      origin: () => string | undefined;
      nodeId: () => string | undefined;
      now?: () => number;
    }
  ) {}

  async publish(source: PublicationSource, resource: SessionImageResource) {
    const origin = this.options.origin();
    const nodeId = this.options.nodeId();
    if (origin === undefined || nodeId === undefined) return undefined;
    const id = this.identity(source, resource.resourceId);
    const current = this.#pending.get(id);
    if (current !== undefined) return current;
    const creation = this.create(id, source, resource.resourceId, origin, nodeId);
    this.#pending.set(id, creation);
    try {
      return await creation;
    } finally {
      if (this.#pending.get(id) === creation) this.#pending.delete(id);
    }
  }

  private async create(
    id: string,
    source: PublicationSource,
    resourceId: string,
    origin: string,
    nodeId: string
  ) {
    const key = await this.signingKey();
    try {
      const record = JSON.parse(await readFile(this.path(id), 'utf8')) as Publication;
      if (record.version !== 2 || this.identity(record.source, record.resourceId) !== id)
        throw new Error('MODEL_IMAGE_INVALID');
      return { url: record.url, urlExpiresAt: record.expiresAt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const expiresAt = this.now() + TTL_MS;
    const signature = this.signature(key, nodeId, source, resourceId, expiresAt);
    const scope =
      'workspaceId' in source
        ? `workspaces/${encodeURIComponent(source.workspaceId)}`
        : `conversations/${encodeURIComponent(source.conversationId)}`;
    const url = `${origin}/api/nodes/${encodeURIComponent(nodeId)}/${scope}/sessions/${encodeURIComponent(source.sessionId)}/images/${resourceId}?expiresAt=${expiresAt}&signature=${signature}`;
    const record: Publication = { version: 2, source, resourceId, expiresAt, url };
    const temporary = join(this.options.directory(), `.${id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, this.path(id));
    } finally {
      await rm(temporary, { force: true });
    }
    return { url, urlExpiresAt: expiresAt };
  }

  async read(
    input: ModelImageReadInput
  ): Promise<{ mimeType: string; dataBase64: string } | undefined> {
    if (!modelImageReadInputSchema.safeParse(input).success) return undefined;
    if ('imageId' in input) return this.readLegacy(input.imageId, input.token);
    if (input.expiresAt <= this.now()) return undefined;
    const nodeId = this.options.nodeId();
    if (nodeId === undefined) return undefined;
    const scope: ResourceScope =
      'workspaceId' in input
        ? { workspaceId: input.workspaceId }
        : { conversationId: input.conversationId };
    const source = { ...scope, sessionId: input.sessionId };
    const expected = this.signature(
      await this.signingKey(),
      nodeId,
      source,
      input.resourceId,
      input.expiresAt
    );
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature))) return undefined;
    let record: Publication;
    try {
      record = JSON.parse(
        await readFile(this.path(this.identity(source, input.resourceId)), 'utf8')
      ) as Publication;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (
      record.version !== 2 ||
      record.expiresAt !== input.expiresAt ||
      this.identity(record.source, record.resourceId) !== this.identity(source, input.resourceId)
    )
      return undefined;
    const catalog = await openMarAgentSessionCatalog({
      homeDirectory: record.source.homeDirectory
    });
    try {
      return await catalog.readImageResource(record.source.sessionId, record.resourceId);
    } catch (error) {
      if (error instanceof MarAgentError && error.code === 'MAR_AGENT_SESSION_NOT_FOUND')
        return undefined;
      throw error;
    } finally {
      await catalog.close();
    }
  }

  dispose(): void {
    this.#pending.clear();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private path(id: string) {
    return join(this.options.directory(), `${id}.json`);
  }
  private identity(source: ResourceScope & { sessionId: string }, resourceId: string) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          'workspaceId' in source ? 'workspace' : 'conversation',
          'workspaceId' in source ? source.workspaceId : source.conversationId,
          source.sessionId,
          resourceId
        ])
      )
      .digest('hex');
  }
  private signature(
    key: Buffer,
    nodeId: string,
    source: ResourceScope & { sessionId: string },
    resourceId: string,
    expiresAt: number
  ) {
    return createHmac('sha256', key)
      .update(JSON.stringify([nodeId, this.identity(source, resourceId), expiresAt]))
      .digest('base64url');
  }
  private signingKey(): Promise<Buffer> {
    return (this.#key ??= (async () => {
      const directory = this.options.directory();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'signing-key');
      try {
        await writeFile(path, randomBytes(32), { mode: 0o600, flag: 'wx', flush: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const key = await readFile(path);
      if (key.length !== 32) throw new Error('MODEL_IMAGE_SIGNING_KEY_INVALID');
      return key;
    })());
  }
  /** Already stored URLs stay readable until their original expiry, without rewriting history. */
  private async readLegacy(id: string, token: string) {
    try {
      const record = JSON.parse(await readFile(this.path(id), 'utf8')) as {
        id?: string;
        token?: string;
        expiresAt?: number;
        mimeType?: string;
        dataBase64?: string;
      };
      if (
        record.id !== id ||
        typeof record.token !== 'string' ||
        record.token.length !== token.length ||
        !timingSafeEqual(Buffer.from(record.token), Buffer.from(token)) ||
        typeof record.expiresAt !== 'number' ||
        record.expiresAt <= this.now() ||
        typeof record.mimeType !== 'string' ||
        typeof record.dataBase64 !== 'string'
      )
        return undefined;
      return { mimeType: record.mimeType, dataBase64: record.dataBase64 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
