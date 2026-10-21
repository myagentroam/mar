import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
  runtimeCredentialResolveRequestSchema,
  runtimeCredentialResolveResponseSchema,
  runtimeCredentialTicketSchema,
  type MarAgentStoredModelConfiguration,
  type ResolvedRuntimeCredential,
  type RuntimeCredentialResolveRequest,
  type RuntimeCredentialResolveResponse,
  type RuntimeCredentialTicket
} from '@myagentroam/protocol';

const TICKET_TTL_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const HMAC_KEY_BYTES = 32;
const HMAC_KEY_FILENAME = 'runtime-credential-hmac.key';

interface RuntimeCredentialServiceOptions {
  readonly resolveCredential: (
    credentialId: string,
    reason: 'RUNTIME' | 'UNAUTHORIZED'
  ) => Promise<ResolvedRuntimeCredential>;
  readonly readModel: (modelId: string) => Promise<MarAgentStoredModelConfiguration>;
  readonly canUseModel?: (userId: number, modelId: string) => Promise<boolean>;
  readonly canUseCredential?: (userId: number, credentialId: string) => Promise<void>;
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly hmacKey: Buffer;
}

interface RuntimeCredentialTicketInput {
  readonly userId: number;
  readonly credentialId: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly runtimeScopeId: string;
  readonly allowedModelIds: readonly string[];
  readonly purpose?: 'MODEL' | 'IMAGE_GENERATION';
}

export class RuntimeCredentialService {
  readonly #resolveCredential: RuntimeCredentialServiceOptions['resolveCredential'];
  readonly #readModel: RuntimeCredentialServiceOptions['readModel'];
  readonly #canUseModel: RuntimeCredentialServiceOptions['canUseModel'];
  readonly #canUseCredential: RuntimeCredentialServiceOptions['canUseCredential'];
  readonly #now: () => number;
  readonly #nonce: () => string;
  readonly #hmacKey: Buffer;
  readonly #nodeConnections = new Map<string, number>();
  #connectionSequence = 0;

  constructor(options: RuntimeCredentialServiceOptions) {
    this.#resolveCredential = options.resolveCredential;
    this.#readModel = options.readModel;
    this.#canUseModel = options.canUseModel;
    this.#canUseCredential = options.canUseCredential;
    this.#now = options.now ?? Date.now;
    this.#nonce = options.nonce ?? randomUUID;
    this.#hmacKey = Buffer.from(options.hmacKey);
    if (this.#hmacKey.byteLength !== HMAC_KEY_BYTES)
      throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_HMAC_KEY_INVALID');
  }

  activateNodeConnection(nodeId: string): void {
    this.#nodeConnections.set(nodeId, ++this.#connectionSequence);
  }

  deactivateNodeConnection(nodeId: string): void {
    this.#nodeConnections.delete(nodeId);
  }

  async issue(input: RuntimeCredentialTicketInput): Promise<RuntimeCredentialTicket> {
    await this.#validateScope(input);
    return this.#sign(input);
  }

  async #assertUserCanUseModels(userId: number, modelIds: readonly string[]): Promise<void> {
    if (this.#canUseModel === undefined) return;
    for (const modelId of modelIds)
      if (!(await this.#canUseModel(userId, modelId)))
        throw new Error('MAR_AGENT_RUNTIME_MODEL_FORBIDDEN');
  }

  async resolve(nodeId: string, raw: unknown): Promise<RuntimeCredentialResolveResponse> {
    try {
      const request = runtimeCredentialResolveRequestSchema.parse(raw);
      const connection = this.#verify(nodeId, request);
      await this.#validateScope({
        ...scopeOf(request.ticket),
        allowedModelIds: [request.modelId]
      });
      this.#assertConnection(nodeId, connection);
      const credential = await this.#resolveCredential(
        request.ticket.credentialId,
        request.reason === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : 'RUNTIME'
      );
      this.#assertConnection(nodeId, connection);
      return runtimeCredentialResolveResponseSchema.parse({
        credential,
        nextTicket: this.#sign(scopeOf(request.ticket))
      });
    } catch (error) {
      return runtimeCredentialResolveResponseSchema.parse({
        error: safeResolveError(error)
      });
    }
  }

  async #validateModels(credentialId: string, modelIds: readonly string[]): Promise<void> {
    for (const modelId of modelIds) {
      const model = await this.#readModel(modelId);
      if (
        !model.enabled ||
        model.protocol !== 'OPENAI_RESPONSES' ||
        model.credential.type !== 'CREDENTIAL_REF' ||
        model.credential.credentialId !== credentialId
      )
        throw new Error('MAR_AGENT_RUNTIME_MODEL_CREDENTIAL_CHANGED');
    }
  }

  async #validateScope(input: RuntimeCredentialTicketInput): Promise<void> {
    if (input.purpose === 'IMAGE_GENERATION') {
      if (this.#canUseCredential === undefined)
        throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_SCOPE_INVALID');
      await this.#canUseCredential(input.userId, input.credentialId);
      return;
    }
    await this.#validateModels(input.credentialId, input.allowedModelIds);
    await this.#assertUserCanUseModels(input.userId, input.allowedModelIds);
    await this.#canUseCredential?.(input.userId, input.credentialId);
  }

  #sign(input: RuntimeCredentialTicketInput): RuntimeCredentialTicket {
    if (!this.#nodeConnections.has(input.nodeId))
      throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID');
    const issuedAt = this.#now();
    const unsigned = {
      userId: input.userId,
      credentialId: input.credentialId,
      nodeId: input.nodeId,
      workspaceId: input.workspaceId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      runtimeScopeId: input.runtimeScopeId,
      allowedModelIds: [...input.allowedModelIds],
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      issuedAt,
      expiresAt: issuedAt + TICKET_TTL_MS,
      nonce: this.#nonce()
    };
    return runtimeCredentialTicketSchema.parse({
      ...unsigned,
      signature: this.#signature(unsigned)
    });
  }

  #verify(nodeId: string, request: RuntimeCredentialResolveRequest): number {
    const connection = this.#nodeConnections.get(nodeId);
    if (connection === undefined)
      throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID');
    const ticket = request.ticket;
    const expected = this.#signature(unsignedTicket(ticket));
    const actualBuffer = Buffer.from(ticket.signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (
      actualBuffer.byteLength !== expectedBuffer.byteLength ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    )
      throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_TICKET_INVALID');
    const now = this.#now();
    if (ticket.issuedAt > now + CLOCK_SKEW_MS)
      throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_TICKET_INVALID');
    if (ticket.expiresAt < now - CLOCK_SKEW_MS)
      throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_TICKET_EXPIRED');
    if (ticket.nodeId !== nodeId) throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_TICKET_INVALID');
    return connection;
  }

  #assertConnection(nodeId: string, expected: number): void {
    if (this.#nodeConnections.get(nodeId) !== expected)
      throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID');
  }

  #signature(ticket: Omit<RuntimeCredentialTicket, 'signature'>): string {
    const payload = [
      ticket.userId,
      ticket.credentialId,
      ticket.nodeId,
      ticket.workspaceId,
      ticket.sessionId ?? null,
      ticket.runtimeScopeId,
      ticket.allowedModelIds,
      ticket.issuedAt,
      ticket.expiresAt,
      ticket.nonce
    ];
    if (ticket.purpose !== undefined) payload.push(ticket.purpose);
    return createHmac('sha256', this.#hmacKey).update(JSON.stringify(payload)).digest('hex');
  }
}

export function loadOrCreateRuntimeCredentialHmacKey(dataDirectory: string): Buffer {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, HMAC_KEY_FILENAME);
  try {
    return readRuntimeCredentialHmacKey(path);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let key: Buffer | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    key = randomBytes(HMAC_KEY_BYTES);
    writeFileSync(descriptor, key);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    key = readRuntimeCredentialHmacKey(path);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT') && cleanupError === undefined) cleanupError = error;
  }

  if (operationFailed) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (key === undefined) throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_HMAC_KEY_INVALID');
  return key;
}

function readRuntimeCredentialHmacKey(path: string): Buffer {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_HMAC_KEY_INVALID');
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.byteLength !== HMAC_KEY_BYTES)
    throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_HMAC_KEY_INVALID');
  return key;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { readonly code?: string }).code === code
  );
}

function unsignedTicket(
  ticket: RuntimeCredentialTicket
): Omit<RuntimeCredentialTicket, 'signature'> {
  const { signature, ...unsigned } = ticket;
  void signature;
  return unsigned;
}

function scopeOf(ticket: RuntimeCredentialTicket): RuntimeCredentialTicketInput {
  return {
    userId: ticket.userId,
    credentialId: ticket.credentialId,
    nodeId: ticket.nodeId,
    workspaceId: ticket.workspaceId,
    ...(ticket.sessionId === undefined ? {} : { sessionId: ticket.sessionId }),
    runtimeScopeId: ticket.runtimeScopeId,
    allowedModelIds: ticket.allowedModelIds,
    ...(ticket.purpose === undefined ? {} : { purpose: ticket.purpose })
  };
}

function safeResolveError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly retryAfterMs?: number;
} {
  const rawCode =
    error instanceof Error ? /^([A-Z][A-Z0-9_]{0,79})/u.exec(error.message)?.[1] : undefined;
  switch (rawCode) {
    case 'CODEX_CREDENTIAL_REFRESH_TRANSIENT':
    case 'CODEX_CREDENTIAL_CHECK_FAILED':
      return {
        code: rawCode,
        message: 'The runtime credential is temporarily unavailable.',
        recoverable: true,
        retryAfterMs: 60_000
      };
    case 'CODEX_CREDENTIAL_REAUTH_REQUIRED':
      return {
        code: rawCode,
        message: 'The runtime credential requires reauthentication.',
        recoverable: false
      };
    case 'CODEX_CREDENTIAL_UNAVAILABLE':
      return {
        code: rawCode,
        message: 'The runtime credential is unavailable.',
        recoverable: false
      };
    case 'MAR_AGENT_RUNTIME_CREDENTIAL_TICKET_EXPIRED':
      return {
        code: rawCode,
        message: 'The runtime credential ticket has expired.',
        recoverable: false
      };
    case 'MAR_AGENT_RUNTIME_MODEL_CREDENTIAL_CHANGED':
      return {
        code: rawCode,
        message: 'The model credential binding has changed.',
        recoverable: false
      };
    case 'MAR_AGENT_RUNTIME_MODEL_FORBIDDEN':
      return {
        code: rawCode,
        message: 'The model is no longer authorized for this user.',
        recoverable: false
      };
    case 'MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID':
      return {
        code: rawCode,
        message: 'The Node control connection is no longer valid.',
        recoverable: false
      };
    case 'MAR_AGENT_RUNTIME_CREDENTIAL_TICKET_INVALID':
      return {
        code: rawCode,
        message: 'The runtime credential ticket is invalid.',
        recoverable: false
      };
    default:
      return {
        code: 'MAR_AGENT_RUNTIME_CREDENTIAL_REQUEST_INVALID',
        message: 'The runtime credential request is invalid.',
        recoverable: false
      };
  }
}
