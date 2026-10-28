import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { LogController } from 'fastify';
import { registerWebStaticRoutes } from '@myagentroam/server-core/web-static-routes';
import { RotatingLogStream } from '../rotating-log-stream.js';
import { databaseError, logCorrelation, safePublicError, sendError } from '../util/http-request.js';
import { ServerTrafficMetrics } from '../service/server-traffic-metrics.js';

/** Own the HTTP boundary and request instrumentation, independent of product storage. */
export function createServerHttp(options: {
  readonly dataDirectory: string;
  readonly webRoot?: string;
  readonly logger?: boolean;
}) {
  const { dataDirectory } = options;
  const app = Fastify({
    genReqId: () => `req-${randomUUID()}`,
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      options.logger === true
        ? { stream: new RotatingLogStream(resolve(dataDirectory, 'logs'), 'server') }
        : false
  });
  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'ROUTE_NOT_FOUND'));
  if (options.webRoot !== undefined) registerWebStaticRoutes(app, options.webRoot);
  app.setErrorHandler((error, request, reply) => {
    const errorRecord =
      error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
    const rawStatusCode = errorRecord?.['statusCode'];
    const statusCode =
      typeof rawStatusCode === 'number' &&
      Number.isInteger(rawStatusCode) &&
      rawStatusCode >= 400 &&
      rawStatusCode < 500
        ? rawStatusCode
        : undefined;
    if (statusCode !== undefined) {
      const failure = safePublicError(
        error,
        statusCode === 413 ? 'REQUEST_BODY_TOO_LARGE' : 'REQUEST_INVALID'
      );
      return sendError(
        reply,
        statusCode,
        statusCode === 413 ? 'REQUEST_BODY_TOO_LARGE' : 'REQUEST_INVALID',
        failure.details === undefined ? {} : { details: failure.details }
      );
    }
    request.log.error(
      {
        event: 'request.failed',
        requestId: request.id,
        error: safePublicError(error).code,
        ...logCorrelation(request.params)
      },
      'request_failed'
    );
    return databaseError(reply, error);
  });
  const traffic = new ServerTrafficMetrics((event, fields) => app.log.info({ event, ...fields }));
  app.addHook('onSend', async (_request, _reply, payload) => {
    traffic.record('http', 'out', payloadByteLength(payload));
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    traffic.record('http', 'in', numericHeader(request.headers['content-length']));
    app.log.info(
      {
        requestId: request.id,
        statusCode: reply.statusCode,
        ...logCorrelation(request.params)
      },
      'request_completed'
    );
  });

  return { app, traffic };
}

function numericHeader(value: unknown): number {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized === 'number') return normalized;
  if (typeof normalized !== 'string' || !/^\d+$/u.test(normalized)) return 0;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function payloadByteLength(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  return 0;
}
