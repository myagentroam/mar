import type { FastifyReply } from 'fastify';
import {
  isPublicErrorCode,
  safePublicError as sharedSafePublicError,
  type PublicError
} from '@myagentroam/protocol';

export interface SafePublicError extends PublicError {
  readonly parameters?: Readonly<Record<string, string | number>>;
  readonly upstreamRequestId?: string;
}

export function errorResponseOptions(error: SafePublicError): {
  readonly message: string;
  readonly details?: string;
  readonly parameters?: Readonly<Record<string, string | number>>;
  readonly upstreamRequestId?: string;
} {
  return {
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    ...(error.parameters === undefined ? {} : { parameters: error.parameters }),
    ...(error.upstreamRequestId === undefined ? {} : { upstreamRequestId: error.upstreamRequestId })
  };
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  options: {
    readonly message?: string;
    readonly details?: string;
    readonly parameters?: Readonly<Record<string, string | number>>;
    readonly upstreamRequestId?: string;
  } = {}
): FastifyReply {
  const safeCode = isPublicErrorCode(code) ? code : 'INTERNAL_ERROR';
  const safeStatusCode = safeCode === 'INTERNAL_ERROR' && code !== safeCode ? 500 : statusCode;
  const failure = sharedSafePublicError(
    {
      code: safeCode,
      ...(safeCode === code && options.message !== undefined
        ? { publicMessage: options.message }
        : {}),
      ...(options.details === undefined ? {} : { publicDetails: options.details }),
      ...(options.parameters === undefined ? {} : { publicParameters: options.parameters })
    },
    safeCode
  );
  const upstreamRequestId = safeRequestId(options.upstreamRequestId);
  const requestId = safeRequestId(String(reply.request.id)) ?? 'unknown';
  return reply.code(safeStatusCode).send({
    error: {
      code: safeCode,
      message: failure.message,
      ...(failure.details === undefined ? {} : { details: failure.details }),
      ...(failure.parameters === undefined ? {} : { parameters: failure.parameters }),
      requestId,
      ...(upstreamRequestId === undefined ? {} : { upstreamRequestId })
    }
  });
}

export function safeErrorCode(error: unknown, fallback = 'INTERNAL_ERROR'): string {
  return safePublicError(error, fallback).code;
}

/** Builds the bounded error shape that may be returned by Server HTTP routes. */
export function safePublicError(error: unknown, fallback = 'INTERNAL_ERROR'): SafePublicError {
  const failure = sharedSafePublicError(error, fallback);
  const record = errorRecord(error);
  const upstreamRequestId = safeRequestId(record?.['upstreamRequestId']);
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.details === undefined ? {} : { details: failure.details }),
    ...(failure.parameters === undefined ? {} : { parameters: failure.parameters }),
    ...(upstreamRequestId === undefined ? {} : { upstreamRequestId })
  };
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return error !== null && typeof error === 'object'
    ? (error as Record<string, unknown>)
    : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 && !normalized.includes('\0')
    ? normalized
    : undefined;
}
