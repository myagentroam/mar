import {
  runtimeCredentialResolveRequestSchema,
  type MarAgentRuntimeCredentialCapability,
  type NodeEnvelope
} from '@myagentroam/protocol';
import type { RuntimeCredentialService } from './runtime-credential-service.js';

export function runtimeCredentialConnectionError() {
  return {
    error: {
      code: 'MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID',
      message: 'The Node control connection is no longer valid.',
      recoverable: false
    }
  } as const;
}

export async function resolveNodeRuntimeCredential(input: {
  readonly nodeId: string;
  readonly envelope: NodeEnvelope;
  readonly isCurrentConnection: () => boolean;
  readonly capability: MarAgentRuntimeCredentialCapability | undefined;
  readonly service: Pick<RuntimeCredentialService, 'resolve'> | undefined;
  readonly respond: (payload: unknown) => void;
}): Promise<void> {
  if (!input.isCurrentConnection()) {
    input.respond(runtimeCredentialConnectionError());
    return;
  }
  if (input.capability?.apiVersion !== 1 || input.service === undefined) {
    input.respond({
      error: {
        code: 'MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED',
        message: 'This Node does not support runtime credentials.',
        recoverable: false
      }
    });
    return;
  }
  const request = runtimeCredentialResolveRequestSchema.safeParse(input.envelope.payload);
  if (!request.success) {
    input.respond({
      error: {
        code: 'MAR_AGENT_RUNTIME_CREDENTIAL_REQUEST_INVALID',
        message: 'The runtime credential request is invalid.',
        recoverable: false
      }
    });
    return;
  }
  const result = await input.service.resolve(input.nodeId, request.data);
  input.respond(input.isCurrentConnection() ? result : runtimeCredentialConnectionError());
}
