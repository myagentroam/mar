import { AgentError } from '@myagentroam/agent';
import { httpErrorResponseSchema } from '@myagentroam/protocol';

export async function readWebSearchError(response: Response): Promise<AgentError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new AgentError('MAR_AGENT_WEB_SEARCH_FAILED', 'Web search failed.', {
      details: { status: response.status }
    });
  }
  const parsed = httpErrorResponseSchema.safeParse(payload);
  if (!parsed.success)
    return new AgentError('MAR_AGENT_WEB_SEARCH_FAILED', 'Web search failed.', {
      details: { status: response.status }
    });
  const failure = parsed.data.error;
  const identifiers = [
    `requestId: ${failure.requestId}`,
    ...(failure.upstreamRequestId === undefined
      ? []
      : [`upstreamRequestId: ${failure.upstreamRequestId}`])
  ];
  const detail = [
    ...(failure.details === undefined ? [] : [`details: ${failure.details}`]),
    ...identifiers
  ].join('; ');
  return new AgentError(
    failure.code,
    detail.length === 0 ? failure.message : `${failure.message} (${detail})`,
    {
      details: {
        status: response.status,
        requestId: failure.requestId,
        ...(failure.details === undefined ? {} : { serverDetails: failure.details }),
        ...(failure.parameters === undefined ? {} : { serverParameters: failure.parameters }),
        ...(failure.upstreamRequestId === undefined
          ? {}
          : { upstreamRequestId: failure.upstreamRequestId })
      }
    }
  );
}
