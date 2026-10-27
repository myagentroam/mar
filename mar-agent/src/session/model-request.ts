import type { ModelMessage, ModelRequest } from '../model/contracts.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import type { CodeObservation, CodeToolCallRecord } from './code-observation-contract.js';

/** Durable execution facts, projected to protocol input at the SDK adapter boundary. */
export interface SessionModelMessage extends ModelMessage {
  calls?: readonly CodeToolCallRecord[];
  observations?: readonly CodeObservation[];
  observationId?: string;
  toolSearchTools?: readonly ClientToolDefinition[];
}

export interface SessionModelRequest extends ModelRequest {
  messages: readonly SessionModelMessage[];
  tools: readonly ClientToolDefinition[];
}
