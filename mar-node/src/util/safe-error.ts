import { safePublicError as sharedSafePublicError, type PublicError } from '@myagentroam/protocol';

export type SafePublicError = PublicError;

export function safeErrorCode(error: unknown, fallback: string): string {
  return safePublicError(error, fallback).code;
}

/** Builds the bounded error shape that may cross the Node control boundary. */
export function safePublicError(error: unknown, fallback: string): SafePublicError {
  return sharedSafePublicError(error, fallback);
}
