import {
  codexCredentialDetailsSchema,
  codexCredentialSummarySchema,
  codexCredentialUsageSchema,
  codexLoginAttemptSchema,
  codexModelCatalogSchema,
  codexModelImportRequestSchema,
  codexModelImportResultSchema,
  XAI_SUBSCRIPTION_BASE_URL,
  imageGenerationCatalogSchema,
  marAgentModelTransportTestResultSchema,
  type CodexCredentialDetails,
  type CodexCredentialOwnership,
  type CodexCredentialSummary,
  type CodexCredentialUsage,
  type CodexLoginAttempt,
  type CodexModelCatalog,
  type CodexModelImportRequest,
  type CodexModelImportResult,
  type MarAgentModelSummary,
  type MarAgentResponsesTransport,
  type MarAgentModelTransportTestResult,
  type ImageGenerationModel
} from '@myagentroam/protocol';
import type { NodeSummary } from '../model/workbench.js';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface CodexLoginDraft {
  readonly type?: 'CHATGPT_OAUTH' | 'XAI_OAUTH';
  readonly nodeId?: string;
  readonly name: string;
  readonly ownership: CodexCredentialOwnership | { readonly ownerType: 'PERSONAL' };
  readonly socks5Url?: string;
  readonly targetCredentialId?: string;
}

export interface CodexCredentialUpdateDraft {
  readonly name: string;
  readonly ownership: CodexCredentialOwnership | { readonly ownerType: 'PERSONAL' };
  readonly socks5Url?: string | null;
}

export interface CodexImportDraft {
  readonly upstreamModelId: string;
  readonly selected: boolean;
  readonly name: string;
  readonly contextWindowTokens?: number;
}

export function createCodexCredentialManagementService(request: Request) {
  return {
    async listCredentials(): Promise<readonly CodexCredentialSummary[]> {
      const raw = await request<unknown>('/api/admin/mar-agent/codex-credentials');
      return parseEnvelope(raw, 'credentials', (value) =>
        codexCredentialSummarySchema.array().parse(value)
      );
    },
    async credentialDetails(credentialId: string): Promise<CodexCredentialDetails> {
      const raw = await request<unknown>(
        `/api/admin/mar-agent/codex-credentials/${encodeURIComponent(credentialId)}`,
        { cache: 'no-store' }
      );
      return parseEnvelope(raw, 'details', (value) => codexCredentialDetailsSchema.parse(value));
    },
    async credentialUsage(credentialId: string): Promise<CodexCredentialUsage> {
      const raw = await request<unknown>(
        `/api/admin/mar-agent/codex-credentials/${encodeURIComponent(credentialId)}/usage`,
        { cache: 'no-store' }
      );
      return parseEnvelope(raw, 'usage', (value) => codexCredentialUsageSchema.parse(value));
    },
    async startLogin(input: CodexLoginDraft): Promise<CodexLoginAttempt> {
      const raw = await request<unknown>('/api/admin/mar-agent/codex-login-attempts', {
        method: 'POST',
        body: JSON.stringify(loginBody(input))
      });
      return parseEnvelope(raw, 'attempt', (value) => codexLoginAttemptSchema.parse(value));
    },
    async loginAttempt(attemptId: string): Promise<CodexLoginAttempt> {
      const raw = await request<unknown>(
        `/api/admin/mar-agent/codex-login-attempts/${encodeURIComponent(attemptId)}`
      );
      return parseEnvelope(raw, 'attempt', (value) => codexLoginAttemptSchema.parse(value));
    },
    async cancelLogin(attemptId: string): Promise<void> {
      await request(`/api/admin/mar-agent/codex-login-attempts/${encodeURIComponent(attemptId)}`, {
        method: 'DELETE'
      });
    },
    async updateCredential(
      credentialId: string,
      input: CodexCredentialUpdateDraft
    ): Promise<CodexCredentialSummary> {
      const raw = await request<unknown>(
        `/api/admin/mar-agent/codex-credentials/${encodeURIComponent(credentialId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(credentialUpdateBody(input))
        }
      );
      return parseEnvelope(raw, 'credential', (value) => codexCredentialSummarySchema.parse(value));
    },
    async removeCredential(credentialId: string): Promise<void> {
      await request(`/api/admin/mar-agent/codex-credentials/${encodeURIComponent(credentialId)}`, {
        method: 'DELETE'
      });
    },
    async refreshCredential(credentialId: string): Promise<CodexCredentialSummary> {
      const raw = await request<unknown>(
        `/api/admin/mar-agent/codex-credentials/${encodeURIComponent(credentialId)}/refresh`,
        { method: 'POST' }
      );
      return parseEnvelope(raw, 'credential', (value) => codexCredentialSummarySchema.parse(value));
    },
    async testCredential(
      credentialId: string
    ): Promise<{ readonly success: boolean; readonly code: string | null }> {
      const raw = await request<unknown>(
        `/api/admin/mar-agent/codex-credentials/${encodeURIComponent(credentialId)}/test`,
        { method: 'POST' }
      );
      return parseEnvelope(raw, 'result', parseSimpleTestResult);
    },
    async loadCatalog(credentialId: string): Promise<CodexModelCatalog> {
      const raw = await request<unknown>(
        `/api/admin/mar-agent/codex-credentials/${encodeURIComponent(credentialId)}/models/load`,
        { method: 'POST' }
      );
      return parseEnvelope(raw, 'catalog', (value) => codexModelCatalogSchema.parse(value));
    },
    async importModels(
      credentialId: string,
      input: CodexModelImportRequest
    ): Promise<CodexModelImportResult> {
      const body = codexModelImportRequestSchema.parse(input);
      const raw = await request<unknown>(
        `/api/admin/mar-agent/codex-credentials/${encodeURIComponent(credentialId)}/models/import`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      return parseEnvelope(raw, 'result', (value) => codexModelImportResultSchema.parse(value));
    },
    async testModel(modelId: string, nodeId: string): Promise<MarAgentModelTransportTestResult> {
      const raw = await request<unknown>(
        `/api/admin/mar-agent/models/${encodeURIComponent(modelId)}/test`,
        { method: 'POST', body: JSON.stringify({ nodeId }) }
      );
      return marAgentModelTransportTestResultSchema.parse(raw);
    },
    async imageGenerationConfiguration(): Promise<ImageGenerationModel[]> {
      const raw = await request<unknown>('/api/admin/mar-agent/image-generation');
      return parseEnvelope(raw, 'configuration', (value) =>
        imageGenerationCatalogSchema.parse(value)
      );
    },
    async updateImageGenerationConfiguration(
      input: ImageGenerationModel[]
    ): Promise<ImageGenerationModel[]> {
      const body = imageGenerationCatalogSchema.parse(input);
      const raw = await request<unknown>('/api/admin/mar-agent/image-generation', {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      return parseEnvelope(raw, 'configuration', (value) =>
        imageGenerationCatalogSchema.parse(value)
      );
    }
  };
}

export function buildCodexModelImportRequest(
  rawCatalog: unknown,
  drafts: readonly CodexImportDraft[]
): CodexModelImportRequest {
  const catalog = codexModelCatalogSchema.parse(rawCatalog);
  const candidates = new Map(catalog.models.map((model) => [model.upstreamModelId, model]));
  const models = drafts.flatMap((draft) => {
    if (!draft.selected) return [];
    const candidate = candidates.get(draft.upstreamModelId);
    if (candidate === undefined) throw new Error('CODEX_MODEL_IMPORT_CANDIDATE_INVALID');
    const contextWindowTokens =
      candidate.contextWindowTokens === undefined ? draft.contextWindowTokens : undefined;
    if (
      candidate.contextWindowTokens === undefined &&
      (contextWindowTokens === undefined ||
        !Number.isSafeInteger(contextWindowTokens) ||
        contextWindowTokens <= 0)
    )
      throw new Error('CODEX_MODEL_IMPORT_LIMIT_REQUIRED');
    return [
      {
        upstreamModelId: draft.upstreamModelId,
        ...(draft.name.trim().length === 0 ? {} : { name: draft.name.trim() }),
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        enabled: true
      }
    ];
  });
  return codexModelImportRequestSchema.parse({ catalogHash: catalog.catalogHash, models });
}

export function modelProtocolChoice(
  model: Pick<MarAgentModelSummary, 'protocol' | 'credentialType' | 'baseUrl'>
): MarAgentModelSummary['protocol'] | 'CODEX' | 'CHATGPT' | 'GROK' {
  if (model.credentialType !== 'CREDENTIAL_REF') return model.protocol;
  if (model.baseUrl === XAI_SUBSCRIPTION_BASE_URL) return 'GROK';
  return model.baseUrl === 'https://api.openai.com/v1' ? 'CHATGPT' : 'CODEX';
}

export function credentialRefreshOutcome(
  previous: CodexCredentialSummary,
  current: CodexCredentialSummary,
  now = Date.now()
): 'REFRESHED' | 'DEFERRED' | 'DEGRADED' | 'UNCHANGED' {
  if (current.status === 'DEGRADED') return 'DEGRADED';
  if (
    current.lastRefreshAt !== previous.lastRefreshAt ||
    current.accessTokenExpiresAt !== previous.accessTokenExpiresAt
  )
    return 'REFRESHED';
  if (
    current.type === 'CHATGPT_OAUTH' &&
    current.earliestRefreshAt !== null &&
    current.earliestRefreshAt !== undefined &&
    now < current.earliestRefreshAt
  )
    return 'DEFERRED';
  return 'UNCHANGED';
}

export function eligibleMarAgentTransportTestNodes(
  nodes: readonly NodeSummary[]
): readonly NodeSummary[] {
  return nodes.filter((node) => {
    const capability = node.capabilities.marAgentRuntimeCredentials;
    return node.connected && !node.disabled && capability?.apiVersion === 1;
  });
}

export function modelSupportsNodeTransport(
  node: NodeSummary,
  transport: MarAgentResponsesTransport | undefined,
  serviceTier?: MarAgentModelSummary['serviceTier'],
  requireResponsesOptionalParameters = false,
  requireResponsesHttpContinuation = false
): boolean {
  if (!eligibleMarAgentTransportTestNodes([node]).length) return false;
  const capability = node.capabilities.marAgentRuntimeCredentials!;
  if (
    requireResponsesOptionalParameters &&
    (capability as { readonly responsesOptionalParameters?: boolean })
      .responsesOptionalParameters !== true
  )
    return false;
  if (
    serviceTier !== undefined &&
    serviceTier !== 'default' &&
    !capability.serviceTiers?.includes(serviceTier)
  )
    return false;
  if (
    requireResponsesHttpContinuation &&
    transport?.transport !== 'WEBSOCKET' &&
    capability.responsesHttpContinuation !== true
  )
    return false;
  if (transport === undefined) return true;
  return transport.transport === 'WEBSOCKET'
    ? capability.websocket
    : capability.httpVersions.includes(transport.httpVersion);
}

export function codexCredentialErrorMessageKey(code: string): string | undefined {
  const keys: Readonly<Record<string, string>> = {
    CHATGPT_PLAN_UNAUTHORIZED: 'marAgentModels.chatgptUnauthorizedHint',
    CODEX_CREDENTIAL_IN_USE: 'marAgentModels.codexErrorInUse',
    CODEX_CREDENTIAL_NAME_CONFLICT: 'marAgentModels.codexErrorNameConflict',
    CODEX_CREDENTIAL_SCOPE_FORBIDDEN: 'marAgentModels.codexErrorScopeForbidden',
    CODEX_CREDENTIAL_SCOPE_CONFLICT: 'marAgentModels.codexErrorScopeConflict',
    CODEX_CREDENTIAL_REAUTH_REQUIRED: 'marAgentModels.codexErrorReauthRequired',
    CODEX_CREDENTIAL_REFRESH_TRANSIENT: 'marAgentModels.codexErrorRefreshTransient',
    CODEX_CREDENTIAL_CHECK_FAILED: 'marAgentModels.codexErrorCheckFailed',
    CODEX_CATALOG_CHANGED: 'marAgentModels.codexErrorCatalogChanged',
    CODEX_CATALOG_LOAD_FAILED: 'marAgentModels.codexErrorCatalogLoadFailed',
    CODEX_USAGE_RATE_LIMITED: 'marAgentModels.codexErrorUsageRateLimited',
    CODEX_USAGE_LOAD_FAILED: 'marAgentModels.codexErrorUsageLoadFailed',
    CODEX_USAGE_RESPONSE_INVALID: 'marAgentModels.codexErrorUsageLoadFailed',
    CODEX_DEVICE_AUTH_UNAVAILABLE: 'marAgentModels.codexErrorDeviceAuthUnavailable',
    XAI_DEVICE_AUTH_UNAVAILABLE: 'marAgentModels.grokErrorDeviceAuthUnavailable',
    XAI_LOGIN_FAILED: 'marAgentModels.grokErrorLoginFailed',
    XAI_LOGIN_DENIED: 'marAgentModels.grokErrorLoginDenied',
    XAI_LOGIN_CONFLICT: 'marAgentModels.grokErrorLoginConflict',
    XAI_RESPONSE_INVALID: 'marAgentModels.grokErrorResponseInvalid',
    XAI_ENTITLEMENT_REQUIRED: 'marAgentModels.grokErrorEntitlementRequired',
    XAI_REFRESH_FAILED: 'marAgentModels.grokErrorRefreshFailed',
    XAI_USAGE_LOAD_FAILED: 'marAgentModels.grokErrorUsageLoadFailed',
    XAI_USAGE_RATE_LIMITED: 'marAgentModels.grokErrorUsageRateLimited',
    XAI_CATALOG_LOAD_FAILED: 'marAgentModels.grokErrorCatalogLoadFailed',
    XAI_REQUEST_FAILED: 'marAgentModels.grokErrorRequestFailed',
    CODEX_LOGIN_ATTEMPT_NOT_FOUND: 'marAgentModels.codexErrorAttemptNotFound',
    MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED:
      'marAgentModels.modelTestRuntimeCredentialsUnsupported',
    MAR_AGENT_MODEL_WEBSOCKET_UNAVAILABLE: 'marAgentModels.modelTestWebSocketUnavailable',
    MAR_AGENT_MODEL_HTTP_CONTINUATION_UNAVAILABLE:
      'marAgentModels.modelTestHttpContinuationUnavailable',
    MAR_AGENT_MODEL_HTTP2_UNAVAILABLE: 'marAgentModels.modelTestHttp2Unavailable',
    MAR_AGENT_MODEL_HTTP1_UNAVAILABLE: 'marAgentModels.modelTestHttp1Unavailable',
    MAR_AGENT_MODEL_SERVICE_TIER_UNAVAILABLE: 'marAgentModels.modelTestServiceTierUnavailable',
    MAR_AGENT_MODEL_TEST_WORKSPACE_REQUIRED: 'marAgentModels.modelTestWorkspaceRequired'
  };
  return keys[code];
}

interface LoginPollService {
  readonly startLogin: (input: CodexLoginDraft) => Promise<CodexLoginAttempt>;
  readonly loginAttempt: (attemptId: string) => Promise<CodexLoginAttempt>;
  readonly cancelLogin: (attemptId: string) => Promise<void>;
}

interface LoginPollOptions {
  readonly now?: () => number;
  readonly onChange?: (attempt: CodexLoginAttempt) => void;
  readonly onTerminal?: (attempt: CodexLoginAttempt) => void;
  readonly onError?: (error: unknown) => void;
}

export class CodexLoginAttemptPoller {
  readonly #now: () => number;
  #sequence = 0;
  #attempt: CodexLoginAttempt | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly service: LoginPollService,
    private readonly options: LoginPollOptions = {}
  ) {
    this.#now = options.now ?? Date.now;
  }

  current(): CodexLoginAttempt | undefined {
    return this.#attempt;
  }

  async begin(input: CodexLoginDraft): Promise<CodexLoginAttempt | undefined> {
    const previous = this.#attempt;
    const sequence = ++this.#sequence;
    this.#clearTimer();
    this.#attempt = undefined;
    if (previous?.status === 'PENDING')
      void this.service.cancelLogin(previous.id).catch(() => undefined);
    const attempt = await this.service.startLogin(input);
    if (sequence !== this.#sequence) {
      if (attempt.status === 'PENDING')
        await this.service.cancelLogin(attempt.id).catch(() => undefined);
      return undefined;
    }
    this.#apply(attempt, sequence);
    return attempt;
  }

  async cancel(): Promise<void> {
    const attempt = this.#attempt;
    ++this.#sequence;
    this.#clearTimer();
    this.#attempt = undefined;
    if (attempt?.status === 'PENDING') await this.service.cancelLogin(attempt.id);
  }

  async refresh(): Promise<void> {
    const current = this.#attempt;
    if (current?.status !== 'PENDING') return;
    const sequence = ++this.#sequence;
    this.#clearTimer();
    try {
      const attempt = await this.service.loginAttempt(current.id);
      this.#apply(attempt, sequence);
    } catch (error) {
      if (sequence !== this.#sequence) return;
      this.options.onError?.(error);
      this.#apply(current, sequence);
    }
  }

  dispose(): void {
    void this.cancel().catch(() => undefined);
  }

  #apply(attempt: CodexLoginAttempt, sequence: number): void {
    if (sequence !== this.#sequence) return;
    this.#attempt = attempt;
    this.options.onChange?.(attempt);
    if (attempt.status !== 'PENDING') {
      this.options.onTerminal?.(attempt);
      return;
    }
    const { expiresAt, pollIntervalMs } = attempt;
    if (expiresAt === undefined || pollIntervalMs === undefined) {
      this.options.onError?.(new Error('CODEX_LOGIN_ATTEMPT_RESPONSE_INVALID'));
      return;
    }
    const remaining = Math.max(0, expiresAt - this.#now());
    const delay = Math.min(pollIntervalMs, remaining);
    this.#timer = setTimeout(() => void this.#poll(sequence, attempt.id), delay);
  }

  async #poll(sequence: number, attemptId: string): Promise<void> {
    this.#timer = undefined;
    try {
      const attempt = await this.service.loginAttempt(attemptId);
      this.#apply(attempt, sequence);
    } catch (error) {
      if (sequence === this.#sequence) this.options.onError?.(error);
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

function loginBody(input: CodexLoginDraft): CodexLoginDraft {
  const name = input.name.trim();
  return {
    name,
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.type === undefined || input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    ownership: input.ownership,
    ...(input.socks5Url === undefined ? {} : { socks5Url: input.socks5Url }),
    ...(input.targetCredentialId === undefined
      ? {}
      : { targetCredentialId: input.targetCredentialId })
  };
}

function credentialUpdateBody(input: CodexCredentialUpdateDraft): CodexCredentialUpdateDraft {
  return {
    name: input.name.trim(),
    ownership: input.ownership,
    ...(input.socks5Url === undefined
      ? {}
      : { socks5Url: input.socks5Url === null ? null : input.socks5Url.trim() })
  };
}

function parseEnvelope<T>(raw: unknown, key: string, parse: (value: unknown) => T): T {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw responseError(key);
  const entries = Object.entries(raw);
  if (entries.length !== 1 || entries[0]?.[0] !== key) throw responseError(key);
  try {
    return parse(entries[0][1]);
  } catch {
    throw responseError(key);
  }
}

function parseSimpleTestResult(raw: unknown): {
  readonly success: boolean;
  readonly code: string | null;
} {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('CODEX_CREDENTIAL_RESPONSE_INVALID');
  const entries = Object.entries(raw);
  const success = (raw as { success?: unknown }).success;
  const code = (raw as { code?: unknown }).code;
  if (
    entries.some(([key]) => key !== 'success' && key !== 'code') ||
    typeof success !== 'boolean' ||
    (code !== null && typeof code !== 'string')
  )
    throw new Error('CODEX_CREDENTIAL_RESPONSE_INVALID');
  return { success, code };
}

function responseError(key: string): Error {
  return new Error(
    key === 'catalog'
      ? 'CODEX_CATALOG_RESPONSE_INVALID'
      : key === 'usage'
        ? 'CODEX_USAGE_RESPONSE_INVALID'
        : key === 'attempt'
          ? 'CODEX_LOGIN_ATTEMPT_RESPONSE_INVALID'
          : 'CODEX_CREDENTIAL_RESPONSE_INVALID'
  );
}
