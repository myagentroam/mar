import { testMarAgentModelTransport } from '@myagentroam/agent';
import {
  marAgentModelTransportTestInputSchema,
  marAgentModelTransportTestResultSchema,
  type MarAgentModelTransportTestResult
} from '@myagentroam/protocol';
import type { MarAgentRuntimeModelFactory } from '../runner/mar-agent/runtime-model-factory.js';
import { runnerErrorProjection } from '../util/runner-error.js';

interface MarAgentModelTransportTestServiceOptions {
  readonly modelFactory: Pick<MarAgentRuntimeModelFactory, 'create'>;
  readonly testTransport?: typeof testMarAgentModelTransport;
  readonly timeoutMs?: number;
}

export class MarAgentModelTransportTestService {
  readonly #timeoutMs: number;

  constructor(private readonly options: MarAgentModelTransportTestServiceOptions) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  operations() {
    return {
      'mar-agent.model.test': (raw: unknown) => this.test(raw)
    };
  }

  async test(raw: unknown): Promise<MarAgentModelTransportTestResult> {
    const parsed = marAgentModelTransportTestInputSchema.safeParse(withoutNodeRequestMetadata(raw));
    if (!parsed.success) throw new Error('MAR_AGENT_MODEL_TEST_INPUT_INVALID');
    const [configuration] = this.options.modelFactory.create([parsed.data.model], {
      runtimeScopeId: parsed.data.runtimeScopeId,
      executionId: parsed.data.executionId
    });
    if (configuration === undefined) throw new Error('MAR_AGENT_MODEL_TEST_INPUT_INVALID');
    try {
      const completed = await (this.options.testTransport ?? testMarAgentModelTransport)(
        configuration,
        AbortSignal.timeout(this.#timeoutMs)
      );
      return marAgentModelTransportTestResultSchema.parse(
        completed
          ? { success: true, code: null, message: null, httpStatus: null }
          : {
              success: false,
              code: 'MAR_AGENT_MODEL_CONNECTION_FAILED',
              message: 'Model transport test ended without completion.',
              httpStatus: null
            }
      );
    } catch (error) {
      const projection = modelTestErrorProjection(error);
      return marAgentModelTransportTestResultSchema.parse({
        success: false,
        ...projection
      });
    } finally {
      await configuration.credentialProvider?.close().catch(() => undefined);
    }
  }
}

function withoutNodeRequestMetadata(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const payload = { ...(raw as Record<string, unknown>) };
  delete payload.__requestUserId;
  delete payload.__workspaceWatchSessionHash;
  return payload;
}

function modelTestErrorProjection(error: unknown) {
  if (error === null || typeof error !== 'object')
    return runnerErrorProjection(error, 'MAR_AGENT_MODEL_CONNECTION_FAILED');
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string')
    return runnerErrorProjection(error, 'MAR_AGENT_MODEL_CONNECTION_FAILED');
  const prefix = `${candidate.code}: `;
  const projection = runnerErrorProjection(
    {
      code: candidate.code,
      message: candidate.message.startsWith(prefix)
        ? candidate.message.slice(prefix.length)
        : candidate.message,
      status: candidate.details?.['status']
    },
    'MAR_AGENT_MODEL_CONNECTION_FAILED'
  );
  const details = candidate.details;
  return {
    ...projection,
    ...(typeof details?.['body'] === 'string' && typeof details['bodyTruncated'] === 'boolean'
      ? {
          response: {
            body: details['body'],
            bodyTruncated: details['bodyTruncated'],
            contentType: details['contentType'] ?? null,
            requestId: details['requestId'] ?? null,
            retryAfter: details['retryAfter'] ?? null
          }
        }
      : {})
  };
}
