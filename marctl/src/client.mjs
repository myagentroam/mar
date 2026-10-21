import { MarctlError } from './config.mjs';
import { createTranslator } from './i18n/index.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export class MarctlClient {
  #serverUrl;
  #key;
  #fetch;
  #translate;
  #requestTimeoutMs;

  constructor({
    serverUrl,
    key,
    fetchImpl = globalThis.fetch,
    translate = createTranslator(),
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  }) {
    this.#serverUrl = serverUrl;
    this.#key = key;
    this.#fetch = fetchImpl;
    this.#translate = translate;
    this.#requestTimeoutMs = requestTimeoutMs;
    if (typeof this.#fetch !== 'function')
      throw new MarctlError(this.#translate('errors.fetchUnavailable'));
  }

  async listNodes() {
    const payload = await this.#requestJson('/api/marctl/nodes');
    if (!isRecord(payload) || !Array.isArray(payload.nodes))
      throw new MarctlError(this.#translate('errors.serverInvalidNodes'));

    return payload.nodes.map((node) => {
      if (
        !isRecord(node) ||
        !isNonEmptyString(node.id) ||
        typeof node.connected !== 'boolean' ||
        (node.displayName !== undefined && typeof node.displayName !== 'string') ||
        (node.platform !== undefined && typeof node.platform !== 'string')
      )
        throw new MarctlError(this.#translate('errors.serverInvalidNodes'));
      return {
        id: node.id,
        ...(node.displayName === undefined ? {} : { displayName: node.displayName }),
        connected: node.connected,
        ...(node.platform === undefined ? {} : { platform: node.platform })
      };
    });
  }

  async sessionCommand(body) {
    const result = await this.#requestJson('/api/marctl/sessions', {
      method: 'POST',
      body,
      preserveError: true
    });
    if (!isRecord(result))
      throw new MarctlError(this.#translate('errors.serverInvalidJson'), {
        code: 'MARCTL_RESPONSE_INVALID'
      });
    return result;
  }

  async createTerminal({ nodeId, rows, cols, command, binary = false }) {
    validateNodeId(nodeId, this.#translate);
    validateDimensions(rows, cols, this.#translate);
    if (command !== undefined && typeof command !== 'string')
      throw new MarctlError(this.#translate('errors.terminalCommandInvalid'));
    const body = { nodeId, rows, cols };
    if (command !== undefined) body.command = command;
    if (binary) body.binary = true;
    const payload = await this.#requestJson('/api/marctl/terminals', {
      method: 'POST',
      body
    });
    if (!isRecord(payload) || !isNonEmptyString(payload.terminalId))
      throw new MarctlError(this.#translate('errors.serverInvalidTerminalId'));
    return binary
      ? { terminalId: payload.terminalId, binary: payload.binary === true }
      : payload.terminalId;
  }

  async getTerminalManifest(nodeId) {
    validateNodeId(nodeId, this.#translate);
    const payload = await this.#requestJson(
      `/api/marctl/nodes/${encodeURIComponent(nodeId)}/manifest`
    );
    if (
      !isRecord(payload) ||
      !isRecord(payload.manifest) ||
      !isNonEmptyString(payload.manifest.nodeGeneration)
    )
      throw new MarctlError(this.#translate('errors.serverInvalidManifest'));
    return {
      ...payload.manifest,
      ...(payload.deferredRelay === true ? { deferredRelay: true } : {}),
      ...(payload.binaryTerminal === true ? { binaryTerminal: true } : {})
    };
  }

  async openDirectTerminal(options) {
    const { openDirectTerminalProcess } = await import('./direct-process.mjs');
    return openDirectTerminalProcess({
      ...options,
      connection: { serverUrl: this.#serverUrl, key: this.#key }
    });
  }

  async createAttachTicket({ nodeId, terminalId, afterSequence }) {
    validateNodeId(nodeId, this.#translate);
    validateTerminalId(terminalId, this.#translate);
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0))
      throw new MarctlError(this.#translate('errors.terminalSequenceInvalid'));

    const body = { nodeId };
    if (afterSequence !== undefined) body.afterSequence = afterSequence;
    const payload = await this.#requestJson(
      `/api/marctl/terminals/${encodeURIComponent(terminalId)}/attach-ticket`,
      { method: 'POST', body }
    );
    if (!isRecord(payload) || !isNonEmptyString(payload.ticket))
      throw new MarctlError(this.#translate('errors.serverInvalidTicket'));
    return payload.ticket;
  }

  async deleteTerminal({ nodeId, terminalId }) {
    validateNodeId(nodeId, this.#translate);
    validateTerminalId(terminalId, this.#translate);
    await this.#request('/api/marctl/terminals/' + encodeURIComponent(terminalId), {
      method: 'DELETE',
      body: { nodeId }
    });
  }

  openTerminalWebSocket(WebSocketClass, { terminalId, ticket, deferred = false }) {
    validateTerminalId(terminalId, this.#translate);
    if (!isNonEmptyString(ticket))
      throw new MarctlError(this.#translate('errors.terminalTicketInvalid'));

    const url = new URL(
      `/api/marctl/terminals/${encodeURIComponent(terminalId)}/connect`,
      `${this.#serverUrl}/`
    );
    url.searchParams.set('ticket', ticket);
    if (deferred) url.searchParams.set('deferred', '1');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    try {
      return new WebSocketClass(url.toString(), {
        headers: { Authorization: `Bearer ${this.#key}` }
      });
    } catch {
      throw new MarctlError(this.#translate('errors.terminalConnectionStart'));
    }
  }

  openWorkbenchWebSocket(WebSocketClass) {
    const url = new URL('/api/marctl/live', `${this.#serverUrl}/`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      return new WebSocketClass(url.toString(), {
        headers: { Authorization: `Bearer ${this.#key}` }
      });
    } catch {
      throw new MarctlError(this.#translate('errors.workbenchConnectionStart'));
    }
  }

  async #requestJson(pathname, options = {}) {
    return this.#request(pathname, { ...options, json: true });
  }

  async #request(pathname, { method = 'GET', body, json = false, preserveError = false } = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.#key}`
    };
    const controller = new AbortController();
    const request = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(body);
    }

    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(new URL(pathname, `${this.#serverUrl}/`), request);
      if (!response?.ok) {
        if (preserveError) {
          const payload = await response?.json().catch(() => undefined);
          const failure = payload?.error;
          if (
            isRecord(failure) &&
            typeof failure.code === 'string' &&
            /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(failure.code) &&
            typeof failure.message === 'string'
          ) {
            throw new MarctlError(failure.message.slice(0, 2000), {
              code: failure.code,
              statusCode: response.status,
              requestId:
                typeof failure.requestId === 'string' ? failure.requestId.slice(0, 160) : undefined,
              upstreamRequestId:
                typeof failure.upstreamRequestId === 'string'
                  ? failure.upstreamRequestId.slice(0, 160)
                  : undefined,
              details:
                typeof failure.details === 'string' ? failure.details.slice(0, 4000) : undefined
            });
          }
        }
        throw new MarctlError(this.#translate('errors.serverRejected'), {
          code: 'MARCTL_SERVER_REJECTED',
          statusCode: response?.status
        });
      }
      if (!json) return response;
      try {
        return await response.json();
      } catch {
        throw new MarctlError(
          this.#translate(
            controller.signal.aborted ? 'errors.serverTimeout' : 'errors.serverInvalidJson'
          ),
          { code: controller.signal.aborted ? 'MARCTL_REQUEST_TIMEOUT' : 'MARCTL_RESPONSE_INVALID' }
        );
      }
    } catch (error) {
      if (error instanceof MarctlError) throw error;
      throw new MarctlError(
        this.#translate(
          controller.signal.aborted ? 'errors.serverTimeout' : 'errors.serverUnreachable'
        ),
        { code: controller.signal.aborted ? 'MARCTL_REQUEST_TIMEOUT' : 'MARCTL_SERVER_UNREACHABLE' }
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function validateNodeId(nodeId, translate) {
  if (!isNonEmptyString(nodeId) || nodeId.length > 128)
    throw new MarctlError(translate('errors.nodeIdInvalid'));
}

function validateTerminalId(terminalId, translate) {
  if (!isNonEmptyString(terminalId) || terminalId.length > 128)
    throw new MarctlError(translate('errors.terminalIdInvalid'));
}

function validateDimensions(rows, cols, translate) {
  if (
    !Number.isSafeInteger(rows) ||
    !Number.isSafeInteger(cols) ||
    rows < 1 ||
    cols < 1 ||
    rows > 1000 ||
    cols > 1000
  )
    throw new MarctlError(translate('errors.terminalSizeInvalid'));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}
