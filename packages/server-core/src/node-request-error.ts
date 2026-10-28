import { publicErrorMessage, type NodeResponseErrorPayload } from '@myagentroam/protocol';

/** A structured failure returned by the currently authenticated Node request channel. */
export class NodeRequestError extends Error {
  readonly code: string;
  readonly publicMessage: string;
  readonly publicDetails: string | undefined;
  readonly publicParameters: Readonly<Record<string, string | number>> | undefined;
  readonly upstreamRequestId: string;

  constructor(
    failure: NodeResponseErrorPayload,
    upstreamRequestId: string,
    readonly source: 'node' | 'transport' = 'transport'
  ) {
    super(failure.error);
    this.name = 'NodeRequestError';
    this.code = failure.error;
    this.publicMessage = failure.message ?? publicErrorMessage(failure.error);
    this.publicDetails = failure.details;
    this.publicParameters = failure.parameters;
    this.upstreamRequestId = upstreamRequestId;
  }
}
