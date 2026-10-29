import {
  AgentError,
  SecretValue,
  type AgentModelConfiguration,
  type ModelCredential,
  type ModelCredentialAcquireReason,
  type ModelCredentialProvider
} from '@myagentroam/agent';
import {
  marAgentRuntimeModelConfigurationSchema,
  resolveMarAgentDefaultReasoningEffort,
  type MarAgentRuntimeModelConfiguration,
  type RuntimeCredentialTicket
} from '@myagentroam/protocol';
import type { RuntimeCredentialControlService } from '../../service/runtime-credential-control-service.js';
import type { ImageGenerationConfiguration } from './image-generation.js';

export interface MarAgentRuntimeModel extends AgentModelConfiguration {
  readonly imageGeneration?: ImageGenerationConfiguration;
}

export function sdkModelConfigurations(
  models: readonly MarAgentRuntimeModel[]
): AgentModelConfiguration[] {
  return models.map(({ imageGeneration: _imageGeneration, ...model }) => model);
}

export async function closeImageCredentialProviders(
  models: readonly MarAgentRuntimeModel[]
): Promise<void> {
  const textProviders = new Set(models.map((model) => model.credentialProvider));
  const imageProviders = new Set(
    models.flatMap((model) =>
      model.imageGeneration === undefined ||
      textProviders.has(model.imageGeneration.credentialProvider)
        ? []
        : [model.imageGeneration.credentialProvider]
    )
  );
  await Promise.allSettled([...imageProviders].map((provider) => provider.close()));
}

interface RuntimeModelContext {
  readonly runtimeScopeId?: string;
  readonly executionId: string;
}

class PendingCredentialResolution {
  forceUnauthorized = false;
  promise!: Promise<ModelCredential>;

  constructor(
    readonly abort: AbortController,
    readonly initialReason: ModelCredentialAcquireReason
  ) {}
}

interface TicketState {
  ticket: RuntimeCredentialTicket;
  credential?: ModelCredential;
  pending?: PendingCredentialResolution;
  readonly providers: Set<ServerRuntimeCredentialProvider>;
  refreshTimer?: NodeJS.Timeout;
  released: boolean;
}

const CREDENTIAL_REFRESH_WINDOW_MS = 60_000;
const CREDENTIAL_REFRESH_RETRY_MS = 30_000;

export class MarAgentRuntimeModelFactory {
  constructor(
    private readonly control: Pick<RuntimeCredentialControlService, 'resolve'>,
    private readonly now: () => number = Date.now
  ) {}

  create(
    configurations: readonly MarAgentRuntimeModelConfiguration[],
    context: RuntimeModelContext
  ): MarAgentRuntimeModel[] {
    const tickets = new Map<string, TicketState>();
    const providers: ServerRuntimeCredentialProvider[] = [];
    try {
      return configurations.map((raw) => {
        const configuration = marAgentRuntimeModelConfigurationSchema.parse(raw);
        const imageGeneration =
          configuration.imageGeneration === undefined ||
          configuration.imageGeneration.credential === undefined
            ? undefined
            : {
                provider: configuration.imageGeneration.provider,
                config: configuration.imageGeneration.config,
                generateEndpoint: configuration.imageGeneration.generateEndpoint,
                editEndpoint: configuration.imageGeneration.editEndpoint,
                imageModelId: configuration.imageGeneration.imageModelId,
                httpVersion: configuration.imageGeneration.httpVersion,
                credentialProvider:
                  configuration.imageGeneration.credential.type === 'INLINE_API_KEY'
                    ? staticImageProvider(configuration.imageGeneration.credential.value)
                    : runtimeProvider(
                        configuration.imageGeneration.credential,
                        'image-generation',
                        context,
                        tickets,
                        providers,
                        this.control,
                        this.now
                      )
              };
        const model = {
          id: configuration.id,
          name: configuration.name,
          protocol: configuration.protocol,
          baseUrl: configuration.baseUrl,
          modelId: configuration.modelId,
          contextWindowTokens: configuration.contextWindowTokens,
          maxOutputTokens: configuration.maxOutputTokens,
          inputCapabilities: configuration.inputCapabilities,
          outputCapabilities: configuration.outputCapabilities,
          reasoningEfforts: configuration.reasoningEfforts,
          defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
            configuration.defaultReasoningEffort,
            configuration.reasoningEfforts
          ),
          conversationModel: configuration.conversationModel ?? true,
          subagentModel: configuration.subagentModel ?? false,
          titleGeneration: configuration.titleGeneration,
          codeMode: configuration.codeMode,
          ...(configuration.serviceTier === undefined
            ? {}
            : { serviceTier: configuration.serviceTier }),
          hostedWebSearch: configuration.hostedWebSearch,
          useResourceUrl: configuration.useResourceUrl,
          ...(imageGeneration === undefined ? {} : { imageGeneration }),
          ...(configuration.responsesTransport === undefined
            ? {}
            : { responsesTransport: configuration.responsesTransport }),
          responsesToolNamespace: configuration.responsesToolNamespace,
          ...(configuration.responsesOptionalParameters === undefined
            ? {}
            : {
                responsesOptionalParameters: configuration.responsesOptionalParameters
              }),
          responsesPreviousResponseId: configuration.responsesPreviousResponseId,
          ...(configuration.responsesConfigurationUpdates === undefined
            ? {}
            : { responsesConfigurationUpdates: configuration.responsesConfigurationUpdates }),
          enabled: configuration.enabled
        };
        const { credential } = configuration;
        if (credential.type === 'INLINE_API_KEY')
          return {
            ...model,
            apiKey: new SecretValue(credential.value)
          };
        if (credential?.type !== 'RUNTIME_TICKET')
          throw new AgentError(
            'MAR_AGENT_RUNTIME_MODEL_CREDENTIAL_INVALID',
            'The runtime model credential is invalid.'
          );
        if (
          context.runtimeScopeId === undefined ||
          context.runtimeScopeId !== credential.ticket.runtimeScopeId ||
          !credential.ticket.allowedModelIds.includes(configuration.id)
        )
          throw new AgentError(
            'MAR_AGENT_RUNTIME_CREDENTIAL_SCOPE_INVALID',
            'The runtime credential does not authorize this execution or model.'
          );
        const provider = runtimeProvider(
          credential,
          configuration.id,
          context,
          tickets,
          providers,
          this.control,
          this.now
        );
        return {
          ...model,
          ...(configuration.imageGeneration !== undefined &&
          configuration.imageGeneration.credential === undefined
            ? {
                imageGeneration: {
                  provider: configuration.imageGeneration.provider ?? 'CODEX',
                  config: configuration.imageGeneration.config ?? {},
                  generateEndpoint: configuration.imageGeneration.generateEndpoint,
                  editEndpoint: configuration.imageGeneration.editEndpoint,
                  imageModelId: configuration.imageGeneration.imageModelId,
                  httpVersion: configuration.imageGeneration.httpVersion,
                  credentialProvider: provider
                }
              }
            : {}),
          credentialProvider: provider
        } satisfies MarAgentRuntimeModel;
      });
    } catch (error) {
      for (const provider of providers) void provider.close();
      throw error;
    }
  }
}

function staticImageProvider(value: string): ModelCredentialProvider {
  const bearer = new SecretValue(value);
  return {
    acquire: async () => ({ revision: 0, expiresAt: Number.MAX_SAFE_INTEGER, bearer, headers: {} }),
    invalidate: () => undefined,
    close: async () => undefined
  };
}

function runtimeProvider(
  credential: Extract<
    MarAgentRuntimeModelConfiguration['credential'],
    { readonly type: 'RUNTIME_TICKET' }
  >,
  consumerId: string,
  context: RuntimeModelContext,
  tickets: Map<string, TicketState>,
  providers: ServerRuntimeCredentialProvider[],
  control: Pick<RuntimeCredentialControlService, 'resolve'>,
  now: () => number
): ServerRuntimeCredentialProvider {
  if (
    context.runtimeScopeId === undefined ||
    context.runtimeScopeId !== credential.ticket.runtimeScopeId ||
    !credential.ticket.allowedModelIds.includes(consumerId)
  )
    throw new AgentError(
      'MAR_AGENT_RUNTIME_CREDENTIAL_SCOPE_INVALID',
      'The runtime credential does not authorize this execution or model.'
    );
  const key = `${credential.credentialId}\0${credential.ticket.runtimeScopeId}\0${credential.ticket.purpose ?? 'MODEL'}`;
  let state = tickets.get(key);
  if (state === undefined) {
    state = {
      ticket: credential.ticket,
      providers: new Set(),
      released: false
    };
    tickets.set(key, state);
  } else if (!sameRuntimeCredentialTicket(state.ticket, credential.ticket))
    throw new AgentError(
      'MAR_AGENT_RUNTIME_CREDENTIAL_SCOPE_INVALID',
      'The runtime credential does not authorize this execution or model.'
    );
  const provider = new ServerRuntimeCredentialProvider(
    control,
    state,
    consumerId,
    context.runtimeScopeId,
    context.executionId,
    now
  );
  providers.push(provider);
  return provider;
}

class ServerRuntimeCredentialProvider implements ModelCredentialProvider {
  readonly #pending = new Set<AbortController>();
  #closed = false;

  constructor(
    private readonly control: Pick<RuntimeCredentialControlService, 'resolve'>,
    private readonly state: TicketState,
    private readonly modelId: string,
    private readonly runtimeScopeId: string,
    private readonly executionId: string,
    private readonly now: () => number
  ) {
    this.state.providers.add(this);
    scheduleRefresh(this.state, this.now);
  }

  async acquire(reason: ModelCredentialAcquireReason): Promise<ModelCredential> {
    if (this.#closed || this.state.released)
      throw new AgentError(
        'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED',
        'The runtime credential provider is closed.'
      );
    if (isReusableCredential(this.state.credential, this.now())) {
      if (isWithinRefreshWindow(this.state.ticket.expiresAt, this.now()))
        this.refreshAutomatically();
      return this.state.credential;
    }

    const abort = new AbortController();
    this.#pending.add(abort);
    try {
      const pending = this.pendingResolution(reason);
      return await waitForCredential(pending.promise, abort.signal);
    } finally {
      this.#pending.delete(abort);
    }
  }

  invalidate(revision: number): void {
    if (this.state.credential?.revision === revision) delete this.state.credential;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending) pending.abort();
    this.#pending.clear();
    this.state.providers.delete(this);
    if (this.state.providers.size === 0) {
      this.state.released = true;
      delete this.state.credential;
      clearRefreshTimer(this.state);
      this.state.pending?.abort.abort();
    } else scheduleRefresh(this.state, this.now);
  }

  refreshAutomatically(): void {
    if (this.#closed || this.state.released) return;
    const pending = this.pendingResolution('REQUEST');
    void pending.promise.catch(() => undefined);
  }

  private pendingResolution(reason: ModelCredentialAcquireReason): PendingCredentialResolution {
    const current = this.state.pending;
    if (current !== undefined) {
      if (reason === 'UNAUTHORIZED' && current.initialReason !== 'UNAUTHORIZED')
        current.forceUnauthorized = true;
      return current;
    }

    clearRefreshTimer(this.state);
    const abort = new AbortController();
    const pending = new PendingCredentialResolution(abort, reason);
    pending.promise = this.runResolution(pending, abort.signal);
    this.state.pending = pending;
    pending.promise.then(
      () => {
        if (this.state.pending !== pending) return;
        delete this.state.pending;
        scheduleRefresh(this.state, this.now, CREDENTIAL_REFRESH_RETRY_MS);
      },
      () => {
        if (this.state.pending !== pending) return;
        delete this.state.pending;
        scheduleRefresh(this.state, this.now, CREDENTIAL_REFRESH_RETRY_MS);
      }
    );
    return pending;
  }

  private async runResolution(
    pending: PendingCredentialResolution,
    signal: AbortSignal
  ): Promise<ModelCredential> {
    const credential = await this.resolveFromServer(pending.initialReason, signal);
    if (pending.initialReason === 'UNAUTHORIZED' || !pending.forceUnauthorized) return credential;
    if (this.state.credential?.revision === credential.revision) delete this.state.credential;
    return this.resolveFromServer('UNAUTHORIZED', signal);
  }

  private async resolveFromServer(
    reason: ModelCredentialAcquireReason,
    signal: AbortSignal
  ): Promise<ModelCredential> {
    const response = await this.control.resolve(
      {
        ticket: this.state.ticket,
        modelId: this.modelId,
        runtimeScopeId: this.runtimeScopeId,
        executionId: this.executionId,
        reason
      },
      signal
    );
    if (this.state.released)
      throw new AgentError(
        'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED',
        'The runtime credential provider is closed.'
      );
    if ('error' in response) throw new AgentError(response.error.code, response.error.message);
    this.state.ticket = response.nextTicket;
    const credential: ModelCredential = {
      revision: response.credential.revision,
      expiresAt: response.credential.expiresAt,
      bearer: new SecretValue(response.credential.bearer),
      headers: Object.fromEntries(
        Object.entries(response.credential.headers).map(([name, value]) => [
          name,
          new SecretValue(value)
        ])
      ),
      ...(response.credential.socks5Url === undefined
        ? {}
        : { socks5Url: new SecretValue(response.credential.socks5Url) })
    };
    this.state.credential = credential;
    return credential;
  }
}

function isReusableCredential(
  credential: ModelCredential | undefined,
  now: number
): credential is ModelCredential {
  return credential !== undefined && !isWithinRefreshWindow(credential.expiresAt, now);
}

function isWithinRefreshWindow(expiresAt: number, now: number): boolean {
  return expiresAt - now <= CREDENTIAL_REFRESH_WINDOW_MS;
}

function sameRuntimeCredentialTicket(
  first: RuntimeCredentialTicket,
  second: RuntimeCredentialTicket
): boolean {
  return (
    first.userId === second.userId &&
    first.credentialId === second.credentialId &&
    first.nodeId === second.nodeId &&
    first.workspaceId === second.workspaceId &&
    first.sessionId === second.sessionId &&
    first.runtimeScopeId === second.runtimeScopeId &&
    first.purpose === second.purpose &&
    first.issuedAt === second.issuedAt &&
    first.expiresAt === second.expiresAt &&
    first.nonce === second.nonce &&
    first.signature === second.signature &&
    first.allowedModelIds.length === second.allowedModelIds.length &&
    first.allowedModelIds.every((modelId, index) => modelId === second.allowedModelIds[index])
  );
}

function scheduleRefresh(state: TicketState, now: () => number, minimumDelayMs = 0): void {
  clearRefreshTimer(state);
  if (state.released || state.pending !== undefined || state.providers.size === 0) return;
  const timestamp = now();
  if (state.ticket.expiresAt <= timestamp) return;
  const expiresAt = Math.min(
    state.ticket.expiresAt,
    state.credential?.expiresAt ?? Number.POSITIVE_INFINITY
  );
  const delay = Math.max(minimumDelayMs, expiresAt - timestamp - CREDENTIAL_REFRESH_WINDOW_MS, 0);
  if (timestamp + delay > state.ticket.expiresAt) return;
  const timer = setTimeout(() => {
    if (state.refreshTimer === timer) delete state.refreshTimer;
    const provider = state.providers.values().next().value as
      ServerRuntimeCredentialProvider | undefined;
    provider?.refreshAutomatically();
  }, delay);
  timer.unref();
  state.refreshTimer = timer;
}

function clearRefreshTimer(state: TicketState): void {
  if (state.refreshTimer === undefined) return;
  clearTimeout(state.refreshTimer);
  delete state.refreshTimer;
}

function waitForCredential(
  pending: Promise<ModelCredential>,
  signal: AbortSignal
): Promise<ModelCredential> {
  if (signal.aborted)
    return Promise.reject(
      new AgentError(
        'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED',
        'The runtime credential provider is closed.'
      )
    );
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(
        new AgentError(
          'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED',
          'The runtime credential provider is closed.'
        )
      );
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (credential) => {
        cleanup();
        resolve(credential);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}
