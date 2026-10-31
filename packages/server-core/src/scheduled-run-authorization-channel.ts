import {
  scheduledRunAuthorizeRequestSchema,
  type NodeEnvelope,
  type ScheduledRunAuthorizeRequest,
  type ScheduledRunAuthorizeResponse
} from '@myagentroam/protocol';
import type { ZodType } from 'zod';

export type ScheduledRunAuthorizer = (
  nodeId: string,
  request: ScheduledRunAuthorizeRequest
) => Promise<Extract<ScheduledRunAuthorizeResponse, { context: unknown }>['context']>;

interface AuthorizationInput<Request> {
  readonly nodeId: string;
  readonly envelope: NodeEnvelope;
  readonly isCurrentConnection: () => boolean;
  readonly authorize:
    ((nodeId: string, request: Request) => ReturnType<ScheduledRunAuthorizer>) | undefined;
  readonly respond: (payload: ScheduledRunAuthorizeResponse) => void;
}

export async function resolveScheduledRunAuthorization(input: {
  readonly nodeId: string;
  readonly envelope: NodeEnvelope;
  readonly isCurrentConnection: () => boolean;
  readonly authorize: ScheduledRunAuthorizer | undefined;
  readonly respond: (payload: ScheduledRunAuthorizeResponse) => void;
}): Promise<void> {
  return resolveAuthorization(
    input,
    scheduledRunAuthorizeRequestSchema,
    'SCHEDULE',
    'scheduled run'
  );
}

async function resolveAuthorization<Request>(
  input: AuthorizationInput<Request>,
  schema: ZodType<Request>,
  prefix: string,
  description: string
): Promise<void> {
  const error = (code: string, message: string) => ({ error: { code, message } }) as const;
  if (!input.isCurrentConnection()) {
    input.respond(error(`${prefix}_SERVER_UNAVAILABLE`, 'The Node connection is no longer valid.'));
    return;
  }
  const parsed = schema.safeParse(input.envelope.payload);
  if (!parsed.success) {
    input.respond(
      error(`${prefix}_AUTH_REQUEST_INVALID`, `The ${description} request is invalid.`)
    );
    return;
  }
  if (input.authorize === undefined) {
    input.respond(error(`${prefix}_UNSUPPORTED`, `The ${description} is unavailable.`));
    return;
  }
  try {
    const context = await input.authorize(input.nodeId, parsed.data);
    input.respond(
      input.isCurrentConnection()
        ? { context }
        : error(`${prefix}_SERVER_UNAVAILABLE`, 'The Node connection is no longer valid.')
    );
  } catch (cause) {
    const code =
      cause instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(cause.message)
        ? cause.message
        : `${prefix}_AUTH_DENIED`;
    input.respond(error(code, `The ${description} could not be authorized.`));
  }
}
