import WebSocket from 'ws';
import { AgentError } from '../error.js';

export type ResponsesRequestBody = Readonly<Record<string, unknown>> & {
  readonly input: readonly unknown[];
};

export interface ResponsesSessionState {
  socket?: WebSocket;
  endpoint?: string;
  credentialRevision?: number;
  credentialFingerprint?: string;
  connectionId?: string;
  proxyType?: 'DIRECT' | 'SOCKS5';
  lastRequest?: ResponsesRequestBody;
  lastMessageCount?: number;
  lastInputItemCount?: number;
  lastSystem?: string;
  lastResponse?: {
    readonly responseId: string;
    readonly outputItems: readonly Record<string, unknown>[];
  };
}

export function clearResponsesContinuation(state: ResponsesSessionState): void {
  delete state.lastRequest;
  delete state.lastMessageCount;
  delete state.lastInputItemCount;
  delete state.lastSystem;
  delete state.lastResponse;
}

export function terminateWebSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CONNECTING) socket.once('error', () => undefined);
  socket.terminate();
}

export function invalidateResponsesWebSocket(
  state: ResponsesSessionState,
  clearContinuation: boolean
): void {
  const socket = state.socket;
  delete state.socket;
  delete state.endpoint;
  delete state.credentialRevision;
  delete state.credentialFingerprint;
  delete state.connectionId;
  delete state.proxyType;
  if (clearContinuation) clearResponsesContinuation(state);
  if (
    socket !== undefined &&
    socket.readyState !== WebSocket.CLOSED &&
    socket.readyState !== WebSocket.CLOSING
  )
    terminateWebSocket(socket);
}

/** One idle state per Adapter; concurrent Turns never share a lease. */
export class ResponsesSessionCache {
  #state: ResponsesSessionState = {};
  #leased = false;
  #closed = false;

  checkout(): { readonly state: ResponsesSessionState; readonly lease: boolean } {
    if (this.#closed) throw new AgentError('MAR_AGENT_DISPOSED', 'Model adapter is disposed.');
    const lease = !this.#leased;
    const state = lease ? this.#state : {};
    if (lease) {
      this.#state = {};
      this.#leased = true;
    }
    return { state, lease };
  }

  release(state: ResponsesSessionState, lease: boolean): void {
    if (!lease || this.#closed) {
      invalidateResponsesWebSocket(state, true);
      return;
    }
    if (state.socket !== undefined && state.socket.readyState !== WebSocket.OPEN) {
      invalidateResponsesWebSocket(state, false);
      clearResponsesContinuation(state);
    }
    this.#state = state;
    this.#leased = false;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    invalidateResponsesWebSocket(this.#state, true);
  }
}
